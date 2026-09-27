import test from 'node:test';
import assert from 'node:assert/strict';
import { syncRows } from '../workers/soccer-ingest/src/store.js';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { buildQuery, postgrestStore, storeFromEnv } from '../workers/shared/postgrest.js';
import { assessMateriality } from '../workers/soccer-news/src/materiality.js';
import { failureState, successState, emptyLaneState, inBackoff } from '../workers/soccer-ingest/src/state.js';
import { currentSeason, runOpenLigaCurrent } from '../workers/soccer-ingest/src/openligadb-current.js';
import { SourceBlockedError } from '../workers/shared/http.js';
import * as R from '../workers/soccer-api/src/routes.js';
import { adminRaw } from '../workers/soccer-ingest/src/index.js';
import { mintId } from '../workers/shared/ids.js';

test('postgrest store refuses any project but the sports project', () => {
  assert.throws(() => storeFromEnv({ SOCCER_MODEL_SUPABASE_URL: 'https://rlfyavnhbngwbldebrid.supabase.co', SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY: 'k' }), /not the sports project/);
  assert.equal(storeFromEnv({}), null);
  assert.ok(storeFromEnv({ SOCCER_MODEL_SUPABASE_URL: 'https://tkmlnhmylqnttmnsnief.supabase.co', SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY: 'k' }));
});

test('postgrest query builder quotes list values and encodes filters', () => {
  const q = buildQuery({ columns: ['id', 'name'], eq: { provider: 'openligadb' }, in: { external_id: ['1', 'a,b', 'x"y'] }, gte: { kickoff_at: '2026-09-27T00:00:00Z' }, order: 'kickoff_at.desc', limit: 5 });
  assert.match(q, /^select=id%2Cname&provider=eq\.openligadb/);
  assert.match(q, /external_id=in\.\(1,%22a%2Cb%22,%22x%5C%22y%22\)/);
  assert.match(q, /kickoff_at=gte\.2026-09-27T00%3A00%3A00Z/);
});

test('postgrest store pages past max-rows, retries 5xx, surfaces 4xx', async () => {
  const calls = [];
  let fail = 1;
  const fake = async (url, init) => {
    calls.push([init.method, url]);
    if (url.includes('soccer_teams') && fail-- > 0) return new Response('busy', { status: 503 });
    if (url.includes('bad')) return new Response('{"message":"nope"}', { status: 400 });
    const offset = Number((url.match(/offset=(\d+)/) || [0, 0])[1]);
    const n = offset === 0 ? 1000 : 3;
    return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: offset + i }))), { status: 200 });
  };
  const s = postgrestStore('https://tkmlnhmylqnttmnsnief.supabase.co', 'k', fake);
  const rows = await s.select('soccer_teams', { columns: ['id'] });
  assert.equal(rows.length, 1003);
  assert.ok(calls.filter(([, u]) => u.includes('soccer_teams?') && u.includes('offset=')).every(([, u]) => u.includes('order=id.asc')), 'paged selects must be ordered');
  await assert.rejects(s.select('soccer_teams', { columns: '*' }), /needs an explicit order/);
  await assert.rejects(s.select('bad', { limit: 1 }), /postgrest 400/);
  await s.upsert('soccer_teams', [{ id: 'a' }], ['id']);
  assert.ok(calls.some(([m, u]) => m === 'POST' && u.endsWith('soccer_teams?on_conflict=id')));
});

test('lane state: backoff doubles, blocks go straight to 6 h, success clears', () => {
  const now = Date.parse('2026-09-27T12:00:00Z');
  let s = failureState(emptyLaneState('x'), new Error('boom'), now);
  assert.equal(s.health, 'degraded');
  assert.equal(Date.parse(s.backoff_until) - now, 5 * 60e3);
  s = failureState(s, new Error('boom'), now);
  assert.equal(Date.parse(s.backoff_until) - now, 10 * 60e3);
  const b = failureState(emptyLaneState('x'), new SourceBlockedError('u', 403, 'forbidden'), now);
  assert.equal(b.health, 'blocked');
  assert.equal(Date.parse(b.backoff_until) - now, 6 * 3600e3);
  assert.ok(inBackoff(b, now + 1000));
  const ok = successState(b, { now, observed: 9, changed: 2, captureId: 'c', parserVersion: 'p', changedValue: 'md5' });
  assert.equal(ok.health, 'ok'); assert.equal(ok.backoff_until, null); assert.equal(ok.records_changed, 2); assert.ok(ok.last_change_at);
  assert.equal(currentSeason(new Date('2026-09-27')), 2026);
  assert.equal(currentSeason(new Date('2027-03-01')), 2026);
});

