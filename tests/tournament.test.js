// Tournament API (World Cup shape): per-type knockout stages, knockout results decided after extra time or on
// penalties, bracket edges only where proven from canonical results, completed state, and group tables withheld
// when a group-stage fixture does not reconcile with the group's membership.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import * as R from '../workers/soccer-api/src/routes.js';
import { provenBracket } from '../workers/shared/bracket.js';

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
const SLUG = 'fifa-world-cup';

async function seed({ crossing = false } = {}) {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: U(1), slug: SLUG, name: 'FIFA World Cup', comp_type: 'international_tournament' }]);
  await store.insert('soccer_seasons', [{ id: U(2), competition_id: U(1), label: '2026' }]);
  await store.insert('soccer_stages', [
    { id: U(3), season_id: U(2), name: 'Group stage', stage_type: 'league', stage_order: 1 },
    { id: U(4), season_id: U(2), name: 'Semifinals', stage_type: 'knockout', stage_order: 2 },
    { id: U(5), season_id: U(2), name: '3rd-Place Match', stage_type: 'knockout', stage_order: 3 },
    { id: U(6), season_id: U(2), name: 'Final', stage_type: 'knockout', stage_order: 4 },
  ]);
  const names = ['Argentina', 'France', 'Spain', 'Brazil'];
  await store.insert('soccer_teams', names.map((name, i) => ({ id: U(10 + i), slug: name.toLowerCase(), name, team_type: 'national', founding_provider: 'espn', founding_external_id: String(200 + i) })));
  const m = (n, stage, day, h, a, hs, as, extra = {}) => ({ id: U(100 + n), competition_id: U(1), season_id: U(2), stage_id: U(stage), kickoff_at: `2026-07-${day}T19:00:00Z`, home_team_id: U(h), away_team_id: U(a), status: 'finished', home_score: hs, away_score: as, duration: 'regular', home_pens: null, away_pens: null, winner_team_id: hs > as ? U(h) : hs < as ? U(a) : null, result_provider: 'espn', ...extra });
  await store.insert('soccer_matches', [
    // group stage: A = Argentina, France; B = Spain, Brazil (crossing: Argentina v Spain filed in the group stage)
    m(1, 3, '01', 10, 11, 1, 1), m(2, 3, '02', 12, 13, 2, 0), ...(crossing ? [m(9, 3, '03', 10, 12, 0, 1)] : []),
    // semis: Argentina beat France on penalties; Spain beat Brazil after extra time
    m(3, 4, '14', 10, 11, 0, 0, { duration: 'penalties', home_pens: 4, away_pens: 3, winner_team_id: U(10) }),
    m(4, 4, '15', 12, 13, 2, 1, { duration: 'extra_time' }),
    m(5, 5, '18', 11, 13, 1, 0), // third place: the two semi-final losers
    m(6, 6, '19', 10, 12, 2, 1), // final: the two semi-final winners
  ]);
  const g = (id, key) => ({ id: U(id), season_id: U(2), group_key: key, name: `Group ${key.toUpperCase()}`, abbreviation: `Group ${key.toUpperCase()}`, group_type: 'group', provider: 'espn', external_id: key, sort_order: id });
  await store.insert('soccer_season_groups', [g(50, 'a'), g(51, 'b')]);
  await store.insert('soccer_season_group_members', [[50, 10], [50, 11], [51, 12], [51, 13]].map(([gid, t]) => ({ group_id: U(gid), team_id: U(t), provider: 'espn' })));
  const row = (gid, tid, rank, w, d, l, gf, ga, pts) => ({ group_id: U(gid), team_id: U(tid), provider: 'espn', rank, played: w + d + l, won: w, drawn: d, lost: l, goals_for: gf, goals_against: ga, goal_difference: gf - ga, points: pts, observed_at: '2026-07-01T00:00:00Z' });
  const argentina = crossing ? row(50, 10, 1, 0, 1, 1, 1, 2, 1) : row(50, 10, 1, 0, 1, 0, 1, 1, 1);
  const spain = crossing ? row(51, 12, 1, 2, 0, 0, 3, 0, 6) : row(51, 12, 1, 1, 0, 0, 2, 0, 3);
  await store.insert('soccer_source_standings', [argentina, row(50, 11, 2, 0, 1, 0, 1, 1, 1), spain, row(51, 13, 2, 0, 0, 1, 0, 2, 0)]);
  return store;
}

