// LEAKAGE GUARD (owner 2026-10-03): Kalshi / Polymarket / any prediction-market price is benchmark only and never a
// soccer model input. Enforced at every model boundary (algoForecast = soccer-algo-v1, v2Forecast = soccer-algo-v2.1,
// predictShadow) and on every table the Algo lanes read. REGRESSION: radically different venue prices in the same
// database leave the lanes' model inputs and outputs byte-identical.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { assertMarketFree, assertModelInputs, assertModelSourceTable, findMarketKeys, guardModelStore, MarketLeakageError } from '../workers/soccer-ingest/src/leakage-guard.js';
import { algoForecast, runAlgo } from '../workers/soccer-ingest/src/algo-lane.js';
import { v2Forecast, runAlgoV2 } from '../workers/soccer-ingest/src/algo-v2-lane.js';
import { predictShadow, modelMatch, sortInputs } from '../workers/soccer-ingest/src/shadow-lane.js';

const DAY = 864e5;
const NOW = Date.now(); // one clock for every run in this file: runs differ ONLY in venue prices

test('denylist: every venue-derived key is rejected at any depth; the real model input keys pass', () => {
  for (const k of ['kalshi_mid', 'polymarket_price', 'prediction_market_prob', 'best_bid', 'best_ask', 'best_bid_bp', 'yes_ask_bp', 'no_bid', 'bid', 'ask', 'midpoint', 'mid', 'mid_bp', 'home_mid', 'comparable_mid_bp', 'spread_bp', 'order_book', 'book_hash', 'depth', 'last_trade_bp', 'last_price', 'venue_gap_pts', 'consensus_prob', 'market_volume', 'volume', 'liquidity', 'open_interest', 'token_id', 'clob_token', 'gamma_market_id', 'condition_id', 'implied_prob']) {
    assert.throws(() => assertMarketFree({ inputs: [{ nested: [{ [k]: 1 }] }] }), MarketLeakageError, k);
  }
  // exactly the keys the frozen models receive today (modelMatch + V2 neutral + the selected fixture columns)
  const input = { id: 'x', kickoff_at: '2026-01-01T00:00:00.000Z', t: 1, home_team_id: 'h', away_team_id: 'a', home_score: 1, away_score: 0, neutral: false };
  const target = { id: 'y', competition_id: 'c', season_id: 's', stage_id: 'g', kickoff_at: '2026-01-02T00:00:00Z', status: 'scheduled', home_team_id: 'h', away_team_id: 'a', home_score: null, away_score: null, neutral: true, result_provider: 'espn' };
  assert.deepEqual(findMarketKeys({ inputs: [input], target }), []);
  assert.deepEqual(findMarketKeys({ a: { venue_mid_bp: 1 } }), ['$.a.venue_mid_bp']);
});

test('source tables: market/venue tables and the propsports-markets endpoint are refused; soccer tables pass', async () => {
  for (const t of ['market_intel_snapshots', 'market_venue_observations', 'market_intel_event_links', 'algo_market_comparisons_current', 'pred_venue_quotes', 'kalshi_markets', 'soccer_kalshi_links', 'polymarket_books', 'propsports-markets/admin/kalshi']) assert.throws(() => assertModelSourceTable(`${t}?select=*`), MarketLeakageError, t);
  for (const t of ['soccer_matches', 'soccer_competitions', 'soccer_seasons', 'soccer_stages', 'soccer_teams', 'soccer_team_external_ids', 'soccer_match_external_ids', 'soccer_source_captures', 'soccer_algo_forecasts', 'soccer_algo_picks', 'soccer_algo_events']) assert.doesNotThrow(() => assertModelSourceTable(t), t);
  const reads = []; const g = guardModelStore({ select: async (t) => { reads.push(t); return []; }, insert: async () => [] });
  await assert.rejects(g.select('market_venue_observations', {}), MarketLeakageError);
  assert.deepEqual(reads, [], 'the refused read never reached the store');
  await g.select('soccer_matches', {}); assert.deepEqual(reads, ['soccer_matches']);
});

