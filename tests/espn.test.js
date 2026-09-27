import test from 'node:test';
import assert from 'node:assert/strict';
import * as espn from '../workers/providers/espn.js';
import { toCanonical } from '../workers/shared/coords.js';
import { proveTeamsByFixtureSubset } from '../workers/shared/fixture-graph.js';

test('ESPN coordinates: team-relative, attacking x=100, y=0 = attacking right', () => {
  // A shot "from the left side of the box" has ESPN y > 50 -> canonical left (y_m < 34).
  const left = toCanonical('espn_pct_v1', 88, 65);
  assert.ok(left.x_m > 90 && left.y_m < 34);
  const right = toCanonical('espn_pct_v1', 88, 34);
  assert.ok(right.y_m > 34);
  assert.deepEqual(toCanonical('espn_pct_v1', 50, 102), { x_m: null, y_m: null }); // off-pitch: no canonical point
});

test('event, status, roster, athlete and team-stat parsers', () => {
  const ev = espn.parseEvent({ id: '401884817', date: '2026-08-28T18:30Z', season: { $ref: 'http://x/leagues/ger.1/seasons/2026?lang=en&region=us' }, seasonType: { $ref: 'http://x/seasons/2026/types/1?lang=en' },
    competitions: [{ competitors: [{ id: '132', homeAway: 'home', winner: true, team: { $ref: 't' } }, { id: '134', homeAway: 'away', winner: false, team: { $ref: 't' } }], venue: { id: '3845', fullName: 'Allianz Arena', address: { city: 'Munich' } }, attendance: 75000, status: { $ref: 's' } }] }, 'ger.1');
  assert.equal(ev.season_year, 2026); assert.equal(ev.home.team_id, '132'); assert.equal(ev.venue.name, 'Allianz Arena');
  assert.throws(() => espn.parseEvent({ id: 1, competitions: [] }), espn.EspnShapeError);
  assert.equal(espn.parseStatus({ type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true } }), 'finished');
  assert.equal(espn.parseStatus({ type: { name: 'STATUS_POSTPONED', state: 'post' } }), 'postponed');
  assert.equal(espn.parseStatus({ type: { state: 'in' } }), 'live');
  const r = espn.parseRoster({ formation: { summary: '4-2-3-1' }, entries: [{ playerId: 157688, starter: true, jersey: '3', athlete: { $ref: '.../athletes/157688?lang=en' }, subbedOut: { didSub: true, replacementAthlete: { $ref: '.../athletes/188052?x' }, clock: { value: 5010 } }, formationPlace: '6' }] });
  assert.deepEqual(r.entries[0].sub_out, { replacement_id: '188052', clock_s: 5010 });
  assert.equal(r.formation, '4-2-3-1');
  const a = espn.parseAthlete({ id: '84774', displayName: 'Manuel Neuer', firstName: 'Manuel', lastName: 'Neuer', dateOfBirth: '1986-03-27T08:00Z', position: { abbreviation: 'G' } });
  assert.equal(a.birth_date, '1986-03-27'); assert.equal(a.primary_role, 'goalkeeper');
  assert.deepEqual(espn.parseTeamStats({ splits: { categories: [{ stats: [{ name: 'possessionPct', value: 61.2 }, { name: 'totalShots', value: 15 }, { name: 'somethingElse', value: 3 }] }] } }), { possession_pct: 61.2, shots: 15 });
  assert.equal(espn.seasonLabel(2026, 'split'), '2026/27'); assert.equal(espn.seasonLabel(2026, 'calendar'), '2026');
});

const play = (id, text, extra = {}) => ({ id: String(id), type: { text }, period: { number: 1 }, clock: { value: 600 + id }, valid: true, team: { $ref: '.../teams/132?x' },
  participants: [{ order: 1, athlete: { $ref: '.../athletes/9?x' } }], fieldPositionX: 80, fieldPositionY: 40, fieldPosition2X: 90, fieldPosition2Y: 45,
  text: 'Some Player (Club) prose that must never be stored', shortText: 'prose', ...extra });

