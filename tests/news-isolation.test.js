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
import { runIsolated, runnerRpc, runnerOptions } from '../workers/soccer-news/src/isolation.js';
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
  const noSched = c => { const { scheduled, ...rest } = c; return rest; }; // phase 4 annotation (here: no store -> fail open, all run)
  for (const s of NEWS_COMPETITIONS.filter(x => x !== MIDDLE)) { assert.equal(JSON.stringify(noSched(last.competitions[s])), JSON.stringify(healthy.competitions[s]), `${s} unaffected by the failure`); assert.equal(last.competitions[s].scheduled.reason, 'activity_read_failed_run_all'); }
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

// ------------------------------------------------------------------ 2b. sequential real ticks + time budget (1.1.0)
const SMALL = { tickMs: 4000, softMs: 150, inflightMs: 150, reserveMs: 60, dryMs: 1000 };
const realEnv = () => ({ ...VARS, ...natural.env });

test('real isolated dispatch is SEQUENTIAL in registry order (each runner starts after the previous one ended)', async () => {
  const env = realEnv(); const store = replayStore(unpackReads(natural.reads, fx.blobs)); const lb = loopback(env, () => store);
  const events = []; let active = 0; let maxActive = 0;
  const s = await runIsolated(env, { now: natural.opts.now, dispatch: async (slug, o) => { active += 1; maxActive = Math.max(maxActive, active); events.push(['start', slug, o]); try { await new Promise(r => setTimeout(r, 5)); return await lb(slug, o); } finally { active -= 1; events.push(['end', slug]); } } });
  assert.equal(s.dispatch.concurrency, 'sequential'); assert.equal(maxActive, 1, 'never two runners at once');
  assert.deepEqual(events.filter(e => e[0] === 'start').map(e => e[1]), NEWS_COMPETITIONS);
  for (let i = 0; i < events.length; i += 2) { assert.equal(events[i][0], 'start'); assert.equal(events[i + 1][0], 'end'); assert.equal(events[i][1], events[i + 1][1]); }
  for (const [, , o] of events.filter(e => e[0] === 'start')) { assert.ok(Number.isFinite(o.softDeadlineAt), 'every real runner gets a soft deadline'); assert.equal(o.dry, undefined); }
});

test('parallel dispatch is refused for real runs and allowed for dry canaries', async () => {
  const env = realEnv();
  await assert.rejects(runIsolated(env, { now: 1, dispatch: async () => ({}), concurrency: 'parallel' }), /parallel dispatch is allowed only for dry runs/);
  const store = replayStore(unpackReads(natural.reads, fx.blobs)); let active = 0; let maxActive = 0; const lb = loopback(env, () => store);
  const s = await runIsolated(env, { now: natural.opts.now, dry: true, dispatch: async (slug, o) => { active += 1; maxActive = Math.max(maxActive, active); try { await new Promise(r => setTimeout(r, 20)); return await lb(slug, o); } finally { active -= 1; } } });
  assert.equal(s.dispatch.concurrency, 'parallel'); assert.ok(maxActive > 1, 'dry canary runs runners concurrently');
});

