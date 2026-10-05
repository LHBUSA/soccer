// Phase 4 (docs/COMPETITION_DESKS.md section 8): activity-aware scheduling. The scheduler changes HOW OFTEN a
// competition's runner looks, never WHAT it may publish; final_ready never waits; the plan fails OPEN (run all).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { NEWS_COMPETITIONS, runNews } from '../workers/soccer-news/src/pipeline.js';
import { runnerRpc, runIsolated } from '../workers/soccer-news/src/isolation.js';
import { runTick, competitionsHealth, NEWS_CRON } from '../workers/soccer-news/src/index.js';
import { CADENCE_MS, TICK_TOLERANCE_MS, decide, planTick, scheduleActivity, SCHEDULE_VERSION } from '../workers/soccer-news/src/schedule.js';
import { competitionState, parseState, seasonFacts, stateKey } from '../workers/soccer-news/src/runner-state.js';
import { publicationDiagnostic } from '../workers/soccer-news/src/news-health.js';
import { replayStore, unpackReads } from '../scripts/news/replay-store.mjs';

const M = 60e3; const H = 3600e3;
const NOW = Date.parse('2026-10-10T12:07:00Z');
const iso = ms => new Date(ms).toISOString();
const m = (status, offH) => ({ kickoff_at: iso(NOW + offH * H), status });
const memKV = () => { const mm = new Map(); return { m: mm, async get(k, t) { return mm.has(k) ? (t === 'json' ? JSON.parse(mm.get(k)) : mm.get(k)) : null; }, async put(k, v) { mm.set(k, v); } }; };
const stateRaw = (o = {}) => JSON.stringify({ slug: 'mls', state_version: 'soccer-news-comp-state/1.1.0', activity: 'quiet', last_run_at: iso(NOW - 10 * M), last_run_outcome: 'ran', recaps: { awaiting_enrichment: 0, too_soon: 0 }, deferred: 0, new_recaps: 0, ...o });

// ------------------------------------------------------------------ activity + cadence (pure)
test('activity from canonical rows: live > final_ready (kicked off <= 8 h) > matchday (<= 12 h) > pre_match (<= 26 h) > post_match (finished <= 36 h) > quiet', () => {
  assert.equal(scheduleActivity([m('live', -0.5), m('scheduled', 3)], NOW), 'live');
  assert.equal(scheduleActivity([m('finished', -2.5), m('scheduled', 3)], NOW), 'final_ready');
  assert.equal(scheduleActivity([m('scheduled', -0.2)], NOW), 'final_ready', 'kicked off, status not yet updated: still every tick');
  assert.equal(scheduleActivity([m('finished', -7.9)], NOW), 'final_ready');
  assert.equal(scheduleActivity([m('scheduled', 5)], NOW), 'matchday');
  assert.equal(scheduleActivity([m('scheduled', 20)], NOW), 'pre_match');
  assert.equal(scheduleActivity([m('finished', -20)], NOW), 'post_match');
  assert.equal(scheduleActivity([m('finished', -40), m('scheduled', 30)], NOW), 'quiet');
  assert.equal(scheduleActivity([m('postponed', -2), m('cancelled', -1)], NOW), 'quiet', 'postponed / cancelled never wake a desk');
  assert.equal(scheduleActivity([], NOW), 'quiet'); assert.equal(scheduleActivity(undefined, NOW), 'quiet');
  assert.deepEqual(CADENCE_MS, { live: 30 * M, final_ready: 30 * M, matchday: 30 * M, pre_match: 60 * M, post_match: 120 * M, quiet: 360 * M });
});

test('cadence: every tick while live / final_ready / matchday; hourly pre_match; 2 h post_match; 6 h quiet (5 min tick tolerance)', () => {
  const d = (rows, lastAgo, o = {}) => decide({ slug: 'mls', matches: rows, raw: stateRaw({ last_run_at: iso(NOW - lastAgo), ...o }), now: NOW });
  assert.equal(d([m('scheduled', 5)], 1 * M).due, true);
  assert.equal(d([m('live', -1)], 1 * M).due, true);
  assert.equal(d([m('finished', -2)], 1 * M).due, true, 'final_ready never waits');
  assert.equal(d([m('scheduled', 20)], 30 * M).due, false); assert.equal(d([m('scheduled', 20)], 56 * M).due, true);
  assert.equal(d([m('finished', -20)], 90 * M).due, false); assert.equal(d([m('finished', -20)], 116 * M).due, true);
  assert.equal(d([], 5 * H).due, false); assert.equal(d([], 6 * H - TICK_TOLERANCE_MS).due, true);
  const nd = d([], 30 * M);
  assert.equal(nd.reason, 'not_due:quiet'); assert.equal(nd.next_due_at, iso(NOW - 30 * M + 6 * H));
});