// ---- OpenLigaDB current lane against a fake upstream + PGlite
const REG = { competitions: [{ slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1, external_ids: [{ provider: 'wyscout', external_id: '426', method: 'founding', evidence: 't' }, { provider: 'openligadb', external_id: 'bl1', method: 'reviewed', evidence: 't' }] }] };
const olm = (id, g, t1, t2, date, fin, s1, s2, goals = []) => ({ matchID: id, matchDateTimeUTC: `${date}Z`, leagueId: 1, leagueSeason: 2026, leagueShortcut: 'bl1', group: { groupOrderID: g },
  team1: { teamId: t1, teamName: `Club ${t1}`, shortName: `C${t1}` }, team2: { teamId: t2, teamName: `Club ${t2}`, shortName: `C${t2}` }, matchIsFinished: fin,
  matchResults: fin ? [{ resultTypeID: 1, pointsTeam1: 0, pointsTeam2: 0 }, { resultTypeID: 2, pointsTeam1: s1, pointsTeam2: s2 }] : [], goals });
function fakeUpstream(state) {
  const calls = [];
  const memStore = new Map();
  const storage = { async head(k) { return memStore.has(k); }, async put(k, b) { memStore.set(k, b); }, async get(k) { return memStore.get(k) || null; } };
  const fetcher = async url => {
    calls.push(url);
    let body;
    if (url.endsWith('/getcurrentgroup/bl1')) body = { groupOrderID: 1 };
    else if (url.includes('/getlastchangedate/')) body = state.changes[url.split('/').pop()] || '2026-01-01T00:00:00';
    else if (/getmatchdata\/bl1\/2026\/\d+$/.test(url)) body = state.matches.filter(m => String(m.group.groupOrderID) === url.split('/').pop());
    else body = state.matches;
    return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body)) };
  };
  return { calls, storage, fetcher };
}

test('openligadb current lane: first run founds the season; unchanged matchdays are not re-downloaded; score changes update the canonical match', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const up = { changes: { 1: 'A', 2: 'A' }, matches: [olm(1, 1, 10, 20, '2026-09-26T13:30:00', false, null, null), olm(2, 2, 20, 10, '2026-10-03T13:30:00', false, null, null)] };
  const f = fakeUpstream(up);
  const now = Date.parse('2026-09-26T14:00:00Z');
  const r1 = await runOpenLigaCurrent({ store, storage: f.storage, registry: REG, state: emptyLaneState('x'), now, fetcher: f.fetcher });
  assert.equal(r1.inLiveWindow, false); // nothing stored yet when the window was computed
  const [m1] = await store.select('soccer_matches', { columns: ['status', 'home_score'], eq: { id: mintId('match', 'openligadb', 1) } });
  assert.equal(m1.status, 'live');
  // same change dates -> no matchdata download
  const st = { ...emptyLaneState('x'), cursor: r1.cursor, last_attempt_at: new Date(now).toISOString() };
  f.calls.length = 0;
  await runOpenLigaCurrent({ store, storage: f.storage, registry: REG, state: st, now: now + 300e3, fetcher: f.fetcher });
  assert.equal(f.calls.filter(u => u.includes('getmatchdata')).length, 0);
  // matchday 1 finishes 2-1 with a goal by an unknown scorer
  up.matches[0] = olm(1, 1, 10, 20, '2026-09-26T13:30:00', true, 2, 1, [
    { goalID: 1, scoreTeam1: 1, scoreTeam2: 0, matchMinute: 10, goalGetterID: 555, goalGetterName: 'A. Scorer', isPenalty: false, isOwnGoal: false, isOvertime: false },
    { goalID: 2, scoreTeam1: 1, scoreTeam2: 1, matchMinute: 50, goalGetterID: 556, goalGetterName: 'B. Other', isPenalty: false, isOwnGoal: false, isOvertime: false },
    { goalID: 3, scoreTeam1: 2, scoreTeam2: 1, matchMinute: 88, goalGetterID: 555, goalGetterName: 'A. Scorer', isPenalty: true, isOwnGoal: false, isOvertime: false }]);
  up.changes[1] = 'B';
  const r3 = await runOpenLigaCurrent({ store, storage: f.storage, registry: REG, state: { ...st, cursor: r1.cursor }, now: now + 600e3, fetcher: f.fetcher });
  assert.ok(r3.changed > 0);
  assert.deepEqual(f.calls.filter(u => u.includes('getmatchdata')).map(u => u.split('/').slice(-1)[0]), ['1']);
  const [m2] = await store.select('soccer_matches', { columns: ['status', 'home_score', 'away_score'], eq: { id: mintId('match', 'openligadb', 1) } });
  assert.deepEqual(m2, { status: 'finished', home_score: 2, away_score: 1 });
  assert.equal(await store.count('soccer_match_events', { eq: { source_family: 'openligadb' } }), 3);
  assert.equal(await store.count('soccer_identity_queue', { eq: { reason: 'scorer_without_canonical_identity' } }), 2);
  assert.equal(await store.count('soccer_players'), 0); // abbreviated names never found a person
  const changes = await store.select('soccer_source_changes', { columns: ['field', 'provider'], eq: { entity_table: 'soccer_matches' } });
  assert.ok(changes.some(c => c.field === 'home_score' && c.provider === 'openligadb'));
  await store.close();
});

