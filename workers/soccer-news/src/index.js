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
import { callsForDay, costReport, readCallLog, WORKER_VERSION } from './openai-cost.js';
import { ROUTER_VERSION, aiConfig } from './ai-router.js';
import { publicationDiagnostic } from './news-health.js';
import { leaguePhaseCfg } from './profiles.js';

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
  // League-phase boundaries come only from Worker vars (a missing or invalid var skips that competition).
  const summary = await runNews(store, { env, cfg: leaguePhaseCfg(env), ...opts });
  summary.elapsed_ms = Date.now() - t0;
  if (env.SOCCER_STATE && !opts.dry && !opts.review && !opts.previewMatch) await env.SOCCER_STATE.put('news:last_run', JSON.stringify(summary)); // a forced / review run is not the newsroom's run
  return summary;
}

// Admin re-edit trigger (ai-router.js allow-list): canary > dry_run > scope sweep (backfill) > named-slug admin re-edit.
export function reeditTrigger(url) {
  if (url.searchParams.get('canary') === '1') return 'canary';
  if (url.searchParams.get('dry') === '1') return 'dry_run';
  if (url.searchParams.get('scope') && !url.searchParams.getAll('slug').length) return 'backfill';
  return 'manual_reedit';
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const last = env.SOCCER_STATE ? await env.SOCCER_STATE.get('news:last_run', 'json') : null;
      const tick = env.SOCCER_STATE ? await env.SOCCER_STATE.get('news:last_tick', 'json') : null;
      // newest PUBLISHED story (stale-publication diagnostic); a read failure is reported, never guessed
      let newest = null; let newestError = null;
      try { const store = storeFromEnv(env); const [a] = store ? await store.select('soccer_articles', { columns: ['published_at'], eq: { status: 'published' }, order: 'published_at.desc', limit: 1 }) : []; newest = a?.published_at || null; } catch (e) { newestError = String(e.message || e).slice(0, 160); }
      const publication = { ...publicationDiagnostic({ tick, last, newestPublishedAt: newest }), ...(newestError ? { newest_published_error: newestError } : {}) };
      const fresh = publication.ok;
      return json({ ok: !!fresh, state: publication.state, message: publication.message, publication, version: WORKER_VERSION, news_enabled: env.NEWS_ENABLED === 'on', last_tick: tick, desk: { version: DESK_VERSION, quality: QUALITY_VERSION, packet: PACKET_V3, depth: DEPTH_VERSION, required: deskRequired(env), available: deskAvailable(env) }, ai: (() => { const c = aiConfig(env); return { router: ROUTER_VERSION, enabled: c.enabled, standard_model: c.standardModel, standard_max_output: c.standardMaxOutput, flagship_enabled: c.flagshipEnabled, flagship_classes: [...c.flagshipClasses] }; })(), last_run: last }, fresh ? 200 : 503);
    }
    if (url.pathname === '/v1/run' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const days = Math.max(1, Math.min(14, Number(url.searchParams.get('window_days')) || 4));
      // ?preview_match=<match uuid>: build ONLY that fixture's preview (up to 7 days out; same materiality bar, packet and
      // gates). ?review=1 (with preview_match): owner review - the desk writes it, NOTHING is stored, dedupe ignored;
      // ?as_of=<iso> replays detection at that instant (review only). ?dry=1 = zero model calls, zero writes.
      const pm = url.searchParams.get('preview_match');
      if (pm && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(pm)) return json({ error: 'preview_match must be a match uuid' }, 400);
      const review = url.searchParams.get('review') === '1';
      if (review && !pm) return json({ error: 'review needs preview_match' }, 400);
      const asOfRaw = review ? url.searchParams.get('as_of') : null; const asOf = asOfRaw ? Date.parse(asOfRaw) : null;
      if (asOfRaw && !Number.isFinite(asOf)) return json({ error: 'as_of must be an ISO timestamp' }, 400);
      try { return json(await run(env, { windowDays: days, dry: url.searchParams.get('dry') === '1', ...(pm ? { previewMatch: pm } : {}), ...(review ? { review: true } : {}), ...(Number.isFinite(asOf) ? { now: asOf } : {}) })); } catch (e) { return json({ error: String(e.message || e) }, 500); }
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
      // One paid attempt unless the operator explicitly asks for the corrective repair (?repair=1). ?canary=1 is always
      // non-publishing (forced dry). ?dry=1 without canary never reaches a model. A ?scope= sweep is a backfill: model-free.
      const canary = url.searchParams.get('canary') === '1';
      for (const s of slugs.slice(0, limit)) { try { out.push(await reeditArticle(store, s, env, { dry: canary || url.searchParams.get('dry') === '1', holdOnFail: url.searchParams.get('hold_on_fail') === '1', attempts: url.searchParams.get('repair') === '1' ? 2 : 1, trigger: reeditTrigger(url) })); } catch (e) { out.push({ slug: s, error: String(e.message).slice(0, 200) }); } }
      return json({ desk: DESK_VERSION, available: deskAvailable(env), total_candidates: slugs.length, processed: out.length, results: out });
    }
    if (url.pathname === '/v1/admin/openai-cost') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('date') || '') ? url.searchParams.get('date') : new Date().toISOString().slice(0, 10);
      // Durable ledger totals (KV fallback) + the routing view from the KV day log (lane/pool/latency live there until the
      // ledger routing columns are applied).
      const rep = costReport(await callsForDay(env, day), day);
      const kvCalls = await readCallLog(env.SOCCER_STATE, `${day}T00:00:00Z`).catch(() => []);
      const kv = costReport(kvCalls, day);
      return json({ ...rep, routing: { router_version: ROUTER_VERSION, calls: kvCalls.length, by_lane: kv.by_lane, by_pool: kv.by_pool, by_model: kv.by_model, premium_tokens_today: kv.premium_tokens_today, latency_ms: kvCalls.map(c => c.latency_ms).filter(Number.isFinite) } });
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
