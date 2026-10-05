// Phase 2 (docs/COMPETITION_DESKS.md section 7): per-competition state `news:comp:<slug>:state` + per-competition health.
// Observational only: the newsroom's reads, candidates, keys, packets, desk inputs, gates, statuses and writes are
// identical with and without state (frozen production replay vs the RC2.1 reference); KV state writes are the only new
// side effect. Activity comes from canonical fixtures/results/enrichment the runner already loaded.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import * as neu from '../workers/soccer-news/src/pipeline.js';
import * as old from './fixtures/news/legacy-pipeline.js';
import worker, { run, stateRecorder, competitionsHealth, NEWS_CRON } from '../workers/soccer-news/src/index.js';
import { activityAt, competitionState, nextTickAt, parseState, seasonFacts, stateKey, STATE_VERSION, REGISTRY_VERSION } from '../workers/soccer-news/src/runner-state.js';
import { competitionDiagnostic, publicationDiagnostic } from '../workers/soccer-news/src/news-health.js';
import { replayStore, unpackReads } from '../scripts/news/replay-store.mjs';

const H = 3600e3;
const memKV = ({ failPut = false, failGet = false } = {}) => {
  const m = new Map();
  return { m, puts: 0,
    async get(k, t) { if (failGet) throw new Error('kv get down'); return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; },
    async put(k, v) { this.puts += 1; if (failPut && k.startsWith('news:comp:')) throw new Error('kv put down'); m.set(k, v); },
  };
};
const stateOf = (kv, slug) => parseState(kv.m.get(stateKey(slug)) ?? null).state;

// ---------------------------------------------------------------- 1. parity: state is the only new side effect
const fx = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/news/runner-parity-prod.json.gz', import.meta.url))).toString('utf8'));
for (const r of fx.runs) {
  test(`state parity ${r.at} ${r.variant}: with the state recorder, reads/summary/keys/packets/writes == RC2.1; one state per competition`, async () => {
    const reads = unpackReads(r.reads, fx.blobs);
    const a = replayStore(reads); const b = replayStore(reads);
    const now = r.opts.now;
    const kv = memKV(); const rec = stateRecorder(kv, { now, cfg: r.opts.cfg });
    const sa = await old.runNews(a, { ...r.opts, env: r.env });
    const sb = await neu.runNews(b, { ...r.opts, env: r.env, onCompetition: rec.hook });
    assert.deepEqual(b.issued, a.issued, 'state adds no read and reorders none');
    assert.deepEqual(b.unconsumed, []);
    assert.equal(JSON.stringify(sb), JSON.stringify(sa), 'identical newsroom summary');
    assert.equal(JSON.stringify(b.writes), JSON.stringify(a.writes), 'identical article / evidence / event writes');
    assert.equal(rec.writes.ok, fx.competitions.length); assert.equal(rec.writes.failed, 0);
    for (const slug of fx.competitions) {
      const s = stateOf(kv, slug);
      assert.ok(s, `${slug} state written`); assert.equal(s.slug, slug); assert.equal(s.last_run_outcome, 'ran');
      const c = sa.competitions[slug];
      for (const k of ['candidates', 'new', 'duplicates', 'published', 'held']) assert.equal(s[k], c[k], `${slug}.${k} mirrors the run`);
      assert.deepEqual(s.existing, c.existing); assert.deepEqual(s.hold_reasons, c.holds);
      assert.equal(s.registry_version, REGISTRY_VERSION); assert.equal(s.versions.state, STATE_VERSION);
      assert.ok(s.profile, `${slug} has its publishing profile`);
    }
  });
}

