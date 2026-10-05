// Phase 3 (docs/COMPETITION_DESKS.md section 6): competition runner ISOLATION. The cron dispatches each enabled
// competition as its own loopback RPC invocation (worker.js NewsRunner via ctx.exports). Proven here:
//  - all healthy: identical competition summaries, candidates, keys, packets, routing and writes as the sequential
//    in-process orchestrator (frozen production replay vs the RC2.1 reference);
//  - a failure in the MIDDLE runner: earlier competitions healthy, the failed one run_failing, every later one still runs
//    and writes a fresh state, the tick is `ran`, and no blocked_by_runner_failure exists any more;
//  - strict runner input (slug allow-list, option allow-list), missing config, no season, KV state failure, dry/review,
//    timeout, missing loopback binding.
// The fake loopback mirrors RPC: options and results cross by structured clone; an error crosses as a NEW Error with
// the same message (Cloudflare preserves name + message, not identity or stack).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import * as old from './fixtures/news/legacy-pipeline.js';
import { NEWS_COMPETITIONS } from '../workers/soccer-news/src/pipeline.js';
import { runIsolated, runnerRpc, runnerOptions, RUNNER_DEADLINE_MS } from '../workers/soccer-news/src/isolation.js';
import worker, { runTick, competitionsHealth, stateRecorder, NEWS_CRON } from '../workers/soccer-news/src/index.js';
import { competitionDiagnostic } from '../workers/soccer-news/src/news-health.js';
import { parseState, stateKey, competitionState, seasonFacts } from '../workers/soccer-news/src/runner-state.js';
import { replayStore, unpackReads } from '../scripts/news/replay-store.mjs';

const fx = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/news/runner-parity-prod.json.gz', import.meta.url))).toString('utf8'));
const toml = readFileSync(new URL('../workers/soccer-news/wrangler.toml', import.meta.url), 'utf8');
const VARS = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "([^"]*)"/gm)].map(m => [m[1], m[2]])); // production vars
const memKV = ({ failPut = false } = {}) => { const m = new Map(); return { m, async get(k, t) { return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; }, async put(k, v) { if (failPut && k.startsWith('news:comp:')) throw new Error('kv put down'); m.set(k, v); } }; };
const stateOf = (kv, slug) => parseState(kv.m.get(stateKey(slug)) ?? null).state;
// RPC-faithful fake of ctx.exports.NewsRunner.run
const loopback = (env, storeFor) => async (slug, opts) => {
  const o = structuredClone(opts);
  try { return structuredClone(await runnerRpc(env, slug, o, { store: storeFor(slug) })); } catch (e) { throw new Error(e.message); }
};
const sorted = xs => xs.map(x => JSON.stringify(x)).sort();
const withoutDispatch = s => { const { dispatch, elapsed_ms, state_writes, ...rest } = s; return rest; };

// ------------------------------------------------------------------ 1. healthy isolated dispatch == sequential baseline
for (const r of fx.runs) {
  test(`isolated parity ${r.at} ${r.variant}: summaries, candidates, keys, packets, routing and writes identical`, async () => {
    const reads = unpackReads(r.reads, fx.blobs);
    const a = replayStore(reads); const b = replayStore(reads);
    const env = { ...VARS, ...r.env };
    const sa = await old.runNews(a, { ...r.opts, env: r.env });
    const sb = await runIsolated(env, { now: r.opts.now, dry: !!r.opts.dry, dispatch: loopback(env, () => b) });
    assert.equal(JSON.stringify(withoutDispatch(sb)), JSON.stringify(sa), 'identical summary (registry-order merge, same key order, same routing counts)');
    assert.deepEqual(sorted(b.writes), sorted(a.writes), 'identical writes (runners run concurrently: compared as a set)');
    assert.deepEqual(b.unconsumed, [], 'every recorded read issued'); assert.deepEqual([...b.issued].sort(), [...a.issued].sort(), 'same reads, no extra');
    assert.deepEqual(Object.values(sb.dispatch.runners).map(x => x.outcome), NEWS_COMPETITIONS.map(() => 'ran'));
    // writes per competition keep their in-runner order
    const byComp = ws => { const o = {}; for (const w of ws) for (const row of w.rows) { const k = row.competition_id || row.news_event_id || row.id; (o[w.table] ||= []).push(k); } return o; };
    if (a.writes.length) assert.deepEqual(Object.keys(byComp(b.writes)).sort(), Object.keys(byComp(a.writes)).sort());
  });
}

