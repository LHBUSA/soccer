// soccer#17 / Market Disagreement Radar V1 (contract section A): /v1/algo/forecasts serves the frozen Soccer Algo V1
// forecasts exactly as stored, with the Official Pick kept separate (an AWAY pick stays AWAY), game_best discloses
// input_as_of, and lineup readiness is independent, rights-aware context. All read-only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { runAlgo } from '../workers/soccer-ingest/src/algo-lane.js';
import * as A from '../workers/soccer-api/src/algo.js';
import { decideReadiness, lineupReadiness, lineupRights, readinessFor } from '../workers/soccer-api/src/lineups.js';

const DAY = 864e5;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = t => new Date(t).toISOString();
const COMP = uuid(1); const S25 = uuid(2); const S26 = uuid(3); const L25 = uuid(4); const L26 = uuid(5);
const TEAMS = Array.from({ length: 18 }, (_, i) => uuid(100 + i));
const ROUNDS = (() => { const ids = [...TEAMS]; const first = []; for (let r = 0; r < 17; r++) { const ps = []; for (let i = 0; i < 9; i++) ps.push(r % 2 ? [ids[17 - i], ids[i]] : [ids[i], ids[17 - i]]); first.push(ps); ids.splice(1, 0, ids.pop()); } return [...first, ...first.map(ps => ps.map(([h, a]) => [a, h]))]; })();
const UNPLAYED = ROUNDS.slice(20).flat();
let mid = 1000;
async function match(store, { season = S26, stage = L26, t, h, a, status = 'scheduled', hs = null, as = null }) {
  const id = uuid(mid++);
  await store.query(`insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, home_team_id, away_team_id, status, home_score, away_score) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, COMP, season, stage, iso(t), h, a, status, hs, as]);
  return id;
}
async function world(now) {
  const store = await openPglite(); await applyMigrations(store);
  await store.query(`insert into soccer_competitions (id, slug, name, comp_type) values ($1,'bundesliga','Bundesliga','league')`, [COMP]);
  await store.query(`insert into soccer_seasons (id, competition_id, label, publication_state, published_at) values ($1,$3,'2025/26','published',now()), ($2,$3,'2026/27','published',now())`, [S25, S26, COMP]);
  await store.query(`insert into soccer_stages (id, season_id, name, stage_type) values ($1,$3,'Regular Season','league'), ($2,$4,'Regular Season','league')`, [L25, L26, S25, S26]);
  for (const [i, t] of TEAMS.entries()) await store.query(`insert into soccer_teams (id, slug, name, team_type, founding_provider, founding_external_id) values ($1,$2,$3,'club','test',$4)`, [t, `team-${i}`, `Team ${i}`, String(i)]);
  let k = 0;
  const score = (h, a) => { k += 1; if (h === TEAMS[0]) return [4, 0]; if (a === TEAMS[0]) return [0, 3]; return [(k * 7) % 3, (k * 5) % 3]; };
  for (let r = 0; r < 34; r++) for (const [h, a] of ROUNDS[r]) { const [hs, as] = score(h, a); await match(store, { season: S25, stage: L25, t: now - 420 * DAY + r * 7 * DAY, h, a, status: 'finished', hs, as }); }
  for (let r = 0; r < 20; r++) for (const [h, a] of ROUNDS[r]) { const [hs, as] = score(h, a); await match(store, { t: now - 150 * DAY + r * 7 * DAY, h, a, status: 'finished', hs, as }); }
  return store;
}
const memStorage = () => { const m = new Map(); return { async head(k) { return m.has(k); }, async put(k, b) { m.set(k, b); }, async get(k) { return m.get(k) || null; } }; };
// Every call the API makes is recorded; anything but select() fails the test (frozen tables are never written).
function readOnly(store) {
  const calls = [];
  const proxy = new Proxy(store, { get(t, p) { const v = t[p]; if (typeof v !== 'function') return v; return (...args) => { calls.push([p, args[0]]); if (p !== 'select') throw new Error(`write path ${String(p)} on ${args[0]}`); return v.apply(t, args); }; } });
  return { proxy, calls };
}
const r4 = x => Math.round(x * 1e4) / 1e4;
const PUBLIC_BL = { competitions: [{ slug: 'bundesliga', espn: { enabled: true, live_enrichment: 'public' } }] };

test('forecasts: frozen numbers unchanged, AWAY Official Pick stays AWAY, no pick -> null, game_best discloses input_as_of', async () => {
  const now = Date.now();
  const store = await world(now);
  const [ah, aa] = UNPLAYED.find(([, a]) => a === TEAMS[0]); const awayFav = await match(store, { t: now + 2 * DAY, h: ah, a: aa }); // strong AWAY side
  const [nh, na] = UNPLAYED.find(([h, a]) => h === TEAMS[3] && a !== TEAMS[0]); const plain = await match(store, { t: now + 3 * DAY, h: nh, a: na });
  await runAlgo({ store, storage: memStorage(), now, env: { ALGO_OFFICIAL: 'on' }, force: true });
  const { rows: fcs } = await store.query('select * from soccer_algo_forecasts order by kickoff_at');
  const { rows: pks } = await store.query('select * from soccer_algo_picks');
  const before = JSON.stringify([fcs, pks]);
  const { proxy, calls } = readOnly(store);
  const out = await A.forecasts(proxy, { from: iso(now), to: iso(now + 10 * DAY) }, now);
  assert.ok(calls.length && calls.every(([m]) => m === 'select'));
  assert.equal(out.data.length, fcs.length);
  for (const row of out.data) {
    const f = fcs.find(x => x.match_id === row.match_id);
    assert.deepEqual(row.forecast.probabilities, { home_win: r4(f.probabilities['1x2'].home), draw: r4(f.probabilities['1x2'].draw), away_win: r4(f.probabilities['1x2'].away) });
    assert.equal(row.forecast.forecast_id, f.id); assert.equal(row.forecast.input_hash, f.input_hash); assert.equal(row.forecast.model_hash, f.model_hash); assert.equal(row.forecast.spec_hash, f.spec_hash);
    assert.equal(row.forecast.algo_version, 'soccer-algo-v1.0.0');
    assert.equal(row.forecast.issued_at, iso(f.issued_at)); assert.equal(row.forecast.input_as_of, iso(f.input_as_of));
    assert.equal(row.competition.slug, 'bundesliga'); assert.equal(row.status, 'scheduled');
    assert.equal(row.home.id, f.match_id === awayFav ? ah : row.home.id);
  }
  const fav = out.data.find(r => r.match_id === awayFav);
  const stored = pks.find(p => p.match_id === awayFav);
  assert.ok(stored, 'the strong away side is an Official Pick');
  assert.equal(stored.selection, 'away');
  assert.equal(fav.official_pick.selection, 'away', 'never relabelled HOME');
  assert.equal(fav.official_pick.market, '1x2'); assert.equal(fav.official_pick.selection_label, 'Team 0 to win');
  assert.equal(fav.official_pick.record_no, 1); assert.equal(fav.official_pick.status, 'pending');
  assert.equal(fav.official_pick.model_probability, r4(stored.model_probability));
  assert.ok(fav.forecast.probabilities.away_win > fav.forecast.probabilities.home_win);
  // a forecast with no qualifying pick exposes official_pick: null (forecast still served)
  const noPick = out.data.filter(r => !pks.some(p => p.match_id === r.match_id));
  assert.ok(noPick.length >= 1 && noPick.every(r => r.official_pick === null && r.forecast.probabilities.home_win !== null));
  assert.ok(out.data.some(r => r.match_id === plain));
  // lineups: Bundesliga's only lineup provider is SHADOW -> pregame UNAVAILABLE, never confirmed
  for (const r of out.data) assert.deepEqual([r.lineups.state, r.lineups.reason, r.lineups.source_rights], ['UNAVAILABLE', 'NO_RIGHTS_CLEARED_PREGAME_SOURCE', 'shadow_only']);
  assert.match(out.meta.semantics, /never recomputed/);
  // game_best (A1): additive model clock + identity
  const p = await A.picks(store, now);
  for (const g of p.data.game_best) {
    const f = fcs.find(x => x.match_id === g.match_id);
    assert.equal(g.input_as_of, iso(f.input_as_of)); assert.equal(g.algo_version, 'soccer-algo-v1.0.0'); assert.equal(g.model_hash, f.model_hash); assert.equal(g.spec_hash, f.spec_hash);
  }
  // nothing frozen moved
  const { rows: fcs2 } = await store.query('select * from soccer_algo_forecasts order by kickoff_at');
  const { rows: pks2 } = await store.query('select * from soccer_algo_picks');
  assert.equal(JSON.stringify([fcs2, pks2]), before);
  // window bounds: [from, to] by kickoff; 21-day cap; validation
  const only = await A.forecasts(store, { from: iso(now + 2 * DAY - 60e3), to: iso(now + 2 * DAY + 60e3) }, now);
  assert.deepEqual(only.data.map(r => r.match_id), [awayFav]);
  assert.equal((await A.forecasts(store, { from: iso(now + 5 * DAY), to: iso(now + 6 * DAY) }, now)).data.length, 0);
  assert.equal((await A.forecasts(store, {}, now)).data.length, fcs.length, 'default window now-2d .. now+8d');
  await assert.rejects(A.forecasts(store, { from: iso(now), to: iso(now + 22 * DAY) }, now), e => e.status === 400);
  await assert.rejects(A.forecasts(store, { from: iso(now + DAY), to: iso(now) }, now), e => e.status === 400);
  await assert.rejects(A.forecasts(store, { from: 'yesterday' }, now), e => e.status === 400);
  assert.deepEqual(A.FORECASTS_QUERY, ['from', 'to']);
  await store.close();
});

test('lineup readiness route: stored rows decide CONFIRMED / PARTIAL / POST_KICKOFF_RECORD / UNAVAILABLE; read-only', async () => {
  const now = Date.now();
  const store = await openPglite(); await applyMigrations(store);
  await store.query(`insert into soccer_competitions (id, slug, name, comp_type) values ($1,'bundesliga','Bundesliga','league')`, [COMP]);
  await store.query(`insert into soccer_seasons (id, competition_id, label, publication_state, published_at) values ($1,$2,'2026/27','published',now())`, [S26, COMP]);
  await store.query(`insert into soccer_stages (id, season_id, name, stage_type) values ($1,$2,'Regular Season','league')`, [L26, S26]);
  for (const t of [0, 1]) await store.query(`insert into soccer_teams (id, slug, name, team_type, founding_provider, founding_external_id) values ($1,$2,$3,'club','test',$4)`, [TEAMS[t], `team-${t}`, `Team ${t}`, String(t)]);
  for (let i = 0; i < 40; i++) await store.query(`insert into soccer_players (id, slug, display_name, founding_provider, founding_external_id) values ($1,$2,$3,'test',$4)`, [uuid(9000 + i), `p-${i}`, `P ${i}`, String(i)]);
  let cap = 0;
  const lineup = async (matchId, team, starters, bench, capturedAt) => {
    const capId = (++cap).toString(16).padStart(24, '0');
    await store.query(`insert into soccer_source_captures (capture_id, source_key, family, request_url, captured_at, http_status, content_sha256, bytes, raw_key) values ($1,'espn_core','espn','https://example.invalid/x',$2,200,$3,1,'k')`, [capId, iso(capturedAt), 'a'.repeat(64)]);
    const lid = uuid(20000 + cap);
    await store.query(`insert into soccer_lineups (id, match_id, team_id, provider, capture_id) values ($1,$2,$3,'espn',$4)`, [lid, matchId, TEAMS[team], capId]);
    const base = team * 20;
    for (let i = 0; i < starters + bench; i++) await store.query(`insert into soccer_lineup_players (lineup_id, player_id, is_starter) values ($1,$2,$3)`, [lid, uuid(9000 + base + i), i < starters]);
  };
  const ko = now + 30 * 60e3;
  const full = await match(store, { t: ko, h: TEAMS[0], a: TEAMS[1] }); await lineup(full, 0, 11, 9, ko - 50 * 60e3); await lineup(full, 1, 11, 7, ko - 45 * 60e3);
  const ten = await match(store, { t: ko, h: TEAMS[1], a: TEAMS[0] }); await lineup(ten, 1, 10, 9, ko - 50 * 60e3); await lineup(ten, 0, 11, 7, ko - 45 * 60e3);
  const pastKo = now - 3 * 3600e3;
  const post = await match(store, { t: pastKo, h: TEAMS[0], a: TEAMS[1], status: 'finished', hs: 1, as: 2 }); await lineup(post, 0, 11, 9, pastKo + 120 * 60e3); await lineup(post, 1, 11, 9, pastKo + 120 * 60e3);
  const none = await match(store, { t: ko + 7 * DAY, h: TEAMS[0], a: TEAMS[1] });
  const { proxy, calls } = readOnly(store);
  const get = async (id, registry) => (await lineupReadiness(proxy, id, { now, registry })).data;

  // rights-cleared (public) competition
  const c = await get(full, PUBLIC_BL);
  assert.equal(c.state, 'CONFIRMED'); assert.equal(c.reason, null); assert.equal(c.source_rights, 'pregame_public');
  assert.deepEqual([c.sides.home.starters, c.sides.home.bench, c.sides.away.starters, c.sides.away.bench], [11, 9, 11, 7]);
  assert.equal(c.sides.home.captured_at, iso(ko - 50 * 60e3)); assert.equal(c.sides.home.team_id, TEAMS[0]); assert.equal(c.kickoff_at, iso(ko));
  assert.ok(!JSON.stringify(c).includes('P 1'), 'counts only, no player names');
  const p = await get(ten, PUBLIC_BL);
  assert.deepEqual([p.state, p.reason, p.sides.home.starters], ['PARTIAL', 'PARTIAL_XI', 10]);
  const k = await get(post, PUBLIC_BL);
  assert.deepEqual([k.state, k.reason, k.sides.away.starters], ['POST_KICKOFF_RECORD', null, 11]);
  const n = await get(none, PUBLIC_BL);
  assert.deepEqual([n.state, n.reason, n.sides], ['UNAVAILABLE', 'NOT_YET_PUBLISHED', { home: null, away: null }]);

  // the real registry: Bundesliga's ESPN enrichment is SHADOW -> nothing pregame is ever surfaced
  const s = await get(full);
  assert.deepEqual([s.state, s.reason, s.source_rights, s.sides], ['UNAVAILABLE', 'NO_RIGHTS_CLEARED_PREGAME_SOURCE', 'shadow_only', { home: null, away: null }]);
  assert.deepEqual([(await get(none)).state, (await get(none)).reason], ['UNAVAILABLE', 'NO_RIGHTS_CLEARED_PREGAME_SOURCE']);
  // post-kickoff records stay records (already public on /v1/matches/:id), never presented as pregame
  assert.equal((await get(post)).state, 'POST_KICKOFF_RECORD');
  assert.ok(calls.every(([m]) => m === 'select'));
  await assert.rejects(lineupReadiness(store, uuid(99999), { now }), e => e.status === 404);

  // provider error (rights-cleared competition, lineup component failed)
  await store.query(`insert into soccer_match_enrichment (match_id, component, provider, status) values ($1,'lineup_home','espn','unavailable')`, [none]);
  assert.equal((await get(none, PUBLIC_BL)).reason, 'PROVIDER_ERROR');
  // batch form equals the single route
  const [m] = (await store.query('select * from soccer_matches where id = $1', [full])).rows;
  const batch = await readinessFor(store, [m], { now, registry: PUBLIC_BL, slugByCompetition: new Map([[COMP, 'bundesliga']]) });
  assert.equal(batch.get(full).state, 'CONFIRMED');
  await store.close();
});

test('lineup rules (pure): registry rights, captured-at-kickoff is not pregame, 11+10 is partial', () => {
  assert.equal(lineupRights('bundesliga').source_rights, 'shadow_only');
  assert.equal(lineupRights('premier-league').source_rights, 'none');
  assert.equal(lineupRights('bundesliga', PUBLIC_BL).source_rights, 'pregame_public');
  const ko = Date.parse('2026-10-10T13:30:00Z');
  const match = { kickoff_at: iso(ko), home_team_id: 'h', away_team_id: 'a' };
  const players = n => Array.from({ length: n }, () => ({ lineup_id: 'L', is_starter: true }));
  const L = (id, team, cap) => ({ id, team_id: team, provider: 'espn', capture_id: cap });
  const P = [...players(11).map(p => ({ ...p, lineup_id: 'H' })), ...players(11).map(p => ({ ...p, lineup_id: 'A' }))];
  const atKo = decideReadiness({ match, slug: 'bundesliga', registry: PUBLIC_BL, lineups: [L('H', 'h', 'c1'), L('A', 'a', 'c2')], players: P, captures: new Map([['c1', iso(ko)], ['c2', iso(ko - 1)]]), now: ko + 60e3 });
  assert.equal(atKo.state, 'PARTIAL', 'a capture AT kickoff is not before kickoff');
  const pre = decideReadiness({ match, slug: 'bundesliga', registry: PUBLIC_BL, lineups: [L('H', 'h', 'c1'), L('A', 'a', 'c2')], players: P, captures: new Map([['c1', iso(ko - 1)], ['c2', iso(ko - 1)]]), now: ko - 30e3 });
  assert.equal(pre.state, 'CONFIRMED'); assert.equal(pre.sides.home.provider, 'PropSports');
  const shadowPre = decideReadiness({ match, slug: 'bundesliga', lineups: [L('H', 'h', 'c1'), L('A', 'a', 'c2')], players: P, captures: new Map([['c1', iso(ko - 1)], ['c2', iso(ko - 1)]]), now: ko - 30e3 });
  assert.deepEqual([shadowPre.state, shadowPre.reason, shadowPre.sides.home], ['UNAVAILABLE', 'NO_RIGHTS_CLEARED_PREGAME_SOURCE', null]);
  assert.match(shadowPre.note, /rights/); assert.doesNotMatch(JSON.stringify(shadowPre), /ESPN/);
});
