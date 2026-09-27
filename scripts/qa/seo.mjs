#!/usr/bin/env node
// First-response SEO QA (no JavaScript, crawler user agent) against production.
//   node scripts/qa/seo.mjs https://soccer.propbetedge.ai
// Writes docs/evidence/qa/seo-<date>.json.
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const SITE = 'https://soccer.propbetedge.ai';
const UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const failures = []; const results = [];
const fail = (k, m) => failures.push(`${k}: ${m}`);
const get = async (p, opts = {}) => { const r = await fetch(BASE + p, { headers: { 'user-agent': UA }, redirect: 'manual', ...opts }); return { r, text: opts.binary ? null : await r.text(), buf: opts.binary ? Buffer.from(await r.arrayBuffer()) : null }; };
const api = async p => (await fetch(`${BASE}/api/soccer/${p}`)).json();

const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const all = (html, re) => [...html.matchAll(re)].map(m => unesc(m[1]));
const metaC = (html, attr, name) => all(html, new RegExp(`<meta ${attr}="${name.replace(/[:]/g, '\\:')}" content="([^"]*)"`, 'g'));

const epl = (await api('matches?competition=premier-league&status=finished&limit=1')).data[0];
const wy = (await api('matches?competition=bundesliga&season=2017/18&status=finished&limit=1')).data[0];
const epld = (await api(`matches/${epl.id}`)).data;
const playerSlug = epld.lineups?.home?.starters?.find(Boolean)?.slug;
const stories = (await api('news?limit=5')).data || [];
const story = stories[0];
const otherDesk = story && ['mls', 'premier-league', 'champions-league', 'bundesliga'].find(d => d !== story.desk);
const NEWS_PAGES = story ? [
  { key: 'news', path: '/news', ld: ['BreadcrumbList', 'ItemList'] },
  { key: 'news-desk', path: `/news/${story.desk}`, ld: ['BreadcrumbList', 'ItemList'] },
  { key: 'article', path: `/news/${story.desk}/${story.slug}`, ld: ['NewsArticle', 'BreadcrumbList'], titleHas: story.headline },
  { key: 'article-wrong-desk', path: `/news/${otherDesk}/${story.slug}`, status: 404 },
  { key: 'article-missing', path: `/news/${story.desk}/no-such-story-xyz`, status: 404 },
] : [{ key: 'news', path: '/news', robots: 'noindex, follow' }];

const PAGES = [
  { key: 'homepage', path: '/', ld: ['WebSite', 'Organization'] },
  { key: 'competition-epl', path: '/competitions/premier-league', ld: ['SportsOrganization', 'BreadcrumbList'], titleHas: 'Premier League' },
  { key: 'competition-bundesliga', path: '/competitions/bundesliga', ld: ['SportsOrganization'], titleHas: 'Table, Results & Fixtures' },
  { key: 'competition-mls', path: '/competitions/mls', ld: ['SportsOrganization', 'BreadcrumbList'], titleHas: 'MLS' },
  { key: 'competition-ucl', path: '/competitions/uefa-champions-league', ld: ['SportsOrganization'], titleHas: 'Champions League' },
  { key: 'match-espn', path: `/matches/${epl.id}`, ld: ['SportsEvent', 'BreadcrumbList'], titleHas: `${epl.home.name} vs ${epl.away.name} — Match Intelligence | PropBetEdge Soccer` },
  { key: 'match-wyscout', path: `/matches/${wy.id}`, ld: ['SportsEvent'], titleHas: 'Match Intelligence' },
  { key: 'team', path: '/teams/bayern-munchen', ld: ['SportsTeam'], titleHas: '— Soccer Intelligence | PropBetEdge' },
  { key: 'player', path: `/players/${playerSlug || 'robert-lewandowski'}`, ld: ['Person'], titleHas: '— Player Intelligence | PropBetEdge Soccer' },
  { key: 'player-wyscout', path: '/players/robert-lewandowski', ld: ['Person'], titleHas: 'Robert Lewandowski' },
  { key: 'sources', path: '/sources', ld: ['BreadcrumbList'] },
  { key: 'tables', path: '/tables', ld: ['BreadcrumbList'] },
  ...NEWS_PAGES,
  { key: 'missing-match', path: '/matches/00000000-0000-5000-8000-000000000000', status: 404 },
  { key: 'missing-team', path: '/teams/not-a-real-team-xyz', status: 404 },
  { key: 'missing-player', path: '/players/not-a-real-player-xyz', status: 404 },
  { key: 'missing-competition', path: '/competitions/not-a-league', status: 404 },
  { key: 'unknown-route', path: '/this/does/not/exist', status: 404 },
];

