// Optional-enrichment transport (World Cup canary blocker, 2026-09-30): one non-JSON ESPN athlete page
// (/seasons/2026/athletes/274277) must be archived + queued without killing the match or the lane, while a
// non-JSON CORE response (event, status) still fails the lane closed. Every provider response here is a fake
// fetcher inside the test (no network, no committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPglite, applyMigrations } from '../workers/soccer-ingest/src/store-pglite.js';
import { runEspnLane, espnClient } from '../workers/soccer-ingest/src/espn-jobs.js';
import { emptyLaneState } from '../workers/soccer-ingest/src/state.js';
import * as espn from '../workers/providers/espn.js';

const C = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/fifa.world';
const HOME = '475'; const AWAY = '208'; const EV = '760100';
const ath = (id, first, last, dob) => ({ id, firstName: first, lastName: last, displayName: `${first} ${last}`, dateOfBirth: `${dob}T08:00Z`, position: { abbreviation: 'F' } });
const ATHLETES = { 274277: null, 5001: ath('5001', 'Alpha', 'Home', '1995-01-02'), 5002: ath('5002', 'Beta', 'Home', '1996-03-04'), 6001: ath('6001', 'Gamma', 'Away', '1994-05-06'), 6002: ath('6002', 'Delta', 'Away', '1997-07-08') };
const roster = ids => ({ formation: { summary: '4-4-2' }, entries: ids.map((id, i) => ({ playerId: Number(id), starter: i === 0, jersey: String(9 + i), athlete: { $ref: `http://x/athletes/${id}?lang=en` } })) });

function world({ htmlAt = null } = {}) {
  const calls = [];
  const body = url => {
    if (url === C) return { season: { $ref: `${C}/seasons/2026?lang=en&region=us` } };
    if (url.endsWith('/seasons/2026/types')) return { items: [{ $ref: `${C}/seasons/2026/types/1` }, { $ref: `${C}/seasons/2026/types/2` }] };
    if (url.endsWith('/seasons/2026/types/1')) return { id: '1', name: 'Group Stage' };
    if (url.endsWith('/seasons/2026/types/2')) return { id: '2', name: 'Round of 32' };
    if (url.includes('/types/1/events')) return { items: [{ $ref: `${C}/events/${EV}?lang=en` }], pageCount: 1 };
    if (url.includes('/types/2/events')) return { items: [], pageCount: 1 };
    if (url.endsWith(`/events/${EV}`)) return { id: EV, date: '2026-06-20T19:00Z', season: { $ref: `${C}/seasons/2026` }, seasonType: { $ref: `${C}/seasons/2026/types/1` }, competitions: [{ competitors: [{ id: HOME, homeAway: 'home' }, { id: AWAY, homeAway: 'away' }], venue: { id: '9001', fullName: 'Test Stadium', address: { city: 'Test City' } } }] };
    if (url.endsWith(`/teams/${HOME}`)) return { id: HOME, displayName: 'Japan', abbreviation: 'JPN', isNational: true };
    if (url.endsWith(`/teams/${AWAY}`)) return { id: AWAY, displayName: 'Sweden', abbreviation: 'SWE', isNational: false }; // provider inconsistency (as ESPN's Curacao record)
    if (url.endsWith('/status')) return { type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true }, period: 2 };
    if (url.endsWith(`/competitors/${HOME}/score`)) return { value: 2 };
    if (url.endsWith(`/competitors/${AWAY}/score`)) return { value: 1 };
    if (url.endsWith(`/competitors/${HOME}/roster`)) return roster(['274277', '5001', '5002']);
    if (url.endsWith(`/competitors/${AWAY}/roster`)) return roster(['6001', '6002']);
    if (url.includes('/statistics')) return { splits: { categories: [{ stats: [{ name: 'totalShots', value: 11 }, { name: 'possessionPct', value: 50 }] }] } };
    if (url.includes('/plays')) return { items: [{ id: '1', type: { text: 'Goal' }, scoringPlay: true, period: { number: 1 }, clock: { value: 600 }, team: { $ref: `http://x/teams/${HOME}?x` }, participants: [{ order: 1, athlete: { $ref: 'http://x/athletes/5001?x' } }] }], pageCount: 1 };
    const m = url.match(/\/athletes\/(\d+)$/);
    if (m && m[1] in ATHLETES) return ATHLETES[m[1]];
    return {};
  };
  const html = new TextEncoder().encode('<!DOCTYPE html><html><body>Service Unavailable</body></html>');
  const fetcher = async url => {
    calls.push(url);
    const bad = url.endsWith('/athletes/274277') || (htmlAt && url.endsWith(htmlAt));
    if (bad) return { status: 200, contentType: 'text/html; charset=utf-8', bytes: html };
    return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body(url))) };
  };
  const mem = new Map();
  const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const registry = { competitions: [{ slug: 'fifa-world-cup', name: 'FIFA World Cup', comp_type: 'international_tournament', gender: 'men', country_code: null, tier: null, season_format: 'calendar',
    external_ids: [{ provider: 'espn', external_id: 'fifa.world', method: 'reviewed', evidence: 't' }, { provider: 'wyscout', external_id: '28', method: 'founding', evidence: 't' }],
    espn: { league: 'fifa.world', id: '606', enabled: true, may_found: true, stage_by_type: true, stage_per_type: true, team_type: 'national', league_stage_name: 'Group stage', type_roles: { 'Group Stage': 'league' } } }] };
  return { calls, fetcher, storage, mem, registry };
}
const lane = { name: 'espn_fifa_world_cup', competition: 'fifa-world-cup' };
const NOW = Date.parse('2026-09-30T12:00:00Z');

