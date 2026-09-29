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
  assert.equal(espn.seasonTypeRole('League Phase'), 'league'); // UCL 2024+ format
  for (const k of ['Knockout Round Playoffs', 'Round of 16', 'Quarterfinals', 'Semifinals', 'Final']) assert.equal(espn.seasonTypeRole(k), 'playoff', k);
  // UEFA Nations League 2026/27 types (docs/evidence/espn/uefa-nations-discovery-2026-09-29.json)
  for (const k of ['Relegation Playoffs', '3rd-Place Match']) assert.equal(espn.seasonTypeRole(k), 'playoff', k);
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

test('enrichment ledger: unavailable is scheduled for retry; complete is never downgraded', async () => {
  const { openPglite, applyMigrations } = await import('../workers/soccer-ingest/src/store-pglite.js');
  const { recordEnrichment, nextRetryAt, MAX_ENRICH_ATTEMPTS } = await import('../workers/soccer-ingest/src/espn-lane.js');
  const store = await openPglite(); await applyMigrations(store);
  const cid = '00000000-0000-5000-8000-00000000c001'; const sid = '00000000-0000-5000-8000-00000000c002'; const stg = '00000000-0000-5000-8000-00000000c003';
  const t1 = '00000000-0000-5000-8000-00000000c004'; const t2 = '00000000-0000-5000-8000-00000000c005'; const mid = '00000000-0000-5000-8000-00000000c006';
  await store.insert('soccer_competitions', [{ id: cid, slug: 'x', name: 'X', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: sid, competition_id: cid, label: '2026' }]);
  await store.insert('soccer_stages', [{ id: stg, season_id: sid, name: 'Regular Season', stage_type: 'league', stage_order: 1 }]);
  await store.insert('soccer_teams', [{ id: t1, slug: 'a', name: 'A', team_type: 'club', gender: 'men', founding_provider: 'espn', founding_external_id: '1' }, { id: t2, slug: 'b', name: 'B', team_type: 'club', gender: 'men', founding_provider: 'espn', founding_external_id: '2' }]);
  await store.insert('soccer_matches', [{ id: mid, competition_id: cid, season_id: sid, stage_id: stg, kickoff_at: '2026-09-20T00:00:00Z', home_team_id: t1, away_team_id: t2, status: 'finished', home_score: 1, away_score: 0, result_provider: 'espn' }]);
  const now = Date.parse('2026-09-28T00:00:00Z');
  await recordEnrichment(store, { matchId: mid, now, outcomes: { plays: { status: 'unavailable', error: 'non-JSON response' }, stats_home: { status: 'complete' } } });
  let rows = await store.select('soccer_match_enrichment', { columns: ['component', 'status', 'attempts', 'next_retry_at'], eq: { match_id: mid } });
  const plays = rows.find(r => r.component === 'plays');
  assert.equal(plays.status, 'unavailable'); assert.equal(new Date(plays.next_retry_at).toISOString(), nextRetryAt(1, now));
  assert.equal(rows.find(r => r.component === 'stats_home').next_retry_at, null);
  // A later failure never downgrades the complete component; the retried one completes.
  await recordEnrichment(store, { matchId: mid, now: now + 3600e3, outcomes: { stats_home: { status: 'unavailable', error: 'boom' }, plays: { status: 'complete', detail: { events: 700 } } } });
  rows = await store.select('soccer_match_enrichment', { columns: ['component', 'status', 'attempts', 'next_retry_at'], eq: { match_id: mid } });
  assert.deepEqual(rows.map(r => [r.component, r.status]).sort(), [['plays', 'complete'], ['stats_home', 'complete']]);
  assert.equal(rows.find(r => r.component === 'plays').attempts, 2);
  assert.ok(nextRetryAt(20, now) <= new Date(now + 24 * 3600e3).toISOString()); // capped at 24 h
  assert.equal(MAX_ENRICH_ATTEMPTS, 8);
  await store.close();
});

