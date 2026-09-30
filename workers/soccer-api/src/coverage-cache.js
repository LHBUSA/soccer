// Materialized graph counts shared across edge locations, on existing KV/cron only.
import { coverage } from './routes.js';
export const COVERAGE_KEY = 'public:coverage:v1';
export const COVERAGE_FRESH_MS = 3600000;
export const isFreshCoverage = (env, now = Date.now()) => !!env?.meta && Number.isFinite(Date.parse(env.meta.generated_at)) && now - Date.parse(env.meta.generated_at) >= 0 && now - Date.parse(env.meta.generated_at) < COVERAGE_FRESH_MS;
export async function cachedCoverage(store, env = {}, { now = Date.now(), warm = false } = {}) {
  const kv = env.SOCCER_STATE;
  const hit = kv ? await kv.get(COVERAGE_KEY, 'json').catch(() => null) : null;
  if (isFreshCoverage(hit, now)) return hit;
  const result = await coverage(store); // failure propagates; expired counts are never fake success
  result.meta.generated_at = new Date(now).toISOString();
  result.meta.materialized = { basis: 'Canonical graph counts, refreshed at least hourly on the existing API minute cron.', warmed: warm };
  if (kv) await kv.put(COVERAGE_KEY, JSON.stringify(result), { expirationTtl: 7200 });
  return result;
}