test('World Cup: a non-JSON athlete page (274277) is archived + queued; the match, teams, score, events and other players still land', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world();
  const out = await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(lane.name), now: NOW, fetcher: w.fetcher, budget: 200, force: true });
  const r = out.results[0];
  assert.equal(r.matches_detailed, 1, 'the match is detailed, not discarded');
  assert.equal(out.cursor.types['1'].role, 'league', 'Group Stage is indexed through the registry role, not excluded');
  // response archived: payload bytes + capture row with status and content type
  const [cap] = await store.select('soccer_source_captures', { columns: ['capture_id', 'http_status', 'content_type', 'request_url', 'raw_key'], eq: { request_url: `${C}/seasons/2026/athletes/274277` } });
  assert.ok(cap, 'capture row stored'); assert.equal(cap.http_status, 200); assert.match(cap.content_type, /text\/html/);
  assert.ok(w.mem.has(cap.raw_key), 'raw bytes archived');
  // athlete queued with the capture evidence; no player founded from it
  const [q] = await store.select('soccer_identity_queue', { columns: ['reason', 'payload', 'status'], eq: { entity_type: 'player', provider: 'espn', external_id: '274277' } });
  assert.equal(q.reason, 'athlete_record_unavailable'); assert.equal(q.status, 'open');
  assert.equal(q.payload.capture_id, cap.capture_id); assert.equal(q.payload.http_status, 200); assert.match(q.payload.content_type, /text\/html/);
  assert.equal(q.payload.endpoint, `${C}/seasons/2026/athletes/274277`); assert.equal(q.payload.detail, 'non_json_response');
  const px = await store.select('soccer_player_external_ids', { columns: ['external_id'], eq: { provider: 'espn' } });
  assert.deepEqual(px.map(x => x.external_id).sort(), ['5001', '5002', '6001', '6002'], 'other players resolve; 274277 is never founded');
  const players = await store.select('soccer_players', { columns: ['display_name', 'birth_date'] });
  assert.equal(players.length, 4); assert.ok(players.every(p => p.display_name && p.birth_date), 'no fabricated athlete');
  // match, teams, score, lineup (without the unresolved player), stats and events
  const [m] = await store.select('soccer_matches', { columns: ['id', 'status', 'home_score', 'away_score', 'duration', 'winner_team_id', 'stage_id'] });
  assert.deepEqual([m.status, m.home_score, m.away_score, m.duration], ['finished', 2, 1, 'regular']);
  const teams = await store.select('soccer_teams', { columns: ['name', 'team_type'] });
  assert.deepEqual(teams.map(t => [t.name, t.team_type]).sort(), [['Japan', 'national'], ['Sweden', 'national']]);
  const [stage] = await store.select('soccer_stages', { columns: ['name', 'stage_type'], eq: { id: m.stage_id } });
  assert.deepEqual([stage.name, stage.stage_type], ['Group stage', 'league']);
  const lps = await store.select('soccer_lineup_players', { columns: ['player_id'] });
  assert.equal(lps.length, 4, 'lineups keep every resolved player and leave the unresolved one out');
  const enr = await store.select('soccer_match_enrichment', { columns: ['component', 'status', 'detail'], eq: { match_id: m.id } });
  const lh = enr.find(e => e.component === 'lineup_home');
  assert.equal(lh.status, 'complete'); assert.equal(lh.detail.players_unresolved, 1);
  assert.equal((await store.select('soccer_match_events', { columns: ['id'], eq: { match_id: m.id } })).length, 1);
  assert.ok((await store.select('soccer_team_match_stats', { columns: ['stat_key'], eq: { match_id: m.id } })).length >= 2);
  await store.close();
});

