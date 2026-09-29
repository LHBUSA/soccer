// soccer-api — read-only public API over the canonical soccer graph.
// Browser-facing; reads the SPORTS project through PostgREST with the service
// role (RLS has no public policies), never calls a provider, never serves raw
// captures, identity queue, change ledger or source-conflict tooling.
//
// Secrets: SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY. KV SOCCER_STATE
// stores operational state plus the materialized public /live snapshot.

import { storeFromEnv } from '../../shared/postgrest.js';
import * as R from './routes.js';
import * as C from './cast.js';
import { handlePro, PRO_HEADERS } from './pro/routes.js';
import { readLiveSnapshotInputs, snapshotRefreshReason } from '../../shared/live-snapshot.js';

const LANES = [{ lane: 'openligadb_bl1_current', priority: true }];

const ROUTES = [
  [/^\/v1\/health$/, async (s, _m, _q, env) => R.health(s, { lanes: await Promise.all(LANES.map(async l => ({ ...l, ...((env.SOCCER_STATE && await env.SOCCER_STATE.get(`lane:${l.lane}`, 'json')) || {}) }))) }), 0, []],
  [/^\/v1\/competitions$/, s => R.competitions(s), 600, []],
  [/^\/v1\/coverage$/, s => R.coverage(s), 3600, []],
  [/^\/v1\/data-health$/, (s, _m, _q, env) => R.dataHealth(s, env), 300, []],
  [/^\/v1\/sitemap\/(competitions|teams|players|matches)$/, (s, m) => R.sitemap(s, m[1]), 3600, []],
  [/^\/v1\/sitemap\/news$/, s => R.sitemap(s, 'news'), 300, []],
  [/^\/v1\/competitions\/([a-z0-9-]+)$/, (s, m) => R.competition(s, m[1]), 600, []],
  [/^\/v1\/matches$/, (s, _m, q) => R.matches(s, q), 120, ['competition', 'season', 'status', 'date', 'from', 'to', 'order', 'team', 'limit']],
  [/^\/v1\/matches\/([0-9a-f-]{36})$/, (s, m) => R.match(s, m[1]), 120, []],
  [/^\/v1\/matches\/([0-9a-f-]{36})\/cast$/, (s, m, _q, env) => C.cast(s, m[1], env), 60, []],
  [/^\/v1\/live$/, (s, _m, _q, env) => C.live(s, env), 60, []],
  [/^\/v1\/players$/, (s, _m, q, env) => C.players(s, q, env), 600, ['competition', 'season', 'sort', 'role', 'q', 'team', 'limit', 'offset']],
  [/^\/v1\/teams\/([a-z0-9-]+)$/, (s, m, _q, env) => R.team(s, m[1], env), 300, []],
  [/^\/v1\/teams\/([a-z0-9-]+)\/dna$/, (s, m, q, env) => R.teamDnaRoute(s, m[1], q, env), 3600, ['as_of']],
  [/^\/v1\/players\/([a-z0-9-]+)\/dna$/, (s, m, q, env) => R.playerDnaRoute(s, m[1], q, env), 3600, ['as_of']],
  [/^\/v1\/players\/([a-z0-9-]+)$/, (s, m) => R.player(s, m[1]), 600, []],
  [/^\/v1\/table$/, (s, _m, q) => R.table(s, q), 300, ['competition', 'season', 'group', 'expand']],
  [/^\/v1\/news$/, (s, _m, q) => R.news(s, q), 300, ['desk', 'team', 'player', 'match', 'limit']],
  [/^\/v1\/videos$/, (s, _m, q) => R.videos(s, q), 300, ['desk', 'limit']],
  [/^\/v1\/news\/([a-z0-9-]+)$/, (s, m) => R.article(s, m[1]), 600, []],
];

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*propbetedge\.ai$/;

export function canonicalQuery(params, allowedQuery = []) {
  const allowed = new Set(allowedQuery);
  const seen = new Set();
  for (const [k, v] of params) {
    if (!allowed.has(k) || seen.has(k) || v.length > 64) return null;
    seen.add(k);
  }
  const canonical = new URLSearchParams(params); canonical.sort();
  return canonical.toString();
}

