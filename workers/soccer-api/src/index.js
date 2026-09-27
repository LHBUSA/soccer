// soccer-api — read-only public API over the canonical soccer graph.
// Browser-facing; reads the SPORTS project through PostgREST with the service
// role (RLS has no public policies), never calls a provider, never serves raw
// captures, identity queue, change ledger or source-conflict tooling.
//
// Secrets: SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY. KV SOCCER_STATE (read-only use).

import { storeFromEnv } from '../../shared/postgrest.js';
import * as R from './routes.js';

const LANES = [{ lane: 'openligadb_bl1_current', priority: true }];

const ROUTES = [
  [/^\/v1\/health$/, async (s, _m, _q, env) => R.health(s, { lanes: await Promise.all(LANES.map(async l => ({ ...l, ...((env.SOCCER_STATE && await env.SOCCER_STATE.get(`lane:${l.lane}`, 'json')) || {}) }))) }), 0],
  [/^\/v1\/competitions$/, s => R.competitions(s), 300],
  [/^\/v1\/coverage$/, s => R.coverage(s), 3600],
  [/^\/v1\/sitemap\/(competitions|teams|players|matches)$/, (s, m) => R.sitemap(s, m[1]), 3600],
  [/^\/v1\/sitemap\/news$/, s => R.sitemap(s, 'news'), 300],
  [/^\/v1\/competitions\/([a-z0-9-]+)$/, (s, m) => R.competition(s, m[1]), 300],
  [/^\/v1\/matches$/, (s, _m, q) => R.matches(s, q), 60],
  [/^\/v1\/matches\/([0-9a-f-]{36})$/, (s, m) => R.match(s, m[1]), 60],
  [/^\/v1\/teams\/([a-z0-9-]+)$/, (s, m) => R.team(s, m[1]), 120],
  [/^\/v1\/players\/([a-z0-9-]+)$/, (s, m) => R.player(s, m[1]), 600],
  [/^\/v1\/table$/, (s, _m, q) => R.table(s, q), 60],
  [/^\/v1\/news$/, (s, _m, q) => R.news(s, q), 60],
  [/^\/v1\/news\/([a-z0-9-]+)$/, (s, m) => R.article(s, m[1]), 120],
];

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*propbetedge\.ai$/;

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
      const store = storeFromEnv(env);
      try {
        const o = await R.mediaObject(store, env.SOCCER_SOURCE, media[1]);
        return new Response(o.body, { status: 200, headers: { 'content-type': o.contentType, 'cache-control': 'public, max-age=31536000, s-maxage=31536000, immutable', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" } });
      } catch (err) {
        return respond({ error: err.status === 404 ? 'not found' : 'upstream error' }, err.status === 404 ? 404 : 502, 0, origin);
      }
    }
    const hit = ROUTES.map(([re, fn, ttl]) => [url.pathname.match(re), fn, ttl]).find(([m]) => m);
    if (!hit) return respond({ error: 'not found' }, 404, 0, origin);
    const [m, fn, ttl] = hit;
    const cache = caches.default;
    const cacheKey = new Request(`${url.origin}${url.pathname}?${[...url.searchParams].sort().map(([k, v]) => `${k}=${v}`).join('&')}`);
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
      console.error('soccer-api', url.pathname, err.message);
      return respond({ error: 'upstream error' }, 502, 0, origin);
    }
  },
};
