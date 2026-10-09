// Multilingual Soccer (Phase 1: English + Spanish). Contract:
//   - /es/... is the Spanish experience of every page; English stays unprefixed; unready locales 404.
//   - translation never touches names, scores, numbers, odds/probabilities, market rules or article text;
//   - SEO: localized title/description/canonical + reciprocal hreflang; articles keep the English canonical;
//   - the reader's choice (pbe_lang cookie) redirects unprefixed pages, never cached; futbol host -> /es/.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { LOCALES, READY_LOCALES, alternateLinks, isLocalizable, localizePath, readLangCookie, splitLocale } from '../../src/i18n/locales.js';
import { translateHtml, translateText } from '../../src/i18n/translate.js';
import es from '../../src/i18n/catalog/es.js';
import { resolve } from '../../src/lib/router.js';
import { ALL_COMPS } from '../../src/lib/competitions.js';
import { SITE } from '../../src/seo/meta.js';
import middleware, { languageRedirect } from '../../middleware.js';
import { entriesFor, KINDS, urlset } from '../../api/sitemap.js';

const RENDERED = JSON.parse(readFileSync('tests/web/fixtures/i18n-rendered-en.json', 'utf8')).strings;

test('locale registry: Phase 1 offers exactly English and Spanish; Portuguese and French are registered, not ready', () => {
  assert.deepEqual(READY_LOCALES, ['en', 'es']);
  assert.equal(LOCALES.pt.ready, false); assert.equal(LOCALES.fr.ready, false);
});

test('locale paths: split, localize (idempotent), never prefix files or APIs; unready prefixes stay in the path', () => {
  assert.deepEqual(splitLocale('/es/matches/abc'), { locale: 'es', path: '/matches/abc' });
  assert.deepEqual(splitLocale('/es'), { locale: 'es', path: '/' });
  assert.deepEqual(splitLocale('/es/'), { locale: 'es', path: '/' });
  assert.deepEqual(splitLocale('/espn-thing'), { locale: 'en', path: '/espn-thing' });
  assert.deepEqual(splitLocale('/pt/matches'), { locale: 'en', path: '/pt/matches' });
  assert.equal(resolve(splitLocale('/pt/matches').path).page, 'notfound');
  assert.equal(localizePath('/matches?view=upcoming#x', 'es'), '/es/matches?view=upcoming#x');
  assert.equal(localizePath('/es/matches', 'es'), '/es/matches');
  assert.equal(localizePath('/es/matches', 'en'), '/matches');
  assert.equal(localizePath('/', 'es'), '/es/');
  for (const p of ['/api/soccer/live', '/assets/app.js', '/brand/pbe-mark-64.webp', '/og/match/x.png', '/sitemap.xml', '/robots.txt', '/favicon.ico', 'https://propbetedge.ai/', '//cdn.x/y']) {
    assert.equal(isLocalizable(p), false, p); assert.equal(localizePath(p, 'es'), p);
  }
  assert.equal(readLangCookie('a=1; pbe_lang=es; b=2'), 'es');
  assert.equal(readLangCookie('pbe_lang=pt'), null);
  assert.equal(readLangCookie(''), null);
});

test('every shipped route resolves identically under /es', () => {
  for (const p of ['/', '/matches', '/competitions/premier-league', '/matches/5b0c8f3e-1111-5222-8333-444455556666', '/pbecast', '/teams/fulham', '/players', '/players/x', '/tables', '/pro', '/all-access', '/news', '/news/mls', '/news/mls/some-story', '/sources', '/picks', '/track-record']) {
    assert.deepEqual(resolve(splitLocale(localizePath(p, 'es')).path), resolve(p), p);
  }
});

