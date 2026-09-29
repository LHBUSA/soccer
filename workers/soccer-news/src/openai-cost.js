// OpenAI cost telemetry + daily circuit breaker for the soccer newsroom desk — one record per Responses API call.
//
//   SOCCER_STATE key openai:v1:calls:<YYYY-MM-DD UTC> -> [{ worker, id, model, trigger, attempt, input_tokens,
//                                                          output_tokens, estimated_usd, error, at }]
// Triggers: new_story | revision | manual_reedit | backfill | canary | repair.
// "How much did Soccer OpenAI cost today?" = GET /v1/admin/openai-cost (admin token).
// SOCCER_OPENAI_DAILY_MAX_USD (default 5) is an emergency ceiling against a runaway loop, not a budget.

// Account pricing constant, the same one UFC, Tennis and WNBA record against.
export const USD_PER_MTOK = { input: 1.25, output: 10 };
export const OPENAI_COST_VERSION = 'soccer-openai-cost/1.0.0';

const keyOf = (iso) => `openai:v1:calls:${String(iso || new Date().toISOString()).slice(0, 10)}`;
export const costUsd = (i, o) => Math.round(((i * USD_PER_MTOK.input + o * USD_PER_MTOK.output) / 1e6) * 1e6) / 1e6;
export const spentUsd = (calls) => Math.round((calls || []).reduce((s, c) => s + (c.estimated_usd || 0), 0) * 1e6) / 1e6;
export const dailyMaxUsd = (env) => Math.max(0, Number(env?.SOCCER_OPENAI_DAILY_MAX_USD ?? 5));

export async function readCallLog(kv, iso) {
  return kv ? (await kv.get(keyOf(iso), 'json')) || [] : [];
}

/** Append one call (read-modify-write; the newsroom cron runs one pass at a time). No KV (operator scripts): no-op. */
export async function recordCall(kv, entry) {
  if (!kv) return;
  const at = entry.at || new Date().toISOString();
  const prior = await readCallLog(kv, at);
  prior.push({ worker: 'soccer-news', ...entry, at, estimated_usd: costUsd(entry.input_tokens || 0, entry.output_tokens || 0) });
  await kv.put(keyOf(at), JSON.stringify(prior), { expirationTtl: 400 * 86400 });
}

/** True when today's recorded spend has reached the emergency ceiling. */
export async function overCeiling(env) {
  const max = dailyMaxUsd(env);
  if (!max || !env?.SOCCER_STATE) return false;
  return spentUsd(await readCallLog(env.SOCCER_STATE, new Date().toISOString())) >= max;
}

export function costReport(calls, day) {
  const by = (f) => calls.reduce((m, c) => { const k = f(c); const x = (m[k] ||= { calls: 0, input_tokens: 0, output_tokens: 0, estimated_usd: 0 }); x.calls += 1; x.input_tokens += c.input_tokens || 0; x.output_tokens += c.output_tokens || 0; x.estimated_usd = Math.round((x.estimated_usd + (c.estimated_usd || 0)) * 1e6) / 1e6; return m; }, {});
  return {
    version: OPENAI_COST_VERSION, day, pricing_usd_per_mtok: USD_PER_MTOK,
    totals: { calls: calls.length, input_tokens: calls.reduce((s, c) => s + (c.input_tokens || 0), 0), output_tokens: calls.reduce((s, c) => s + (c.output_tokens || 0), 0), estimated_usd: spentUsd(calls), failed_calls: calls.filter((c) => c.error).length },
    by_trigger: by((c) => c.trigger), by_story: by((c) => c.id), calls
  };
}