// ------------------------------------------------------------------ 2. failure in the middle runner
const natural = fx.runs.find(x => x.variant === 'natural' && x.at.startsWith('2026-10-05'));
function tickHarness({ failSlug = null, kv = memKV(), exports = true, run = natural } = {}) {
  const env = { ...VARS, ...run.env, NEWS_ENABLED: 'on', SOCCER_STATE: kv };
  const store = replayStore(unpackReads(run.reads, fx.blobs));
  // the failing runner's store throws inside runCompetition (a real runner exception, not a dispatch error)
  const failing = { select: async () => { throw new Error('PostgREST 503 while loading the season'); } };
  const ctx = { pending: [], waitUntil(p) { this.pending.push(p); }, ...(exports ? { exports: { NewsRunner: { run: loopback(env, slug => (slug === failSlug ? failing : store)) } } } : {}) };
  return { env, ctx, kv, store };
}
const MIDDLE = NEWS_COMPETITIONS[Math.floor(NEWS_COMPETITIONS.length / 2)];

test(`injected failure in the middle runner (${MIDDLE}): earlier healthy, it is run_failing, later ones still run with fresh state; tick ran; nothing blocked`, async () => {
  assert.equal(NEWS_COMPETITIONS.indexOf(MIDDLE), 2);
  const { env, ctx, kv } = tickHarness({ failSlug: MIDDLE });
  await worker.scheduled({ cron: NEWS_CRON, scheduledTime: natural.opts.now }, env, ctx);
  await Promise.all(ctx.pending);
  const tick = JSON.parse(kv.m.get('news:last_tick'));
  assert.equal(tick.outcome, 'ran', 'a runner failure is not a cron outage');
  const last = JSON.parse(kv.m.get('news:last_run'));
  assert.deepEqual(Object.keys(last.competitions), NEWS_COMPETITIONS, 'news:last_run represents the whole tick');
  assert.equal(last.competitions[MIDDLE].failed, true); assert.match(last.competitions[MIDDLE].error, /PostgREST 503/);
  assert.equal(last.dispatch.failed, 1);
  assert.deepEqual(last.state_writes, { version: 'soccer-news-comp-state/1.1.0', ok: 5, failed: 0 });
  for (const s of NEWS_COMPETITIONS) {
    const st = stateOf(kv, s);
    assert.equal(st.last_run_at, tick.at, `${s}: fresh state this tick`); assert.equal(st.dispatch, 'isolated');
    assert.equal(st.last_run_outcome, s === MIDDLE ? 'failed' : 'ran', s);
  }
  // later competitions produced their real results (same as the healthy baseline)
  const healthy = await runIsolated({ ...VARS, ...natural.env }, { now: natural.opts.now, dry: true, dispatch: loopback({ ...VARS, ...natural.env }, () => replayStore(unpackReads(natural.reads, fx.blobs))) });
  for (const s of NEWS_COMPETITIONS.filter(x => x !== MIDDLE)) assert.equal(JSON.stringify(last.competitions[s]), JSON.stringify(healthy.competitions[s]), `${s} unaffected by the failure`);
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick, store: null, now: natural.opts.now + 60e3 });
  assert.equal(h.competitions[MIDDLE].state, 'run_failing'); assert.equal(h.competitions[MIDDLE].ok, false);
  for (const s of NEWS_COMPETITIONS.filter(x => x !== MIDDLE)) { assert.equal(h.competitions[s].ok, true, `${s}: ${h.competitions[s].state}`); assert.notEqual(h.competitions[s].state, 'blocked_by_runner_failure'); }
  assert.deepEqual(h.failing, [MIDDLE]);
});

