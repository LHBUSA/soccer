// UEFA Nations League newsroom profile: national teams, groups in Leagues A-D, no domestic-league frame.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROFILES, profileFor, unsupportedGroupClaims } from '../workers/soccer-news/src/profiles.js';
import { NEWS_COMPETITIONS } from '../workers/soccer-news/src/pipeline.js';

const P = PROFILES.nations_league;
const banned = text => P.banned.filter(([, re]) => re.test(text)).map(([n]) => n);

test('nations league: eligible competition, league-phase profile until the knockouts', () => {
  assert.ok(NEWS_COMPETITIONS.includes('uefa-nations-league'));
  assert.equal(profileFor('uefa-nations-league', '2026-10-13T18:45:00Z').key, 'nations_league');
  assert.equal(profileFor('uefa-nations-league', '2027-03-25T19:45:00Z').key, 'nations_league_knockout');
  assert.equal(P.table, false); // no overall table angles
});

test('nations league: domestic-league race and club language are always banned', () => {
  assert.deepEqual(banned('France stay in the title race'), ['nl_domestic_race_language']);
  assert.deepEqual(banned('Italy slip into the relegation zone'), ['nl_domestic_race_language']);
  assert.deepEqual(banned('a top-four finish'), ['nl_domestic_race_language']);
  assert.deepEqual(banned('both clubs'), ['nl_club_language']);
  assert.deepEqual(banned('France beat Italy 2-1 in Group A1 of League A'), []);
  assert.ok(PROFILES.nations_league_knockout.banned.some(([n]) => n === 'nl_club_language'));
});

test('nations league: group / quarter-final / promotion / relegation claims need a verified, source-supported zone', () => {
  const verified = { teams: { home: { group: { verified: true, group: 'Group A1', tier: 'League A', position: 1, zone: 'Qualifies for QFs' } }, away: { group: { verified: true, group: 'Group A1', position: 4, zone: 'Relegation' } } } };
  assert.deepEqual(unsupportedGroupClaims(P, 'France lead the group and sit in a quarter-final place; Italy face relegation.', verified), []);
  // no verified group in the packet: every group claim fails
  assert.deepEqual(unsupportedGroupClaims(P, 'France top of the group', { teams: {} }).map(x => x[0]), ['nl_group_position_claim']);
  // a verified group whose zone notes do not state promotion / play-offs: those words fail
  const plain = { teams: { home: { group: { verified: true, zone: null } }, away: { group: { verified: true, zone: null } } } };
  assert.deepEqual(unsupportedGroupClaims(P, 'a promotion push and a play-off place', plain).map(x => x[0]).sort(), ['nl_playoff_claim', 'nl_promotion_claim']);
  assert.deepEqual(unsupportedGroupClaims(P, 'France lead the group', plain), []); // group position itself only needs verification
  // an unverified group never counts
  assert.deepEqual(unsupportedGroupClaims(P, 'quarter-finals', { teams: { home: { group: { verified: false, zone: 'Qualifies for QFs' } } } }).map(x => x[0]), ['nl_quarterfinal_claim']);
});
