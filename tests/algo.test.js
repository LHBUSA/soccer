// Soccer Algo V1: frozen spec, forecast = frozen model, pick policy, SQL grading, ledger immutability, lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { algoForecast, decide, grade, runAlgo, ALGO_SPEC as spec } from '../workers/soccer-ingest/src/algo-lane.js';
import { predictShadow } from '../workers/soccer-ingest/src/shadow-lane.js';

const DAY = 864e5; const H = 3600e3;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = t => new Date(t).toISOString();
const COMP = uuid(1); const S25 = uuid(2); const S26 = uuid(3); const L25 = uuid(4); const L26 = uuid(5);
const TEAMS = Array.from({ length: 18 }, (_, i) => uuid(100 + i));
const ROUNDS = (() => { const ids = [...TEAMS]; const first = []; for (let r = 0; r < 17; r++) { const ps = []; for (let i = 0; i < 9; i++) ps.push(r % 2 ? [ids[17 - i], ids[i]] : [ids[i], ids[17 - i]]); first.push(ps); ids.splice(1, 0, ids.pop()); } return [...first, ...first.map(ps => ps.map(([h, a]) => [a, h]))]; })();
let mid = 1000;
async function world(now) {
  const store = await openPglite(); await applyMigrations(store);
  await store.query(`insert into soccer_competitions (id, slug, name, comp_type) values ($1,'bundesliga','Bundesliga','league')`, [COMP]);
  await store.query(`insert into soccer_seasons (id, competition_id, label) values ($1,$3,'2025/26'), ($2,$3,'2026/27')`, [S25, S26, COMP]);
  await store.query(`insert into soccer_stages (id, season_id, name, stage_type) values ($1,$3,'Regular Season','league'), ($2,$4,'Regular Season','league')`, [L25, L26, S25, S26]);
  for (const [i, t] of TEAMS.entries()) await store.query(`insert into soccer_teams (id, slug, name, team_type, founding_provider, founding_external_id) values ($1,$2,$3,'club','test',$4)`, [t, `team-${i}`, `Team ${i}`, String(i)]);
  // strong team 0 (wins big), everyone else mixed: gives the model clear favourites
  let k = 0;
  const score = (h, a) => { k += 1; if (h === TEAMS[0]) return [4, 0]; if (a === TEAMS[0]) return [0, 3]; return [(k * 7) % 3, (k * 5) % 3]; };
  for (let r = 0; r < 34; r++) for (const [h, a] of ROUNDS[r]) { const [hs, as] = score(h, a); await match(store, { season: S25, stage: L25, t: now - 420 * DAY + r * 7 * DAY, h, a, status: 'finished', hs, as }); }
  for (let r = 0; r < 20; r++) for (const [h, a] of ROUNDS[r]) { const [hs, as] = score(h, a); await match(store, { t: now - 150 * DAY + r * 7 * DAY, h, a, status: 'finished', hs, as }); }
  return store;
}
async function match(store, { season = S26, stage = L26, t, h, a, status = 'scheduled', hs = null, as = null }) {
  const id = uuid(mid++);
  await store.query(`insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, home_team_id, away_team_id, status, home_score, away_score) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, COMP, season, stage, iso(t), h, a, status, hs, as]);
  return id;
}
// an unplayed 2026/27 pairing (rounds 21-34) with the given home team
const unplayed = (home, skip = 0) => ROUNDS.slice(20).flat().filter(([h]) => h === home)[skip];
const memStorage = () => { const m = new Map(); return { m, async head(k) { return m.has(k); }, async put(k, b) { m.set(k, b); }, async get(k) { return m.get(k) || null; } }; };

test('algo-v1.json is regenerated exactly from committed evidence; V1 = Bundesliga 1X2 >= 0.60 + home_to_score >= 0.875', () => {
  execFileSync(process.execPath, ['scripts/algo/build-spec.mjs', '--check'], { stdio: 'pipe' });
  assert.equal(spec.algo_version, 'soccer-algo-v1.0.0');
  assert.deepEqual(Object.fromEntries(Object.entries(spec.pick_policy.markets).map(([k, v]) => [k, v.threshold])), { '1x2': 0.6, home_to_score: 0.875 });
  assert.equal(spec.lead_time.lock_minutes_before_kickoff, 60);
  assert.equal(spec.competition_scope.competition_slug, 'bundesliga');
  assert.match(spec.prices, /no default odds/);
});

test('the forecast is the frozen model: 1X2 equals the shadow prediction; markets are a coherent scoreline grid', () => {
  const now = Date.parse('2026-01-10T12:00:00Z');
  const inputs = []; let k = 0;
  for (let r = 0; r < 34; r++) for (const [h, a] of ROUNDS[r]) { k += 1; const t = now - 300 * DAY + r * 7 * DAY; inputs.push({ id: uuid(5000 + k), kickoff_at: iso(t), t, home_team_id: h, away_team_id: a, home_score: h === TEAMS[0] ? 4 : (k * 7) % 3, away_score: a === TEAMS[0] ? 3 : (k * 5) % 3 }); }
  const target = { kickoff_at: iso(now + 2 * DAY), home_team_id: TEAMS[0], away_team_id: TEAMS[5] };
  const f = algoForecast(inputs, target); const sh = predictShadow(inputs, target);
  const v = f.probabilities['1x2'];
  assert.deepEqual([v.home, v.draw, v.away].map(x => +x.toFixed(12)), sh.probs.map(x => +x.toFixed(12)));
  assert.ok(Math.abs(v.home + v.draw + v.away - 1) < 1e-12);
  assert.ok(f.probabilities.btts <= Math.min(f.probabilities.home_to_score, f.probabilities.away_to_score) + 1e-12);
  assert.equal(f.lambda_home, sh.lambda_home);
});

test('pick policy: frozen thresholds, one pick per match, Game Best always, non-qualifying never official', () => {
  const strong = decide({ '1x2': { home: 0.66, draw: 0.2, away: 0.14 }, over_2_5: 0.6, home_to_score: 0.9, away_to_score: 0.5, btts: 0.45 });
  assert.equal(strong.official.market, '1x2'); assert.equal(strong.official.selection, 'home'); // margin .06 beats .025
  const hts = decide({ '1x2': { home: 0.55, draw: 0.25, away: 0.2 }, over_2_5: 0.6, home_to_score: 0.9, away_to_score: 0.5, btts: 0.45 });
  assert.equal(hts.official.market, 'home_to_score');
  const none = decide({ '1x2': { home: 0.45, draw: 0.27, away: 0.28 }, over_2_5: 0.52, home_to_score: 0.8, away_to_score: 0.7, btts: 0.5 });
  assert.equal(none.official, null); assert.equal(none.game_best.qualifies, false); assert.ok(none.game_best.market);
  const away = decide({ '1x2': { home: 0.16, draw: 0.2, away: 0.64 }, over_2_5: 0.6, home_to_score: 0.6, away_to_score: 0.9, btts: 0.5 });
  assert.equal(away.official.selection, 'away');
  // markets outside V1 (over_2_5, away_to_score, btts) can never be selected
  assert.ok(![strong, hts, none, away].some(d => ['over_2_5', 'away_to_score', 'btts'].includes(d.game_best.market)));
});

test('grading: JS grade() equals the SQL soccer_algo_grade() for every V1 market/selection and score', async () => {
  const store = await openPglite(); await applyMigrations(store);
  for (const [market, sels] of [['1x2', ['home', 'draw', 'away']], ['home_to_score', ['yes', 'no']], ['away_to_score', ['yes', 'no']], ['over_2_5', ['over', 'under']]]) for (const sel of sels) for (let hs = 0; hs <= 3; hs++) for (let as = 0; as <= 3; as++) {
    const { rows: [r] } = await store.query('select public.soccer_algo_grade($1,$2,$3,$4) g', [market, sel, hs, as]);
    assert.equal(r.g, grade(market, sel, hs, as), `${market} ${sel} ${hs}-${as}`);
  }
  await store.close();
});

test('lane end to end: forecast + Official Pick before lock, input archive, immutability, settlement once from the canonical score', async () => {
  const now = Date.now();
  const store = await world(now);
  const [fh, fa] = unplayed(TEAMS[0]); const fx = await match(store, { t: now + 3 * DAY, h: fh, a: fa }); // strong home side -> qualifies
  const [lh, la] = unplayed(TEAMS[1]); const late = await match(store, { t: now + 30 * 60e3, h: lh, a: la }); // inside the 60-minute lock: never issued
  const storage = memStorage();
  const off = await runAlgo({ store, storage, now, env: {} });
  assert.equal(off.skipped, 'algo_official_off');
  const run = await runAlgo({ store, storage, now, env: { ALGO_OFFICIAL: 'on' }, force: true });
  assert.ok(run.results.forecasts >= 1, JSON.stringify(run));
  const { rows: fcs } = await store.query('select * from soccer_algo_forecasts');
  assert.ok(!fcs.some(f => f.match_id === late), 'no forecast inside the lock window');
  const { rows: [p] } = await store.query('select * from soccer_algo_picks where match_id = $1', [fx]);
  assert.ok(p, 'the strong home favourite is an Official Pick');
  assert.equal(Number(p.record_no), 1); assert.equal(p.status, 'pending'); assert.equal(p.algo_version, 'soccer-algo-v1.0.0');
  assert.ok(Date.parse(p.issued_at) <= Date.parse(p.lock_at) && Date.parse(p.lock_at) < Date.parse(p.kickoff_at));
  assert.equal(Date.parse(p.kickoff_at) - Date.parse(p.lock_at), 60 * 60e3);
  assert.ok([...storage.m.keys()].some(k => k.includes('algo_inputs')), 'input list archived');
  const archived = JSON.parse([...storage.m.values()][0]);
  assert.equal(archived.input_hash, p.input_hash);
  // reproduction: the archived inputs give the same forecast bit-for-bit
  const inputs = archived.inputs.map(([id, kickoff_at, home_team_id, away_team_id, home_score, away_score]) => ({ id, kickoff_at, t: Date.parse(kickoff_at), home_team_id, away_team_id, home_score, away_score }));
  const again = algoForecast(inputs, { kickoff_at: p.kickoff_at instanceof Date ? p.kickoff_at.toISOString() : p.kickoff_at, home_team_id: fh, away_team_id: fa });
  assert.equal(again.official.probability, p.model_probability);
  // idempotent: a second run issues nothing new
  const run2 = await runAlgo({ store, storage, now, env: { ALGO_OFFICIAL: 'on' }, force: true });
  assert.equal(run2.results.forecasts, 0);
  // immutability
  await assert.rejects(store.query('update soccer_algo_picks set model_probability = 0.99 where id = $1', [p.id]), /frozen/);
  await assert.rejects(store.query('update soccer_algo_forecasts set lambda_home = 3 where match_id = $1', [fx]), /immutable/);
  await assert.rejects(store.query('delete from soccer_algo_picks where id = $1', [p.id]), /immutable/);
  await assert.rejects(store.query("update soccer_algo_picks set status = 'win', settled_at = now(), final_home_score = 1, final_away_score = 0 where id = $1", [p.id]), /not final/);
  // settlement from the canonical score only (the match finishes 0-1: the home pick loses)
  await store.query("update soccer_matches set status = 'finished', home_score = 0, away_score = 1 where id = $1", [fx]);
  await assert.rejects(store.query("update soccer_algo_picks set status = 'win', settled_at = now(), final_home_score = 0, final_away_score = 1 where id = $1", [p.id]), /graded win but the canonical score says loss/);
  await assert.rejects(store.query("update soccer_algo_picks set status = 'void', settled_at = now() where id = $1", [p.id]), /void only/);
  const run3 = await runAlgo({ store, storage, now: now + 4 * DAY, env: { ALGO_OFFICIAL: 'on' }, force: true });
  assert.equal(run3.results.settled, 1);
  const { rows: [s] } = await store.query('select status, final_home_score, final_away_score from soccer_algo_picks where id = $1', [p.id]);
  assert.deepEqual([s.status, s.final_home_score, s.final_away_score], ['loss', 0, 1]);
  await assert.rejects(store.query("update soccer_algo_picks set status = 'win' where id = $1", [p.id]), /already settled/);
  const { rows: ev } = await store.query("select event, reason from soccer_algo_events where event in ('issued','settled','alert') order by at");
  assert.ok(ev.some(e => e.event === 'issued') && ev.some(e => e.event === 'settled'));
  assert.ok(ev.filter(e => e.event === 'alert').every(e => e.reason === 'slack_not_configured_or_failed'), 'no webhook configured: alerts land in the events table only');
  await store.close();
});

test('ledger guards: no pick after lock, no price after lock, price once, profit only from a stored price, void for a cancelled match', async () => {
  const now = Date.now();
  const store = await world(now);
  const [gh, ga] = unplayed(TEAMS[0]); const fx = await match(store, { t: now + 2 * DAY, h: gh, a: ga });
  await runAlgo({ store, storage: memStorage(), now, env: { ALGO_OFFICIAL: 'on' }, force: true });
  const { rows: [p] } = await store.query('select * from soccer_algo_picks where match_id = $1', [fx]);
  assert.ok(p);
  // a second pick for the same match / a pick whose lock has passed
  await assert.rejects(store.query(`insert into soccer_algo_picks (forecast_id, algo_version, model_id, model_version, model_hash, pick_policy_version, spec_hash, competition_id, season_id, match_id, market, selection, model_probability, threshold, lambda_home, lambda_away, issued_at, lock_at, kickoff_at, input_as_of, input_hash)
    select forecast_id, algo_version, model_id, model_version, model_hash, pick_policy_version, spec_hash, competition_id, season_id, match_id, market, selection, model_probability, threshold, lambda_home, lambda_away, issued_at, now() - interval '1 minute', kickoff_at, input_as_of, input_hash from soccer_algo_picks where id = $1`, [p.id]), /after lock|lock_at|duplicate/);
  // price: once, before lock
  await store.query("update soccer_algo_picks set sportsbook = 'test-book', price_decimal = 1.62, price_american = -161, price_captured_at = now() where id = $1", [p.id]);
  await assert.rejects(store.query("update soccer_algo_picks set price_decimal = 1.70 where id = $1", [p.id]), /write-once/);
  // cancelled -> void; profit must follow the stored price
  await store.query("update soccer_matches set status = 'cancelled' where id = $1", [fx]);
  await assert.rejects(store.query("update soccer_algo_picks set status = 'void', settled_at = now(), units = 1, profit_units = 0.62 where id = $1", [p.id]), /profit_units must follow/);
  await store.query("update soccer_algo_picks set status = 'void', settled_at = now(), settlement_reason = 'match cancelled', units = 1, profit_units = 0 where id = $1", [p.id]);
  const { rows: [v] } = await store.query('select status from soccer_algo_picks where id = $1', [p.id]);
  assert.equal(v.status, 'void');
  await store.close();
});

test('public API: empty before go-live; Official Picks, Game Best and the record come from the ledger only; research is labelled and separate', async () => {
  const A = await import('../workers/soccer-api/src/algo.js');
  const now = Date.now();
  const store = await world(now);
  const pre = await A.record(store, {});
  assert.equal(pre.data.live, false); assert.equal(pre.data.totals.picks, 0); assert.equal(pre.data.totals.hit_rate, null); assert.equal(pre.meta.coverage.state, 'unavailable');
  const [fh, fa] = unplayed(TEAMS[0]); const fx = await match(store, { t: now + 3 * DAY, h: fh, a: fa });
  const [nh, na] = unplayed(TEAMS[3]); await match(store, { t: now + 4 * DAY, h: nh, a: na });
  await match(store, { t: now + 12 * DAY, h: unplayed(TEAMS[5])[0], a: unplayed(TEAMS[5])[1] }); // outside the 7-day window
  const prePicks = await A.picks(store, now);
  assert.equal(prePicks.data.official_picks.open.length, 0); assert.equal(prePicks.data.game_best.length, 0);
  assert.ok(prePicks.data.awaiting_forecast.length >= 1 && prePicks.data.awaiting_forecast.every(m => m.forecast_window_opens_at && m.lock_at));
  await runAlgo({ store, storage: memStorage(), now, env: { ALGO_OFFICIAL: 'on' }, force: true });
  const p = await A.picks(store, now);
  assert.equal(p.data.live, true);
  assert.equal(p.data.official_picks.open.length, 1);
  const op = p.data.official_picks.open[0];
  assert.equal(op.match_id, fx); assert.equal(op.record_no, 1); assert.equal(op.label, 'Team 0 to win'); assert.equal(op.price, null);
  assert.ok(p.data.game_best.length >= 2, 'every forecast match has a Game Best');
  assert.ok(p.data.game_best.some(g => !g.game_best.qualifies && g.official_pick === null), 'a non-qualifying Game Best is shown but is not an Official Pick');
  assert.equal(p.data.game_best.find(g => g.match_id === fx).official_pick.record_no, 1);
  assert.ok(p.data.awaiting_forecast.some(m => Date.parse(m.kickoff_at) > now + 7 * DAY));
  await store.query("update soccer_matches set status = 'finished', home_score = 2, away_score = 0 where id = $1", [fx]);
  await runAlgo({ store, storage: memStorage(), now: now + 4 * DAY, env: { ALGO_OFFICIAL: 'on' }, force: true });
  const r = await A.record(store, {});
  assert.equal(r.data.totals.wins, 1); assert.equal(r.data.totals.losses, 0); assert.equal(r.data.totals.hit_rate, 1);
  assert.equal(r.data.picks[0].final_score, '2-0'); assert.equal(r.data.picks[0].status, 'win');
  assert.equal(r.data.prices.roi, null); assert.equal(r.data.prices.units, null); assert.match(r.data.prices.reason, /No default odds/);
  assert.equal(r.data.windows.last_30.graded, 1);
  assert.equal((await A.record(store, { market: 'home_to_score' })).data.totals.picks, 0);
  await assert.rejects(A.record(store, { market: 'btts' }), e => e.status === 400);
  await assert.rejects(A.record(store, { last: '50' }), e => e.status === 400);
  const res = A.researchSummary().data;
  assert.equal(res.label, 'HISTORICAL VALIDATION'); assert.equal(res.holdout.combined.official_picks, 548); assert.equal(res.spec_hash, spec.spec_hash);
  execFileSync(process.execPath, ['scripts/algo/build-research-summary.mjs', '--check'], { stdio: 'pipe' });
  await store.close();
});