test('raw admin upload is write-once and content addressed', async () => {
  const objs = new Map();
  const env = { SOCCER_SOURCE: { async get(k) { const v = objs.get(k); return v ? { arrayBuffer: async () => v } : null; }, async put(k, v) { objs.set(k, v); } } };
  const body = new TextEncoder().encode('hello').buffer;
  const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const key = `soccer-source/openligadb/sha256/2c/${sha}`;
  const put = b => adminRaw(new Request('https://x', { method: 'PUT', body: b }), env, key);
  const [r1, s1] = await put(body);
  assert.equal(s1, 201); assert.equal(r1.verified, true);
  const [r2, s2] = await put(body);
  assert.equal(s2, 200); assert.equal(r2.existed, true);
  const [, s3] = await adminRaw(new Request('https://x', { method: 'PUT', body: new TextEncoder().encode('evil').buffer }), env, key);
  assert.equal(s3, 422);
  const [, s4] = await adminRaw(new Request('https://x', { method: 'PUT', body }), env, '../../etc/passwd');
  assert.equal(s4, 400);
});

test('materiality: ordinary results are match pages; angles make news', () => {
  const mk = (id, day, h, a, hs, as, hh = 0, ah = 0) => ({ id, matchday: day, kickoff_at: `2026-${String(8 + Math.floor(day / 4)).padStart(2, '0')}-${String(1 + (day % 4) * 7).padStart(2, '0')}T13:30:00Z`, home_team_id: h, away_team_id: a, home_score: hs, away_score: as, home_score_ht: hh, away_score_ht: ah });
  const plain = mk('m1', 1, 'A', 'B', 2, 1, 1, 0);
  const r = assessMateriality(plain, [plain]);
  assert.equal(r.material, false); assert.equal(r.reason, 'ordinary_result_match_page_only');
  const comeback = mk('m2', 1, 'C', 'D', 3, 2, 0, 2);
  assert.equal(assessMateriality(comeback, [comeback]).material, true);
  const hat = assessMateriality(plain, [plain], { goals: [{ is_goal: true, player_id: 'p' }, { is_goal: true, player_id: 'p' }, { is_goal: true, player_id: 'p' }] });
  assert.ok(hat.angles.some(a => a.key === 'multi_goal_scorer' && a.weight === 1.2)); assert.equal(hat.material, true);
  const brace = assessMateriality(plain, [plain], { goals: [{ is_goal: true, player_id: 'p' }, { is_goal: true, player_id: 'p' }] });
  assert.equal(brace.material, false); // a brace alone is below threshold
  const unresolved = assessMateriality(plain, [plain], { goals: [{ is_goal: true, player_id: null }, { is_goal: true, player_id: null }, { is_goal: true, player_id: null }] });
  assert.equal(unresolved.angles.length, 0); // unresolved scorers never make a story
  // winning streak of 5
  const season = [mk('s1', 1, 'A', 'B', 1, 0), mk('s2', 2, 'C', 'A', 0, 1), mk('s3', 3, 'A', 'D', 2, 0), mk('s4', 4, 'E', 'A', 0, 3)];
  const t = mk('s5', 5, 'A', 'F', 2, 0);
  assert.ok(assessMateriality(t, [...season, t]).angles.some(a => a.key === 'winning_streak' && a.detail.run === 5));
});

