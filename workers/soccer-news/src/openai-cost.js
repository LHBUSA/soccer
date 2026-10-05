// OpenAI cost telemetry + daily circuit breaker for the soccer newsroom desk — one record per Responses API call.
//
// Durable ledger (migration 20260929001100): public.soccer_news_openai_usage, ONE ROW PER REQUEST (every attempt,
// including failed / incomplete / refused / timed-out calls), append-only, service role only.
//   trigger (owner enum): cron_new_story | admin_reedit | manual_backfill | canary
// Fast path / fallback: SOCCER_STATE key openai:v1:calls:<YYYY-MM-DD UTC> (the same record, for the admin cost view).
// Token counts are the Responses API's own usage fields; estimated_usd is derived from them.
// SOCCER_OPENAI_DAILY_MAX_USD (default 5) is an emergency ceiling against a runaway loop, not a budget.
// V4 (soccer-ai-router/1.0.0): every entry carries its routing decision (lane, reason, pool, story class, router
// version) and latency. estimated_usd is the NOMINAL standard-rate equivalent from the router's per-model rates (cached
// input at the cached rate; null for an unpriced model) — never the billed amount: eligible traffic inside the org's
// complimentary data-sharing allowance may bill nothing. The emergency ceiling counts an unpriced call at the standard
// constant, and it fails CLOSED: an unreadable budget or an invalid ceiling holds the story.
// Ledger routing columns (migration 20260929230000) are written only when SOCCER_LEDGER_ROUTING=on (set after it is
// applied); until then the routing fields live in the KV day log.
import { storeFromEnv } from '../../shared/postgrest.js';
import { nominalStandardCost, aiConfig } from './ai-router.js';

// Account pricing constant, the same one UFC, Tennis and WNBA record against.
export const USD_PER_MTOK = { input: 1.25, output: 10 };
export const OPENAI_COST_VERSION = 'soccer-openai-cost/1.2.0';
export const WORKER_VERSION = 'soccer-news/1.6.0'; // 1.6.0 = phase 3 isolated competition runners (2026-10-05)
export const LEDGER_TABLE = 'soccer_news_openai_usage';
// The desk's internal trigger names (shared with the WNBA desk) -> the owner's ledger enum. A repair (attempt 2)
// is recorded under its PARENT trigger with attempt = 2.
export const LEDGER_TRIGGER = { new_story: 'cron_new_story', cron_new_story: 'cron_new_story', manual_reedit: 'admin_reedit', admin_reedit: 'admin_reedit', revision: 'admin_reedit', backfill: 'manual_backfill', manual_backfill: 'manual_backfill', canary: 'canary' };

const keyOf = (iso) => `openai:v1:calls:${String(iso || new Date().toISOString()).slice(0, 10)}`;
export const costUsd = (i, o) => Math.round(((i * USD_PER_MTOK.input + o * USD_PER_MTOK.output) / 1e6) * 1e6) / 1e6;
// Breaker spend: a call without a nominal price (unpriced model) counts at the standard constant, never as free.
const callUsd = c => (c.estimated_usd !== null && c.estimated_usd !== undefined && c.estimated_usd !== '' && Number.isFinite(Number(c.estimated_usd)) ? Number(c.estimated_usd) : costUsd(Number(c.input_tokens) || 0, Number(c.output_tokens) || 0));
export const spentUsd = (calls) => Math.round((calls || []).reduce((s, c) => s + callUsd(c), 0) * 1e6) / 1e6;
// An unset or unparsable ceiling is the default ($5), never 'disabled'; an explicit 0 blocks every paid call.
export const dailyMaxUsd = (env) => { const v = env?.SOCCER_OPENAI_DAILY_MAX_USD; const n = Number(v); return v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(n) || n < 0 ? 5 : n; };
const dayStart = (iso) => `${String(iso || new Date().toISOString()).slice(0, 10)}T00:00:00Z`;

