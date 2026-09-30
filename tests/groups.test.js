// Generic tournament groups (UEFA Nations League A1..D2 now; World Cup / EURO groups later):
// source group codes -> tier parent, tier-scoped zone notes, and a table API that never ranks
// across groups and withholds only the group that does not verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupKey, parentFromCode, scopedNote } from '../workers/soccer-ingest/src/espn-standings.js';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import * as R from '../workers/soccer-api/src/routes.js';
import { teamHistory } from '../workers/soccer-api/src/history.js';

test('group keys, tier parents from the source code, tier-scoped notes', () => {
  assert.equal(groupKey({ abbreviation: 'Group A1' }, 'group'), 'a1');
  assert.equal(groupKey({ abbreviation: 'Group D2' }, 'group'), 'd2');
  assert.equal(groupKey({ name: 'Eastern Conference' }, 'conference'), 'eastern'); // unchanged for MLS
  assert.equal(groupKey({ name: 'League Phase' }, 'league_phase'), 'league-phase'); // unchanged for UCL
  assert.deepEqual(parentFromCode({ abbreviation: 'Group B3' }, 'League'), { key: 'league-b', name: 'League B', letter: 'B', order: 6603 });
  assert.equal(parentFromCode({ abbreviation: 'Group B3' }, null), null); // only when the registry asks for it
  assert.equal(parentFromCode({ name: 'Eastern Conference' }, 'League'), null); // never from free text
  // ESPN's combined note on A1 (docs/evidence/espn/uefa-nations-discovery-2026-09-29.json)
  assert.equal(scopedNote('A: Qualifies for QFs; B-D: Promotion playoffs', 'A'), 'Qualifies for QFs');
  assert.equal(scopedNote('A: Qualifies for QFs; B-D: Promotion playoffs', 'C'), 'Promotion playoffs');
  assert.equal(scopedNote('A, B: Relegation; C: Relegation or playoffs', 'B'), 'Relegation');
  assert.equal(scopedNote('A, B: Relegation playoffs', 'D'), null); // never borrowed from another tier
  assert.equal(scopedNote('Qualifies for round of 16', 'A'), 'Qualifies for round of 16'); // unscoped note unchanged
  assert.equal(scopedNote(null, 'A'), null);
});

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;

async function seed() {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: U(1), slug: 'uefa-nations-league', name: 'UEFA Nations League', comp_type: 'international_tournament' }]);
  await store.insert('soccer_seasons', [{ id: U(2), competition_id: U(1), label: '2026/27' }]);
  await store.insert('soccer_stages', [{ id: U(3), season_id: U(2), name: 'League phase', stage_type: 'league', stage_order: 1 }]);
  const teams = ['France', 'Italy', 'Belgium', 'Israel', 'Malta', 'Andorra'].map((name, i) => ({ id: U(10 + i), slug: name.toLowerCase(), name, team_type: 'national', founding_provider: 'espn', founding_external_id: String(100 + i) }));
  await store.insert('soccer_teams', teams);
  const m = (n, h, a, hs, as) => ({ id: U(100 + n), competition_id: U(1), season_id: U(2), stage_id: U(3), kickoff_at: `2026-09-0${n}T18:45:00Z`, home_team_id: U(h), away_team_id: U(a), status: 'finished', home_score: hs, away_score: as, result_provider: 'espn' });
  // A1: France 2-0 Italy, Belgium 1-1 Israel. D1: Malta 1-0 Andorra.
  await store.insert('soccer_matches', [m(1, 10, 11, 2, 0), m(2, 12, 13, 1, 1), m(3, 14, 15, 1, 0)]);
  const g = (id, key, name, tier, order) => ({ id: U(id), season_id: U(2), group_key: key, name, abbreviation: name, group_type: 'group', provider: 'espn', external_id: key, parent_group_key: `league-${tier}`, parent_name: `League ${tier.toUpperCase()}`, sort_order: order });
  await store.insert('soccer_season_groups', [g(50, 'a1', 'Group A1', 'a', 6501), g(51, 'd1', 'Group D1', 'd', 6801)]);
  const row = (gid, tid, rank, p, w, d, l, gf, ga, pts, note = null) => ({ group_id: U(gid), team_id: U(tid), provider: 'espn', rank, played: p, won: w, drawn: d, lost: l, goals_for: gf, goals_against: ga, goal_difference: gf - ga, points: pts, note, observed_at: '2026-09-09T00:00:00Z' });
  await store.insert('soccer_season_group_members', [10, 11, 12, 13].map(t => ({ group_id: U(50), team_id: U(t), provider: 'espn' })).concat([14, 15].map(t => ({ group_id: U(51), team_id: U(t), provider: 'espn' }))));
  await store.insert('soccer_source_standings', [
    row(50, 10, 1, 1, 1, 0, 0, 2, 0, 3, 'Qualifies for QFs'), row(50, 12, 2, 1, 0, 1, 0, 1, 1, 1), row(50, 13, 3, 1, 0, 1, 0, 1, 1, 1), row(50, 11, 4, 1, 0, 0, 1, 0, 2, 0, 'Relegation'),
    // D1 provider row disagrees with our canonical result (Malta 1 goal, provider says 2): D1 alone is withheld
    row(51, 14, 1, 1, 1, 0, 0, 2, 0, 3), row(51, 15, 2, 1, 0, 0, 1, 0, 2, 0),
  ]);
  return store;
}

