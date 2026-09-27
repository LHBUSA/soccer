import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite, syncRows } from '../workers/soccer-ingest/src/store.js';
import { resolveAthletes } from '../workers/soccer-ingest/src/espn-lane.js';
import { corroborate } from '../workers/soccer-ingest/src/corroborate.js';
import { childId, mintId } from '../workers/shared/ids.js';

const REGISTRY = { competitions: [{ slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1, season_format: 'split', espn: { league: 'ger.1', id: '720' }, external_ids: [{ provider: 'wyscout', external_id: '426', method: 'founding', evidence: 't' }] }] };
const AREAS = { areas: { DEU: 'Germany', POL: 'Poland' }, aliases: {} };
const COMP = mintId('competition', 'wyscout', '426');
const S17 = mintId('season', 'wyscout', '181137');
const TA = mintId('team', 'wyscout', '1'); const TB = mintId('team', 'wyscout', '2');

async function world({ extraSameName = false, lineup = true } = {}) {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: COMP, slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1 }]);
  await store.insert('soccer_seasons', [{ id: S17, competition_id: COMP, label: '2017/18', start_date: null, end_date: null }]);
  await store.insert('soccer_teams', [TA, TB].map((id, i) => ({ id, slug: `t${i}`, name: `Team ${i}`, team_type: 'club', gender: 'men', founding_provider: 'wyscout', founding_external_id: String(i + 1) })));
  await store.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: '132', team_id: TA, method: 'fixture_graph', evidence: 't', capture_id: null }, { provider: 'espn', external_id: '134', team_id: TB, method: 'fixture_graph', evidence: 't', capture_id: null }]);
  const P1 = mintId('player', 'wyscout', '10');
  const players = [{ id: P1, slug: 'manuel-neuer', display_name: 'Manuel Neuer', first_name: 'Manuel', last_name: 'Neuer', birth_date: '1986-03-27', nationality_code: 'DEU', founding_provider: 'wyscout', founding_external_id: '10' }];
  if (extraSameName) players.push({ ...players[0], id: mintId('player', 'wyscout', '11'), slug: 'manuel-neuer-2', founding_external_id: '11' });
  await store.insert('soccer_players', players);
  if (lineup) {
    const M = mintId('match', 'wyscout', '900');
    await store.insert('soccer_matches', [{ id: M, competition_id: COMP, season_id: S17, kickoff_at: '2017-08-18T18:30:00Z', home_team_id: TA, away_team_id: TB, status: 'finished' }]);
    const L = childId('lineup', M, TA);
    await store.insert('soccer_lineups', [{ id: L, match_id: M, team_id: TA, provider: 'wyscout' }]);
    await store.insert('soccer_lineup_players', [{ lineup_id: L, player_id: P1, is_starter: true }]);
  }
  return { store, P1 };
}

