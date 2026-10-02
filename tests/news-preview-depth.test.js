// PACKET V4 preview depth: every aggregate states what it counts, unreconciled goal records are left out
// of the period split, consequences are provable on points only, angles are deterministic labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { campaignRecord, evidenceDepth, groupConsequences, headToHead, selectAngles, teamDepth, teamMatchView } from '../workers/soccer-news/src/preview-depth.js';

const m = (id, day, h, a, hs, as, extra = {}) => ({ id, kickoff_at: `2026-09-${String(day).padStart(2, '0')}T18:45:00Z`, competition_id: 'unl', season_id: 's', home_team_id: h, away_team_id: a, home_score: hs, away_score: as, status: 'finished', ...extra });
const people = new Map([['p1', { id: 'p1', name: 'Joel Pohjanpalo', slug: 'joel-pohjanpalo' }], ['p2', { id: 'p2', name: 'Leo Walta', slug: 'leo-walta' }]]);

test('period split counts only matches whose goal events reconcile to the score', () => {
  const ok = teamMatchView(m('a', 26, 'FIN', 'SMR', 2, 0), 'FIN', { goals: [{ minute: 5, period: '1H', side: 'home', scorer_id: 'p1' }, { minute: 70, period: '2H', side: 'home', scorer_id: 'p2' }] });
  const bad = teamMatchView(m('b', 29, 'FIN', 'BLR', 3, 0), 'FIN', { goals: [{ minute: 10, period: '1H', side: 'home', scorer_id: 'p1' }] }); // 1 event for 3 goals
  assert.equal(ok.goal_events_reconcile, true); assert.equal(bad.goal_events_reconcile, false); assert.deepEqual(bad.goals, []);
  const d = teamDepth([bad, ok], { people, kickoff: '2026-10-03T13:00:00Z' });
  assert.deepEqual([d.scoring_by_period.matches_counted, d.scoring_by_period.of], [1, 2]);
  assert.deepEqual(d.scoring_by_period.halves.first_half, { for: 1, against: 0 });
  assert.equal(d.record.goals_for, 5, 'the record still counts both scores');
  assert.deepEqual(d.scorers.map(s => [s.player.name, s.goals]), [['Joel Pohjanpalo', 1], ['Leo Walta', 1]]);
  assert.equal(d.rest_days, 3, 'Sep 29 18:45 -> Oct 3 13:00');
});

test('no stats / no lineups / no locations -> those blocks are null, never zero', () => {
  const d = teamDepth([teamMatchView(m('a', 26, 'FIN', 'SMR', 1, 0), 'FIN', {})], { people });
  assert.equal(d.shots, null); assert.equal(d.located_shots, null); assert.deepEqual(d.formations, []); assert.equal(d.starting_xi_continuity, null);
});

test('located shots: inside-box share and average distance are PBE derived and labelled', () => {
  const v = teamMatchView(m('a', 26, 'FIN', 'SMR', 0, 0), 'FIN', { shots: [{ side: 'home', x_m: 94, y_m: 34, outcome: 'on_target' }, { side: 'home', x_m: 75, y_m: 34, outcome: 'off_target' }, { side: 'away', x_m: 90, y_m: 30 }] });
  const d = teamDepth([v], { people });
  assert.deepEqual([d.located_shots.shots, d.located_shots.inside_box, d.located_shots.avg_distance_m], [2, 1, 20.5]);
  assert.match(d.located_shots.basis, /PBE derived/);
});

test('group consequences: only statements true in every outcome combination, points only', () => {
  const table = { ALB: 6, FIN: 4, BLR: 1, SMR: 0 };
  const round = [{ id: 'x', home_team_id: 'FIN', away_team_id: 'ALB' }, { id: 'y', home_team_id: 'BLR', away_team_id: 'SMR' }];
  const c = groupConsequences(table, round, round[0]);
  const s = Object.fromEntries(c.statements.map(x => [`${x.team_id}:${x.statement}`, x]));
  assert.ok(s['ALB:win_guarantees_sole_top_on_points_after_round'], 'Albania win -> 9, nobody else can pass 7');
  assert.ok(s['FIN:win_guarantees_sole_top_on_points_after_round'], 'Finland win -> 7 v Albania 6, Belarus at most 4');
  // a draw-level scenario is never called "top": 3 teams where a win only ties on points
  const tie = groupConsequences({ A: 3, B: 3, C: 6 }, [{ id: 'z', home_team_id: 'A', away_team_id: 'B' }], { id: 'z', home_team_id: 'A', away_team_id: 'B' });
  assert.ok(!tie.statements.some(x => x.statement === 'win_guarantees_sole_top_on_points_after_round'), '6 v 6 is a tie, not top');
  assert.match(c.basis, /tie-breakers never assumed/);
});

test('head-to-head says "in the PropBetEdge record since <year>", never all-time', () => {
  const h = headToHead([m('a', 1, 'FIN', 'ALB', 2, 1), m('b', 2, 'ALB', 'FIN', 0, 0)], 'FIN', 'ALB', { coverageStart: '2024' });
  assert.deepEqual([h.meetings, h.home_wins, h.away_wins, h.draws, h.home_goals, h.away_goals], [2, 1, 0, 1, 2, 1]);
  assert.equal(h.wording, 'in the PropBetEdge record since 2024');
});

test('angles: campaign record decides "perfect start"; ranking is deterministic', () => {
  const depth = { home: { record: { played: 4, won: 1, drawn: 1, lost: 2, goals_for: 7, goals_against: 5, clean_sheets: 2 }, campaign: campaignRecord([m('a', 26, 'FIN', 'SMR', 7, 0), m('b', 29, 'FIN', 'BLR', 0, 0)], 'FIN'), scorers: [], home: { played: 0 }, away: { played: 0 }, shots: null },
    away: { record: { played: 2, won: 2, drawn: 0, lost: 0, goals_for: 5, goals_against: 0, clean_sheets: 2 }, campaign: campaignRecord([m('c', 26, 'ALB', 'BLR', 2, 0), m('d', 29, 'SMR', 'ALB', 0, 3)], 'ALB'), scorers: [], home: { played: 0 }, away: { played: 0 }, shots: null } };
  const groups = { FIN: { verified: true, group: 'Group C1', position: 2 }, ALB: { verified: true, group: 'Group C1', position: 1 } };
  const a = selectAngles(depth, { homeId: 'FIN', awayId: 'ALB', group: groups });
  assert.equal(a[0].key, 'group_leaders_meet');
  assert.ok(a.some(x => x.key === 'perfect_start' && x.detail.team_id === 'ALB' && x.detail.scope === 'campaign'));
  assert.ok(!a.some(x => x.key === 'perfect_start' && x.detail.team_id === 'FIN'));
  assert.deepEqual(selectAngles(depth, { homeId: 'FIN', awayId: 'ALB', group: groups }).map(x => x.key), a.map(x => x.key));
});

test('evidence depth sets the allowance, it never forces length', () => {
  assert.deepEqual(evidenceDepth({ home: {}, away: {} }).word_range, [250, 550]);
  const t = { record: { played: 2 }, scoring_by_period: {}, shots: {}, located_shots: {}, scorers: [1], formations: [1] };
  assert.deepEqual(evidenceDepth({ home: t, away: t }).word_range, [500, 850]);
});