test('real production picture 2026-10-05 10:30Z: PL / Bundesliga / UCL quiet in the international break, Nations League on a matchday — all healthy', async () => {
  const r = fx.runs.find(x => x.variant === 'natural' && x.at.startsWith('2026-10-05'));
  const kv = memKV(); const rec = stateRecorder(kv, { now: r.opts.now, cfg: r.opts.cfg });
  await neu.runNews(replayStore(unpackReads(r.reads, fx.blobs)), { ...r.opts, env: r.env, onCompetition: rec.hook });
  const act = Object.fromEntries(fx.competitions.map(s => [s, stateOf(kv, s).activity]));
  assert.equal(act['premier-league'], 'quiet'); assert.equal(act.bundesliga, 'quiet'); assert.equal(act['uefa-champions-league'], 'quiet');
  assert.equal(act['uefa-nations-league'], 'matchday', 'UNL: next kick-off 2026-10-05 16:00Z inside 12 h');
  assert.equal(stateOf(kv, 'premier-league').fixtures.next_fixture_at, '2026-10-10T11:30:00.000Z');
  const tick = { at: new Date(r.opts.now).toISOString(), outcome: 'ran', news_enabled: true };
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick, store: null, now: r.opts.now + 20 * 6e4 });
  for (const s of fx.competitions) assert.equal(h.competitions[s].ok, true, `${s}: ${h.competitions[s].state}`);
  assert.equal(h.competitions['premier-league'].state, 'healthy_no_publishable_material');
  assert.match(h.competitions['premier-league'].message, /quiet/);
  assert.equal(h.competitions['uefa-nations-league'].state, 'healthy_material_held_by_gates', 'UNL: 10 existing stories held');
  assert.equal(h.ok, true);
  // the same quiet states 5 h later, no new run: still healthy (quiet window 6 h); 7 h: runner_stale
  const later = await competitionsHealth({ SOCCER_STATE: kv }, { tick: { ...tick, at: new Date(r.opts.now + 5 * H).toISOString() }, store: null, now: r.opts.now + 5 * H });
  assert.equal(later.competitions['premier-league'].ok, true, 'quiet + no run for 5 h is not stale');
  assert.equal(later.competitions['uefa-nations-league'].state, 'runner_stale', 'UNL had fixtures: stale after 2 h');
  // phase 4: quiet runs every 6 h, so quiet is stale only after cadence + 90 min = 7.5 h
  const seven = await competitionsHealth({ SOCCER_STATE: kv }, { tick: { ...tick, at: new Date(r.opts.now + 7 * H).toISOString() }, store: null, now: r.opts.now + 7 * H });
  assert.equal(seven.competitions['premier-league'].ok, true, 'quiet + 7 h: inside its 6 h cadence + 90 min');
  const much = await competitionsHealth({ SOCCER_STATE: kv }, { tick: { ...tick, at: new Date(r.opts.now + 8 * H).toISOString() }, store: null, now: r.opts.now + 8 * H });
  assert.equal(much.competitions['premier-league'].state, 'runner_stale', 'quiet but no run for 8 h: stale');
});

test('real production picture 2026-09-21: post-match Premier League / Bundesliga after the 09-20 round', async () => {
  const r = fx.runs.find(x => x.variant === 'natural' && x.at.startsWith('2026-09-21'));
  const kv = memKV(); const rec = stateRecorder(kv, { now: r.opts.now, cfg: r.opts.cfg });
  await neu.runNews(replayStore(unpackReads(r.reads, fx.blobs)), { ...r.opts, env: r.env, onCompetition: rec.hook });
  for (const s of ['premier-league', 'bundesliga']) assert.ok(['post_match', 'pre_match', 'matchday'].includes(stateOf(kv, s).activity), `${s}: ${stateOf(kv, s).activity}`);
  assert.equal(stateOf(kv, 'premier-league').recaps.finished_in_window > 0, true);
});