export async function readCallLog(kv, iso) {
  return kv ? (await kv.get(keyOf(iso), 'json')) || [] : [];
}

// The durable row for one request (pure; exported for tests).
export function ledgerRow(e, { routingColumns = false } = {}) {
  const trigger = LEDGER_TRIGGER[e.trigger];
  if (!trigger) throw new Error(`unknown desk trigger ${e.trigger}`);
  const known = v => (Number.isFinite(v) ? v : null); // null = the API did not report it (never 0 by assumption)
  return {
    occurred_at: e.started_at, finished_at: e.finished_at || null, article_id: e.article_id || null, news_event_id: e.news_event_id || null, slug: e.slug || null,
    trigger, attempt: e.attempt, model: e.model, response_id: e.response_id || null,
    input_tokens: known(e.input_tokens), cached_input_tokens: known(e.cached_input_tokens), output_tokens: known(e.output_tokens), reasoning_tokens: known(e.reasoning_tokens),
    estimated_usd: Number.isFinite(e.input_tokens) || Number.isFinite(e.output_tokens) ? nominalStandardCost(e.requested_model || e.model, e, aiConfig(e.env || {})) : null,
    status: e.status, error_code: e.error_code || null, desk_version: e.desk_version, worker_version: WORKER_VERSION,
    ...(routingColumns ? { sport: 'soccer', worker: 'soccer-news', nominal_standard_cost: Number.isFinite(e.input_tokens) || Number.isFinite(e.output_tokens) ? nominalStandardCost(e.requested_model || e.model, e, aiConfig(e.env || {})) : null, routing_lane: e.routing?.lane || null, routing_reason: e.routing?.reason || null, pool: e.routing?.pool || null, story_class: e.routing?.story_class || null, router_version: e.routing?.router_version || null, latency_ms: Number.isFinite(e.latency_ms) ? e.latency_ms : null } : {}),
  };
}

/** Record ONE request: the durable ledger row, then the KV day log. A telemetry failure never breaks the newsroom. */
export async function recordCall(env, entry) {
  const row = ledgerRow({ ...entry, env }, { routingColumns: env?.SOCCER_LEDGER_ROUTING === 'on' });
  const store = (() => { try { return storeFromEnv(env); } catch { return null; } })();
  if (store) await store.insert(LEDGER_TABLE, [row]).catch(e => console.error('openai usage ledger insert failed', String(e?.message || e).slice(0, 200)));
  const kv = env?.SOCCER_STATE;
  if (kv) {
    const prior = await readCallLog(kv, row.occurred_at);
    const r = entry.routing || {};
    const tokens = (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0);
    prior.push({ worker: 'soccer-news', sport: 'soccer', id: entry.slug || entry.news_event_id || null, ...row, at: row.occurred_at, error: row.error_code, requested_model: entry.requested_model || null, routing_lane: r.lane || null, routing_reason: r.reason || null, pool: r.pool || null, story_class: r.story_class || null, router_version: r.router_version || null, flagship_eligible: r.flagship_eligible ?? null, flagship_class: r.flagship_class || null, latency_ms: Number.isFinite(entry.latency_ms) ? entry.latency_ms : null, total_eligible_tokens: tokens, nominal_standard_cost: row.estimated_usd });
    await kv.put(keyOf(row.occurred_at), JSON.stringify(prior), { expirationTtl: 400 * 86400 });
  }
  return row;
}

/** Today's spend from the DURABLE ledger, else the KV day log. Neither readable -> throws (the breaker fails CLOSED). */
export class BudgetStateUnavailable extends Error {}
export async function spentToday(env, now = Date.now()) {
  const iso = new Date(now).toISOString();
  const store = (() => { try { return storeFromEnv(env); } catch { return null; } })();
  if (store) {
    try { return spentUsd(await store.select(LEDGER_TABLE, { columns: ['estimated_usd', 'input_tokens', 'output_tokens'], gte: { occurred_at: dayStart(iso) } })); } catch { /* fall back to KV */ }
  }
  const kv = env?.SOCCER_STATE;
  if (!kv) throw new BudgetStateUnavailable('neither the usage ledger nor the KV day log is readable');
  try { return spentUsd((await kv.get(keyOf(iso), 'json')) || []); } catch (e) { throw new BudgetStateUnavailable(`neither the usage ledger nor the KV day log is readable (${String(e?.message || e).slice(0, 80)})`); }
}