test('translation preserves every number and score in every rendered UI string (all 24 page types)', () => {
  // Football terms whose Spanish name carries no numeral (the meaning is identical): "round of 16" = "octavos de final".
  const EQUIVALENT = [[/round of 16/i, /octavos de final/i]];
  const digits = (s, t) => { let x = s; for (const [en] of EQUIVALENT) x = x.replace(en, ''); return (x.match(/\d+(?:[.,]\d+)*/g) || []).sort().join('|'); };
  let changed = 0;
  for (const s of RENDERED) {
    const t = translateText(s, 'es');
    if (t !== s) changed++;
    assert.equal(digits(t), digits(s), `numbers changed: ${JSON.stringify(s)} -> ${JSON.stringify(t)}`);
    for (const sym of ['%', '¢', '–', '+']) assert.equal(t.split(sym).length, s.split(sym).length, `${sym} changed: ${s} -> ${t}`);
    assert.deepEqual(t.match(/\d+(?:\+\d+)?'/g) || [], s.match(/\d+(?:\+\d+)?'/g) || [], `match minutes changed: ${s} -> ${t}`);
  }
  assert.ok(changed > 700, `catalog covers the rendered UI (${changed} strings translated)`);
});

test('names are never translated: competitions, and team/player names seen in the rendered pages', () => {
  for (const c of ALL_COMPS) for (const n of [c.name, c.long, c.mono, c.name?.toUpperCase()].filter(Boolean)) assert.equal(translateText(n, 'es'), n, n);
  for (const n of ['Fulham', 'Manchester United', 'Borussia Dortmund', 'Bayern München', 'Spain', 'England', 'Real Madrid', 'Lionel Messi', 'Harry Kane', 'Inter Miami CF', 'D.C. United', 'Atlético Madrid', 'PSG', 'Como', 'Sporting', 'Club Brugge']) assert.equal(translateText(n, 'es'), n, n);
  // A name inside a sentence survives verbatim.
  assert.equal(translateText('Fulham · 12 shots · 0 goals', 'es'), 'Fulham · 12 tiros · 0 goles');
  assert.equal(translateText('Arsenal crest. Image: ESPN. Used to identify the club.', 'es'), 'Escudo de Arsenal. Imagen: ESPN. Se usa para identificar al club.');
  assert.equal(translateText('RB Leipzig to score: Yes', 'es'), 'RB Leipzig marca: Sí');
  assert.equal(translateText("63' Goal Martínez", 'es'), "63' Gol Martínez");
});

test('probabilities, prices and model outputs keep their exact values', () => {
  assert.equal(translateText('Home 69.3% · Draw 18.7% · Away 12.0% · Home scores 91.4%', 'es'), 'Local 69.3% · Empate 18.7% · Visitante 12.0% · Marca el local 91.4%');
  assert.equal(translateText('Market 80.5¢', 'es'), 'Mercado 80.5¢');
  assert.equal(translateText('threshold 87.5%', 'es'), 'umbral 87.5%');
  assert.equal(translateText('PBE 71.4% ·', 'es'), 'PBE 71.4% ·');
});

test('English is a pass-through; unknown strings and whitespace are untouched; split headings reorder', () => {
  for (const s of RENDERED.slice(0, 200)) assert.equal(translateText(s, 'en'), s);
  assert.equal(translateText('  Matches ', 'es'), '  Partidos ');
  assert.equal(translateText('Some brand-new sentence nobody catalogued.', 'es'), 'Some brand-new sentence nobody catalogued.');
  assert.equal(translateText('MATCHES', 'es'), 'PARTIDOS');
  assert.equal(translateHtml('Official <span>Picks</span>', 'es'), 'Picks <span>oficiales</span>');
  assert.equal(translateHtml('Official <span>Picks</span>', 'en'), null);
});