test('budget checks and KV call-log writes never overlap across competitions on a real multi-league news day', async () => {
  // 2026-09-21 production picture with every candidate NEW: Bundesliga 9, Premier League 5, MLS 4 -> paid desk calls in 3 competitions
  const day = fx.runs.find(x => x.variant === 'new_desk_req' && x.at.startsWith('2026-09-21'));
  const kv = memKV(); const env = { ...VARS, NEWS_ENABLED: 'on', OPENAI_API_KEY: 'k', SOCCER_STATE: kv };
  const store = replayStore(unpackReads(day.reads, fx.blobs));
  const realFetch = globalThis.fetch; let inCall = 0; let maxIn = 0; const callsBySlug = [];
  // a budget window per paid call = the breaker's KV spend read .. that call's KV call-log write (no ledger in tests)
  let openWindows = 0; let maxWindows = 0;
  const origGet = kv.get.bind(kv); const origPut = kv.put.bind(kv);
  kv.get = async (k, t) => { if (k.startsWith('openai:') && t === 'json' && !kv._inRecord) { openWindows += 1; maxWindows = Math.max(maxWindows, openWindows); } return origGet(k, t); };
  kv.put = async (k, v) => { const r = await origPut(k, v); if (k.startsWith('openai:')) openWindows -= 1; return r; };
  globalThis.fetch = async (_u, init) => {
    inCall += 1; maxIn = Math.max(maxIn, inCall);
    try {
      await new Promise(r => setTimeout(r, 3));
      const input = JSON.parse(init.body).input; const m = input.match(/"competition":\{[^}]*"slug":"([a-z-]+)"/); callsBySlug.push(m ? m[1] : '?');
      return { ok: true, json: async () => ({ id: 'r', status: 'completed', model: 'gpt-5.6-sol', usage: { input_tokens: 10, output_tokens: 10 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ headline: 'H', dek: 'D', sections: [{ heading: 'x', paragraphs: ['y'] }], emphasis: [] }) }] }] }) };
    } finally { inCall -= 1; }
  };
  try {
    const s = await runIsolated(env, { now: day.opts.now, dispatch: loopback(env, () => store) });
    assert.equal(s.dispatch.failed, 0);
    const comps = [...new Set(callsBySlug)];
    assert.ok(comps.length >= 3, `paid calls in several competitions (${comps.join(',')})`);
    assert.equal(maxIn, 1, 'never two paid desk calls at once');
    // calls are grouped by competition in registry order: no interleaving between competitions
    const order = callsBySlug.filter((x, i) => i === 0 || callsBySlug[i - 1] !== x);
    assert.deepEqual(order, NEWS_COMPETITIONS.filter(c => comps.includes(c)), 'competition budget windows strictly one after another');
    const log = JSON.parse(kv.m.get([...kv.m.keys()].find(k => k.startsWith('openai:'))));
    assert.equal(log.length, callsBySlug.length, 'KV call log lost no entry (no read-modify-write race)');
  } finally { globalThis.fetch = realFetch; }
});

test('cooperative soft deadline: no paid desk stage after it; the rest is deferred with nothing written', async () => {
  const { runCompetition } = await import('../workers/soccer-news/src/pipeline.js');
  const { leaguePhaseCfg } = await import('../workers/soccer-news/src/profiles.js');
  const day = fx.runs.find(x => x.variant === 'new_desk_off' && x.at.startsWith('2026-09-21'));
  const env = { ...VARS, ...day.env }; const cfg = leaguePhaseCfg(env);
  const full = await runCompetition(replayStore(unpackReads(day.reads, fx.blobs)), 'bundesliga', { now: day.opts.now, env, cfg });
  const a = replayStore(unpackReads(day.reads, fx.blobs));
  let checks = 0; // the clock passes the soft deadline after two stories
  const r = await runCompetition(a, 'bundesliga', { now: day.opts.now, env, cfg, softDeadlineAt: 2, clock: () => (++checks > 2 ? 5 : 0) });
  assert.equal(full.out.published, 9);
  assert.equal(r.out.published, 2); assert.equal(r.out.deferred, 7); assert.equal(r.out.deferred_reason, 'runner_time_budget');
  assert.equal(r.out.new, full.out.new, 'detection unchanged');
  const ev = st => st.writes.filter(x => x.table === 'soccer_news_events').flatMap(x => x.rows.map(y => y.id));
  const fullStore = replayStore(unpackReads(day.reads, fx.blobs));
  await runCompetition(fullStore, 'bundesliga', { now: day.opts.now, env, cfg });
  assert.deepEqual(ev(a), ev(fullStore).slice(0, 2), 'the two processed stories are written exactly as without a deadline; nothing else');
  // dry runs and runs without a deadline never defer
  const d = await runCompetition(replayStore(unpackReads(day.reads, fx.blobs)), 'bundesliga', { now: day.opts.now, env, cfg, dry: true, softDeadlineAt: 0, clock: () => 99 });
  assert.equal(d.out.deferred, undefined);
});