/** Ledger rows for one UTC day (KV fallback when the ledger cannot be read). */
export async function callsForDay(env, day) {
  const store = (() => { try { return storeFromEnv(env); } catch { return null; } })();
  if (store) {
    try { return await store.select(LEDGER_TABLE, { columns: ['occurred_at', 'finished_at', 'slug', 'news_event_id', 'article_id', 'trigger', 'attempt', 'model', 'response_id', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'estimated_usd', 'status', 'error_code'], gte: { occurred_at: `${day}T00:00:00Z` }, lte: { occurred_at: `${day}T23:59:59.999Z` }, order: 'occurred_at.asc' }); } catch { /* KV fallback */ }
  }
  return readCallLog(env?.SOCCER_STATE, `${day}T00:00:00Z`);
}

/** True when today's recorded spend has reached the emergency ceiling: no paid call is made. */
export async function overCeiling(env, now = Date.now()) {
  const max = dailyMaxUsd(env); // 0 = no paid call today (never 'disabled')
  return (await spentToday(env, now)) >= max;
}

// "How much did Soccer OpenAI cost today and why?" over ledger rows (or KV records, same fields).
export function costReport(calls, day) {
  const by = (f) => calls.reduce((m, c) => { const k = f(c); const x = (m[k] ||= { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, estimated_usd: 0 }); x.calls += 1; x.input_tokens += c.input_tokens || 0; x.cached_input_tokens += c.cached_input_tokens || 0; x.output_tokens += c.output_tokens || 0; x.reasoning_tokens += c.reasoning_tokens || 0; x.estimated_usd = Math.round((x.estimated_usd + (Number(c.estimated_usd) || 0)) * 1e6) / 1e6; return m; }, {});
  const stories = new Set(calls.map(c => c.slug || c.news_event_id || c.id).filter(Boolean));
  const sum = k => calls.reduce((s, c) => s + (c[k] || 0), 0);
  return {
    version: OPENAI_COST_VERSION, day, pricing_usd_per_mtok: USD_PER_MTOK,
    totals: { calls: calls.length, input_tokens: sum('input_tokens'), cached_input_tokens: sum('cached_input_tokens'), output_tokens: sum('output_tokens'), reasoning_tokens: sum('reasoning_tokens'), estimated_usd: spentUsd(calls), failed_calls: calls.filter((c) => c.status && c.status !== 'completed').length, stories: stories.size, calls_per_story: stories.size ? Math.round((calls.length / stories.size) * 100) / 100 : null },
    eligible_tokens_today: sum('input_tokens') + sum('output_tokens'),
    premium_tokens_today: calls.filter(c => (c.pool || 'premium') === 'premium').reduce((s, c) => s + (c.input_tokens || 0) + (c.output_tokens || 0), 0),
    nominal_note: 'Nominal standard-rate estimate only; not evidence of actual billing. Complimentary shared-token usage may apply subject to eligibility and remaining daily allowance.',
    by_trigger: { ...Object.fromEntries(['cron_new_story', 'admin_reedit', 'manual_backfill', 'canary'].map(t => [t, { calls: 0, input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, estimated_usd: 0 }])), ...by((c) => c.trigger) },
    by_lane: by((c) => c.routing_lane || 'unrouted'), by_pool: by((c) => c.pool || 'unrouted'), by_model: by((c) => c.model || 'unknown'),
    by_story: by((c) => c.slug || c.news_event_id || c.id), calls
  };
}