// ---------------------------------------------------------------- 2. activity from canonical fixtures (pure)
const NOW = Date.parse('2026-10-10T12:00:00Z');
const iso = ms => new Date(ms).toISOString();
function season(rows, base = NOW) {
  const matches = rows.map(([status, offH], i) => ({ id: `m${i}`, kickoff_at: iso(base + offH * H), status, home_score: status === 'finished' ? 1 : null, away_score: status === 'finished' ? 0 : null, updated_at: iso(NOW - H) }));
  return { comp: { id: 'c1', slug: 'x' }, season: { label: '2026/27' }, matches, finished: matches.filter(m => m.status === 'finished') };
}
const act = (rows, o) => activityAt(seasonFacts(season(rows), NOW), NOW, o);
test('activity: quiet / pre_match / matchday / live / final_ready / post_match, highest wins', () => {
  assert.equal(act([['finished', -10 * 24], ['scheduled', 5 * 24]]), 'quiet', 'international break');
  assert.equal(act([['finished', -10 * 24], ['scheduled', 20]]), 'pre_match', 'kick-off in 20 h');
  assert.equal(act([['scheduled', 3], ['scheduled', 20]]), 'matchday', 'kick-off in 3 h');
  assert.equal(act([['live', -0.5], ['scheduled', 3]]), 'live');
  assert.equal(act([['finished', -3], ['scheduled', 3]], { newRecaps: 1 }), 'final_ready', 'a new ready recap this run');
  assert.equal(act([['finished', -20], ['scheduled', 5 * 24]]), 'post_match');
  assert.equal(act([['finished', -40]]), 'quiet', 'post-match ends at 36 h');
  // a 'live' row that kicked off 10 h ago is a stuck status: reported, never live
  const f = seasonFacts(season([['live', -10]]), NOW);
  assert.equal(f.live_matches, 0); assert.equal(f.live_status_stuck, 1); assert.equal(activityAt(f, NOW), 'quiet');
  assert.equal(f.fixtures_next_24h, 0);
  assert.equal(seasonFacts(season([['scheduled', 3], ['scheduled', 23], ['scheduled', 25]]), NOW).fixtures_next_24h, 2);
  assert.equal(activityAt(null, NOW), 'quiet');
});
test('a stale state re-derives activity from its stored timeline: written quiet 30 h before a kick-off, read 20 h later = matchday', () => {
  const f = seasonFacts(season([['scheduled', 30]]), NOW);
  assert.equal(activityAt(f, NOW), 'quiet');
  assert.equal(activityAt(f, NOW + 20 * H), 'matchday');
  assert.equal(activityAt(f, NOW + 31 * H), 'matchday', 'kicked off since the state was written');
});
test('next due = the next 7,37 tick', () => {
  assert.equal(nextTickAt(NEWS_CRON, Date.parse('2026-10-05T11:37:00Z')), '2026-10-05T12:07:00.000Z');
  assert.equal(nextTickAt(NEWS_CRON, Date.parse('2026-10-05T11:40:10Z')), '2026-10-05T12:07:00.000Z');
  assert.equal(nextTickAt(NEWS_CRON, Date.parse('2026-10-05T23:50:00Z')), '2026-10-06T00:07:00.000Z');
});

// ---------------------------------------------------------------- 3. end to end on PGlite (real runner, real detector)
const id = n => `00000000-0000-5000-8000-0000000d${String(n).padStart(4, '0')}`;
async function seed({ now, rows }) {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }, { id: id(2), slug: 'mls', name: 'MLS', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(3), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }, { id: id(4), competition_id: id(2), label: '2026', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: id(5), season_id: id(3), name: 'Regular season', stage_type: 'league', stage_order: 1 }, { id: id(6), season_id: id(4), name: 'Regular season', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley'].map((n, i) => ({ id: id(10 + i), slug: n.toLowerCase(), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(700 + i) }));
  await store.insert('soccer_teams', teams);
  const pairs = [[0, 1], [2, 3], [4, 5], [0, 2], [1, 4], [3, 5], [5, 0], [3, 1], [4, 2]];
  const hist = pairs.map(([h, a], i) => ({ id: id(20 + i), competition_id: id(1), season_id: id(3), stage_id: id(5), kickoff_at: iso(now - (30 - i) * 24 * H), home_team_id: teams[h].id, away_team_id: teams[a].id, status: 'finished', home_score: (i % 3), away_score: 1, result_provider: 'espn', updated_at: iso(now - 24 * H) }));
  const extra = rows.map(([status, offH, h, a, hs, as], i) => ({ id: id(60 + i), competition_id: id(1), season_id: id(3), stage_id: id(5), kickoff_at: iso(now + offH * H), home_team_id: teams[h].id, away_team_id: teams[a].id, status, home_score: status === 'finished' ? hs : null, away_score: status === 'finished' ? as : null, result_provider: 'espn', updated_at: iso(now - H) }));
  await store.insert('soccer_matches', [...hist, ...extra]);
  return store;
}
const env0 = { NEWS_DESK: 'off', NEWS_ENABLED: 'on' };