test('plays: mapping, own goals, provider xG labelled, prose stripped, unmapped kept', () => {
  const { events, unmapped } = espn.parsePlays([
    play(1, 'Pass'), play(2, 'Goal', { scoringPlay: true, expectedGoals: 0.31, contactType: { text: 'Right Foot' } }),
    play(3, 'Goal', { scoringPlay: true, ownGoal: true }), play(4, 'Mystery Thing'), play(5, 'Shot Blocked'), play(6, 'Yellow Card', { yellowCard: true }),
    play(7, 'Goal Kick'),
  ], { eventId: 1 });
  const by = Object.fromEntries(events.map(e => [e.source_event_id, e]));
  assert.equal(by[1].event_type, 'pass'); assert.equal(by[1].outcome, null); // no completion flag -> never guessed
  assert.ok(by[1].end_x_m !== null);
  assert.equal(by[2].is_goal, true); assert.equal(by[2].body_part, 'right_foot');
  assert.deepEqual(by[2].qualifiers.provider_xg, { provider: 'espn', value: 0.31 }); // labelled as ESPN's, not PBE xG
  assert.equal(by[2].end_x_m, null); // shot end meaning not established
  assert.equal(by[3].is_own_goal, true); assert.equal(by[3].is_goal, false); assert.equal(by[3].event_type, 'touch');
  assert.equal(by[4].event_type, 'unmapped'); assert.equal(by[4].subtype, 'espn_mystery_thing'); assert.deepEqual(unmapped, { 'Mystery Thing': 1 });
  assert.equal(by[5].outcome, 'blocked'); assert.equal(by[6].card, 'yellow');
  assert.equal(by[7].event_type, 'pass'); assert.equal(by[7].set_piece, 'goal_kick'); // a goal kick is not a shot
  assert.equal(by[1].minute, footballMinuteOf(601));
  for (const e of events) {
    assert.ok(!JSON.stringify(e.raw).includes('prose'), 'prose must be stripped before hashing/storage');
    assert.ok(!JSON.stringify(e.qualifiers).includes('prose'));
  }
});
const footballMinuteOf = s => Math.floor(s / 60) + 1;

test('fixture subset proof: needs appearances, injectivity and exact fixture reproduction', () => {
  const canon = [['2026-08-01', 'A', 'B'], ['2026-08-01', 'C', 'D'], ['2026-08-08', 'A', 'C'], ['2026-08-08', 'B', 'D'], ['2026-08-15', 'D', 'A'], ['2026-08-15', 'B', 'C'],
    ['2026-08-22', 'B', 'A'], ['2026-08-22', 'D', 'C']].map(([date, home, away]) => ({ date, home, away }));
  const map = { A: '9', B: '8', C: '7', D: '6' };
  const prov = canon.slice(0, 6).map(f => ({ date: f.date, home: map[f.home], away: map[f.away] }));
  const ok = proveTeamsByFixtureSubset(canon, prov);
  assert.equal(ok.valid, true); assert.equal(ok.mapping.get('9'), 'A'); assert.equal(ok.mapping.size, 4);
  const thin = proveTeamsByFixtureSubset(canon, prov.slice(0, 2));
  assert.equal(thin.mapping.size, 0); assert.equal(thin.thin.length, 4);
  const wrong = proveTeamsByFixtureSubset(canon, [...prov, { date: '2026-08-22', home: '9', away: '8' }]);
  assert.equal(wrong.valid, false); assert.equal(wrong.mapping.size, 0);
});

test('season-type roles: MLS regular season is the league, playoffs separate, All-Star excluded', () => {
  assert.equal(espn.seasonTypeRole('Regular Season'), 'league');
  assert.equal(espn.seasonTypeRole('Eastern Conference Playoffs - Wild Card'), 'playoff');
  assert.equal(espn.seasonTypeRole('MLS Cup'), 'playoff');
  assert.equal(espn.seasonTypeRole('All-Star Game'), 'excluded');
  assert.equal(espn.seasonTypeRole('Combined'), 'excluded');
  assert.equal(espn.seasonTypeRole(undefined), 'excluded');
});

test('All-Star exhibition sides are flagged and never treated as league teams', () => {
  assert.equal(espn.parseTeam({ id: '9817', displayName: 'MLS All-Stars', isAllStar: true }).is_all_star, true);
  assert.equal(espn.parseTeam({ id: '20279', displayName: 'Liga MX All-Stars' }).is_all_star, true); // name fallback
  assert.equal(espn.parseTeam({ id: '18966', displayName: 'LAFC', isAllStar: false }).is_all_star, false);
  assert.equal(espn.parseTeam({ id: '1', displayName: 'Stars FC' }).is_all_star, false);
});

test('an unavailable athlete record is queued, never fails the match', async () => {
  const { openPglite, applyMigrations } = await import('../workers/soccer-ingest/src/store-pglite.js');
  const { resolveAthletes } = await import('../workers/soccer-ingest/src/espn-lane.js');
  const store = await openPglite(); await applyMigrations(store);
  const client = { flush: async () => {}, get: async () => ({ json: { error: { message: 'no instance found', code: 404 } }, capture: { capture_id: 'c'.repeat(24), http_status: 404 } }) };
  const out = await resolveAthletes(store, { athleteIds: ['999999'], client, league: 'usa.1', year: 2026, registry: { competitions: [] }, areas: { areas: {}, aliases: {} } });
  assert.equal(out.queued, 1); assert.equal(out.map.size, 0);
  const [q] = await store.select('soccer_identity_queue', { columns: ['reason'], eq: { external_id: '999999' } });
  assert.equal(q.reason, 'athlete_record_unavailable');
  await store.close();
});