test('catalog hygiene: no duplicate msgids, every translation non-empty, patterns anchored', () => {
  const src = readFileSync('src/i18n/catalog/es.js', 'utf8');
  const body = src.slice(src.indexOf('const exact = {'), src.indexOf('};', src.indexOf('const exact = {')));
  const keys = [...body.matchAll(/^ {2}(['"])((?:\\.|(?!\1).)*)\1:/gm)].map(m => m[2]);
  const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
  assert.deepEqual(dup, [], `duplicate msgids: ${dup.join(' | ')}`);
  for (const [k, v] of Object.entries(es.exact)) assert.ok(typeof v === 'string' && v.trim(), `empty translation for ${k}`);
  for (const [re] of es.patterns) assert.ok(re.source.startsWith('^') && re.source.endsWith('$') || re.source.startsWith('^'), `unanchored pattern ${re}`);
});

test('protected content is excluded from the DOM pass: article bodies, Kalshi markets, translate="no"', () => {
  const dom = readFileSync('src/i18n/dom.js', 'utf8');
  for (const sel of ['.art-body', '[data-kx-impression]', '.kx', '.avm', '[translate="no"]']) assert.ok(dom.includes(sel), sel);
});

const MATCH = { data: { id: '5b0c8f3e-1111-5222-8333-444455556666', status: 'finished', kickoff_at: '2026-09-20T15:30:00Z', season: '2026/27',
  home: { slug: 'fulham', name: 'Fulham' }, away: { slug: 'manchester-united', name: 'Manchester United' }, score: { home: 1, away: 1 },
  competition: { slug: 'premier-league', name: 'Premier League' }, venue: null, timeline: [{}], shots: [{}, {}], stats: { basis: 'source' }, lineups: { home: {} } }, meta: {} };
const ARTICLE = { data: { slug: 'fulham-hold-united', desk: 'premier-league', headline: 'Fulham hold Manchester United 1-1', dek: 'A late equaliser.', published_at: '2026-09-20T18:00:00Z', entities: [] }, meta: {} };
const HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>x</title><meta name="description" content="x"></head><body><div id="app"></div></body></html>';

async function withStubbedNetwork(fn) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async input => {
    const url = String(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (/\/v1\/news\//.test(url)) return new Response(JSON.stringify(ARTICLE), { status: 200, headers: { 'content-type': 'application/json' } });
    if (/\/v1\//.test(url)) return new Response(JSON.stringify(MATCH), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(HTML, { status: 200, headers: { 'content-type': 'text/html' } });
  };
  try { return await fn(); } finally { globalThis.fetch = realFetch; }
}
const links = html => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map(m => [m[1], m[2]]);

test('middleware /es: Spanish title, lang, self-canonical, reciprocal hreflang, localized SSR links', () => withStubbedNetwork(async () => {
  const id = MATCH.data.id;
  const r = await middleware(new Request(`${SITE}/es/matches/${id}`));
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.match(h, /<html lang="es">/);
  assert.match(h, /<title>Fulham vs Manchester United: inteligencia del partido \| PropBetEdge<\/title>/);
  assert.match(h, /<meta name="description" content="Fulham 1–1 Manchester United · Premier League 2026\/27 · 20 de septiembre de 2026\. Final\./);
  assert.ok(h.includes(`<link rel="canonical" href="${SITE}/es/matches/${id}">`));
  assert.deepEqual(links(h), [['en', `${SITE}/matches/${id}`], ['es', `${SITE}/es/matches/${id}`], ['x-default', `${SITE}/matches/${id}`]]);
  assert.match(h, /<meta property="og:locale" content="es_ES">/);
  assert.ok(h.includes('href="/es/teams/fulham"'));
  assert.equal(r.headers.get('link'), `<${SITE}/es/matches/${id}>; rel="canonical"`);
  // English twin carries the same alternates and stays English.
  const en = await (await middleware(new Request(`${SITE}/matches/${id}`))).text();
  assert.match(en, /<html lang="en">/);
  assert.match(en, /<title>Fulham vs Manchester United Match Intelligence \| PropBetEdge<\/title>/);
  assert.deepEqual(links(en), links(h));
}));

test('middleware /es article: English canonical, no hreflang claim (article translation is a separate release)', () => withStubbedNetwork(async () => {
  const r = await middleware(new Request(`${SITE}/es/news/premier-league/fulham-hold-united`));
  assert.equal(r.status, 200);
  const h = await r.text();
  assert.ok(h.includes(`<link rel="canonical" href="${SITE}/news/premier-league/fulham-hold-united">`));
  assert.deepEqual(links(h), []);
  assert.match(h, /<h1>Fulham hold Manchester United 1-1<\/h1>/);
}));

test('middleware: unready locale prefixes are 404, never a duplicate English page', () => withStubbedNetwork(async () => {
  const r = await middleware(new Request(`${SITE}/pt/matches`));
  assert.equal(r.status, 404);
}));

test('language redirects: cookie choice and futbol host; never cached; crawlers (no cookie) get what they asked for', async () => {
  const u = s => new URL(s);
  assert.equal(languageRedirect(u(`${SITE}/matches`), ''), null);
  assert.deepEqual(languageRedirect(u(`${SITE}/matches?view=upcoming`), 'pbe_lang=es'), { status: 307, location: '/es/matches?view=upcoming' });
  assert.equal(languageRedirect(u(`${SITE}/es/matches`), 'pbe_lang=en'), null, 'an explicit /es URL is always honoured');
  assert.equal(languageRedirect(u(`${SITE}/matches`), 'pbe_lang=en'), null);
  assert.deepEqual(languageRedirect(u('https://futbol.propbetedge.ai/'), ''), { status: 308, location: `${SITE}/es/` });
  assert.deepEqual(languageRedirect(u('https://futbol.propbetedge.ai/matches/x?y=1'), 'pbe_lang=en'), { status: 308, location: `${SITE}/es/matches/x?y=1` });
  const r = await middleware(new Request(`${SITE}/picks`, { headers: { cookie: 'pbe_session=abc; pbe_lang=es' } }));
  assert.equal(r.status, 307); assert.equal(r.headers.get('location'), '/es/picks');
  assert.equal(r.headers.get('cache-control'), 'private, no-store'); assert.equal(r.headers.get('vary'), 'Cookie');
});

test('sitemaps: Spanish twins with reciprocal alternates for every localized kind; news stays English-only', async () => {
  for (const k of ['static', 'competitions', 'matches', 'teams', 'players']) assert.ok(KINDS.includes(`es-${k}`), k);
  assert.ok(!KINDS.includes('es-news'));
  // Owner rule 2026-10-09: a Spanish article page whose body is still English is reachable, keeps the English
  // canonical, and appears in NO Spanish sitemap and NO hreflang set until the article is genuinely translated.
  for (const k of KINDS.filter(k => k.startsWith('es-'))) {
    const rows = k === 'es-static' ? await entriesFor(k) : [];
    for (const r of rows) { assert.doesNotMatch(r.loc, /\/es\/news\//, r.loc); for (const a of r.alternates) assert.doesNotMatch(a.url, /\/news\/[^/]+\/[^/]+$/, a.url); }
  }
  const xml = urlset(await entriesFor('es-static'));
  assert.match(xml, /xmlns:xhtml="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.ok(xml.includes(`<loc>${SITE}/es/</loc><xhtml:link rel="alternate" hreflang="en" href="${SITE}/"/>`));
  assert.ok(xml.includes(`<loc>${SITE}/es/picks</loc>`));
  assert.deepEqual(alternateLinks('/tables').map(a => a.url), [`${SITE}/tables`, `${SITE}/es/tables`, `${SITE}/tables`]);
});

test('futbol host: sitemaps 308 to the canonical host, every response noindex, /api and robots.txt keep working', () => {
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const onFutbol = r => (r.has || []).some(h => h.type === 'host' && h.value === 'futbol.propbetedge.ai');
  const red = (v.redirects || []).filter(onFutbol);
  assert.deepEqual(red.map(r => [r.source, r.destination, r.permanent]), [['/sitemap.xml', `${SITE}/sitemap.xml`, true], ['/sitemap-:kind.xml', `${SITE}/sitemap-:kind.xml`, true]]);
  assert.ok(!red.some(r => /api|robots/.test(r.source)), 'API and robots.txt are never redirected');
  assert.ok((v.redirects || []).every(onFutbol), 'no redirect applies to the canonical host');
  const h = v.headers.filter(onFutbol);
  assert.equal(h.length, 1); assert.equal(h[0].source, '/(.*)'); assert.deepEqual(h[0].headers, [{ key: 'X-Robots-Tag', value: 'noindex' }]);
});