test('final_ready vs final awaiting enrichment (real detector + enrichment ledger)', async () => {
  const now = Date.parse('2026-10-18T20:07:00Z');
  const store = await seed({ now, rows: [['finished', -3, 0, 3, 4, 0], ['finished', -2.5, 1, 2, 3, 0]] });
  // match 61: enrichment final -> ready; match 60: plays unavailable with a retry pending -> awaiting enrichment
  await store.insert('soccer_match_enrichment', ['lineup_home', 'lineup_away', 'stats_home', 'stats_away', 'plays'].map(component => ({ match_id: id(61), component, provider: 'espn', status: 'complete' })));
  await store.insert('soccer_match_enrichment', [{ match_id: id(60), component: 'plays', provider: 'espn', status: 'unavailable', next_retry_at: iso(now + 600e3) }]); // separate insert: a batch takes its columns from the first row
  const kv = memKV();
  const s = await run({ ...env0, SOCCER_STATE: kv }, { store, now, competitions: ['premier-league'] });
  const st = stateOf(kv, 'premier-league');
  assert.equal(st.recaps.awaiting_enrichment, 1, 'one final awaiting enrichment');
  assert.ok(st.new_recaps >= 1 && st.activity === 'final_ready', `ready recap -> final_ready (${st.activity}, ${st.new_recaps})`);
  assert.equal(s.state_writes.ok, 1);
  // only the awaiting match: post_match, never final_ready
  const store2 = await seed({ now, rows: [['finished', -2.5, 1, 2, 3, 0]] });
  await store2.insert('soccer_match_enrichment', [{ match_id: id(60), component: 'plays', provider: 'espn', status: 'unavailable', next_retry_at: iso(now + 600e3) }]);
  const kv2 = memKV();
  await run({ ...env0, SOCCER_STATE: kv2 }, { store: store2, now, competitions: ['premier-league'] });
  const st2 = stateOf(kv2, 'premier-league');
  assert.equal(st2.recaps.awaiting_enrichment, 1); assert.equal(st2.new_recaps, 0); assert.equal(st2.activity, 'post_match');
  await store.close(); await store2.close();
});

test('live and matchday from canonical status; dry / review / forced preview write no state', async () => {
  const now = Date.parse('2026-10-18T15:07:00Z');
  const store = await seed({ now, rows: [['live', -0.6, 0, 1], ['scheduled', 4, 2, 3]] });
  const kv = memKV();
  await run({ ...env0, SOCCER_STATE: kv }, { store, now, competitions: ['premier-league'] });
  const st = stateOf(kv, 'premier-league');
  assert.equal(st.activity, 'live'); assert.equal(st.fixtures.live_matches, 1); assert.equal(st.fixtures.fixtures_next_24h, 1);
  const kv2 = memKV();
  await run({ ...env0, SOCCER_STATE: kv2 }, { store, now, competitions: ['premier-league'], dry: true });
  await run({ ...env0, SOCCER_STATE: kv2 }, { store, now, competitions: ['premier-league'], previewMatch: id(61) });
  await run({ ...env0, SOCCER_STATE: kv2 }, { store, now, competitions: ['premier-league'], previewMatch: id(61), review: true });
  assert.equal(kv2.m.size, 0, 'no state and no news:last_run from dry / forced / review runs');
  await store.close();
});

