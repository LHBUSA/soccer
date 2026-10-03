// Women's competitions (World Coverage sprint, 2026-10-03): ESPN names a women's side exactly like the men's club
// ("Manchester City" in eng.w.1). Identity is the stable ESPN team id, never the name: the women's side is founded as
// its own canonical team with gender 'women', displayed "Manchester City Women" when a men's namesake exists, and an
// ESPN id already mapped to a team of the other gender is refused (identity queue), never reused. Every provider
// response here is a fake fetcher inside the test (no network, no committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPglite, applyMigrations } from '../workers/soccer-ingest/src/store-pglite.js';
import { runEspnLane } from '../workers/soccer-ingest/src/espn-jobs.js';
import { emptyLaneState } from '../workers/soccer-ingest/src/state.js';

const C = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/eng.w.1';
const HOME = '21528'; const AWAY = '21530'; const EV = '780100';
const roster = () => ({ entries: [] });

function wsl() {
  const body = url => {
    if (url === C) return { season: { $ref: `${C}/seasons/2026?lang=en&region=us` } };
    if (url.endsWith('/seasons/2026/types')) return { items: [{ $ref: `${C}/seasons/2026/types/1` }] };
    if (url.endsWith('/seasons/2026/types/1')) return { id: '1', name: "2026-27 English Women's Super League" };
    if (url.includes('/types/1/events')) return { items: [{ $ref: `${C}/events/${EV}?lang=en` }], pageCount: 1 };
    if (url.endsWith(`/events/${EV}`)) return { id: EV, date: '2026-09-27T13:00Z', season: { $ref: `${C}/seasons/2026` }, seasonType: { $ref: `${C}/seasons/2026/types/1` }, competitions: [{ competitors: [{ id: HOME, homeAway: 'home' }, { id: AWAY, homeAway: 'away' }] }] };
    if (url.endsWith(`/teams/${HOME}`)) return { id: HOME, displayName: 'Manchester City', abbreviation: 'MNC', isNational: false };
    if (url.endsWith(`/teams/${AWAY}`)) return { id: AWAY, displayName: 'Chelsea', abbreviation: 'CHE', isNational: false };
    if (url.endsWith('/status')) return { type: { name: 'STATUS_SCHEDULED', state: 'pre', completed: false }, period: 0 };
    if (url.includes('/roster')) return roster();
    return {};
  };
  const fetcher = async url => ({ status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body(url))) });
  const mem = new Map();
  const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const registry = { competitions: [{ slug: 'womens-super-league', name: "Women's Super League", comp_type: 'league', gender: 'women', country_code: 'ENG', tier: 1, season_format: 'split',
    external_ids: [{ provider: 'espn', external_id: 'eng.w.1', method: 'founding', evidence: 't' }],
    espn: { league: 'eng.w.1', id: '8097', enabled: true, may_found: true } }] };
  return { fetcher, storage, registry };
}
const lane = { name: 'espn_womens_super_league', competition: 'womens-super-league' };
const NOW = Date.parse('2026-09-20T12:00:00Z');
const MEN_CITY = { id: '00000000-0000-5000-8000-000000000382', slug: 'manchester-city', name: 'Manchester City', team_type: 'club', gender: 'men', founding_provider: 'espn', founding_external_id: '382' };