for (const p of PAGES) {
  const { r, text } = await get(p.path);
  const want = p.status || 200;
  const titles = all(text, /<title>([^<]*)<\/title>/g);
  const canon = all(text, /<link rel="canonical" href="([^"]*)"/g);
  const robots = metaC(text, 'name', 'robots');
  const desc = metaC(text, 'name', 'description');
  const og = { title: metaC(text, 'property', 'og:title'), desc: metaC(text, 'property', 'og:description'), url: metaC(text, 'property', 'og:url'), image: metaC(text, 'property', 'og:image') };
  const tw = metaC(text, 'name', 'twitter:card');
  const lds = all(text, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g).map(j => { try { return JSON.parse(j); } catch { fail(p.key, 'invalid JSON-LD'); return {}; } });
  const types = lds.map(j => j['@type']);
  if (r.status !== want) fail(p.key, `HTTP ${r.status}, want ${want}`);
  if (titles.length !== 1) fail(p.key, `${titles.length} titles`);
  if (desc.length !== 1 || !desc[0]) fail(p.key, 'description missing/duplicated');
  if (robots.length !== 1) fail(p.key, `${robots.length} robots tags`);
  if (/workers\.dev|supabase|vercel\.app|sales-fd3|service_role/i.test(text)) fail(p.key, 'source/host leakage in HTML');
  if (want === 404) {
    if (robots[0] !== 'noindex, follow') fail(p.key, `robots ${robots[0]}`);
    if ((r.headers.get('x-robots-tag') || '') !== 'noindex, follow') fail(p.key, 'x-robots-tag missing');
    if (canon.length) fail(p.key, 'canonical on a 404');
  } else {
    if (canon.length !== 1) fail(p.key, `${canon.length} canonicals`);
    else if (canon[0] !== `${SITE}${p.path === '/' ? '/' : p.path}`) fail(p.key, `canonical ${canon[0]}`);
    if ((p.robots || 'index, follow, max-image-preview:large') !== robots[0]) fail(p.key, `robots ${robots[0]}`);
    if (og.title.length !== 1 || og.desc.length !== 1 || og.url.length !== 1) fail(p.key, 'OG title/description/url');
    if (og.url[0] && og.url[0] !== canon[0]) fail(p.key, 'og:url != canonical');
    if (tw[0] !== 'summary_large_image') fail(p.key, 'twitter card');
    for (const t of p.ld || []) if (!types.includes(t)) fail(p.key, `JSON-LD ${t} missing (have ${types.join(',')})`);
    if (p.titleHas && !titles[0]?.includes(p.titleHas)) fail(p.key, `title "${titles[0]}"`);
    if (p.noTableClaim && /table/i.test(`${titles[0]} ${desc[0]}`)) fail(p.key, 'claims a table it does not have');
    if (!/<h1>[^<]+<\/h1>/.test(text)) fail(p.key, 'no server-rendered h1');
  }
  results.push({ key: p.key, path: p.path, status: r.status, title: titles[0], description: desc[0], canonical: canon[0] || null, robots: robots[0], og_image: og.image[0] || null, jsonld: types });
}

