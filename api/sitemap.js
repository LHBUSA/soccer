// Sitemaps from canonical API data only (Edge).
//   /sitemap.xml            -> index
//   /sitemap-<kind>.xml     -> static | competitions | matches | teams | players
//   /sitemap-es-<kind>.xml  -> the same pages in Spanish (/es/...), each with en/es/x-default alternates.
//                              News is English-only (articles keep the English canonical) and has no es file.
// No guessed URLs, no aliases, lastmod only when the canonical row has updated_at.
import { SITE, upstreamJson } from '../server/upstream.js';
import { READY_LOCALES, alternateLinks } from '../src/i18n/locales.js';

export const config = { runtime: 'edge' };
export const BASE_KINDS = ['static', 'competitions', 'matches', 'teams', 'players', 'news'];
export const LOCALIZED_KINDS = ['static', 'competitions', 'matches', 'teams', 'players'];
export const KINDS = [...BASE_KINDS, ...READY_LOCALES.filter(l => l !== 'en').flatMap(l => LOCALIZED_KINDS.map(k => `${l}-${k}`))];
export const STATIC_PATHS = ['/', '/competitions', '/matches', '/tables', '/pbecast', '/players', '/sources', '/picks', '/track-record', '/all-access'];
const PREFIX = { competitions: '/competitions/', matches: '/matches/', teams: '/teams/', players: '/players/' };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const lastmod = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export function urlset(entries) {
  const alt = entries.some(e => e.alternates);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"${alt ? ' xmlns:xhtml="http://www.w3.org/1999/xhtml"' : ''}>\n${entries.map(e => `<url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}${(e.alternates || []).map(a => `<xhtml:link rel="alternate" hreflang="${esc(a.hreflang)}" href="${esc(a.url)}"/>`).join('')}</url>`).join('\n')}\n</urlset>\n`;
}

/** The Spanish (or other ready locale) twin of an English sitemap: same pages, prefixed, with alternates. */
export function localizedEntries(entries, locale) {
  return entries.map(e => {
    const path = e.loc.slice(SITE.length) || '/';
    const alternates = alternateLinks(path, SITE);
    return { loc: alternates.find(a => a.hreflang === locale).url, lastmod: e.lastmod, alternates };
  });
}
export function sitemapIndex(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.map(i => `<sitemap><loc>${esc(i.loc)}</loc>${i.lastmod ? `<lastmod>${i.lastmod}</lastmod>` : ''}</sitemap>`).join('\n')}\n</sitemapindex>\n`;
}

export async function entriesFor(kind) {
  const m = /^([a-z]{2})-([a-z]+)$/.exec(kind);
  if (m) return localizedEntries(await entriesFor(m[2]), m[1]);
  if (kind === 'static') return STATIC_PATHS.map(p => ({ loc: `${SITE}${p}` }));
  const env = await upstreamJson(`sitemap/${kind}`, { timeoutMs: 20000 });
  if (kind === 'news') {
    // Articles, plus the newsroom index and each desk ONLY once they hold published stories.
    const rows = (env.data || []).filter(r => /^[a-z-]+[/][a-z0-9-]+$/.test(r.key || ''));
    if (!rows.length) return [];
    const desks = [...new Set(rows.map(r => r.desk))];
    const newest = d => lastmod(rows.filter(r => !d || r.desk === d).map(r => r.updated_at).sort().pop());
    return [{ loc: `${SITE}/news`, lastmod: newest(null) }, ...desks.map(d => ({ loc: `${SITE}/news/${d}`, lastmod: newest(d) })), ...rows.map(r => ({ loc: `${SITE}/news/${r.key}`, lastmod: lastmod(r.updated_at) }))];
  }
  const seen = new Set();
  return (env.data || []).filter(r => r.key && /^[a-z0-9-]+$/.test(r.key) && !seen.has(r.key) && seen.add(r.key))
    .map(r => ({ loc: `${SITE}${PREFIX[kind]}${r.key}`, lastmod: lastmod(r.updated_at) }));
}

const xml = (body, status = 200) => new Response(body, { status, headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': status === 200 ? 'public, max-age=0, s-maxage=3600, stale-while-revalidate=86400' : 'no-store', 'x-robots-tag': 'noindex' } });

export default async function handler(request) {
  const kind = new URL(request.url).searchParams.get('kind') || 'index';
  try {
    if (kind === 'index') return xml(sitemapIndex(KINDS.map(k => ({ loc: `${SITE}/sitemap-${k}.xml` }))));
    if (!KINDS.includes(kind)) return xml('<?xml version="1.0" encoding="UTF-8"?><error>not found</error>', 404);
    return xml(urlset(await entriesFor(kind)));
  } catch {
    return xml('<?xml version="1.0" encoding="UTF-8"?><error>temporarily unavailable</error>', 503);
  }
}
