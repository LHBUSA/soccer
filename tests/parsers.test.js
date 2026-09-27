import test from 'node:test';
import assert from 'node:assert/strict';
import { fixText, mapEventType, parseEvents, parseMatches, parsePlayers } from '../workers/providers/wyscout-figshare.js';
import { ShapeDriftError, parseMatchdata, proveTeamsByFixtureGraph } from '../workers/providers/openligadb.js';

// The dataset's own dictionary (eventid2name.csv), verbatim ids.
const DICTIONARY = [[1, 10], [1, 11], [1, 12], [1, 13], [2, 20], [2, 21], [2, 22], [2, 23], [2, 24], [2, 25], [2, 26], [2, 27], [3, 30], [3, 31], [3, 32], [3, 33], [3, 34], [3, 35], [3, 36], [4, 40], [5, 50], [5, 51], [6, 60], [7, 70], [7, 71], [7, 72], [8, 80], [8, 81], [8, 82], [8, 83], [8, 84], [8, 85], [8, 86], [9, 90], [9, 91], [10, 100]];

test('every wyscout (event, subevent) pair in the dictionary maps to a canonical type', () => {
  for (const [e, s] of DICTIONARY) assert.ok(mapEventType(e, s), `${e}/${s} unmapped`);
  assert.deepEqual(mapEventType(3, 35), { event_type: 'shot', subtype: 'penalty', set_piece: 'penalty' });
  assert.deepEqual(mapEventType(3, 30), { event_type: 'pass', subtype: 'corner', set_piece: 'corner' });
  assert.deepEqual(mapEventType(6, ''), { event_type: 'offside', subtype: 'offside', set_piece: null });
  assert.equal(mapEventType(99, 999), null);
});

test('double-escaped unicode in names is decoded', () => {
  assert.equal(fixText('Bayern M\\u00fcnchen'), 'Bayern München');
  assert.equal(fixText('  '), null);
  const [p] = parsePlayers([{ wyId: 1, shortName: 'M. \\u00d6zil', firstName: 'Mesut', lastName: '\\u00d6zil', birthDate: '1988-10-15', role: { code2: 'MD' }, foot: 'left', height: 180, weight: 0, passportArea: { alpha3code: 'DEU' }, birthArea: { alpha3code: 'DEU' } }]);
  assert.equal(p.last_name, 'Özil');
  assert.equal(p.weight_kg, null); // 0 = unknown, never stored as 0 kg
  assert.equal(p.primary_role, 'midfielder');
});

const ev = (id, sec, period, eventId, subEventId, tags = [], positions = [{ x: 50, y: 50 }, { x: 60, y: 40 }], teamId = 1, playerId = 7) =>
  ({ id, matchId: 900, teamId, playerId, eventId, subEventId, matchPeriod: period, eventSec: sec, tags: tags.map(t => ({ id: t })), positions });

test('events are ordered by period and clock, sequenced, and shots get no fake end point', () => {
  const { events, unmapped } = parseEvents([
    ev(3, 10, '2H', 8, 85, [1801]),
    ev(1, 250.5, '1H', 10, 100, [101, 402, 1801], [{ x: 90, y: 50 }, { x: 100, y: 100 }]),
    ev(2, 5, '1H', 2, 20, [1702]),
  ]);
  assert.deepEqual(unmapped, {});
  assert.deepEqual(events.map(e => e.source_event_id), ['2', '1', '3']);
  assert.deepEqual(events.map(e => e.sequence), [1, 2, 3]);
  const shot = events[1];
  assert.equal(shot.event_type, 'shot');
  assert.equal(shot.is_goal, true);
  assert.equal(shot.outcome, 'goal');
  assert.equal(shot.body_part, 'right_foot');
  assert.equal(shot.minute, 5);
  assert.equal(shot.end_x_m, null);          // wyscout shot end is a placeholder
  assert.equal(shot.source_end_x, 100);      // ...but the source value is kept
  assert.equal(events[0].card, 'yellow');
  assert.equal(events[2].minute, 46);
  assert.equal(events[2].under_pressure, null); // never inferred
});

test('duplicate events (same source id) are not a parser concern but stay distinct by id', () => {
  const { events } = parseEvents([ev(5, 1, '1H', 8, 85), ev(6, 1, '1H', 8, 85)]);
  assert.deepEqual(events.map(e => e.sequence), [1, 2]); // equal clocks tie-break on source id
});