test('api routes serve an envelope and hide internals (PGlite)', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const f = fakeUpstream({ changes: {}, matches: [olm(1, 1, 10, 20, '2026-09-20T13:30:00', true, 3, 0, []), olm(2, 1, 30, 40, '2026-09-20T13:30:00', true, 1, 1, [])] });
  await runOpenLigaCurrent({ store, storage: f.storage, registry: REG, state: emptyLaneState('x'), now: Date.parse('2026-09-27T00:00:00Z'), fetcher: f.fetcher });
  const tbl = await R.table(store, { competition: 'bundesliga' });
  assert.equal(tbl.meta.coverage.state, 'ok');
  assert.ok(tbl.meta.semantics && tbl.meta.source && tbl.meta.source_updated_at);
  assert.deepEqual(tbl.data.rows.map(r => [r.team.name, r.points]), [['Club 10', 3], ['Club 30', 1], ['Club 40', 1], ['Club 20', 0]]);
  assert.ok(tbl.meta.attribution.some(a => a.includes('ODbL')));
  assert.deepEqual(tbl.data.rows.map(r => [r.won, r.drawn, r.lost, r.form.join('')]), [[1, 0, 0, 'W'], [0, 1, 0, 'D'], [0, 1, 0, 'D'], [0, 0, 1, 'L']]);
  const list = await R.matches(store, { competition: 'bundesliga', limit: 500 });
  assert.equal(list.data.length, 2);
  assert.deepEqual(list.data[0].intel, { lineups: false, stats: false, event_map: false }); // OpenLigaDB: results only
  const comp = await R.competition(store, 'bundesliga');
  assert.deepEqual([comp.data.current.matches, comp.data.current.finished, comp.data.current.teams.length], [2, 2, 4]);
  const m = await R.match(store, list.data[0].id);
  assert.equal(m.meta.coverage.state, 'partial'); // no ledger, no lineups
  assert.ok(!JSON.stringify(m).includes('capture_id') && !JSON.stringify(m).includes('identity_queue'));
  const team = await R.team(store, 'club-10');
  assert.deepEqual(team.data.form, ['W']);
  assert.deepEqual([team.data.records[0].position, team.data.records[0].record.points, team.data.records[0].record.won], [1, 3, 1]);
  assert.deepEqual(team.data.players_observed, { lineups_counted: 0, players: [] }); // no sourced lineups -> nothing invented
  // Media: only approved rows with a cached copy are exposed; review_required never is.
  const [c10] = await store.select('soccer_teams', { columns: ['id'], eq: { slug: 'club-10' } });
  const base = { entity_type: 'team', entity_id: c10.id, media_type: 'crest', source: 'wikimedia_commons', url: 'https://upload.wikimedia.org/c.png' };
  await store.insert('soccer_entity_media', [{ ...base, id: '00000000-0000-5000-8000-0000000000b1', source_url: 'https://commons.wikimedia.org/wiki/File:Unclear.png', rights_status: 'review_required' }]);
  await store.insert('soccer_entity_media', [
    { ...base, id: '00000000-0000-5000-8000-0000000000b2', source_url: 'https://commons.wikimedia.org/wiki/File:Crest.svg', rights_status: 'approved', license: 'Public domain', license_url: 'https://commons.wikimedia.org/wiki/File:Crest.svg', attribution: 'Public domain, via Wikimedia Commons', verified_at: new Date().toISOString(), content_sha256: 'c'.repeat(64), object_key: 'soccer-source/media/sha256/cc/' + 'c'.repeat(64), cached_url: '/api/soccer/media/' + 'c'.repeat(64), is_primary: true },
  ]);
  const tm = await R.team(store, 'club-10');
  assert.equal(tm.data.media.length, 1); assert.equal(tm.data.crest.url, '/api/soccer/media/' + 'c'.repeat(64));
  assert.ok(!JSON.stringify(tm).includes('Unclear.png') && !JSON.stringify(tm).includes('object_key'));
  const lm = await R.matches(store, { competition: 'bundesliga' });
  assert.ok(lm.data.some(m => m.home.crest?.attribution === 'Public domain, via Wikimedia Commons'));
  await assert.rejects(R.mediaObject(store, { get: async () => null }, 'd'.repeat(64)), /not found/); // unknown / unapproved hash
  const news = await R.news(store, {});
  assert.equal(news.meta.coverage.state, 'unavailable');
  await assert.rejects(R.team(store, 'nope'), /not found/);
  const comps = await R.competitions(store);
  assert.deepEqual(comps.data.map(c => c.slug), ['bundesliga']);
  await store.close();
});

