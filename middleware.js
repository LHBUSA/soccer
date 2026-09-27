// Vercel Routing Middleware (Edge): server-first SEO for every product page.
// Resolves the page identity through the soccer API BEFORE the HTML leaves the
// edge, injects title/description/canonical/robots/OG/Twitter/JSON-LD plus a
// small server-rendered summary, and sets the real HTTP status:
//   unknown route or missing competition/match/team/player -> 404 + noindex, follow
//   upstream failure -> 503 + Retry-After + noindex (never index a degraded page)
// The browser still only talks to /api/soccer/*; the Worker hostname lives in
// server/upstream.js, which the client bundle never imports.
import { upstreamJson } from './server/upstream.js';
import { buildMeta, injectMeta, metaPlan, NOINDEX, SITE } from './src/seo/meta.js';

export const config = {
  matcher: ['/((?!api/|assets/|og/|favicon|robots\\.txt|sitemap).*)'],
};

export default async function middleware(request) {
  const url = new URL(request.url);
  if (/\.[a-z0-9]{2,5}$/i.test(url.pathname)) return; // files: served (or 404'd) by the filesystem
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  const plan = metaPlan(pathname);

  let meta; let status = 200;
  try {
    const results = plan.calls ? await Promise.all(plan.calls.map(c => upstreamJson(c))) : [];
    meta = buildMeta(pathname, plan.page, results);
    status = meta.status;
  } catch {
    meta = { ...buildMeta(pathname, 'notfound'), title: 'PropBetEdge Soccer Intelligence', description: 'Soccer intelligence from the PropBetEdge canonical graph.', status: 503 };
    status = 503;
  }

  const upstream = await fetch(request);
  if (!(upstream.headers.get('content-type') || '').includes('text/html')) return upstream;
  const html = injectMeta(await upstream.text(), meta);
  const headers = new Headers(upstream.headers);
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.delete('content-length');
  headers.delete('etag');
  if (meta.robots === NOINDEX || status !== 200) headers.set('x-robots-tag', NOINDEX);
  if (status === 503) headers.set('retry-after', '120');
  headers.set('cache-control', status === 200 ? 'public, max-age=0, s-maxage=120, stale-while-revalidate=600' : 'no-store');
  if (meta.canonical) headers.set('link', `<${meta.canonical}>; rel="canonical"`);
  return new Response(html, { status, headers });
}

export { SITE };