// Fake ESPN client: current-season athlete + season-scoped records per year.
function client({ team2017 = '132', dob2017 = '1986-03-27T08:00Z', citizenship = 'Germany' } = {}) {
  const c = { used: 0, budget: 100, pending: [], registry: REGISTRY, areas: AREAS, requests: [] };
  c.get = async url => {
    c.used += 1; c.requests.push(url);
    const base = { id: '84774', displayName: 'Manuel Neuer', firstName: 'Manuel', lastName: 'Neuer', dateOfBirth: '1986-03-27T08:00Z', citizenship, position: { abbreviation: 'G' } };
    const json = url.includes('/seasons/2017/') ? { ...base, dateOfBirth: dob2017, team: team2017 ? { $ref: `http://x/leagues/ger.1/seasons/2017/teams/${team2017}?lang=en` } : undefined } : { ...base, team: { $ref: 'http://x/seasons/2026/teams/132' } };
    return { json, capture: { capture_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', captured_at: '2026-09-27T00:00:00Z' } };
  };
  c.flush = async () => {};
  return c;
}
async function seedCapture(store) {
  await store.insert('soccer_source_captures', [{ capture_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', source_key: 't', family: 'espn', request_url: 'https://t/', captured_at: '2026-09-27T00:00:00Z', http_status: 200, content_sha256: '0'.repeat(64), bytes: 1, raw_key: 'k' }]);
}
const resolve = (store, cl) => resolveAthletes(store, { athleteIds: ['84774'], client: cl, league: 'ger.1', year: 2026, registry: REGISTRY, areas: AREAS });
const queue = async store => store.select('soccer_identity_queue', { columns: ['reason', 'status', 'candidate_ids', 'payload'], eq: { provider: 'espn', external_id: '84774' } });
const xw = async store => store.select('soccer_player_external_ids', { columns: ['player_id', 'method', 'evidence'], eq: { provider: 'espn', external_id: '84774' } });

test('exact name + DOB WITHOUT club corroboration does not merge (no canonical club window)', async () => {
  const { store } = await world({ lineup: false }); await seedCapture(store);
  const r = await resolve(store, client());
  assert.equal(r.corroborated, 0); assert.equal(r.founded, 0);
  const [q] = await queue(store);
  assert.equal(q.reason, 'no_canonical_club_window');
  assert.equal((await xw(store)).length, 0);
  assert.equal(await store.count('soccer_players'), 1); // not duplicated either
  await store.close();
});

test('exact name + DOB without an ESPN club in the overlapping season does not merge', async () => {
  const { store } = await world(); await seedCapture(store);
  await resolve(store, client({ team2017: null }));
  const [q] = await queue(store);
  assert.equal(q.reason, 'no_overlapping_club_corroboration');
  assert.equal(q.payload.evidence.unverifiable_windows[0].why, 'espn_has_no_club_for_athlete_that_season');
  await store.close();
});

test('exact name + DOB + overlapping club + unique candidate DOES merge, with persisted evidence', async () => {
  const { store, P1 } = await world(); await seedCapture(store);
  const cl = client();
  const r = await resolve(store, cl);
  assert.equal(r.corroborated, 1);
  const [x] = await xw(store);
  assert.equal(x.player_id, P1); assert.equal(x.method, 'attribute_corroborated');
  const ev = JSON.parse(x.evidence);
  assert.equal(ev.rule, 'attribute_corroborated/1.0.0');
  assert.deepEqual(ev.corroborating_windows.map(w => [w.season, w.espn_team]), [['2017/18', '132']]);
  assert.ok(cl.requests.some(u => u.includes('/seasons/2017/athletes/84774'))); // season-scoped, not present-day club
  assert.deepEqual(ev.nationality, { espn: 'Germany', canonical: 'Germany', compared: true });
  assert.equal((await queue(store)).length, 0);
  // second run is idempotent: resolves through the crosswalk, no fetch, no writes
  const cl2 = client();
  const r2 = await resolve(store, cl2);
  assert.equal(r2.corroborated, 0); assert.equal(r2.founded, 0); assert.equal(cl2.used, 0);
  assert.equal(r2.map.get('84774'), P1);
  assert.equal((await xw(store)).length, 1);
  assert.equal(await store.count('soccer_source_changes'), 0);
  await store.close();
});

test('two possible canonical candidates remain queued', async () => {
  const { store } = await world({ extraSameName: true }); await seedCapture(store);
  await resolve(store, client());
  const [q] = await queue(store);
  assert.equal(q.reason, 'multiple_canonical_candidates'); assert.equal(q.candidate_ids.length, 2);
  assert.equal((await xw(store)).length, 0);
  await store.close();
});

test('conflicting club evidence remains queued', async () => {
  const { store } = await world(); await seedCapture(store);
  await resolve(store, client({ team2017: '134' }));
  const [q] = await queue(store);
  assert.equal(q.reason, 'contradiction_club');
  assert.equal(q.payload.evidence.contradictions[0].kind, 'club');
  assert.equal((await xw(store)).length, 0);
  await store.close();
});

test('conflicting DOB remains queued (season record and candidate)', async () => {
  const { store, P1 } = await world(); await seedCapture(store);
  await resolve(store, client({ dob2017: '1987-01-01T00:00Z' }));
  const [q] = await queue(store);
  assert.equal(q.reason, 'contradiction_dob_season_record');
  const direct = await corroborate(store, { athlete: { external_id: '1', display_name: 'X', birth_date: '1990-01-01', citizenship: null }, candidates: [{ id: P1, birth_date: '1986-03-27', nationality_code: 'DEU' }], client: client(), registry: REGISTRY, areas: AREAS });
  assert.equal(direct.decision, 'queue'); assert.equal(direct.reason, 'dob_contradiction');
  await store.close();
});

test('conflicting nationality and a second ESPN id on the candidate stay queued', async () => {
  const { store, P1 } = await world(); await seedCapture(store);
  await resolve(store, client({ citizenship: 'Poland' }));
  assert.equal((await queue(store))[0].reason, 'contradiction_nationality');
  const w2 = await world(); await seedCapture(w2.store);
  await w2.store.insert('soccer_player_external_ids', [{ provider: 'espn', external_id: '999', player_id: w2.P1, method: 'founding', evidence: 't', capture_id: null }]);
  await resolve(w2.store, client());
  assert.equal((await queue(w2.store))[0].reason, 'contradiction_provider_id');
  await store.close(); await w2.store.close();
});

test('schema refuses an attribute_corroborated crosswalk without structured evidence', async () => {
  const { store, P1 } = await world();
  await assert.rejects(store.insert('soccer_player_external_ids', [{ provider: 'espn', external_id: '1', player_id: P1, method: 'attribute_corroborated', evidence: 'name matched', capture_id: null }]));
  await assert.rejects(store.insert('soccer_player_external_ids', [{ provider: 'espn', external_id: '2', player_id: P1, method: 'attribute_corroborated', evidence: '{"rule":"x","corroborating_windows":[]}', capture_id: null }]));
  await assert.rejects(store.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: '3', team_id: TA, method: 'attribute_corroborated', evidence: '{}', capture_id: null }])); // teams unchanged
  await store.close();
});
