// Same-origin read-only proxy: browser -> /api/soccer/<path> -> soccer-api Worker /v1/<path>.
// GET/HEAD only. Fixed upstream (never an arbitrary URL). Path must match the
// public API's route allowlist; only known query keys are forwarded. No secrets:
// the Worker is public-read. Cache headers from the Worker are preserved so the
// Vercel edge caches exactly as the API intends.
export const config = { runtime: 'edge' };

import { UPSTREAM } from '../server/upstream.js';
export { UPSTREAM };
const ROUTES = [
  /^health$/, /^coverage$/, /^competitions$/, /^competitions\/[a-z0-9-]{1,80}$/,
  /^matches$/, /^matches\/[0-9a-f-]{36}$/, /^teams\/[a-z0-9-]{1,120}$/, /^players\/[a-z0-9-]{1,120}$/,
  /^table$/, /^news$/, /^news\/[a-z0-9-]{1,200}$/, /^media\/[0-9a-f]{64}$/,
];
const QUERY_KEYS = new Set(['competition', 'season', 'status', 'date', 'from', 'to', 'order', 'team', 'limit', 'desk']);

export function isAllowedPath(path) {
  return typeof path === 'string' && ROUTES.some(re => re.test(path));
}

export function upstreamUrl(requestUrl) {
  const url = new URL(requestUrl);
  // vercel.json rewrites /api/soccer/:path* -> /api/soccer?path=:path*
  const path = (url.searchParams.get('path') || url.pathname.replace(/^\/api\/soccer\/?/, '')).replace(/^\/+|\/+$/g, '');
  if (!isAllowedPath(path)) return null;
  const out = new URL(path, UPSTREAM);
  for (const [k, v] of url.searchParams) if (QUERY_KEYS.has(k) && v.length <= 64) out.searchParams.set(k, v);
  if (!out.href.startsWith(UPSTREAM)) return null;
  return out;
}

const json = (body, status) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async function handler(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method not allowed' }, 405);
  const target = upstreamUrl(request.url);
  if (!target) return json({ error: 'not found' }, 404);
  let res;
  try {
    res = await fetch(target, { method: 'GET', headers: { accept: /^media\//.test(target.pathname.replace(/^\/v1\//, '')) ? 'image/*' : 'application/json', 'user-agent': 'propbetedge-soccer-web-proxy' } });
  } catch {
    return json({ error: 'upstream unavailable' }, 502);
  }
  const headers = new Headers({ 'content-type': res.headers.get('content-type') || 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
  const cc = res.headers.get('cache-control');
  if (cc) { headers.set('cache-control', cc); if (/s-maxage=\d+/.test(cc)) headers.set('cdn-cache-control', cc.match(/s-maxage=\d+/)[0].replace('s-maxage', 'max-age')); }
  return new Response(request.method === 'HEAD' ? null : res.body, { status: res.status, headers });
}