test('a hung runner times out as its own failure; every later runner still executes; worst-case aggregate stays inside the tick budget', async () => {
  const env = realEnv(); const store = replayStore(unpackReads(natural.reads, fx.blobs)); const lb = loopback(env, () => store);
  const started = [];
  const s = await runIsolated(env, { now: natural.opts.now, budget: SMALL, dispatch: (slug, o) => { started.push(slug); return slug === MIDDLE ? new Promise(() => {}) : lb(slug, o); } });
  assert.deepEqual(started, NEWS_COMPETITIONS, 'every later runner was dispatched');
  assert.equal(s.dispatch.runners[MIDDLE].outcome, 'failed'); assert.match(s.dispatch.runners[MIDDLE].error, /runner_timeout/);
  for (const x of NEWS_COMPETITIONS.filter(x => x !== MIDDLE)) assert.equal(s.dispatch.runners[x].outcome, 'ran', x);
  // all five hang: each one times out at its own hard deadline; total <= tick budget
  const t1 = Date.now();
  const all = await runIsolated(env, { now: natural.opts.now, budget: SMALL, dispatch: () => new Promise(() => {}) });
  const took = Date.now() - t1;
  assert.ok(took <= SMALL.tickMs + 200, `worst case ${took} ms <= tick budget ${SMALL.tickMs} ms`);
  assert.deepEqual(Object.values(all.dispatch.runners).map(r => r.outcome), NEWS_COMPETITIONS.map(() => 'failed'));
  const runs = Object.values(all.dispatch.runners);
  for (const r of runs) assert.equal(Date.parse(r.hard_deadline_at) - Date.parse(r.soft_deadline_at), SMALL.inflightMs, 'soft = hard - in-flight desk window');
  for (let i = 1; i < runs.length; i++) assert.ok(Date.parse(runs[i].soft_deadline_at) >= Date.parse(runs[i - 1].hard_deadline_at), 'a timed-out runner can no longer start a paid call when the next runner starts');
});

test('a tight tick budget still reserves time for every later runner (no runner starved by earlier hangs)', async () => {
  const TIGHT = { tickMs: 1000, softMs: 300, inflightMs: 200, reserveMs: 60, dryMs: 1000 };
  const started = [];
  const t1 = Date.now();
  const s = await runIsolated(realEnv(), { now: natural.opts.now, budget: TIGHT, dispatch: slug => { started.push(slug); return new Promise(() => {}); } });
  assert.deepEqual(started, NEWS_COMPETITIONS, 'every runner was still dispatched');
  for (const r of Object.values(s.dispatch.runners)) assert.match(r.error, /runner_timeout/, 'each hung runner timed out on its own; none starved (tick_budget_exhausted)');
  assert.ok(Date.now() - t1 <= TIGHT.tickMs + 200, 'inside the tick budget');
});

test('production budget constants: worst case for five sequential runners fits the 15 min cron wall limit', async () => {
  const { BUDGET, TICK_BUDGET_MS, RUNNER_SOFT_MS, DESK_INFLIGHT_MS } = await import('../workers/soccer-news/src/isolation.js');
  assert.equal(TICK_BUDGET_MS, 840e3); assert.equal(RUNNER_SOFT_MS, 150e3); assert.equal(DESK_INFLIGHT_MS, 125e3);
  const desk = readFileSync(new URL('../workers/soccer-news/src/desk.js', import.meta.url), 'utf8');
  assert.match(desk, /AbortSignal\.timeout\(120000\)/, 'the in-flight window covers the desk timeout');
  let now = 0; const n = NEWS_COMPETITIONS.length; const tickEnd = BUDGET.tickMs; const hards = [];
  for (let i = 0; i < n; i++) { const hard = Math.min(now + BUDGET.softMs + BUDGET.inflightMs, tickEnd - (n - i - 1) * BUDGET.reserveMs); hards.push(hard); now = hard; }
  assert.ok(hards.at(-1) <= 840e3, `every runner uses its full window: last hard deadline at ${hards.at(-1) / 1000} s of the 900 s limit`);
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
  // the admin route uses the wall clock: pin it to the fixture's capture instant so the replayed reads match (the test
  // otherwise depends on the time of day it runs; it failed after the 2026-10-05 16:00Z Nations League kick-off)
  const realNow = Date.now; Date.now = () => natural.opts.now;
  let res; try { res = await post('?isolated=1&dry=1&fault=uefa-champions-league', ctx); } finally { Date.now = realNow; }
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
