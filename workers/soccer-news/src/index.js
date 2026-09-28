// soccer-news — PropBetEdge Soccer newsroom runtime (Cloudflare Worker, cron).
// Every 30 minutes: detect material stories in MLS, Premier League, Champions League
// and Bundesliga from the canonical graph, freeze an evidence packet, compose, gate,
// and publish or hold. No provider calls: it reads only the canonical graph.
// Secrets: SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, NEWS_ADMIN_TOKEN.
// Optional (off by default): NEWS_LLM=on + ANTHROPIC_API_KEY for the editorial pass.
import { storeFromEnv } from '../../shared/postgrest.js';
import { runNews, reeditArticle } from './pipeline.js';
import { deskAvailable, deskRequired, DESK_VERSION } from './desk.js';

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
      return json({ ok: !!fresh, version: 'soccer-news/1.1.0', desk: { version: DESK_VERSION, required: deskRequired(env), available: deskAvailable(env) }, last_run: last }, fresh ? 200 : 503);
    }
    if (url.pathname === '/v1/run' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('window_days')) || 4));
      try { return json(await run(env, { windowDays: days, dry: url.searchParams.get('dry') === '1' })); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    // Re-edit existing stories through the desk: ?slug=<slug> (repeatable) | ?scope=held_desk|template
    if (url.pathname === '/v1/admin/reedit' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const store = storeFromEnv(env);
      let slugs = url.searchParams.getAll('slug');
      const scope = url.searchParams.get('scope');
      if (!slugs.length && scope) {
        const rows = await store.select('soccer_articles', { columns: ['slug', 'status', 'composer', 'hold_reasons'], in: { status: ['published', 'held'] } });
        slugs = rows.filter(r => (scope === 'held_desk' ? r.status === 'held' && (r.hold_reasons || []).some(h => /^editorial/.test(h)) : r.status === 'published' && !/soccer-desk/.test(r.composer))).map(r => r.slug);
      }
      const limit = Math.max(1, Math.min(40, Number(url.searchParams.get('limit')) || 10));
      const out = [];
      for (const s of slugs.slice(0, limit)) { try { out.push(await reeditArticle(store, s, env, { dry: url.searchParams.get('dry') === '1', holdOnFail: url.searchParams.get('hold_on_fail') === '1' })); } catch (e) { out.push({ slug: s, error: String(e.message).slice(0, 200) }); } }
      return json({ desk: DESK_VERSION, available: deskAvailable(env), total_candidates: slugs.length, processed: out.length, results: out });
    }
    return json({ error: 'not found' }, 404);
  },
  async scheduled(event, env, ctx) {
    if (env.NEWS_ENABLED !== 'on') return; // launch switch (wrangler.toml var)
    ctx.waitUntil(run(env, { now: event.scheduledTime }).catch(e => console.error('soccer-news run failed', e?.message)));
  },
};