test('a transiently unavailable athlete is re-read when it appears again and resolves only on a real record', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const { resolveAthletes } = await import('../workers/soccer-ingest/src/espn-lane.js');
  const w = world();
  const client = espnClient({ storage: w.storage, store, fetcher: w.fetcher, budget: 50, registry: w.registry, areas: { areas: {}, aliases: {} } });
  const first = await resolveAthletes(store, { athleteIds: ['274277'], client, league: 'fifa.world', year: 2026, registry: w.registry, areas: { areas: {}, aliases: {} } });
  assert.equal(first.queued, 1); assert.equal(first.founded, 0);
  ATHLETES[274277] = ath('274277', 'Ayase', 'Ueda', '1994-08-28');
  const good = async url => (url.endsWith('/athletes/274277') ? { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(ATHLETES[274277])) } : w.fetcher(url));
  const client2 = espnClient({ storage: w.storage, store, fetcher: good, budget: 50, registry: w.registry, areas: { areas: {}, aliases: {} } });
  const second = await resolveAthletes(store, { athleteIds: ['274277'], client: client2, league: 'fifa.world', year: 2026, registry: w.registry, areas: { areas: {}, aliases: {} } });
  ATHLETES[274277] = null;
  assert.equal(second.founded, 1);
  const [q] = await store.select('soccer_identity_queue', { columns: ['status'], eq: { external_id: '274277' } });
  assert.equal(q.status, 'resolved');
  await store.close();
});

test('a non-JSON CORE response (event) still fails the lane closed', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world({ htmlAt: `/events/${EV}` });
  await assert.rejects(() => runEspnLane(lane, { store, storage: w.storage, registry: w.registry, state: emptyLaneState(lane.name), now: NOW, fetcher: w.fetcher, budget: 200, force: true }), espn.EspnShapeError);
  assert.equal((await store.select('soccer_matches', { columns: ['id'] })).length, 0);
  await store.close();
});

test('a non-JSON CORE match status still fails the lane closed (no result invented)', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world({ htmlAt: '/status' });
  await assert.rejects(() => runEspnLane(lane, { store, storage: w.storage, registry: w.registry, state: emptyLaneState(lane.name), now: NOW, fetcher: w.fetcher, budget: 200, force: true }), espn.EspnShapeError);
  const ms = await store.select('soccer_matches', { columns: ['status', 'home_score'] });
  assert.ok(ms.every(m => m.status !== 'finished' && m.home_score === null));
  await store.close();
});

test('knockout results: shootout and extra time come from the ESPN status, never guessed', () => {
  assert.equal(espn.parseDuration({ type: { name: 'STATUS_FINAL_PEN' }, period: 5 }), 'penalties');
  assert.equal(espn.parseDuration({ type: { name: 'STATUS_FINAL_AET' }, period: 4 }), 'extra_time');
  assert.equal(espn.parseDuration({ type: { name: 'STATUS_FULL_TIME' }, period: 2 }), 'regular');
});