test('grouped tournament table: no overall ranking, per-group verification, tiers kept', async () => {
  const store = await seed();
  const idx = await R.table(store, { competition: 'uefa-nations-league', expand: 'groups' });
  assert.equal(idx.data.view, 'groups');
  assert.deepEqual(idx.data.rows, []); // never a 6-team (or 54-team) overall table
  assert.deepEqual(idx.data.tiers.map(t => [t.key, t.name, t.groups]), [['league-a', 'League A', ['a1']], ['league-d', 'League D', ['d1']]]);
  assert.deepEqual(idx.data.groups.map(g => [g.key, g.verified, g.parent?.name]), [['a1', true, 'League A'], ['d1', false, 'League D']]);
  assert.equal(idx.data.groups[0].rows.length, 4);
  assert.deepEqual(idx.data.groups[1].rows, []);
  assert.equal(idx.meta.coverage.state, 'partial');
  const a1 = await R.table(store, { competition: 'uefa-nations-league', group: 'A1' }); // case-insensitive key
  assert.deepEqual(a1.data.rows.map(r => [r.position, r.team.name, r.points, r.zone?.label || null]), [[1, 'France', 3, 'Qualifies for QFs'], [2, 'Belgium', 1, null], [3, 'Israel', 1, null], [4, 'Italy', 0, 'Relegation']]);
  assert.equal(a1.data.rows[0].team.type, 'national');
  assert.deepEqual(a1.data.group.parent, { key: 'league-a', name: 'League A' });
  const d1 = await R.table(store, { competition: 'uefa-nations-league', group: 'd1' });
  assert.equal(d1.data.verification.verified, false);
  assert.deepEqual(d1.data.rows, []);
  // team page: position is the verified GROUP position, never a rank across groups
  const fr = await R.team(store, 'france');
  assert.deepEqual([fr.data.type, fr.data.records[0].position, fr.data.records[0].teams_in_table, fr.data.records[0].group.key], ['national', 1, 4, 'a1']);
  const mt = await R.team(store, 'malta');
  assert.deepEqual([mt.data.records[0].position, mt.data.records[0].group.key, mt.data.records[0].record.points], [null, 'd1', 3]); // D1 withheld -> no position, record still true
  const comp = await R.competition(store, 'uefa-nations-league');
  assert.equal(comp.data.current.team_kind, 'national');
  const history = await teamHistory(store, 'france');
  assert.equal(history.data.seasons[0].table_finish, null);
  assert.equal(history.data.seasons[0].group_position.group, 'a1');
  assert.equal(history.data.seasons[0].group_position.position, 1);
  const held = await teamHistory(store, 'malta'); assert.equal(held.data.seasons[0].group_position, null);
});