test('model boundary: V1, V2.1 and shadow refuse inputs or a target carrying a venue price; clean inputs are untouched', () => {
  const bl = sortInputs(JSON.parse(readFileSync('docs/evidence/research/frozen/bundesliga-results-snapshot.json', 'utf8')).filter(m => m.home_score !== null && m.away_score !== null).map(modelMatch));
  const tg = bl.at(-1); const inputs = bl.slice(0, -1);
  const nat = sortInputs(JSON.parse(readFileSync('docs/evidence/research/algo-v2/national-dataset.json', 'utf8')).rows.filter(m => m.home_score !== null && m.away_score !== null && m.home_team_id && m.away_team_id).map(m => ({ ...modelMatch(m), neutral: m.neutral_site === true })));
  const ntg = nat.at(-1); const ninputs = nat.slice(0, -1);
  for (const [name, fn, xs, t] of [['v1', algoForecast, inputs, tg], ['shadow', predictShadow, inputs, tg], ['v2.1', v2Forecast, ninputs, ntg]]) {
    const before = JSON.stringify(fn(xs, t));
    assert.ok(before && before !== 'null', name);
    const dirty = xs.map((x, i) => (i === xs.length - 1 ? { ...x, kalshi_yes_bid_bp: 9900 } : x));
    assert.throws(() => fn(dirty, t), MarketLeakageError, `${name}: input row with a Kalshi price`);
    assert.throws(() => fn(xs, { ...t, polymarket: { best_bid: 0.97, best_ask: 0.98 } }), MarketLeakageError, `${name}: target with a Polymarket book`);
    assert.throws(() => fn(xs, { ...t, consensus_prob: 0.5 }), MarketLeakageError, `${name}: venue consensus`);
    assert.equal(JSON.stringify(fn(xs, t)), before, `${name}: the guard never changes a clean forecast`);
  }
  assert.doesNotThrow(() => assertModelInputs(inputs, tg));
});

test('static: model lanes never import a market layer, read a venue table, or bind propsports-markets', () => {
  for (const f of ['algo-lane.js', 'algo-v2-lane.js', 'shadow-lane.js']) {
    const src = readFileSync(`workers/soccer-ingest/src/${f}`, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/kalshi|polymarket|market_intel|market_venue|algo_market_|propsports-markets|env\.MARKETS/i.test(src), f);
    if (f !== 'shadow-lane.js') assert.match(src, /guardModelStore\(ctx\.store\)/, `${f} reads through the guarded store`);
    assert.match(src, /assertModelInputs\(inputs, target\)/, `${f} guards its model boundary`);
  }
  for (const core of ['scripts/research/structural-core.mjs', 'scripts/research/national-core.mjs']) assert.ok(!/kalshi|polymarket|market_intel|market_venue/i.test(readFileSync(core, 'utf8')), core);
  const wr = readFileSync('workers/soccer-ingest/wrangler.toml', 'utf8');
  assert.ok(!/propsports-markets|kalshi|polymarket/i.test(wr), 'soccer-ingest has no binding to a market Worker');
});

