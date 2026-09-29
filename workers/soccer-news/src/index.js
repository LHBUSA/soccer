// soccer-news — PropBetEdge Soccer newsroom runtime (Cloudflare Worker, cron).
// Every 30 minutes: detect material stories (recaps, previews, matchday briefs, form, trends,
// table / group watch) in every competition the registry's `news` block enables, freeze an
// evidence packet, compose, gate, and publish or hold. No provider calls: canonical graph only.
// Secrets: SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, NEWS_ADMIN_TOKEN.
// Optional (off by default): NEWS_LLM=on + ANTHROPIC_API_KEY for the editorial pass.
import { storeFromEnv } from '../../shared/postgrest.js';
import { runNews, reeditArticle } from './pipeline.js';
import { deskAvailable, deskRequired, DESK_VERSION, QUALITY_VERSION } from './desk.js';
import { PACKET_V3, DEPTH_VERSION } from './depth.js';
import { callsForDay, costReport, WORKER_VERSION } from './openai-cost.js';

// The only production schedule. The temporary backlog-migration cron (*/10) is retired: there is no automatic OpenAI
// backlog processing. Re-edits are manual only (POST /v1/admin/reedit, scripts/news/reedit-backlog.mjs).
export const NEWS_CRON = '7,37 * * * *';

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
      const tick = env.SOCCER_STATE ? await env.SOCCER_STATE.get('news:last_tick', 'json') : null;
      return json({ ok: !!fresh, version: WORKER_VERSION, news_enabled: env.NEWS_ENABLED === 'on', last_tick: tick, desk: { version: DESK_VERSION, quality: QUALITY_VERSION, packet: PACKET_V3, depth: DEPTH_VERSION, required: deskRequired(env), available: deskAvailable(env) }, last_run: last }, fresh ? 200 : 503);
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
      // One paid attempt unless the operator explicitly asks for the corrective repair (?repair=1).
      for (const s of slugs.slice(0, limit)) { try { out.push(await reeditArticle(store, s, env, { dry: url.searchParams.get('dry') === '1', holdOnFail: url.searchParams.get('hold_on_fail') === '1', attempts: url.searchParams.get('repair') === '1' ? 2 : 1, trigger: url.searchParams.get('canary') === '1' ? 'canary' : 'manual_reedit' })); } catch (e) { out.push({ slug: s, error: String(e.message).slice(0, 200) }); } }
      return json({ desk: DESK_VERSION, available: deskAvailable(env), total_candidates: slugs.length, processed: out.length, results: out });
    }
    if (url.pathname === '/v1/admin/openai-cost') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : new Date().toISOString().slice(0, 10);
      return json(costReport(await callsForDay(env, day), day)); // durable ledger (KV fallback)
    }
    return json({ error: 'not found' }, 404);
  },
  async scheduled(event, env, ctx) {
    // Only the newsroom schedule runs anything; any other trigger (a stale cron left on the Worker) is a no-op.
    if (event.cron && event.cron !== NEWS_CRON) { console.log('ignored cron', event.cron); return; }
    // Every tick leaves a trace (news:last_tick), so health can tell "cron not firing" from
    // "NEWS_ENABLED off" from "run failing". The summary of a SUCCESSFUL run is news:last_run.
    const tick = outcome => env.SOCCER_STATE?.put('news:last_tick', JSON.stringify({ at: new Date(event.scheduledTime).toISOString(), news_enabled: env.NEWS_ENABLED === 'on', outcome }));
    if (env.NEWS_ENABLED !== 'on') { ctx.waitUntil(tick('disabled') || Promise.resolve()); return; } // launch switch (wrangler.toml var)
    ctx.waitUntil(run(env, { now: event.scheduledTime }).then(() => tick('ran')).catch(e => { console.error('soccer-news run failed', e?.message); return tick('failed'); }));
  },
};
