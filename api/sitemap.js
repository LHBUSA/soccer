// Sitemaps from canonical API data only (Edge).
//   /sitemap.xml            -> index
//   /sitemap-<kind>.xml     -> static | competitions | matches | teams | players
// No guessed URLs, no aliases, lastmod only when the canonical row has updated_at.
import { SITE, upstreamJson } from '../server/upstream.js';

export const config = { runtime: 'edge' };
export const KINDS = ['static', 'competitions', 'matches', 'teams', 'players', 'news'];
export const STATIC_PATHS = ['/', '/competitions', '/matches', '/tables', '/sources'];
const PREFIX = { competitions: '/competitions/', matches: '/matches/', teams: '/teams/', players: '/players/' };

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const lastmod = iso => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

export function urlset(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.map(e => `<url><loc>${esc(e.loc)}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`).join('\n')}\n</urlset>\n`;
}
export function sitemapIndex(items) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.map(i => `<sitemap><loc>${esc(i.loc)}</loc>${i.lastmod ? `<lastmod>${i.lastmod}</lastmod>` : ''}</sitemap>`).join('\n')}\n</sitemapindex>\n`;
}

export async function entriesFor(kind) {
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