test('pending work forces every tick whatever the activity; missing / malformed state runs', () => {
  for (const [o, reason] of [[{ last_run_outcome: 'failed' }, 'last_run_failed'], [{ deferred: 3 }, 'stories_deferred'], [{ recaps: { awaiting_enrichment: 1, too_soon: 0 } }, 'recap_awaiting_enrichment'], [{ recaps: { awaiting_enrichment: 0, too_soon: 1 } }, 'recap_too_soon'], [{ new_recaps: 2 }, 'new_recaps_last_run']]) {
    const r = decide({ slug: 'mls', matches: [], raw: stateRaw({ last_run_at: iso(NOW - 31 * M), ...o }), now: NOW });
    assert.equal(r.due, true, reason); assert.equal(r.reason, reason);
  }
  assert.equal(decide({ slug: 'mls', matches: [], raw: null, now: NOW }).reason, 'no_state');
  assert.match(decide({ slug: 'mls', matches: [], raw: '{', now: NOW }).reason, /^state_malformed/);
});

test('fail OPEN: an unreadable activity read or state runs every competition (today\'s behaviour)', async () => {
  const p = await planTick({ kv: memKV(), store: { select: async () => { throw new Error('PostgREST 503'); } }, now: NOW, competitions: NEWS_COMPETITIONS });
  assert.equal(p.mode, 'fail_open_run_all'); assert.match(p.read_error, /503/);
  assert.ok(NEWS_COMPETITIONS.every(s => p.competitions[s].due && p.competitions[s].reason === 'activity_read_failed_run_all'));
  const none = await planTick({ kv: memKV(), store: null, now: NOW, competitions: NEWS_COMPETITIONS });
  assert.ok(NEWS_COMPETITIONS.every(s => none.competitions[s].due));
  const kvDown = { get: async () => { throw new Error('kv down'); } };
  const store = await openPglite(); await applyMigrations(store);
  const k = await planTick({ kv: kvDown, store, now: NOW, competitions: NEWS_COMPETITIONS });
  assert.ok(NEWS_COMPETITIONS.every(s => k.competitions[s].due && /^state_read_failed_run/.test(k.competitions[s].reason)));
  await store.close();
});

// ------------------------------------------------------------------ end to end on PGlite (real runner, real detector)
const id = n => `00000000-0000-5000-8000-0000000b${String(n).padStart(4, '0')}`;
async function seed({ now, rows }) {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }, { id: id(2), slug: 'mls', name: 'MLS', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(3), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: id(5), season_id: id(3), name: 'Regular season', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley'].map((n, i) => ({ id: id(10 + i), slug: n.toLowerCase(), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(900 + i) }));
  await store.insert('soccer_teams', teams);
  const pairs = [[0, 1], [2, 3], [4, 5], [0, 2], [1, 4], [3, 5], [5, 0], [3, 1], [4, 2]];
  const hist = pairs.map(([h, a], i) => ({ id: id(20 + i), competition_id: id(1), season_id: id(3), stage_id: id(5), kickoff_at: iso(now - (30 - i) * 24 * H), home_team_id: teams[h].id, away_team_id: teams[a].id, status: 'finished', home_score: i % 3, away_score: 1, result_provider: 'espn', updated_at: iso(now - 24 * H) }));
  const extra = rows.map(([status, offH, h, a, hs, as], i) => ({ id: id(60 + i), competition_id: id(1), season_id: id(3), stage_id: id(5), kickoff_at: iso(now + offH * H), home_team_id: teams[h].id, away_team_id: teams[a].id, status, home_score: status === 'finished' ? hs : null, away_score: status === 'finished' ? as : null, result_provider: 'espn', updated_at: iso(now - H) }));
  await store.insert('soccer_matches', [...hist, ...extra]);
  return store;
}
const ENV = { NEWS_DESK: 'off', NEWS_ENABLED: 'on', UCL_LEAGUE_PHASE_END: '2027-02-01T00:00:00Z' };
const tickWith = async (store, kv, now) => runTick({ ...ENV, SOCCER_STATE: kv }, null, { now, store, dispatch: (slug, o) => runnerRpc(ENV, slug, structuredClone(o), { store }).catch(e => { throw new Error(e.message); }) });