test('state persistence failure: the run, its publications/holds and its summary are exactly as without state', async () => {
  const now = Date.parse('2026-10-18T20:07:00Z');
  const rows = [['finished', -3, 0, 3, 4, 0], ['scheduled', 20, 2, 5]];
  const A = await seed({ now, rows }); const B = await seed({ now, rows });
  const sa = await old.runNews(A, { now, competitions: ['premier-league', 'mls'], env: env0 });
  const kv = memKV({ failPut: true });
  const sb = await run({ ...env0, SOCCER_STATE: kv }, { store: B, now, competitions: ['premier-league', 'mls'] });
  assert.deepEqual(sb.state_writes, { version: STATE_VERSION, ok: 0, failed: 2, errors: ['premier-league: kv put down', 'mls: kv put down'] });
  const { elapsed_ms, state_writes, ...core } = sb;
  assert.equal(JSON.stringify(core), JSON.stringify(sa), 'same newsroom result');
  const dump = async s => JSON.stringify((await s.select('soccer_articles', { columns: ['id', 'slug', 'status', 'hold_reasons', 'packet_hash', 'headline'], order: 'id.asc' })));
  assert.equal(await dump(B), await dump(A), 'same articles');
  assert.ok(kv.m.get('news:last_run'), 'the run summary is still recorded');
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick: { at: iso(now), outcome: 'ran', news_enabled: true }, store: null, now: now + 60e3 });
  assert.equal(h.competitions['premier-league'].state, 'state_missing'); assert.equal(h.ok, false);
  await A.close(); await B.close();
});

test('one competition runner failure: visible on that competition, earlier ones healthy, later ones blocked (no isolation yet); the tick still fails', async () => {
  const now = Date.parse('2026-10-18T20:07:00Z');
  const store = await seed({ now, rows: [['scheduled', 20, 2, 5]] });
  const kv = memKV();
  // tick 1 (all fine): 3 competitions run
  const comps = ['premier-league', 'mls', 'bundesliga'];
  await run({ ...env0, SOCCER_STATE: kv }, { store, now: now - 30 * 6e4, competitions: comps });
  // tick 2: the store fails while MLS loads -> MLS failed, Bundesliga never runs, the run throws as before
  let mlsReads = 0;
  const flaky = { select: async (t, o) => { if (t === 'soccer_competitions' && o?.eq?.slug === 'mls' && ++mlsReads) throw new Error('boom mls'); return store.select(t, o); }, insert: (...a) => store.insert(...a) };
  await assert.rejects(run({ ...env0, SOCCER_STATE: kv }, { store: flaky, now, competitions: comps }), /boom mls/);
  assert.equal(stateOf(kv, 'mls').last_run_outcome, 'failed'); assert.match(stateOf(kv, 'mls').error, /boom mls/);
  assert.equal(stateOf(kv, 'bundesliga').last_run_at, iso(now - 30 * 6e4), 'bundesliga keeps its previous state');
  const tick = { at: iso(now), outcome: 'failed', news_enabled: true };
  const raw = Object.fromEntries(comps.map(s => [s, kv.m.get(stateKey(s))]));
  const failedThisTick = 'mls';
  assert.equal(competitionDiagnostic({ slug: 'premier-league', raw: raw['premier-league'], tick, now: now + 60e3, failedThisTick }).ok, true, 'PL ran this tick: healthy');
  const m = competitionDiagnostic({ slug: 'mls', raw: raw.mls, tick, now: now + 60e3, failedThisTick });
  assert.equal(m.state, 'run_failing'); assert.equal(m.ok, false);
  const b = competitionDiagnostic({ slug: 'bundesliga', raw: raw.bundesliga, tick, now: now + 60e3, failedThisTick });
  assert.equal(b.state, 'blocked_by_runner_failure'); assert.equal(b.blocked_by, 'mls');
  await store.close();
});