test('standings lane: conference membership + provider standings; a group with an unresolved member is withheld whole', async () => {
  const { openPglite, applyMigrations } = await import('../workers/soccer-ingest/src/store-pglite.js');
  const { runEspnStandings, parseStandingsEntry, groupKey } = await import('../workers/soccer-ingest/src/espn-standings.js');
  const { emptyLaneState } = await import('../workers/soccer-ingest/src/state.js');
  const store = await openPglite(); await applyMigrations(store);
  const team = (id, n) => ({ id: `00000000-0000-5000-8000-0000000d00${n}`, slug: `t${id}`, name: `T${id}`, team_type: 'club', founding_provider: 'espn', founding_external_id: String(id) });
  const teams = [team(182, 10), team(183, 11), team(900, 12)];
  await store.insert('soccer_teams', teams);
  await store.insert('soccer_team_external_ids', teams.slice(0, 2).map(t => ({ provider: 'espn', external_id: t.founding_external_id, team_id: t.id, method: 'founding', evidence: 't' })));
  const rec = (rank, pts, note) => ({ team: { $ref: 'x' }, note: note ? { description: note, rank } : undefined, records: [{ type: 'total', name: 'overall', stats: [['gamesPlayed', 26], ['wins', 12], ['ties', 6], ['losses', 8], ['pointsFor', 46], ['pointsAgainst', 38], ['pointDifferential', 8], ['points', pts], ['rank', rank], ['deductions', '']].map(([name, value]) => ({ name, value })) }] });
  const body = url => {
    if (/leagues\/usa\.1$/.test(url)) return { season: { $ref: 'http://x/leagues/usa.1/seasons/2026' } };
    if (url.endsWith('/types/1/groups')) return { items: [{ $ref: 'http://x/types/1/groups/1' }, { $ref: 'http://x/types/1/groups/2' }] };
    if (url.endsWith('/groups/1')) return { id: '1', name: 'Eastern Conference', abbreviation: 'East' };
    if (url.endsWith('/groups/2')) return { id: '2', name: 'Western Conference', abbreviation: 'West' };
    if (url.endsWith('/groups/1/standings/0')) return { standings: [{ ...rec(1, 42, 'Playoffs'), team: { $ref: 'http://x/teams/182' } }, { ...rec(2, 40), team: { $ref: 'http://x/teams/183' } }] };
    if (url.endsWith('/groups/2/standings/0')) return { standings: [{ ...rec(1, 50), team: { $ref: 'http://x/teams/900' } }] }; // unresolved team
    return {};
  };
  const mem = new Map();
  const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const fetcher = async url => ({ status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body(url))) });
  const reg = { competitions: [{ slug: 'mls', name: 'MLS', comp_type: 'league', gender: 'men', country_code: 'USA', tier: 1, season_format: 'calendar', espn: { league: 'usa.1', enabled: true, standings: { group_type: 'conference' } }, external_ids: [{ provider: 'espn', external_id: 'usa.1', method: 'founding', evidence: 't' }] }] };
  const out = await runEspnStandings({ store, storage, registry: reg, state: emptyLaneState('x'), fetcher, force: true });
  assert.equal(out.results[0].groups, 1); assert.equal(out.results[0].unresolved, 1);
  const g = await store.select('soccer_season_groups', { columns: ['group_key', 'name', 'group_type'] });
  assert.deepEqual(g.map(x => [x.group_key, x.group_type]), [['east', 'conference']]);
  const st = await store.select('soccer_source_standings', { columns: ['rank', 'points', 'note', 'deductions'], order: 'rank.asc' });
  assert.deepEqual(st.map(x => [x.rank, x.points, x.note, x.deductions]), [[1, 42, 'Playoffs', null], [2, 40, null, null]]);
  const q = await store.select('soccer_identity_queue', { columns: ['external_id', 'reason'] });
  assert.ok(q.some(x => x.external_id === '900' && x.reason === 'standings_member_unresolved'));
  assert.equal(groupKey({ abbreviation: 'West' }, 'conference'), 'west'); assert.equal(groupKey({}, 'league_phase'), 'league-phase');
  assert.throws(() => parseStandingsEntry({ records: [] }));
  await store.close();
});

test('live lane: updates status/score of ESPN-owned matches in the live window only', async () => {
  const { openPglite, applyMigrations } = await import('../workers/soccer-ingest/src/store-pglite.js');
  const { runEspnLive } = await import('../workers/soccer-ingest/src/espn-live.js');
  const store = await openPglite(); await applyMigrations(store);
  const id = n => `00000000-0000-5000-8000-0000000e00${n}`;
  await store.insert('soccer_competitions', [{ id: id(10), slug: 'mls', name: 'MLS', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(11), competition_id: id(10), label: '2026' }]);
  await store.insert('soccer_teams', [{ id: id(12), slug: 'a', name: 'A', team_type: 'club', founding_provider: 'espn', founding_external_id: '1' }, { id: id(13), slug: 'b', name: 'B', team_type: 'club', founding_provider: 'espn', founding_external_id: '2' }]);
  await store.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: '1', team_id: id(12), method: 'founding', evidence: 't' }, { provider: 'espn', external_id: '2', team_id: id(13), method: 'founding', evidence: 't' }]);
  const now = Date.parse('2026-09-27T23:40:00Z');
  await store.insert('soccer_matches', [
    { id: id(20), competition_id: id(10), season_id: id(11), kickoff_at: '2026-09-27T23:00:00Z', home_team_id: id(12), away_team_id: id(13), status: 'scheduled', result_provider: 'espn' },
    { id: id(21), competition_id: id(10), season_id: id(11), kickoff_at: '2026-09-20T23:00:00Z', home_team_id: id(13), away_team_id: id(12), status: 'scheduled', result_provider: 'espn' }, // outside window
  ]);
  await store.insert('soccer_match_external_ids', [{ provider: 'espn', external_id: '777', match_id: id(20), method: 'founding', evidence: 't' }]);
  const calls = [];
  const fetcher = async url => { calls.push(url); const b = url.endsWith('/status') ? { type: { state: 'in' }, displayClock: "40'" } : url.includes('/competitors/1/score') ? { value: 1 } : { value: 0 }; return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(b)) }; };
  const mem = new Map(); const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const reg = { competitions: [{ slug: 'mls', espn: { league: 'usa.1', enabled: true } }] };
  const out = await runEspnLive({ store, storage, registry: reg, now, fetcher });
  assert.equal(out.results.length, 1); assert.equal(out.results[0].status, 'live'); assert.equal(out.results[0].score, '1-0');
  const [m] = await store.select('soccer_matches', { columns: ['status', 'home_score', 'away_score'], eq: { id: id(20) } });
  assert.deepEqual([m.status, m.home_score, m.away_score], ['live', 1, 0]);
  const [old] = await store.select('soccer_matches', { columns: ['status'], eq: { id: id(21) } });
  assert.equal(old.status, 'scheduled'); // never touched outside the window
  assert.ok(calls.every(u => u.includes('/events/777/')));
  await store.close();
});