test('final_ready runs on the SAME tick: a quiet competition that ran 10 min ago still runs when a match has just finished, and the recap is the same story the unscheduled newsroom writes', async () => {
  const now = Date.parse('2026-10-18T20:07:00Z');
  const store = await seed({ now, rows: [['finished', -2.5, 1, 2, 3, 0]] });
  const ref = await seed({ now, rows: [['finished', -2.5, 1, 2, 3, 0]] });
  const kv = memKV();
  kv.m.set(stateKey('premier-league'), stateRaw({ slug: 'premier-league', last_run_at: iso(now - 10 * M) })); // 'quiet' 10 min ago
  const s = await tickWith(store, kv, now);
  assert.equal(s.schedule.competitions['premier-league'].activity, 'final_ready');
  assert.equal(s.competitions['premier-league'].scheduled.ran, true);
  const r = await runNews(ref, { now, competitions: ['premier-league'], env: ENV });
  const keys = async st => (await st.select('soccer_news_events', { columns: ['id', 'story_class'], order: 'id.asc' }));
  assert.deepEqual(await keys(store), await keys(ref), 'identical stories (keys, classes) to the unscheduled newsroom');
  assert.ok((await keys(store)).some(e => e.story_class === 'match_recap'), 'the recap was written this tick');
  assert.equal(s.competitions['premier-league'].new, r.competitions['premier-league'].new);
  await store.close(); await ref.close();
});

test('a quiet competition that is not due is skipped; its previous entry is carried (marked) so the tick summary and aggregate health are unchanged', async () => {
  const now = Date.parse('2026-10-18T20:07:00Z');
  const store = await seed({ now, rows: [['scheduled', 5 * 24, 0, 1]] }); // PL quiet (next fixture in 5 days)
  const kv = memKV();
  const first = await tickWith(store, kv, now - 30 * M);                 // first tick: no state -> every competition runs
  assert.ok(NEWS_COMPETITIONS.every(s => first.competitions[s].scheduled.ran));
  const second = await tickWith(store, kv, now);                         // 30 min later: quiet competitions are not due
  const pl = second.competitions['premier-league'];
  assert.equal(pl.scheduled.ran, false); assert.equal(pl.scheduled.reason, 'not_due:quiet');
  assert.equal(pl.scheduled.carried_from, first.at); assert.equal(pl.candidates, first.competitions['premier-league'].candidates);
  assert.equal(parseState(kv.m.get(stateKey('premier-league'))).state.last_run_at, first.at, 'state is the REAL last run, not rewritten');
  assert.deepEqual(Object.keys(second.competitions), NEWS_COMPETITIONS, 'every enabled competition still described');
  const third = await tickWith(store, kv, now + 30 * M);
  assert.equal(third.competitions['premier-league'].scheduled.carried_from, first.at, 'carried twice: still names the real run');
  const tick = { at: iso(now), outcome: 'ran', news_enabled: true };
  assert.equal(publicationDiagnostic({ tick, last: second, newestPublishedAt: null, now: now + M }).state, publicationDiagnostic({ tick, last: first, newestPublishedAt: null, now: now + M }).state);
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick, store: null, now: now + M });
  assert.equal(h.competitions['premier-league'].ok, true, 'a skipped quiet competition is healthy, not stale');
  await store.close();
});