// Sitemaps
const sm = {};
const idx = await get('/sitemap.xml');
if (idx.r.status !== 200 || !idx.text.includes('<sitemapindex')) fail('sitemap-index', `HTTP ${idx.r.status}`);
{
  // News sitemap: only published articles (+ /news and desks that have them).
  const { r, text } = await get('/sitemap-news.xml');
  const locs = all(text, /<loc>([^<]*)<\/loc>/g);
  sm.news = { status: r.status, urls: locs.length };
  if (r.status !== 200) fail('sitemap-news', `HTTP ${r.status}`);
  if (story && !locs.includes(`${SITE}/news/${story.desk}/${story.slug}`)) fail('sitemap-news', 'published article missing');
  if (!story && locs.length) fail('sitemap-news', 'URLs listed with no published stories');
}
for (const kind of ['static', 'competitions', 'matches', 'teams', 'players']) {
  const { r, text } = await get(`/sitemap-${kind}.xml`);
  const locs = all(text, /<loc>([^<]*)<\/loc>/g);
  const lastmods = (text.match(/<lastmod>/g) || []).length;
  sm[kind] = { status: r.status, urls: locs.length, with_lastmod: lastmods };
  if (r.status !== 200 || !locs.length) fail(`sitemap-${kind}`, `HTTP ${r.status}, ${locs.length} urls`);
  if (locs.some(l => !l.startsWith(`${SITE}/`))) fail(`sitemap-${kind}`, 'non-canonical host');
  if (new Set(locs).size !== locs.length) fail(`sitemap-${kind}`, 'duplicate URLs');
  if (locs.some(l => /\/news/.test(l))) fail(`sitemap-${kind}`, 'noindex /news listed');
  for (const l of locs.filter((_, i) => i % Math.max(1, Math.floor(locs.length / 4)) === 0).slice(0, 4)) {
    const s = (await fetch(l.replace(SITE, BASE), { headers: { 'user-agent': UA } })).status;
    if (s !== 200) fail(`sitemap-${kind}`, `${l} -> ${s}`);
  }
}
// robots.txt
const rb = await get('/robots.txt');
const robotsOk = rb.r.status === 200 && /Allow: \//.test(rb.text) && /Disallow: \/api\//.test(rb.text) && rb.text.includes(`Sitemap: ${SITE}/sitemap.xml`) && !/Disallow: \/news/.test(rb.text);
if (!robotsOk) fail('robots', rb.text);
// Social cards
const cards = [];
for (const p of ['/og/match/' + epl.id + '.png', '/og/team/bayern-munchen.png', `/og/player/robert-lewandowski.png`, '/og/competition/premier-league.png', '/og/site/home.png']) {
  const { r, buf } = await get(p, { binary: true });
  const png = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const w = png ? buf.readUInt32BE(16) : 0; const h = png ? buf.readUInt32BE(20) : 0;
  cards.push({ path: p, status: r.status, type: r.headers.get('content-type'), width: w, height: h, bytes: buf.length });
  if (r.status !== 200 || !png || w !== 1200 || h !== 630) fail('og', `${p} ${r.status} ${w}x${h}`);
}
// Security guarantees still hold
const sec = [];
for (const [p, want] of [['/api/soccer/..%2F..%2Fetc%2Fpasswd', 404], ['/api/soccer/https:%2F%2Fevil.example', 404], ['/workers/soccer-ingest/src/index.js', 404], ['/server/upstream.js', 404], ['/src/seo/meta.js', 404], ['/middleware.js', 404], ['/api/og.js', 'no-source']]) {
  const res = await fetch(BASE + p); const s = res.status; const body = await res.text();
  // /api/og.js invokes the function (a PNG card), which is fine: what must never be served is the source.
  const ok = want === 'no-source' ? !/export default|import \{|@vercel\/og/.test(body) : s === want;
  sec.push({ path: p, status: s }); if (!ok) fail('security', `${p} -> ${s}`);
}
const post = (await fetch(BASE + '/api/soccer/competitions', { method: 'POST' })).status;
sec.push({ path: 'POST /api/soccer/competitions', status: post }); if (post < 400) fail('security', 'POST allowed');

const out = { base: BASE, at: new Date().toISOString(), pages: results, sitemaps: sm, robots_ok: robotsOk, cards, security: sec, failures, pass: failures.length === 0 };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/seo-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
for (const p of results) console.log(`${String(p.status).padEnd(4)} ${p.key.padEnd(22)} ${(p.title || '').slice(0, 80)}`);
console.log('sitemaps', JSON.stringify(sm));
console.log('cards', cards.map(c => `${c.status} ${c.width}x${c.height}`).join(' | '));
console.log(`failures ${failures.length}`); for (const f of failures) console.log(' -', f);
process.exit(failures.length ? 1 : 0);