function respond(body, status, maxAge, origin) {
  const h = { 'content-type': 'application/json; charset=utf-8', 'cache-control': status === 200 && maxAge ? `public, max-age=${maxAge}, s-maxage=${maxAge}` : 'no-store', 'x-content-type-options': 'nosniff' };
  if (origin && ALLOWED_ORIGIN.test(origin)) { h['access-control-allow-origin'] = origin; h.vary = 'origin'; }
  return new Response(JSON.stringify(body), { status, headers: h });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const origin = req.headers.get('origin');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: origin && ALLOWED_ORIGIN.test(origin) ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET', 'access-control-max-age': '86400' } : {} });
    if (req.method !== 'GET') return respond({ error: 'method not allowed' }, 405, 0, origin);
    const media = url.pathname.match(/^\/v1\/media\/([0-9a-f]{64})$/);
    if (media) {
      if (canonicalQuery(url.searchParams, []) === null) return respond({ error: 'unknown query parameter' }, 400, 0, origin);
      const store = storeFromEnv(env);
      try {
        const o = await R.mediaObject(store, env.SOCCER_SOURCE, media[1]);
        return new Response(o.body, { status: 200, headers: { 'content-type': o.contentType, 'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
      } catch (err) {
        return respond({ error: err.status === 404 ? 'not found' : 'upstream error' }, err.status === 404 ? 404 : 502, 0, origin);
      }
    }
    // Soccer Pro: per-reader, decided server-side (auth-magic via the AUTH binding); never cached.
    const pro = url.pathname.match(/^\/v1\/pro\/([a-z0-9/-]{1,160})$/);
    if (pro) {
      const store = storeFromEnv(env);
      if (!store) return respond({ error: 'store not configured' }, 503, 0, origin);
      try {
        const r = await handlePro(req, env, store, pro[1]);
        const res = respond(r.body, r.status, 0, origin);
        for (const [k, v] of Object.entries(PRO_HEADERS)) res.headers.set(k, v);
        return res;
      } catch (err) {
        console.error('soccer-api pro', url.pathname, err.message);
        return respond({ error: 'upstream error' }, 502, 0, origin);
      }
    }
    const hit = ROUTES.map(([re, fn, ttl, allowedQuery]) => [url.pathname.match(re), fn, ttl, allowedQuery]).find(([m]) => m);
    if (!hit) return respond({ error: 'not found' }, 404, 0, origin);
    const [m, fn, ttl, allowedQuery = []] = hit;
    const qs = canonicalQuery(url.searchParams, allowedQuery);
    if (qs === null) return respond({ error: 'unknown or invalid query parameter' }, 400, 0, origin);
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}${url.pathname}${qs ? `?${qs}` : ''}`);
    if (ttl) { const c = await cache.match(cacheKey); if (c) { const r = new Response(c.body, c); r.headers.set('x-cache', 'HIT'); return r; } }
    const store = storeFromEnv(env);
    if (!store) return respond({ error: 'store not configured' }, 503, 0, origin);
    const t0 = Date.now();
    try {
      const body = await fn(store, m, Object.fromEntries(url.searchParams), env);
      body.meta.timing_ms = Date.now() - t0;
      body.meta.store_requests = store.requests;
      const res = respond(body, 200, ttl, origin);
      if (ttl) ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (err) {
      if (err.status === 404) return respond({ error: err.message }, 404, 0, origin);
      if (err.status === 400) return respond({ error: err.message }, 400, 0, origin);
      console.error('soccer-api', url.pathname, err.message);
      return respond({ error: 'upstream error' }, 502, 0, origin);
    }
  },
  // Every minute: refresh the materialized /live snapshot only when active, dirty or due for
  // the idle safety refresh. The separate 6-hour cron still warms the expensive DNA cache.
  async scheduled(event, env, ctx) {
    const store = storeFromEnv(env);
    if (!store) return;
    if (event.cron === '* * * * *') {
      ctx.waitUntil((async () => {
        try {
          const { snapshot, dirty } = await readLiveSnapshotInputs(env.SOCCER_STATE);
          const reason = snapshotRefreshReason(snapshot, dirty, event.scheduledTime);
          if (!reason) return;
          const out = await C.materializeLive(store, env, { now: event.scheduledTime, reason });
          console.log('live snapshot', JSON.stringify(out.status));
        } catch (e) {
          console.error('live snapshot failed', e?.message);
        }
      })());
    }
    if (event.cron === '20 */6 * * *') {
      ctx.waitUntil(R.warmDna(store, env).then(r => console.log('dna warm', JSON.stringify(r))).catch(e => console.error('dna warm failed', e?.message)));
    }
  },
};