// ---- lane-level regression worlds ------------------------------------------------------------------------------
// Venue price scenarios. 'base' = plausible prices; then every price 0c, every price 99c, and seeded random values.
const SCENARIOS = ['base', 'zero', 'ninetynine', 'random'];
const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const priceFn = sc => { const r = rng(20261003); return () => (sc === 'base' ? 4500 : sc === 'zero' ? 0 : sc === 'ninetynine' ? 9900 : Math.floor(r() * 10001)); };
const venueTables = async (store, matchIds, sc) => {
  // Present in the same database as the model inputs, keyed to the very fixtures being forecast.
  await store.query('create table market_intel_snapshots (id serial primary key, source text, canonical_event_id text, market_ticker text, yes_bid_bp int, yes_ask_bp int, no_bid_bp int, no_ask_bp int, last_price_bp int, volume int, open_interest int)');
  await store.query('create table market_venue_observations (id serial primary key, venue text, canonical_event_id text, outcome_id text, token_id text, clob_token_id text, best_bid_bp int, best_ask_bp int, mid_bp int, spread_bp int, last_trade_bp int, liquidity numeric, volume numeric, book_depth jsonb, consensus_prob int)');
  const p = priceFn(sc);
  for (const id of matchIds) for (const side of ['home', 'draw', 'away']) {
    await store.query('insert into market_intel_snapshots (source, canonical_event_id, market_ticker, yes_bid_bp, yes_ask_bp, no_bid_bp, no_ask_bp, last_price_bp, volume, open_interest) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)', ['kalshi', id, `KXSOCCER-${id}-${side}`, p(), p(), p(), p(), p(), p(), p()]);
    await store.query('insert into market_venue_observations (venue, canonical_event_id, outcome_id, token_id, clob_token_id, best_bid_bp, best_ask_bp, mid_bp, spread_bp, last_trade_bp, liquidity, volume, book_depth, consensus_prob) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', ['polymarket', id, side, `tok-${sc}-${side}`, `clob-${sc}`, p(), p(), p(), p(), p(), p(), p(), JSON.stringify({ bids: [[p(), p()]], asks: [[p(), p()]] }), p()]);
  }
};
// A fake venue layer: propsports-markets / Polymarket / Kalshi service bindings and a global fetch, all recording calls.
const fakeVenues = sc => {
  const calls = [];
  const svc = name => ({ fetch: async (req) => { calls.push(`${name} ${typeof req === 'string' ? req : req.url}`); const p = priceFn(sc); return new Response(JSON.stringify({ venue: name, best_bid_bp: p(), best_ask_bp: p(), mid_bp: p() }), { headers: { 'content-type': 'application/json' } }); } });
  return { calls, env: { MARKETS: svc('propsports-markets'), POLYMARKET: svc('polymarket'), KALSHI: svc('kalshi'), MARKETS_READ_TOKEN: 'fake' }, fetch: async (u) => { calls.push(`global ${u}`); return new Response('{}'); } };
};
const spy = store => { const reads = []; return { reads, s: new Proxy(store, { get(t, k) { if (k === 'select') return (table, ...r) => { reads.push(table); return t.select(table, ...r); }; const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v; } }) }; };
const memStorage = () => { const m = new Map(); return { m, async head(k) { return m.has(k); }, async put(k, b) { m.set(k, b); }, async get(k) { return m.get(k) || null; } }; };
// The invariant: every perturbed run equals the unperturbed run byte for byte (sha256 of the feature vector =
// the write-once input archive, and of the model output = forecasts + Official Picks), nothing read a venue table,
// and nothing called a venue service.
const sha = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
function checkInvariant(out) {
  const base = out.base;
  assert.ok(base.archive.length > 2, 'the input archive (feature vector) was written');
  for (const sc of SCENARIOS) {
    const o = out[sc];
    if (sc !== 'base') assert.notEqual(sha(o.venue), sha(base.venue), `${sc}: venue prices really differ from base`);
    assert.deepEqual(o.calls, [], `${sc}: no venue service / endpoint was called`);
    assert.ok(!/market_|kalshi|polymarket/.test(o.reads), `${sc}: no venue table read`);
    assert.equal(o.reads, base.reads, `${sc}: same tables read in the same order`);
    assert.equal(sha(o.archive), sha(base.archive), `${sc}: feature vector (input archive) byte-identical`);
    assert.equal(sha(o.forecasts), sha(base.forecasts), `${sc}: forecasts byte-identical`);
    assert.equal(sha(o.picks), sha(base.picks), `${sc}: Official Picks byte-identical`);
    assert.equal(o.run, base.run, `${sc}: run summary identical`);
  }
}
const VOLATILE = new Set(['id', 'forecast_id', 'created_at', 'updated_at', 'record_no']);
const rowsOf = async (store, table) => (await store.query(`select * from ${table} order by match_id`)).rows.map(r => JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)))));