test('every position fails alone without affecting the others', async () => {
  for (const failSlug of NEWS_COMPETITIONS) {
    const { env, ctx, kv } = tickHarness({ failSlug });
    await worker.scheduled({ cron: NEWS_CRON, scheduledTime: natural.opts.now }, env, ctx); await Promise.all(ctx.pending);
    assert.equal(JSON.parse(kv.m.get('news:last_tick')).outcome, 'ran');
    for (const s of NEWS_COMPETITIONS) assert.equal(stateOf(kv, s).last_run_outcome, s === failSlug ? 'failed' : 'ran', `${failSlug} fails: ${s}`);
  }
});

test('a hung runner times out as its own failure; the others finish', async () => {
  const env = { ...VARS, ...natural.env };
  const store = replayStore(unpackReads(natural.reads, fx.blobs));
  const lb = loopback(env, () => store);
  const s = await runIsolated(env, { now: natural.opts.now, dry: true, deadlineMs: 200, dispatch: (slug, o) => (slug === 'mls' ? new Promise(() => {}) : lb(slug, o)) });
  assert.equal(s.dispatch.runners.mls.outcome, 'failed'); assert.match(s.dispatch.runners.mls.error, /runner_timeout/);
  for (const x of NEWS_COMPETITIONS.filter(x => x !== 'mls')) assert.equal(s.dispatch.runners[x].outcome, 'ran');
  assert.equal(RUNNER_DEADLINE_MS, 600000);
});

test('missing loopback binding: the tick fails LOUDLY (no silent in-process fallback); health says orchestrator_failed, never blocked', async () => {
  const kv = memKV();
  // a previous good isolated tick
  const first = tickHarness({ kv }); await worker.scheduled({ cron: NEWS_CRON, scheduledTime: natural.opts.now }, first.env, first.ctx); await Promise.all(first.ctx.pending);
  const t2 = natural.opts.now + 30 * 6e4;
  const { env, ctx } = tickHarness({ kv, exports: false });
  await worker.scheduled({ cron: NEWS_CRON, scheduledTime: t2 }, env, ctx); await Promise.all(ctx.pending);
  const tick = JSON.parse(kv.m.get('news:last_tick'));
  assert.equal(tick.outcome, 'failed');
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick, store: null, now: t2 + 60e3 });
  for (const s of NEWS_COMPETITIONS) assert.equal(h.competitions[s].state, 'orchestrator_failed', s);
});

test('legacy phase 2 state (in-process) still reads as blocked_by_runner_failure; isolated states never do', () => {
  const T = Date.parse('2026-10-05T12:07:00Z'); const tick = { at: new Date(T).toISOString(), outcome: 'failed', news_enabled: true };
  const mk = (o, at) => JSON.stringify({ ...competitionState({ slug: 'bundesliga', result: { out: { candidates: 0, new: 0, duplicates: 0, published: 0, held: 0, holds: {}, by_class: {}, stories: [], existing: { published: 0, held: 0, other: 0, held_reasons: {} } }, routing: { lanes: {} } }, facts: seasonFacts(null, at), now: at, cron: NEWS_CRON, ...o }) });
  const legacy = JSON.parse(mk({}, T - 30 * 6e4)); delete legacy.dispatch; legacy.state_version = 'soccer-news-comp-state/1.0.0';
  assert.equal(competitionDiagnostic({ slug: 'bundesliga', raw: JSON.stringify(legacy), tick, now: T + 60e3, failedThisTick: 'mls', failedDispatch: undefined }).state, 'blocked_by_runner_failure');
  assert.equal(competitionDiagnostic({ slug: 'bundesliga', raw: mk({ dispatch: 'isolated' }, T - 30 * 6e4), tick, now: T + 60e3, failedThisTick: 'mls', failedDispatch: 'isolated' }).state, 'orchestrator_failed');
});

