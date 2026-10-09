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
import { localizeMeta } from './src/seo/meta-i18n.js';
import { DEFAULT_LOCALE, LOCALE_HOSTS, localizePath, readLangCookie, splitLocale } from './src/i18n/locales.js';

export const config = {
  matcher: ['/((?!api/|assets/|og/|favicon|robots\\.txt|sitemap).*)'],
};

// Files are served (or 404'd) by the filesystem. Extensions up to 12 characters: `.webmanifest`
// (11) was routed as a page and answered 404 HTML on every load. Page slugs never contain a dot.
export const isFilePath = pathname => /\.[a-z0-9]{2,12}$/i.test(pathname);

// Language entry points. A language host (futbol.propbetedge.ai) sends every page to the same path in its
// language on the canonical host. A reader who chose a language (pbe_lang cookie, set only by the selector)
// is sent from an unprefixed page to the same page in that language. Crawlers carry no cookie, so they always
// see the URL they asked for. Redirects are never cached (no-store + Vary: Cookie).
export function languageRedirect(url, cookieHeader = '') {
  const hostLocale = LOCALE_HOSTS[url.hostname];
  if (hostLocale) return { status: 308, location: `${SITE}${localizePath(url.pathname, hostLocale)}${url.search}` };
  const { locale } = splitLocale(url.pathname);
  const want = readLangCookie(cookieHeader);
  if (locale === DEFAULT_LOCALE && want && want !== DEFAULT_LOCALE) return { status: 307, location: `${localizePath(url.pathname, want)}${url.search}` };
  return null;
}

export default async function middleware(request) {
  const url = new URL(request.url);
  if (isFilePath(url.pathname)) return;
  const redirect = languageRedirect(url, request.headers.get('cookie') || '');
  if (redirect) return new Response(null, { status: redirect.status, headers: { location: redirect.location, 'cache-control': 'private, no-store', vary: 'Cookie' } });
  const { locale, path } = splitLocale(url.pathname);
  const pathname = path.replace(/\/+$/, '') || '/';
  const plan = metaPlan(pathname);

  let meta; let status = 200;
  try {
    // An article on a localized path asks for its verified translation (the API answers English when none is current).
    const calls = (plan.calls || []).map(c => (plan.page === 'article' && locale !== DEFAULT_LOCALE ? `${c}?locale=${locale}` : c));
    const results = calls.length ? await Promise.all(calls.map(c => upstreamJson(c))) : [];
    meta = localizeMeta(buildMeta(pathname, plan.page, results), { locale, path: pathname, page: plan.page, results });
    status = meta.status;
  } catch {
    meta = { ...buildMeta(pathname, 'notfound'), title: 'PropBetEdge Soccer Intelligence', description: 'Soccer intelligence from the PropBetEdge canonical graph.', status: 503 };
    status = 503;
  }

  // Fetch the built SPA shell explicitly and request an identity-encoded body.
  // Self-fetching the routed request can receive a compressed response that the
  // Node middleware runtime attempts to decompress a second time, which surfaced
  // in production as ERR__ERROR_FORMAT_RESERVED / Z_DATA_ERROR and turned every
  // page into a 500. /index.html bypasses this middleware via the file-extension
  // guard above, and the identity header avoids content-encoding ambiguity.
  const shellUrl = new URL('/index.html', request.url);
  const shellHeaders = new Headers(request.headers);
  shellHeaders.set('accept-encoding', 'identity');
  const upstream = await fetch(new Request(shellUrl, {
    method: 'GET',
    headers: shellHeaders,
    redirect: 'manual',
  }));
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
