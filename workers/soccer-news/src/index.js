// soccer-news — PropBetEdge Soccer newsroom runtime (Cloudflare Worker, cron).
// Every 30 minutes: detect material stories in MLS, Premier League, Champions League
// and Bundesliga from the canonical graph, freeze an evidence packet, compose, gate,
// and publish or hold. No provider calls: it reads only the canonical graph.
// Secrets: SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, NEWS_ADMIN_TOKEN.
// Optional (off by default): NEWS_LLM=on + ANTHROPIC_API_KEY for the editorial pass.
import { storeFromEnv } from '../../shared/postgrest.js';
import { runNews } from './pipeline.js';

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function authorized(req, env) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.NEWS_ADMIN_TOKEN || tok.length !== env.NEWS_ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ env.NEWS_ADMIN_TOKEN.charCodeAt(i);
  return diff === 0;
}

async function run(env, opts = {}) {
  const store = storeFromEnv(env);
  if (!store) throw new Error('store not configured');
  const t0 = Date.now();
  const summary = await runNews(store, { env, cfg: { ucl_league_phase_end: env.UCL_LEAGUE_PHASE_END }, ...opts });
  summary.elapsed_ms = Date.now() - t0;
  if (env.SOCCER_STATE && !opts.dry) await env.SOCCER_STATE.put('news:last_run', JSON.stringify(summary));
  return summary;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const last = env.SOCCER_STATE ? await env.SOCCER_STATE.get('news:last_run', 'json') : null;
      const fresh = last && Date.now() - Date.parse(last.at) < 2 * 3600e3;
      return json({ ok: !!fresh, version: 'soccer-news/1.0.0', last_run: last }, fresh ? 200 : 503);
    }
    if (url.pathname === '/v1/run' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('window_days')) || 4));
      try { return json(await run(env, { windowDays: days, dry: url.searchParams.get('dry') === '1' })); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    return json({ error: 'not found' }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(run(env, { now: event.scheduledTime }).catch(e => console.error('soccer-news run failed', e?.message)));
  },
};
