// Soccer Algo V2 (International): spec generated from committed evidence only; one pick per match from the markets
// the holdout activated; Game Best for every forecast; V1 untouched; research identity rule on inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { runAlgoV2, v2Decide, ALGO_V2_SPEC as spec } from '../workers/soccer-ingest/src/algo-v2-lane.js';
import v1 from '../workers/soccer-ingest/src/algo-v1.json' with { type: 'json' };

test('V2 spec is regenerated exactly from the committed research; V1 spec unchanged', () => {
  execFileSync(process.execPath, ['scripts/algo/build-v2-spec.mjs', '--check'], { stdio: 'pipe' });
  assert.equal(spec.algo_version, 'soccer-algo-v2.0.0'); assert.notEqual(spec.algo_version, v1.algo_version);
  assert.deepEqual(Object.keys(spec.pick_policy.markets), ['away_to_score']);
  assert.equal(spec.status, 'official');
  assert.deepEqual(spec.competition_scope, { competition_slug: 'uefa-nations-league', stage_type: 'league' });
  assert.equal(v1.competition_scope.competition_slug, 'bundesliga'); // V1 scope never widened
  assert.equal(v1.spec_hash, '3156f6f9e3f217fbdd8732363a89ff289d831b695de3be5583691d8966bbc1e6');
});

test('decide: only the active market can be official; a 1X2 Game Best never is', () => {
  const p = (h, d, a, ats) => ({ '1x2': { home: h, draw: d, away: a }, over_2_5: 0.5, home_to_score: 0.7, away_to_score: ats, btts: 0.5 });
  const x = v2Decide(p(0.2, 0.2, 0.6, 0.86));
  assert.equal(x.official.market, 'away_to_score'); assert.equal(x.official.selection, 'yes');
  const y = v2Decide(p(0.9, 0.07, 0.03, 0.4)); // strong home favourite: Game Best 1X2 home, never official
  assert.equal(y.game_best.market, '1x2'); assert.equal(y.game_best.qualifies, false); assert.equal(y.official, null);
});

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
test('lane: V2 forecasts + away-to-score Official Picks only for UNL league matches; flagged teams excluded; V1 rows untouched', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const now = Date.now();
  await store.insert('soccer_competitions', [{ id: U(1), slug: 'uefa-nations-league', name: 'UNL', comp_type: 'international_tournament' }, { id: U(2), slug: 'fifa-world-cup', name: 'WC', comp_type: 'international_tournament' }]);
  await store.insert('soccer_seasons', [{ id: U(3), competition_id: U(1), label: '2026/27' }, { id: U(4), competition_id: U(2), label: '2026' }]);
  await store.insert('soccer_stages', [{ id: U(5), season_id: U(3), name: 'League phase', stage_type: 'league', stage_order: 1 }, { id: U(6), season_id: U(3), name: 'Knockouts', stage_type: 'playoff', stage_order: 2 }, { id: U(7), season_id: U(4), name: 'Group stage', stage_type: 'league', stage_order: 1 }]);
  const teams = Array.from({ length: 8 }, (_, i) => ({ id: U(10 + i), slug: `n${i}`, name: `Nation ${i}`, team_type: 'national', founding_provider: 'espn', founding_external_id: String(900 + i) }));
  await store.insert('soccer_teams', teams);
  await store.insert('soccer_team_external_ids', teams.map((t, i) => ({ provider: 'espn', external_id: String(900 + i), team_id: t.id, method: 'founding', evidence: i === 7 ? 'espn team id; national team by competition contract (fifa-world-cup admits national teams only); provider record says isNational=false (provider inconsistency recorded, not used)' : 'espn team id' })));
  const rows = []; let n = 100;
  // 120 finished UNL league matches (3 past seasons x 40 distinct ordered pairs of 7 nations): nation 0 scores freely
  const pairs = []; for (let h = 0; h < 7; h++) for (let a = 0; a < 7; a++) if (h !== a) pairs.push([h, a]);
  await store.insert('soccer_seasons', [0, 1, 2].map(s => ({ id: U(60 + s), competition_id: U(1), label: `202${s}/2${s + 1}` })));
  await store.insert('soccer_stages', [0, 1, 2].map(s => ({ id: U(70 + s), season_id: U(60 + s), name: 'League phase', stage_type: 'league', stage_order: 1 })));
  for (let k = 0; k < 120; k++) { const [h, a] = pairs[k % 40]; const s = Math.floor(k / 40); rows.push({ id: U(n++), competition_id: U(1), season_id: U(60 + s), stage_id: U(70 + s), kickoff_at: new Date(now - (720 - k * 5) * 864e5).toISOString(), home_team_id: U(10 + h), away_team_id: U(10 + a), status: 'finished', home_score: h === 0 ? 3 : 1, away_score: a === 0 ? 3 : h === 1 ? 2 : 1, result_provider: 'espn' }); }
  const flaggedMatch = { id: U(n++), competition_id: U(2), season_id: U(4), stage_id: U(7), kickoff_at: new Date(now - 30 * 864e5).toISOString(), home_team_id: U(17), away_team_id: U(10), status: 'finished', home_score: 0, away_score: 9, result_provider: 'espn' };
  const target = { id: U(n++), competition_id: U(1), season_id: U(3), stage_id: U(5), kickoff_at: new Date(now + 3 * 864e5).toISOString(), home_team_id: U(11), away_team_id: U(10), status: 'scheduled', home_score: null, away_score: null, result_provider: 'espn' };
  const knockout = { ...target, id: U(n++), stage_id: U(6), home_team_id: U(12), away_team_id: U(13) };
  await store.insert('soccer_matches', [...rows, flaggedMatch, target, knockout]);
  const kv = new Map(); const KV = { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => { kv.set(k, v); } };
  assert.deepEqual(await runAlgoV2({ store, now, env: {}, kv: KV }), { skipped: 'algo_v2_off' });
  const out = await runAlgoV2({ store, now, env: { ALGO_V2: 'on' }, kv: KV, force: true });
  assert.equal(out.results.forecasts, 1, JSON.stringify(out.results)); // league match only, never the knockout
  assert.equal(out.results.input_count, 120, 'the match with an isNational=false side is not an input');
  const [f] = await store.select('soccer_algo_forecasts', { columns: ['algo_version', 'match_id', 'game_best'] });
  assert.equal(f.algo_version, 'soccer-algo-v2.0.0'); assert.equal(f.match_id, target.id);
  const picks = await store.select('soccer_algo_picks', { columns: ['algo_version', 'market', 'selection', 'model_probability'] });
  for (const p of picks) { assert.equal(p.algo_version, 'soccer-algo-v2.0.0'); assert.equal(p.market, 'away_to_score'); assert.ok(p.model_probability >= 0.8); }
  assert.equal((await store.select('soccer_algo_events', { columns: ['algo_version'], eq: { algo_version: v1.algo_version } })).length, 0, 'V1 ledger untouched');
  // idempotent: a second run issues nothing new (one forecast per match, immutable)
  const again = await runAlgoV2({ store, now: now + 3600e3, env: { ALGO_V2: 'on' }, kv: KV, force: true });
  assert.equal(again.results.forecasts, 0);
  await store.close();
});

test('V2 research summary for the API is the generated file', () => {
  const r = JSON.parse(readFileSync('workers/soccer-api/src/algo-v2-research.json', 'utf8'));
  assert.equal(r.status, 'official'); assert.ok(r.disclaimer.includes('Not a track record'));
  assert.deepEqual(r.markets.filter(m => m.active).map(m => m.market), ['away_to_score']);
});