// V1 (Bundesliga) world: deterministic ids per build.
const u1 = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
async function v1World(sc) {
  let mid = 1000;
  const COMP = u1(1); const S25 = u1(2); const S26 = u1(3); const L25 = u1(4); const L26 = u1(5);
  const TEAMS = Array.from({ length: 18 }, (_, i) => u1(100 + i));
  const ids = [...TEAMS]; const first = [];
  for (let r = 0; r < 17; r++) { const ps = []; for (let i = 0; i < 9; i++) ps.push(r % 2 ? [ids[17 - i], ids[i]] : [ids[i], ids[17 - i]]); first.push(ps); ids.splice(1, 0, ids.pop()); }
  const ROUNDS = [...first, ...first.map(ps => ps.map(([h, a]) => [a, h]))];
  const store = await openPglite(); await applyMigrations(store);
  await store.query(`insert into soccer_competitions (id, slug, name, comp_type) values ($1,'bundesliga','Bundesliga','league')`, [COMP]);
  await store.query(`insert into soccer_seasons (id, competition_id, label, publication_state, published_at) values ($1,$3,'2025/26','published',now()), ($2,$3,'2026/27','published',now())`, [S25, S26, COMP]);
  await store.query(`insert into soccer_stages (id, season_id, name, stage_type) values ($1,$3,'Regular Season','league'), ($2,$4,'Regular Season','league')`, [L25, L26, S25, S26]);
  for (const [i, t] of TEAMS.entries()) await store.query(`insert into soccer_teams (id, slug, name, team_type, founding_provider, founding_external_id) values ($1,$2,$3,'club','test',$4)`, [t, `team-${i}`, `Team ${i}`, String(i)]);
  const match = async ({ season = S26, stage = L26, t, h, a, status = 'scheduled', hs = null, as = null }) => { const id = u1(mid++); await store.query(`insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, home_team_id, away_team_id, status, home_score, away_score) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, COMP, season, stage, new Date(t).toISOString(), h, a, status, hs, as]); return id; };
  let k = 0;
  const score = (h, a) => { k += 1; if (h === TEAMS[0]) return [4, 0]; if (a === TEAMS[0]) return [0, 3]; return [(k * 7) % 3, (k * 5) % 3]; };
  for (let r = 0; r < 34; r++) for (const [h, a] of ROUNDS[r]) { const [hs, as] = score(h, a); await match({ season: S25, stage: L25, t: NOW - 420 * DAY + r * 7 * DAY, h, a, status: 'finished', hs, as }); }
  for (let r = 0; r < 20; r++) for (const [h, a] of ROUNDS[r]) { const [hs, as] = score(h, a); await match({ t: NOW - 150 * DAY + r * 7 * DAY, h, a, status: 'finished', hs, as }); }
  const fx = []; for (const [i, [h, a]] of ROUNDS[20].entries()) fx.push(await match({ t: NOW + 3 * DAY + i * 3600e3, h, a }));
  await venueTables(store, fx, sc);
  return store;
}

test('REGRESSION V1 lane: Kalshi + Polymarket prices at base / 0c / 99c / seeded random leave soccer-algo-v1 inputs and outputs byte-identical', async () => {
  const out = {};
  for (const sc of SCENARIOS) {
    const store = await v1World(sc); const { s, reads } = spy(store); const storage = memStorage(); const fv = fakeVenues(sc);
    const realFetch = globalThis.fetch; globalThis.fetch = fv.fetch;
    let run; try { run = await runAlgo({ store: s, storage, now: NOW, env: { ALGO_OFFICIAL: 'on', ...fv.env }, force: true, fetchImpl: fv.fetch }); } finally { globalThis.fetch = realFetch; }
    const venue = JSON.stringify((await store.query('select * from market_intel_snapshots order by id')).rows) + JSON.stringify((await store.query('select * from market_venue_observations order by id')).rows);
    out[sc] = { run: JSON.stringify(run), reads: JSON.stringify(reads), calls: fv.calls, archive: JSON.stringify([...storage.m.entries()]), forecasts: await rowsOf(store, 'soccer_algo_forecasts'), picks: await rowsOf(store, 'soccer_algo_picks'), venue };
    await store.close();
  }
  assert.ok(out.base.forecasts.length >= 5, out.base.run);
  checkInvariant(out);
});

// V2.1 (Nations League) world.
const u2 = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
async function v2World(sc) {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: u2(1), slug: 'uefa-nations-league', name: 'UNL', comp_type: 'international_tournament' }, { id: u2(2), slug: 'fifa-world-cup', name: 'WC', comp_type: 'international_tournament' }]);
  await store.insert('soccer_seasons', [{ id: u2(3), competition_id: u2(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: u2(5), season_id: u2(3), name: 'League phase', stage_type: 'league', stage_order: 1 }]);
  const teams = Array.from({ length: 7 }, (_, i) => ({ id: u2(10 + i), slug: `n${i}`, name: `Nation ${i}`, team_type: 'national', founding_provider: 'espn', founding_external_id: String(900 + i) }));
  await store.insert('soccer_teams', teams);
  await store.insert('soccer_team_external_ids', teams.map((t, i) => ({ provider: 'espn', external_id: String(900 + i), team_id: t.id, method: 'founding', evidence: 'espn team id' })));
  const pairs = []; for (let h = 0; h < 7; h++) for (let a = 0; a < 7; a++) if (h !== a) pairs.push([h, a]);
  await store.insert('soccer_seasons', [0, 1, 2].map(s => ({ id: u2(60 + s), competition_id: u2(1), label: `202${s}/2${s + 1}`, publication_state: 'published', published_at: '2026-01-01T00:00:00Z' })));
  await store.insert('soccer_stages', [0, 1, 2].map(s => ({ id: u2(70 + s), season_id: u2(60 + s), name: 'League phase', stage_type: 'league', stage_order: 1 })));
  const rows = []; let n = 100;
  for (let k = 0; k < 120; k++) { const [h, a] = pairs[k % 40]; const s = Math.floor(k / 40); rows.push({ id: u2(n++), competition_id: u2(1), season_id: u2(60 + s), stage_id: u2(70 + s), kickoff_at: new Date(NOW - (720 - k * 5) * DAY).toISOString(), home_team_id: u2(10 + h), away_team_id: u2(10 + a), status: 'finished', home_score: h === 0 ? 3 : 1, away_score: a === 0 ? 3 : h === 1 ? 2 : 1, result_provider: 'espn' }); }
  const fx = [[1, 0], [2, 0], [3, 4], [5, 6]].map(([h, a], i) => ({ id: u2(n++), competition_id: u2(1), season_id: u2(3), stage_id: u2(5), kickoff_at: new Date(NOW + (3 + i) * DAY).toISOString(), home_team_id: u2(10 + h), away_team_id: u2(10 + a), status: 'scheduled', home_score: null, away_score: null, result_provider: 'espn' }));
  await store.insert('soccer_matches', [...rows, ...fx]);
  await venueTables(store, fx.map(f => f.id), sc);
  return { store, frozen: { ids: new Set(rows.map(r => r.id)), at: NOW - DAY } };
}

test('REGRESSION V2.1 lane: Kalshi + Polymarket prices at base / 0c / 99c / seeded random leave soccer-algo-v2.1 inputs and outputs byte-identical', async () => {
  const out = {};
  for (const sc of SCENARIOS) {
    const { store, frozen } = await v2World(sc); const { s, reads } = spy(store); const storage = memStorage(); const fv = fakeVenues(sc);
    const kv = new Map(); const KV = { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } };
    const realFetch = globalThis.fetch; globalThis.fetch = fv.fetch;
    let run; try { run = await runAlgoV2({ store: s, storage, now: NOW, env: { ALGO_V2: 'on', ...fv.env }, kv: KV, force: true, frozen, fetchImpl: fv.fetch }); } finally { globalThis.fetch = realFetch; }
    const venue = JSON.stringify((await store.query('select * from market_intel_snapshots order by id')).rows) + JSON.stringify((await store.query('select * from market_venue_observations order by id')).rows);
    out[sc] = { run: JSON.stringify(run), reads: JSON.stringify(reads), calls: fv.calls, archive: JSON.stringify([...storage.m.entries()]), forecasts: await rowsOf(store, 'soccer_algo_forecasts'), picks: await rowsOf(store, 'soccer_algo_picks'), venue };
    await store.close();
  }
  assert.ok(out.base.forecasts.length === 4, out.base.run);
  checkInvariant(out);
});