// ------------------------------------------------------------------ 3. strict runner input
test('runner rejects any slug that is not an enabled newsroom competition, and any unknown / unsafe option', async () => {
  const env = { ...VARS };
  const never = { select: () => { throw new Error('must not read'); } };
  for (const slug of ['la-liga', 'nwsl', 'fifa-world-cup', '__proto__', 'constructor', '', 'MLS', ' mls', null, 42, ['mls'], { slug: 'mls' }]) await assert.rejects(runnerRpc(env, slug, { now: 1 }, { store: never }), /not an enabled newsroom competition/, String(slug));
  for (const bad of [null, [], 'x', {}, { now: 'soon' }, { now: 1, review: true }, { now: 1, previewMatch: 'x' }, { now: 1, env: {} }, { now: 1, dry: 'yes' }, { now: 1, windowDays: 30 }, { now: 1, fault: true }, { now: 1, fault: 'x', dry: true }]) assert.throws(() => runnerOptions(bad), /runner:/, JSON.stringify(bad));
  assert.deepEqual(runnerOptions({ now: 5, dry: true, fault: true }), { now: 5, dry: true, fault: true });
  await assert.rejects(runnerRpc(env, 'mls', { now: 1, dry: true, fault: true }, { store: never }), /injected runner fault \(mls, dry canary\)/);
  await assert.rejects(runnerRpc({}, 'mls', { now: 1 }), /store not configured/);
});

test('missing league-phase config: UCL runner skips fail-closed with zero reads; state config_missing', async () => {
  const kv = memKV();
  const env = { NEWS_ENABLED: 'on', SOCCER_STATE: kv }; // no *_LEAGUE_PHASE_END vars
  const never = { select: () => { throw new Error('must not read'); } };
  const s = await runTick(env, null, { now: natural.opts.now, dispatch: (slug, o) => runnerRpc(env, slug, structuredClone(o), { store: slug === 'uefa-champions-league' ? never : replayStore([]) }).catch(e => { throw new Error(e.message); }) });
  assert.equal(s.competitions['uefa-champions-league'].skipped, 'config_missing:UCL_LEAGUE_PHASE_END');
  assert.equal(stateOf(kv, 'uefa-champions-league').last_run_outcome, 'skipped_config');
  const d = competitionDiagnostic({ slug: 'uefa-champions-league', raw: kv.m.get(stateKey('uefa-champions-league')), tick: { at: new Date(natural.opts.now).toISOString(), outcome: 'ran' }, now: natural.opts.now + 60e3 });
  assert.equal(d.state, 'config_missing');
});

test('no season: runner reports it, state no_season, the others unaffected', async () => {
  const store = await openPglite(); await applyMigrations(store); // empty graph: no competitions at all
  const kv = memKV(); const env = { ...VARS, NEWS_ENABLED: 'on', SOCCER_STATE: kv };
  const s = await runTick(env, null, { now: Date.now(), dispatch: (slug, o) => runnerRpc(env, slug, structuredClone(o), { store }) });
  for (const slug of NEWS_COMPETITIONS) { assert.equal(s.competitions[slug].skipped, 'no season'); assert.equal(stateOf(kv, slug).last_run_outcome, 'no_season'); }
  await store.close();
});

test('KV state-write failure: every runner still completes, the summary counts the failures, the tick is ran', async () => {
  const kv = memKV({ failPut: true });
  const { env, ctx } = tickHarness({ kv });
  await worker.scheduled({ cron: NEWS_CRON, scheduledTime: natural.opts.now }, env, ctx); await Promise.all(ctx.pending);
  const last = JSON.parse(kv.m.get('news:last_run'));
  assert.equal(JSON.parse(kv.m.get('news:last_tick')).outcome, 'ran');
  assert.equal(last.state_writes.ok, 0); assert.equal(last.state_writes.failed, 5);
  assert.deepEqual(Object.values(last.dispatch.runners).map(r => r.outcome), NEWS_COMPETITIONS.map(() => 'ran'));
});

