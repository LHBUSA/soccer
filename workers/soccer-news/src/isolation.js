// Phase 3 (docs/COMPETITION_DESKS.md section 6): COMPETITION RUNNER ISOLATION. The cron orchestrator dispatches each
// enabled competition as its own Worker invocation through the same-Worker loopback RPC binding
// `ctx.exports.NewsRunner` (named WorkerEntrypoint in worker.js; compatibility flag enable_ctx_exports). No HTTP route,
// no token, no Queue, no new resource: one Worker, one codebase, one schedule.
// The runner body is the existing runCompetition (unchanged detectors, keys, packets, desk, gates, writes). A runner that
// throws or times out is recorded as THAT competition's failure; every other runner still runs and writes its state,
// and the tick itself is not a failure.
//
// REAL ticks dispatch SEQUENTIALLY in registry order (1.1.0). The OpenAI emergency ceiling (openai-cost.js overCeiling)
// is read-before-call and the KV call log is read-modify-write: concurrent runners with new stories could all pass the
// same pre-call spend and overwrite each other's log entries. Sequential dispatch keeps the global budget order exactly
// as the in-process newsroom had it. Only DRY runs (zero paid calls, zero writes) may dispatch in parallel.
//
// Time budget for a real tick (cron wall limit 15 min): the whole tick gets TICK_BUDGET_MS. Runner i gets a hard
// deadline = min(start + RUNNER_SOFT_MS + DESK_INFLIGHT_MS, tickEnd - (later runners) * RUNNER_RESERVE_MS) and a
// cooperative soft deadline = hard - DESK_INFLIGHT_MS, passed to the runner: it starts no new paid desk stage after the
// soft deadline (pipeline.js softDeadlineAt; the rest is deferred to the next tick, nothing written). A started desk call
// ends within its 120 s timeout, so by the hard deadline the runner can no longer touch the budget: a timed-out runner
// (an RPC cannot be cancelled) never overlaps a later runner's budget checks. Worst case: the last hard deadline is
// <= tickEnd = start + 840 s < 900 s.
import { storeFromEnv } from '../../shared/postgrest.js';
import { runCompetition, newRunSummary, mergeRun, NEWS_COMPETITIONS } from './pipeline.js';
import { leaguePhaseCfg } from './profiles.js';

export const ISOLATION_VERSION = 'soccer-news-isolation/1.1.0';
export const TICK_BUDGET_MS = 840e3;       // 14 min of the 15 min cron wall limit
export const RUNNER_SOFT_MS = 150e3;       // no new paid desk stage after 150 s in one runner (desk p90 36 s, max 43 s observed)
export const DESK_INFLIGHT_MS = 125e3;     // desk.js AbortSignal.timeout(120000) + the story's writes
export const RUNNER_RESERVE_MS = 30e3;     // kept back for every later runner (a duplicate-only runner takes 0.5-11 s)
export const DRY_RUNNER_DEADLINE_MS = 300e3; // dry canary (parallel, no paid calls)
export const BUDGET = { tickMs: TICK_BUDGET_MS, softMs: RUNNER_SOFT_MS, inflightMs: DESK_INFLIGHT_MS, reserveMs: RUNNER_RESERVE_MS, dryMs: DRY_RUNNER_DEADLINE_MS };

// The ONLY options a runner accepts over RPC (serializable, validated): the tick instant, the cooperative soft deadline
// (real ticks), dry (admin dry canary), windowDays (admin), fault (dry canary only: proves isolation without data).
export function runnerOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('runner: options must be an object');
  const extra = Object.keys(raw).filter(k => !['now', 'dry', 'windowDays', 'fault', 'softDeadlineAt'].includes(k));
  if (extra.length) throw new Error(`runner: unknown option ${extra.join(',')}`);
  if (!Number.isFinite(raw.now)) throw new Error('runner: now must be an epoch-ms number');
  if (raw.dry !== undefined && typeof raw.dry !== 'boolean') throw new Error('runner: dry must be boolean');
  if (raw.windowDays !== undefined && !(Number.isInteger(raw.windowDays) && raw.windowDays >= 1 && raw.windowDays <= 14)) throw new Error('runner: windowDays must be 1..14');
  if (raw.fault !== undefined && raw.fault !== true) throw new Error('runner: fault must be true or absent');
  if (raw.fault && raw.dry !== true) throw new Error('runner: fault injection is allowed only on a dry run');
  if (raw.softDeadlineAt !== undefined && !Number.isFinite(raw.softDeadlineAt)) throw new Error('runner: softDeadlineAt must be an epoch-ms number');
  return { now: raw.now, dry: raw.dry === true, ...(raw.windowDays ? { windowDays: raw.windowDays } : {}), fault: raw.fault === true, ...(raw.softDeadlineAt !== undefined ? { softDeadlineAt: raw.softDeadlineAt } : {}) };
}