test('ESPN never founds a competition another provider owns, and disabled lanes do nothing', async () => {
  const { runEspnLane } = await import('../workers/soccer-ingest/src/espn-jobs.js');
  const store = await openPglite(); await applyMigrations(store);
  const reg = { competitions: [
    { slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1, season_format: 'split', espn: { league: 'ger.1', id: '720', enabled: true, may_found: false }, external_ids: [{ provider: 'wyscout', external_id: '426', method: 'founding', evidence: 't' }] },
    { slug: 'mls', name: 'MLS', comp_type: 'league', gender: 'men', country_code: 'USA', tier: 1, season_format: 'calendar', espn: { league: 'usa.1', id: '770', enabled: false, may_found: true }, external_ids: [{ provider: 'espn', external_id: 'usa.1', method: 'founding', evidence: 't' }] },
  ] };
  const calls = [];
  const fetcher = async url => {
    calls.push(url);
    let body = {};
    if (/leagues\/ger\.1$/.test(url)) body = { season: { $ref: 'http://x/leagues/ger.1/seasons/2026' } };
    else if (url.endsWith('/types')) body = { items: [{ $ref: 'http://x/seasons/2026/types/1' }] };
    else if (url.includes('/events?')) body = { items: [{ $ref: 'http://x/events/1' }, { $ref: 'http://x/events/2' }], pageCount: 1, count: 2 };
    else if (/events\/\d+$/.test(url)) { const id = url.split('/').pop(); body = { id, date: '2026-09-20T13:30Z', season: { $ref: 'http://x/seasons/2026' }, competitions: [{ competitors: [{ id: id === '1' ? '132' : '134', homeAway: 'home' }, { id: id === '1' ? '134' : '132', homeAway: 'away' }] }] }; }
    return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body)) };
  };
  const mem = new Map();
  const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const out = await runEspnLane({ name: 'espn_bundesliga', competition: 'bundesliga' }, { store, storage, registry: reg, state: emptyLaneState('x'), fetcher, budget: 20 });
  assert.equal(out.results[0].team_identity.waiting_for_owner_fixture_graph, true);
  assert.equal(await store.count('soccer_teams'), 0);
  assert.equal(await store.count('soccer_matches'), 0);
  calls.length = 0;
  const off = await runEspnLane({ name: 'espn_mls', competition: 'mls' }, { store, storage, registry: reg, state: emptyLaneState('x'), fetcher, budget: 20 });
  assert.match(off.skipped, /not enabled/); assert.equal(calls.length, 0);
  await store.close();
});

test('api: matches carry competition; from/to/order; coverage aggregate is honest', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const f = fakeUpstream({ changes: {}, matches: [olm(1, 1, 10, 20, '2026-09-20T13:30:00', true, 3, 0, []), olm(2, 2, 30, 40, '2026-10-20T13:30:00', false, null, null, [])] });
  await runOpenLigaCurrent({ store, storage: f.storage, registry: REG, state: emptyLaneState('x'), now: Date.parse('2026-09-27T00:00:00Z'), fetcher: f.fetcher });
  const all = await R.matches(store, { competition: 'bundesliga' });
  assert.deepEqual(all.data[0].competition, { slug: 'bundesliga', name: 'Bundesliga' });
  const upcoming = await R.matches(store, { competition: 'bundesliga', from: '2026-09-27', order: 'asc' });
  assert.deepEqual(upcoming.data.map(m => m.status), ['scheduled']);
  const recent = await R.matches(store, { competition: 'bundesliga', to: '2026-09-27', status: 'finished' });
  assert.equal(recent.data.length, 1);
  const bad = await R.matches(store, { competition: 'bundesliga', from: 'drop table' });
  assert.equal(bad.data.length, 2); // invalid dates are ignored, never interpolated
  const cov = await R.coverage(store);
  assert.deepEqual(cov.data.totals, { canonical_matches: 2, finished_matches: 1, events: 0, events_with_coordinates: 0, coordinate_backed_matches: 0, matches_with_lineups: 0 });
  assert.equal(cov.data.competitions[0].slug, 'bundesliga');
  await store.close();
});

test('api: sitemap feed lists canonical keys with genuine updated_at only', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const f = fakeUpstream({ changes: {}, matches: [olm(1, 1, 10, 20, '2026-09-20T13:30:00', true, 3, 0, [])] });
  await runOpenLigaCurrent({ store, storage: f.storage, registry: REG, state: emptyLaneState('x'), now: Date.parse('2026-09-27T00:00:00Z'), fetcher: f.fetcher });
  const m = await R.sitemap(store, 'matches');
  assert.equal(m.data.length, 1); assert.ok(m.data[0].key.length === 36 && m.data[0].updated_at);
  const t = await R.sitemap(store, 'teams');
  assert.deepEqual(t.data.map(x => x.key).sort(), ['club-10', 'club-20']);
  await assert.rejects(R.sitemap(store, 'secrets'), /not found/);
  await store.close();
});