// ------------------------------------------------------------------ 4. admin semantics
test('/v1/run: dry / review / forced preview keep their in-process semantics; ?isolated=1 is a dry-only canary that writes nothing', async () => {
  const kv = memKV(); const env = { ...VARS, NEWS_ENABLED: 'on', SOCCER_STATE: kv, NEWS_ADMIN_TOKEN: 'tok' };
  const post = (q, ctx = {}) => worker.fetch(new Request(`https://x/v1/run${q}`, { method: 'POST', headers: { authorization: 'Bearer tok' } }), env, ctx);
  assert.equal((await worker.fetch(new Request('https://x/v1/run?isolated=1&dry=1', { method: 'POST' }), env, {})).status, 401, 'admin token still required for the admin route');
  assert.equal((await post('?isolated=1')).status, 400, 'isolated needs dry=1');
  assert.equal((await post('?isolated=1&dry=1&review=1&preview_match=00000000-0000-5000-8000-000000000001')).status, 400);
  assert.equal((await post('?isolated=1&dry=1&fault=la-liga')).status, 400, 'fault only for an enabled competition');
  assert.equal((await post('?isolated=1&dry=1', {})).status, 500, 'no loopback binding -> loud error');
  const store = replayStore(unpackReads(natural.reads, fx.blobs));
  const calls = [];
  const ctx = { exports: { NewsRunner: { run: (slug, o) => { calls.push([slug, o]); return loopback(env, () => store)(slug, o); } } } };
  const res = await post('?isolated=1&dry=1&fault=uefa-champions-league', ctx);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(calls.every(([, o]) => o.dry === true), 'every runner dispatched dry');
  assert.equal(body.dispatch.runners['uefa-champions-league'].outcome, 'failed'); assert.match(body.dispatch.runners['uefa-champions-league'].error, /injected runner fault/);
  assert.equal(body.dispatch.failed, 1);
  assert.deepEqual(store.writes, [], 'zero writes'); assert.equal(kv.m.size, 0, 'no state, no news:last_run, no tick');
});

test('production-shaped five-run aggregation through the scheduled handler', async () => {
  const { env, ctx, kv } = tickHarness();
  await worker.scheduled({ cron: NEWS_CRON, scheduledTime: natural.opts.now }, env, ctx); await Promise.all(ctx.pending);
  const last = JSON.parse(kv.m.get('news:last_run'));
  assert.deepEqual(Object.keys(last.dispatch.runners), NEWS_COMPETITIONS);
  assert.equal(last.dispatch.failed, 0); assert.equal(last.state_writes.ok, 5);
  const c = last.competitions;
  assert.deepEqual([c['uefa-nations-league'].candidates, c['uefa-nations-league'].duplicates, c.mls.candidates, c.mls.duplicates], [12, 12, 2, 2], 'the 2026-10-05 production picture');
  for (const s of ['bundesliga', 'premier-league', 'uefa-champions-league']) assert.equal(c[s].candidates, 0);
  const h = await competitionsHealth({ SOCCER_STATE: kv }, { tick: JSON.parse(kv.m.get('news:last_tick')), store: null, now: natural.opts.now + 60e3 });
  assert.equal(h.ok, true);
  for (const s of NEWS_COMPETITIONS) assert.equal(h.competitions[s].dispatch, 'isolated');
});

test('worker entry wiring: worker.js exports the handler + NewsRunner; wrangler main/flags; no public runner route', () => {
  const src = readFileSync(new URL('../workers/soccer-news/src/worker.js', import.meta.url), 'utf8');
  assert.match(src, /export class NewsRunner extends WorkerEntrypoint/);
  assert.match(src, /async run\(slug, opts\) \{ return runnerRpc\(this\.env, slug, opts\); \}/);
  assert.doesNotMatch(src, /fetch\s*\(/, 'the runner entrypoint has no fetch handler');
  assert.match(toml, /^main = "src\/worker\.js"$/m);
  assert.match(toml, /^compatibility_flags = \["nodejs_compat", "enable_ctx_exports"\]$/m);
  assert.match(toml, /^crons = \["7,37 \* \* \* \*"\]/m);
  assert.doesNotMatch(toml, /\[\[queues|\[\[services|MARKETS/, 'no Queue, no extra service binding');
  const idx = readFileSync(new URL('../workers/soccer-news/src/index.js', import.meta.url), 'utf8');
  assert.doesNotMatch(idx, /\/v1\/runner/, 'no /v1/runner route');
});