test('missing league-phase config: fail closed, zero reads, state says config_missing', async () => {
  const kv = memKV();
  const throwing = { select: () => { throw new Error('must not read'); } };
  const now = Date.parse('2026-10-18T20:07:00Z');
  await run({ ...env0, SOCCER_STATE: kv }, { store: throwing, now, competitions: ['uefa-champions-league'] }); // no UCL_LEAGUE_PHASE_END in env
  const st = stateOf(kv, 'uefa-champions-league');
  assert.equal(st.last_run_outcome, 'skipped_config'); assert.equal(st.skipped, 'config_missing:UCL_LEAGUE_PHASE_END');
  const d = competitionDiagnostic({ slug: 'uefa-champions-league', raw: kv.m.get(stateKey('uefa-champions-league')), tick: { at: iso(now), outcome: 'ran' }, now: now + 60e3 });
  assert.equal(d.state, 'config_missing'); assert.equal(d.ok, false);
});

// ---------------------------------------------------------------- 4. diagnostics edge cases
const T0 = Date.parse('2026-10-05T12:00:00Z');
const goodState = (o = {}) => JSON.stringify({ ...competitionState({ slug: 'mls', result: { out: { candidates: 0, new: 0, duplicates: 0, published: 0, held: 0, holds: {}, by_class: {}, stories: [], existing: { published: 0, held: 0, other: 0, held_reasons: {} } }, routing: { lanes: {} } }, facts: seasonFacts(season([['scheduled', 50]], T0), T0), now: T0, cron: NEWS_CRON, stories: [] }), ...o });
test('diagnostics: missing, malformed, unreadable, disabled, cron not firing, stale with fixtures', () => {
  const tick = { at: iso(T0), outcome: 'ran', news_enabled: true };
  assert.equal(competitionDiagnostic({ slug: 'mls', raw: null, tick, now: T0 }).state, 'state_missing');
  for (const bad of ['{', '[]', '{"state_version":"x"}', JSON.stringify({ state_version: STATE_VERSION, last_run_at: 'nope', activity: 'quiet' }), JSON.stringify({ state_version: STATE_VERSION, last_run_at: iso(T0), activity: 'party' })]) {
    const d = competitionDiagnostic({ slug: 'mls', raw: bad, tick, now: T0 });
    assert.equal(d.state, 'state_malformed', bad); assert.equal(d.ok, false);
  }
  assert.equal(competitionDiagnostic({ slug: 'mls', raw: null, readError: 'kv down', tick, now: T0 }).state, 'state_unreadable');
  assert.equal(competitionDiagnostic({ slug: 'mls', raw: goodState(), tick: { ...tick, outcome: 'disabled', news_enabled: false }, now: T0 }).state, 'disabled');
  assert.equal(competitionDiagnostic({ slug: 'mls', raw: goodState(), tick: { ...tick, at: iso(T0 - 3 * H) }, now: T0 }).state, 'cron_not_firing');
  // written quiet (kick-off 50 h out); 40 h later the fixture is 10 h out -> active -> no run for 40 h = stale (2 h rule)
  const later = T0 + 40 * H;
  const d = competitionDiagnostic({ slug: 'mls', raw: goodState(), tick: { ...tick, at: iso(later - 60e3) }, now: later });
  assert.equal(d.state, 'runner_stale'); assert.equal(d.activity_now, 'matchday'); assert.equal(d.ok, false);
  // fresh + healthy, and recent publication
  assert.equal(competitionDiagnostic({ slug: 'mls', raw: goodState(), tick, now: T0 + 60e3 }).state, 'healthy_no_publishable_material');
  assert.equal(competitionDiagnostic({ slug: 'mls', raw: goodState(), tick, now: T0 + 60e3, newestPublishedAt: iso(T0 - H) }).state, 'publishing');
});

