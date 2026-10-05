// Phase 3 (docs/COMPETITION_DESKS.md section 6): COMPETITION RUNNER ISOLATION. The cron orchestrator dispatches each
// enabled competition as its own Worker invocation through the same-Worker loopback RPC binding
// `ctx.exports.NewsRunner` (named WorkerEntrypoint in worker.js; compatibility flag enable_ctx_exports). No HTTP route,
// no token, no Queue, no new resource: one Worker, one codebase, one schedule.
// The runner body is the existing runCompetition (unchanged detectors, keys, packets, desk, gates, writes). A runner that
// throws or times out is recorded as THAT competition's failure; every other runner still completes and writes its
// state, and the tick itself is not a failure.
import { storeFromEnv } from '../../shared/postgrest.js';
import { runCompetition, newRunSummary, mergeRun, NEWS_COMPETITIONS } from './pipeline.js';
import { leaguePhaseCfg } from './profiles.js';

export const ISOLATION_VERSION = 'soccer-news-isolation/1.0.0';
// A runner that has not answered after 10 min is recorded failed (runner_timeout) so the tick can finish inside the
// cron wall limit (15 min). Real runners take seconds (production 2026-10-05: 19-37 s for all five, sequential).
export const RUNNER_DEADLINE_MS = 10 * 60e3;

// The ONLY options a runner accepts over RPC (serializable, validated): the tick instant, dry (admin dry canary),
// windowDays (admin), fault (dry canary only: proves isolation on Cloudflare without touching data).
export function runnerOptions(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('runner: options must be an object');
  const extra = Object.keys(raw).filter(k => !['now', 'dry', 'windowDays', 'fault'].includes(k));
  if (extra.length) throw new Error(`runner: unknown option ${extra.join(',')}`);
  if (!Number.isFinite(raw.now)) throw new Error('runner: now must be an epoch-ms number');
  if (raw.dry !== undefined && typeof raw.dry !== 'boolean') throw new Error('runner: dry must be boolean');
  if (raw.windowDays !== undefined && !(Number.isInteger(raw.windowDays) && raw.windowDays >= 1 && raw.windowDays <= 14)) throw new Error('runner: windowDays must be 1..14');
  if (raw.fault !== undefined && raw.fault !== true) throw new Error('runner: fault must be true or absent');
  if (raw.fault && raw.dry !== true) throw new Error('runner: fault injection is allowed only on a dry run');
  return { now: raw.now, dry: raw.dry === true, ...(raw.windowDays ? { windowDays: raw.windowDays } : {}), fault: raw.fault === true };
}

// The runner RPC body (worker.js NewsRunner.run). `store` is a test seam only; the Worker builds it from its own env.
export async function runnerRpc(env, slug, rawOpts, { store = null } = {}) {
  if (typeof slug !== 'string' || !NEWS_COMPETITIONS.includes(slug)) throw new Error(`runner: ${JSON.stringify(String(slug)).slice(0, 60)} is not an enabled newsroom competition`);
  const o = runnerOptions(rawOpts);
  if (o.fault) throw new Error(`injected runner fault (${slug}, dry canary)`);
  const st = store || storeFromEnv(env);
  if (!st) throw new Error('store not configured');
  const r = await runCompetition(st, slug, { now: o.now, env, cfg: leaguePhaseCfg(env), dry: o.dry, ...(o.windowDays ? { windowDays: o.windowDays } : {}) });
  return { slug: r.slug, out: r.out, routing: r.routing, facts: r.facts };
}

function withDeadline(promise, ms, slug) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`runner_timeout: ${slug} gave no answer in ${Math.round(ms / 1000)} s`)), ms); });
  promise.catch(() => {}); // an abandoned runner's late rejection is not an unhandled rejection
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Isolated orchestrator. dispatch(slug, opts) = one runner invocation (ctx.exports.NewsRunner.run in the Worker).
// All runners start together; results merge in registry order (same summary shape and key order as before); a failed
// runner's entry is { failed, error, counts null } so news:last_run represents the whole tick. onCompetition (phase 2
// state) is called for EVERY competition, success or failure.
export async function runIsolated(env, { now, dispatch, dry = false, windowDays, faultSlug = null, onCompetition = null, deadlineMs = RUNNER_DEADLINE_MS, competitions = NEWS_COMPETITIONS } = {}) {
  if (typeof dispatch !== 'function') throw new Error('isolated dispatch unavailable (ctx.exports.NewsRunner missing: enable_ctx_exports?)');
  const summary = newRunSummary(env, now);
  summary.dispatch = { version: ISOLATION_VERSION, mode: 'isolated', runners: {} };
  const settled = await Promise.all(competitions.map(async slug => {
    const t0 = Date.now();
    const opts = { now, ...(dry ? { dry: true } : {}), ...(windowDays ? { windowDays } : {}), ...(faultSlug === slug ? { fault: true } : {}) };
    try { return { slug, result: await withDeadline(Promise.resolve().then(() => dispatch(slug, opts)), deadlineMs, slug), elapsedMs: Date.now() - t0 }; } catch (error) { return { slug, error, elapsedMs: Date.now() - t0 }; }
  }));
  for (const { slug, result, error, elapsedMs } of settled) {
    if (result) {
      mergeRun(summary, result);
      summary.dispatch.runners[slug] = { outcome: 'ran', elapsed_ms: elapsedMs };
    } else {
      const msg = String(error?.message || error).slice(0, 200);
      summary.competitions[slug] = { failed: true, error: msg, candidates: null, new: null, duplicates: null, published: null, held: null };
      summary.dispatch.runners[slug] = { outcome: 'failed', elapsed_ms: elapsedMs, error: msg };
    }
    if (onCompetition) { try { await onCompetition({ slug, result: result || null, error: error || null, elapsedMs }); } catch (e) { console.error('competition state hook failed', slug, String(e?.message || e).slice(0, 160)); } }
  }
  summary.dispatch.failed = Object.values(summary.dispatch.runners).filter(r => r.outcome === 'failed').length;
  return summary;
}