test('competition: stages with counts, completed state, bracket proven from results (winners + third-place losers)', async () => {
  const store = await seed();
  const c = await R.competition(store, SLUG, {}, Date.parse('2026-09-30T00:00:00Z'));
  const cur = c.data.current;
  assert.equal(cur.state, 'completed');
  assert.deepEqual(cur.stages.map(s => [s.key, s.type, s.matches]), [['group-stage', 'league', 2], ['semifinals', 'knockout', 2], ['3rd-place-match', 'knockout', 1], ['final', 'knockout', 1]]);
  assert.equal(cur.bracket.proven, true);
  assert.deepEqual(cur.bracket.edges.map(e => [e.from, e.to, e.via]).sort(), [[U(103), U(105), 'loser'], [U(103), U(106), 'winner'], [U(104), U(105), 'loser'], [U(104), U(106), 'winner']].sort());
  assert.equal(cur.team_kind, 'national');
  assert.equal(cur.coverage.results, 6); assert.equal(cur.coverage.finished, 6);
  await store.close();
});

test('matches: stage filter, stage on every row, penalties / extra time only where stored', async () => {
  const store = await seed();
  const semis = await R.matches(store, { competition: SLUG, stage: 'semifinals', order: 'asc' });
  assert.equal(semis.data.length, 2);
  assert.ok(semis.data.every(m => m.stage.key === 'semifinals' && m.stage.type === 'knockout'));
  const [pens, aet] = semis.data;
  assert.deepEqual(pens.score, { home: 0, away: 0, home_ht: null, away_ht: null, after: 'penalties', pens: { home: 4, away: 3 }, winner: 'home' });
  assert.equal(aet.score.after, 'extra_time'); assert.equal(aet.score.pens, undefined);
  const final = (await R.matches(store, { competition: SLUG, stage: 'final' })).data[0];
  assert.equal(final.score.after, undefined); // a regular-time result carries no knockout detail
  await assert.rejects(() => R.matches(store, { competition: SLUG, stage: 'round-of-64' }), /stage/);
  const one = await R.match(store, U(103));
  assert.equal(one.data.stage.name, 'Semifinals'); assert.equal(one.data.score.pens.home, 4);
  await store.close();
});

test('bracket: an unproven feeder (no stored winner) draws no edge for that match', () => {
  const stages = [{ id: 's', stage_order: 1 }, { id: 'f', stage_order: 2 }];
  const ms = [
    { id: 'a', stage_id: 's', kickoff_at: '2026-07-01T00:00Z', status: 'finished', home_team_id: 1, away_team_id: 2, winner_team_id: null },
    { id: 'b', stage_id: 's', kickoff_at: '2026-07-02T00:00Z', status: 'finished', home_team_id: 3, away_team_id: 4, winner_team_id: 3 },
    { id: 'c', stage_id: 'f', kickoff_at: '2026-07-05T00:00Z', status: 'finished', home_team_id: 1, away_team_id: 3, winner_team_id: 1 },
  ];
  const b = provenBracket(stages, ms);
  assert.equal(b.proven, false); assert.equal(b.edges.length, 0); assert.equal(b.unproven.length, 1);
});

test('groups: every table verified; a group-stage fixture that crosses groups withholds both groups (no guessing)', async () => {
  const ok = await seed();
  const idx = await R.table(ok, { competition: SLUG, expand: 'groups' });
  assert.deepEqual(idx.data.groups.map(g => [g.key, g.verified]), [['a', true], ['b', true]]);
  assert.deepEqual(idx.data.rows, []); // no overall table across groups
  await ok.close();
  const bad = await seed({ crossing: true });
  const idx2 = await R.table(bad, { competition: SLUG, expand: 'groups' });
  assert.deepEqual(idx2.data.groups.map(g => [g.key, g.verified]), [['a', false], ['b', false]]);
  assert.match(idx2.data.groups[0].withheld_reason, /do not reconcile/);
  const one = await R.table(bad, { competition: SLUG, group: 'a' });
  assert.equal(one.data.verification.verified, false); assert.deepEqual(one.data.rows, []);
  await bad.close();
});