test('wyscout matches parse lineups, bench and substitutions', () => {
  const [m] = parseMatches([{
    wyId: 11, competitionId: 426, seasonId: 181137, roundId: 1, gameweek: 3, dateutc: '2017-09-01 18:30:00', label: 'A - B, 1 - 0', status: 'Played', duration: 'Regular', venue: 'X', winner: 1, referees: [],
    teamsData: {
      1: { teamId: 1, side: 'home', score: 1, scoreHT: 0, scoreET: 0, scoreP: 0, coachId: 5, hasFormation: 1, formation: { lineup: [{ playerId: 10 }], bench: [{ playerId: 11 }], substitutions: [{ playerIn: 11, playerOut: 10, minute: 70 }] } },
      2: { teamId: 2, side: 'away', score: 0, scoreHT: 0, scoreET: 0, scoreP: 0, coachId: 0, hasFormation: 1, formation: { lineup: [{ playerId: 20 }], bench: [], substitutions: 'null' } },
    },
  }]);
  assert.equal(m.kickoff_utc, '2017-09-01T18:30:00.000Z');
  assert.deepEqual(m.home.starters, ['10']);
  assert.deepEqual(m.home.substitutions, [{ player_in: '11', player_out: '10', minute: 70 }]);
  assert.deepEqual(m.away.substitutions, []);
  assert.equal(m.away.coach_external_id, null);
});

const olMatch = (id, t1, t2, date, goals = [], finished = true) => ({
  matchID: id, matchDateTimeUTC: `${date}T13:30:00Z`, leagueId: 1, leagueSeason: 2017, leagueShortcut: 'bl1', group: { groupOrderID: 1 },
  team1: { teamId: t1, teamName: `T${t1}` }, team2: { teamId: t2, teamName: `T${t2}` }, matchIsFinished: finished,
  matchResults: [{ resultTypeID: 1, pointsTeam1: 0, pointsTeam2: 0 }, { resultTypeID: 2, pointsTeam1: goals.filter(g => g[1] === 1).length, pointsTeam2: goals.filter(g => g[1] === 2).length }],
  goals: goals.map(([gid, side, s1, s2]) => ({ goalID: gid, scoreTeam1: s1, scoreTeam2: s2, matchMinute: 10 + gid, goalGetterID: 100 + gid, goalGetterName: 'X', isPenalty: false, isOwnGoal: false, isOvertime: false })),
});

test('openligadb scoring side comes from the running score, not an optional field', () => {
  const [m] = parseMatchdata([olMatch(1, 40, 7, '2017-08-18', [[1, 1, 1, 0], [2, 2, 1, 1], [3, 1, 2, 1]])]);
  assert.deepEqual(m.goals.map(g => g.side), ['team1', 'team2', 'team1']);
  assert.equal(m.score1, 2);
  assert.throws(() => parseMatchdata({}), ShapeDriftError);
  assert.throws(() => parseMatchdata([{ matchID: 1 }]), ShapeDriftError);
});

test('fixture graph proves team identity without names, and refuses when ambiguous', () => {
  // canonical ids A..D, provider ids 1..4 in scrambled order, a double round robin.
  const canon = [['2017-08-01', 'A', 'B'], ['2017-08-01', 'C', 'D'], ['2017-08-08', 'A', 'C'], ['2017-08-08', 'B', 'D'], ['2017-08-15', 'D', 'A'], ['2017-08-15', 'B', 'C'],
    ['2017-08-22', 'B', 'A'], ['2017-08-22', 'D', 'C'], ['2017-08-29', 'C', 'A'], ['2017-08-29', 'D', 'B'], ['2017-09-05', 'A', 'D'], ['2017-09-05', 'C', 'B']]
    .map(([date, home, away]) => ({ date, home, away }));
  const toProv = { A: '3', B: '1', C: '4', D: '2' };
  const prov = canon.map(f => ({ date: f.date, home: toProv[f.home], away: toProv[f.away] }));
  const ok = proveTeamsByFixtureGraph(canon, prov);
  assert.equal(ok.proven, true);
  assert.equal(ok.mapping.get('3'), 'A');
  assert.equal(ok.mapping.get('2'), 'D');

  // A single matchday cannot separate teams playing at home the same day.
  const thin = proveTeamsByFixtureGraph(canon.slice(0, 2), prov.slice(0, 2));
  assert.equal(thin.proven, false);
  assert.ok(thin.unresolved.length > 0);

  // One contradicting fixture breaks the proof.
  const bad = prov.map((f, i) => (i === 4 ? { ...f, home: f.away, away: f.home } : f));
  assert.equal(proveTeamsByFixtureGraph(canon, bad).proven, false);
});

test('openligadb phantom goal rows never count, and pre-2008 final scores are read', () => {
  const m = olMatch(2, 40, 7, '2017-09-01', [[1, 1, 1, 0]]);
  m.goals.unshift({ goalID: 99, scoreTeam1: 0, scoreTeam2: 0, matchMinute: null, goalGetterID: null, goalGetterName: null, isPenalty: false, isOwnGoal: false, isOvertime: false });
  const [p] = parseMatchdata([m]);
  assert.deepEqual(p.goals.map(g => g.advances), [false, true]);
  const old = olMatch(3, 1, 2, '2005-08-05');
  old.matchResults = [{ resultTypeID: 0, resultName: 'Endergebnis', pointsTeam1: 3, pointsTeam2: 0 }];
  const [q] = parseMatchdata([old]);
  assert.deepEqual([q.score1, q.score2], [3, 0]);
});