test('history lane: a pinned past season never reads the league (current season) and keeps its own cursor', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world();
  const out = await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(`${lane.name}@2026`), now: NOW, fetcher: w.fetcher, budget: 200, force: true, year: 2026 });
  assert.equal(w.calls.filter(u => u === C).length, 0, 'no league lookup for a pinned season');
  assert.equal(out.cursor.season_year, 2026); assert.equal(out.cursor.history, true);
  assert.equal(out.results[0].matches_detailed, 1);
  const { historyLane } = await import('../workers/soccer-ingest/src/index.js');
  assert.deepEqual(historyLane('espn_uefa_nations_league@2018'), { lane: { name: 'espn_uefa_nations_league', competition: 'uefa-nations-league' }, year: 2018, depth: 'full' });
  assert.deepEqual(historyLane('espn_uefa_nations_league@2018:results'), { lane: { name: 'espn_uefa_nations_league', competition: 'uefa-nations-league' }, year: 2018, depth: 'results' }, 'PASS A lane');
  assert.equal(historyLane('espn_uefa_nations_league@2018:events'), null);
  assert.equal(historyLane('espn_uefa_nations_league'), null); assert.equal(historyLane('espn_nope@2018'), null);
  await store.close();
});

test('PASS A (results-only history lane): season born held, final score stored, no roster/statistics/plays read', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world();
  const out = await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(`${lane.name}@2026:results`), now: NOW, fetcher: w.fetcher, budget: 200, force: true, year: 2026, depth: 'results' });
  assert.equal(out.results[0].matches_detailed, 1);
  assert.equal(w.calls.filter(u => /\/(roster|statistics|plays)/.test(u)).length, 0, 'skeleton only');
  const [season] = await store.select('soccer_seasons', { columns: ['publication_state', 'source_families'] });
  assert.equal(season.publication_state, 'held');
  const ms = await store.select('soccer_matches', { columns: ['status', 'home_score', 'away_score'] });
  assert.ok(ms.some(m => m.status === 'finished' && Number.isInteger(m.home_score)));
  assert.equal((await store.select('soccer_public_matches', { columns: ['id'] })).length, 0, 'invisible until accepted');
  assert.equal((await store.select('soccer_lineups', { columns: ['id'] })).length, 0);
  await store.close();
});

test('history lane founds NOTHING while discovery is incomplete (budget exhausted mid-discovery), then founds on resume', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world();
  const state = emptyLaneState(`${lane.name}@2026:results`);
  const first = await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state, now: NOW, fetcher: w.fetcher, budget: 3, force: true, year: 2026, depth: 'results' });
  assert.equal(first.results[0].budget_exhausted_at, 'discovery'); assert.match(first.results[0].deferred, /discovery incomplete/);
  assert.equal((await store.select('soccer_matches', { columns: ['id'] })).length, 0, 'no fixture founded on a partial cursor');
  const second = await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: { ...state, cursor: first.cursor }, now: NOW, fetcher: w.fetcher, budget: 200, force: true, year: 2026, depth: 'results' });
  assert.ok(!second.results[0].deferred); assert.ok((await store.select('soccer_matches', { columns: ['id'] })).length > 0);
  await store.close();
});

test('national-team competition: an isNational=false entrant is founded national (contract, evidence recorded); an ESPN id mapped to a CLUB is refused', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const w = world();
  await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(lane.name), now: NOW, fetcher: w.fetcher, budget: 200, force: true });
  const [x] = await store.select('soccer_team_external_ids', { columns: ['evidence', 'team_id'], eq: { provider: 'espn', external_id: AWAY } });
  assert.match(x.evidence, /competition contract/); assert.match(x.evidence, /isNational=false/);
  await store.close();
  // an existing CLUB crosswalked to ESPN id 208: the lane refuses it and writes no match for it
  const s2 = await openPglite(); await applyMigrations(s2);
  const club = { id: '00000000-0000-5000-8000-0000000c1b00', slug: 'club-208', name: 'Some Club', team_type: 'club', founding_provider: 'espn', founding_external_id: AWAY };
  await s2.insert('soccer_teams', [club]);
  await s2.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: AWAY, team_id: club.id, method: 'founding', evidence: 't' }]);
  const w2 = world();
  await runEspnLane(lane, { store: s2, storage: w2.storage, registry: w2.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(lane.name), now: NOW, fetcher: w2.fetcher, budget: 200, force: true });
  const [q] = await s2.select('soccer_identity_queue', { columns: ['reason', 'status'], eq: { entity_type: 'team', external_id: AWAY } });
  assert.equal(q.reason, 'club_mapped_in_national_team_competition');
  assert.equal((await s2.select('soccer_matches', { columns: ['id'] })).length, 0);
  await s2.close();
});