test('/health: aggregate fields and status code unchanged; competitions view added; OFF lanes reported truthfully', async () => {
  const kv = memKV();
  const now = Date.now();
  const tick = { at: iso(now - 5 * 6e4), news_enabled: true, outcome: 'ran' };
  const last = { at: tick.at, competitions: { mls: { candidates: 2, new: 0, published: 0, held: 0, holds: {}, existing: { published: 1, held: 1, other: 0, held_reasons: {} } } } };
  kv.m.set('news:last_tick', JSON.stringify(tick)); kv.m.set('news:last_run', JSON.stringify(last));
  kv.m.set(stateKey('mls'), JSON.stringify({ ...JSON.parse(goodState()), last_run_at: tick.at }));
  const res = await worker.fetch(new Request('https://x/health'), { SOCCER_STATE: kv, NEWS_ENABLED: 'on' });
  const body = await res.json();
  const expected = publicationDiagnostic({ tick, last, newestPublishedAt: null, now });
  assert.equal(res.status, expected.ok ? 200 : 503, 'status code still from the aggregate diagnostic');
  assert.equal(body.state, expected.state);
  for (const k of ['ok', 'state', 'message', 'publication', 'version', 'news_enabled', 'last_tick', 'desk', 'ai', 'last_run']) assert.ok(k in body, `aggregate field ${k} kept`);
  assert.deepEqual(Object.keys(body.competitions.competitions), neu.NEWS_COMPETITIONS, 'exactly the five enabled competitions');
  assert.equal(body.competitions.competitions.mls.ok, true);
  assert.equal(body.competitions.competitions.bundesliga.state, 'state_missing', 'no state yet -> reported, not guessed');
  const off = body.competitions.off.map(c => c.slug).sort();
  assert.deepEqual(off, ['fifa-world-cup', 'la-liga', 'liga-f', 'ligue-1', 'nwsl', 'premiere-ligue', 'serie-a', 'uefa-europa-league', 'uefa-european-championship', 'uefa-womens-champions-league', 'womens-super-league']);
  for (const c of body.competitions.off) { assert.equal(c.mode, 'off'); assert.equal(c.publishing_profile, 'none', `${c.slug}: no fake profile`); }
});

test('/health newest published per competition comes from that competition\'s own rows (never another desk\'s)', async () => {
  const now = Date.parse('2026-10-18T08:07:00Z');
  const store = await seed({ now, rows: [['scheduled', 4, 0, 3], ['scheduled', 6, 1, 5], ['scheduled', 8, 2, 4]] });
  const kv = memKV();
  await run({ ...env0, SOCCER_STATE: kv }, { store, now, competitions: ['premier-league', 'mls'] });
  const arts = await store.select('soccer_articles', { columns: ['id', 'status'], eq: { status: 'published' }, order: 'id.asc' });
  assert.ok(arts.length >= 2, 'the seed publishes previews');
  // spread publication times: the NEWEST must win, whatever the row order
  for (const [i, a] of arts.entries()) await store.update('soccer_articles', { published_at: iso(now - (i + 1) * 5 * H) }, { eq: { id: a.id } });
  await store.update('soccer_articles', { published_at: iso(now - 2 * H) }, { eq: { id: arts.at(-1).id } });
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick: { at: iso(now), outcome: 'ran', news_enabled: true }, store, now: now + 60e3 });
  assert.equal(Date.parse(h.competitions['premier-league'].newest_published_at), now - 2 * H);
  assert.equal(h.competitions['premier-league'].state, 'publishing');
  assert.equal(h.competitions.mls.newest_published_at, null, 'MLS published nothing: not credited with PL stories');
  assert.notEqual(h.competitions.mls.state, 'publishing');
  await store.close();
});