test("women's side named like the men's club: founded as its own team (gender women), never merged, displayed '<name> Women'", async () => {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_teams', [MEN_CITY]);
  await store.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: '382', team_id: MEN_CITY.id, method: 'founding', evidence: 't' }]);
  const w = wsl();
  await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(lane.name), now: NOW, fetcher: w.fetcher, budget: 200, force: true });
  const teams = await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'gender', 'team_type'] });
  const city = teams.filter(t => /manchester city/i.test(t.name));
  assert.equal(city.length, 2, "two canonical teams: the men's club and the women's side");
  const women = city.find(t => t.gender === 'women');
  assert.ok(women && women.id !== MEN_CITY.id);
  assert.equal(women.name, 'Manchester City Women'); assert.equal(women.slug, 'manchester-city-women');
  const chelsea = teams.find(t => t.name === 'Chelsea');
  assert.equal(chelsea.gender, 'women', 'gender comes from the competition (no men\'s namesake seeded: ESPN name kept)');
  const [x] = await store.select('soccer_team_external_ids', { columns: ['team_id', 'evidence'], eq: { provider: 'espn', external_id: HOME } });
  assert.equal(x.team_id, women.id);
  assert.match(x.evidence, /women's team/); assert.match(x.evidence, new RegExp(`men's team ${MEN_CITY.id}`));
  const [comp] = await store.select('soccer_competitions', { columns: ['gender'] });
  assert.equal(comp.gender, 'women');
  assert.equal((await store.select('soccer_identity_queue', { columns: ['id'], eq: { entity_type: 'team' } })).length, 0, 'a cross-gender namesake is not a clash');
  assert.equal((await store.select('soccer_matches', { columns: ['id'] })).length, 1);
  await store.close();
});

test("an ESPN id already mapped to a MEN's team is refused in a women's competition (queue), and no match is written", async () => {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_teams', [MEN_CITY]);
  await store.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: HOME, team_id: MEN_CITY.id, method: 'founding', evidence: 't' }]);
  const w = wsl();
  await runEspnLane(lane, { store, storage: w.storage, registry: w.registry, areas: { areas: {}, aliases: {} }, state: emptyLaneState(lane.name), now: NOW, fetcher: w.fetcher, budget: 200, force: true });
  const [q] = await store.select('soccer_identity_queue', { columns: ['reason', 'status', 'payload'], eq: { entity_type: 'team', external_id: HOME } });
  assert.equal(q.reason, 'team_gender_differs_from_competition'); assert.equal(q.status, 'open');
  assert.equal(q.payload.team_gender, 'men'); assert.equal(q.payload.competition_gender, 'women');
  assert.equal((await store.select('soccer_matches', { columns: ['id'] })).length, 0);
  await store.close();
});

test('pinned history lane: a corrected type role rebuilds the cached type index (Premiere Ligue 2022/23 regression)', async () => {
  const L = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues/fra.w.1';
  const TYPE = '2022-23 French Division 1 Féminine';
  const body = url => {
    if (url.endsWith('/seasons/2022/types')) return { items: [{ $ref: `${L}/seasons/2022/types/1` }] };
    if (url.endsWith('/seasons/2022/types/1')) return { id: '1', name: TYPE };
    if (url.includes('/types/1/events')) return { items: [{ $ref: `${L}/events/${EV}?lang=en` }], pageCount: 1 };
    if (url.endsWith(`/events/${EV}`)) return { id: EV, date: '2022-09-10T13:00Z', season: { $ref: `${L}/seasons/2022` }, seasonType: { $ref: `${L}/seasons/2022/types/1` }, competitions: [{ competitors: [{ id: HOME, homeAway: 'home' }, { id: AWAY, homeAway: 'away' }] }] };
    if (url.endsWith(`/teams/${HOME}`)) return { id: HOME, displayName: 'Lyon', isNational: false };
    if (url.endsWith(`/teams/${AWAY}`)) return { id: AWAY, displayName: 'Paris FC', isNational: false };
    if (url.endsWith('/status')) return { type: { name: 'STATUS_FULL_TIME', state: 'post', completed: true }, period: 2 };
    if (url.endsWith('/score')) return { value: 1 };
    return {};
  };
  const fetcher = async url => ({ status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body(url))) });
  const mem = new Map(); const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const comp = roles => ({ competitions: [{ slug: 'premiere-ligue', name: 'Premiere Ligue', comp_type: 'league', gender: 'women', country_code: 'FRA', tier: 1, season_format: 'split',
    external_ids: [{ provider: 'espn', external_id: 'fra.w.1', method: 'founding', evidence: 't' }], espn: { league: 'fra.w.1', id: '20955', enabled: true, may_found: true, stage_by_type: true, ...(roles ? { type_roles: roles } : {}) } }] });
  const store = await openPglite(); await applyMigrations(store);
  const plLane = { name: 'espn_premiere_ligue', competition: 'premiere-ligue' };
  const first = await runEspnLane(plLane, { store, storage, registry: comp(null), state: emptyLaneState('espn_premiere_ligue@2022:results'), now: NOW, fetcher, budget: 200, force: true, year: 2022, depth: 'results' });
  assert.equal(first.cursor.types['1'].role, 'excluded', 'the generic classifier excludes this type name');
  assert.equal(Object.keys(first.cursor.fixtures || {}).length, 0);
  const second = await runEspnLane(plLane, { store, storage, registry: comp({ [TYPE]: 'league' }), state: { lane: 'espn_premiere_ligue@2022:results', cursor: first.cursor }, now: NOW, fetcher, budget: 200, force: true, year: 2022, depth: 'results' });
  assert.equal(second.cursor.types['1'].role, 'league', 'cached index rebuilt with the corrected role');
  assert.equal(Object.keys(second.cursor.fixtures).length, 1, 'the season is indexed after the role fix');
  await store.close();
});