test('24 h simulation (48 ticks): quiet every 6 h, then pre_match hourly, then every tick through matchday / live / final, then post_match every 2 h', async () => {
  const start = Date.parse('2026-10-17T00:07:00Z');
  const kickoff = start + 20 * H; // one fixture, kick-off 20:07
  const runs = [];
  const kv = memKV();
  for (let i = 0; i < 48 * 2; i++) {
    const now = start + i * 30 * M;
    const status = now < kickoff ? 'scheduled' : now < kickoff + 2 * H ? 'live' : 'finished';
    const matches = new Map([['mls', [{ kickoff_at: iso(kickoff), status }]]]);
    const raw = kv.m.get(stateKey('mls')) ?? null;
    const d = decide({ slug: 'mls', matches: matches.get('mls'), raw, now });
    if (d.due) { runs.push([(now - start) / H, d.activity]); kv.m.set(stateKey('mls'), stateRaw({ last_run_at: iso(now), activity: d.activity })); }
  }
  const at = h => runs.find(r => r[0] === h);
  const hours = runs.map(r => r[0]);
  // quiet until kick-off - 26 h does not exist here (fixture 20 h after start): pre_match from the start
  assert.deepEqual(hours.filter(h => h < 8), [0, 1, 2, 3, 4, 5, 6, 7], 'pre_match: hourly');
  for (let h = 8; h < 22; h += 0.5) assert.ok(at(h), `every tick from 12 h before kick-off through the match (${h} h)`);
  assert.ok(hours.filter(h => h >= 22 && h < 28).length === 12, 'final_ready: every tick for 8 h after kick-off');
  const post = hours.filter(h => h >= 28 && h <= 56);
  assert.deepEqual(post.slice(0, 4), [28, 30, 32, 34], 'post_match: every 2 h');
  const quiet = hours.filter(h => h > 56);
  assert.ok(quiet.every((h, i) => i === 0 || h - quiet[i - 1] === 6), `quiet: every 6 h (${quiet})`);
});

// ------------------------------------------------------------------ scheduling never changes WHAT a runner produces
const fx = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/news/runner-parity-prod.json.gz', import.meta.url))).toString('utf8'));
const toml = readFileSync(new URL('../workers/soccer-news/wrangler.toml', import.meta.url), 'utf8');
const VARS = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "([^"]*)"/gm)].map(x => [x[1], x[2]]));
test('a due competition produces exactly the phase 3 result (frozen production replay, every run)', async () => {
  for (const r of fx.runs.filter(x => x.variant !== 'natural')) {
    const env = { ...VARS, ...r.env };
    const a = replayStore(unpackReads(r.reads, fx.blobs)); const b = replayStore(unpackReads(r.reads, fx.blobs));
    const lb = st => (slug, o) => runnerRpc(env, slug, structuredClone(o), { store: st });
    const base = await runIsolated(env, { now: r.opts.now, dispatch: lb(a) });
    const kv = memKV(); // no state -> every competition due; store null -> fail open (also all due)
    const sched = await runTick({ ...env, SOCCER_STATE: kv }, null, { now: r.opts.now, store: null, dispatch: lb(b) });
    for (const s of NEWS_COMPETITIONS) { const { scheduled, ...c } = sched.competitions[s]; assert.equal(JSON.stringify(c), JSON.stringify(base.competitions[s]), `${r.at} ${r.variant} ${s}`); }
    assert.deepEqual(b.writes.map(w => JSON.stringify(w)).sort(), a.writes.map(w => JSON.stringify(w)).sort());
  }
});

test('state records the schedule decision and the real next due time', () => {
  const st = competitionState({ slug: 'mls', result: { out: { candidates: 0, new: 0, duplicates: 0, published: 0, held: 0, holds: {}, by_class: {}, stories: [], existing: { published: 0, held: 0, other: 0, held_reasons: {} } }, routing: { lanes: {} } }, facts: seasonFacts(null, NOW), now: NOW, cron: NEWS_CRON, schedule: { activity: 'quiet', cadence_min: 360, reason: 'cadence_elapsed:quiet' } });
  assert.deepEqual(st.cadence, { activity: 'quiet', minutes: 360, reason: 'cadence_elapsed:quiet' });
  assert.equal(st.next_due_at, '2026-10-10T18:07:00.000Z');
  const pend = competitionState({ slug: 'mls', error: new Error('x'), facts: null, now: NOW, cron: NEWS_CRON, schedule: { activity: 'quiet', cadence_min: 360, reason: 'r' } });
  assert.equal(pend.next_due_at, '2026-10-10T12:37:00.000Z', 'a failed run is due again next tick');
  assert.equal(SCHEDULE_VERSION, 'soccer-news-schedule/1.0.0');
});