// The runner RPC body (worker.js NewsRunner.run). `store` / `clock` are test seams only.
export async function runnerRpc(env, slug, rawOpts, { store = null, clock = Date.now } = {}) {
  if (typeof slug !== 'string' || !NEWS_COMPETITIONS.includes(slug)) throw new Error(`runner: ${JSON.stringify(String(slug)).slice(0, 60)} is not an enabled newsroom competition`);
  const o = runnerOptions(rawOpts);
  if (o.fault) throw new Error(`injected runner fault (${slug}, dry canary)`);
  const st = store || storeFromEnv(env);
  if (!st) throw new Error('store not configured');
  const r = await runCompetition(st, slug, { now: o.now, env, cfg: leaguePhaseCfg(env), dry: o.dry, clock, ...(o.dry ? {} : { budget: { competitions: NEWS_COMPETITIONS } }), ...(o.windowDays ? { windowDays: o.windowDays } : {}), ...(o.softDeadlineAt !== undefined ? { softDeadlineAt: o.softDeadlineAt } : {}) });
  return { slug: r.slug, out: r.out, routing: r.routing, facts: r.facts };
}

function withDeadline(promise, ms, slug) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`runner_timeout: ${slug} gave no answer in ${Math.round(ms / 1000)} s`)), Math.max(0, ms)); });
  promise.catch(() => {}); // an abandoned runner's late rejection is not an unhandled rejection
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Isolated orchestrator. dispatch(slug, opts) = one runner invocation (ctx.exports.NewsRunner.run in the Worker).
// concurrency: 'sequential' (every real tick; registry order) | 'parallel' (dry only). Results merge in registry order
// (same summary shape and key order as before); a failed runner's entry is { failed, error, counts null } so
// news:last_run represents the whole tick. onCompetition (phase 2 state) runs for EVERY competition.
export async function runIsolated(env, { now, dispatch, dry = false, windowDays, faultSlug = null, onCompetition = null, competitions = NEWS_COMPETITIONS, concurrency = dry ? 'parallel' : 'sequential', budget = BUDGET, clock = Date.now } = {}) {
  if (typeof dispatch !== 'function') throw new Error('isolated dispatch unavailable (ctx.exports.NewsRunner missing: enable_ctx_exports?)');
  if (!['sequential', 'parallel'].includes(concurrency)) throw new Error(`unknown concurrency ${concurrency}`);
  if (concurrency === 'parallel' && !dry) throw new Error('parallel dispatch is allowed only for dry runs (global OpenAI budget order)');
  const summary = newRunSummary(env, now);
  summary.dispatch = { version: ISOLATION_VERSION, mode: 'isolated', concurrency, runners: {} };
  const base = { now, ...(dry ? { dry: true } : {}), ...(windowDays ? { windowDays } : {}) };
  const call = async (slug, opts, ms) => {
    const t0 = clock();
    try { return { slug, result: await withDeadline(Promise.resolve().then(() => dispatch(slug, opts)), ms, slug), elapsedMs: clock() - t0 }; } catch (error) { return { slug, error, elapsedMs: clock() - t0 }; }
  };
  const record = async ({ slug, result, error, elapsedMs }, extra = {}) => {
    if (result) {
      mergeRun(summary, result);
      summary.dispatch.runners[slug] = { outcome: 'ran', elapsed_ms: elapsedMs, ...extra, ...(result.out?.deferred ? { deferred: result.out.deferred } : {}) };
    } else {
      const msg = String(error?.message || error).slice(0, 200);
      summary.competitions[slug] = { failed: true, error: msg, candidates: null, new: null, duplicates: null, published: null, held: null };
      summary.dispatch.runners[slug] = { outcome: 'failed', elapsed_ms: elapsedMs, error: msg, ...extra };
    }
    if (onCompetition) { try { await onCompetition({ slug, result: result || null, error: error || null, elapsedMs }); } catch (e) { console.error('competition state hook failed', slug, String(e?.message || e).slice(0, 160)); } }
  };
  if (concurrency === 'parallel') {
    const settled = await Promise.all(competitions.map(slug => call(slug, { ...base, ...(faultSlug === slug ? { fault: true } : {}) }, budget.dryMs)));
    for (const x of settled) await record(x);
  } else {
    const tickEnd = clock() + budget.tickMs;
    for (const [i, slug] of competitions.entries()) {
      const start = clock();
      const later = competitions.length - i - 1;
      const hardAt = Math.min(start + budget.softMs + budget.inflightMs, tickEnd - later * budget.reserveMs);
      const softAt = hardAt - budget.inflightMs;
      // not enough time left even for a duplicate-only run: do not start a runner that could outlive the tick. Earlier
      // runners may legitimately leave exactly the reserve, so the cut-off is half of it (timer drift is milliseconds).
      if (hardAt - start < budget.reserveMs / 2) { await record({ slug, error: new Error('tick_budget_exhausted: not dispatched'), elapsedMs: 0 }); continue; }
      const x = await call(slug, { ...base, softDeadlineAt: softAt, ...(faultSlug === slug ? { fault: true } : {}) }, hardAt - start);
      await record(x, { soft_deadline_at: new Date(softAt).toISOString(), hard_deadline_at: new Date(hardAt).toISOString() });
    }
  }
  summary.dispatch.failed = Object.values(summary.dispatch.runners).filter(r => r.outcome === 'failed').length;
  return summary;
}
