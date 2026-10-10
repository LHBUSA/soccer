// Spanish article polish (LHBUSA/soccer#16, 2026-10-10). Reviewer saw on /es: "No official call a favor de this event"
// (the DOM localizer translated fragments of the article-market module), identical "Polymarket" columns, and English
// headlines in the Spanish sidebar. Contract proven here:
//   1. the article-market module renders natively in the page language from the SHARED client (locale), and the DOM
//      pass never touches it (.am protected); English pages render exactly as before;
//   2. several contracts of one venue get distinct, accessible headers (real Dortmund v Bremen payload: Kalshi + three
//      Polymarket contracts, GET /v1/article-market/soccer/48fdbe3e-... captured 2026-10-10);
//   3. Spanish related coverage / rail / "In the news" list ONLY verified current Spanish translations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { articleMarketSlot, related, railStories, RAIL_NATIVE_LIMIT, renderArticle } from '../../src/pages/article.js';
import { articleMarketHtml } from '../../src/data/article-market.js';
import { mountArticleMarket } from '../../src/vendor/kalshi/article-market-ui.js';
import { setCurrentLocale, servedInLocale, currentLocale } from '../../src/i18n/current.js';
import { SKIP } from '../../src/i18n/dom.js';
import { translateText } from '../../src/i18n/translate.js';

const fx = f => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const clone = x => JSON.parse(JSON.stringify(x));
const forest = fx('article-market-soccer-fa23ec39.json'); // real: LIVE, Kalshi only, NO_PBE_DECISION
const dortmund = fx('article-market-soccer-48fdbe3e-multi-pm.json'); // real: RESULT, Kalshi + 3 Polymarket, PBE graded
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const noVenueEnglish = h => { let s = h, p; do { p = s; s = s.replace(/<span lang="en">[^<]*<\/span>/g, ' '); } while (s !== p); return s; };
const headers = h => [...h.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map(m => text(m[1]));
const inLocale = (l, fn) => { setCurrentLocale(l); try { return fn(); } finally { setCurrentLocale('en'); } };

const FOREST_MATCH = 'fa23ec39-30fc-55a0-9349-d4966333396d';
const forestArticle = { slug: 'x', desk: 'premier-league', published_at: '2026-10-04T14:35:00Z', entities: [{ type: 'SportsEvent', name: 'Nottm Forest v Arsenal', href: `/matches/${FOREST_MATCH}` }] };

// A live view of the real Dortmund packet: same venues / markets / roles; current = last pre-event observation.
function dortmundLive() {
  const p = clone(dortmund);
  p.live.mode = 'LIVE_MARKET_WATCH'; p.live.in_play = false;
  for (const lv of p.live.venues) {
    const pv = p.packet.venues.find(v => v.venue === lv.venue && (v.venue_market_id ?? null) === (lv.venue_market_id ?? null));
    for (const o of lv.outcomes) { const mid = pv.outcomes.find(x => x.role === o.role)?.pre_event?.mid_bp ?? null; o.current = mid == null ? null : { mid_bp: mid }; o.freshness = 'LIVE'; o.age_s = 15; o.checked_at = '2026-10-09T18:20:00Z'; }
  }
  return p;
}

test('the DOM localizer never enters the article-market module (.am is a protected boundary)', () => {
  assert.ok(SKIP.split(',').map(s => s.trim()).includes('.am'));
  // the catalog pattern that produced the reviewer's hybrid still exists for other UI, so protection is what matters
  assert.equal(translateText('on this event', 'es'), 'a favor de this event');
});

test('/es article market: native Spanish NO_PBE_DECISION sentence, no hybrid, no English presentation (real Forest v Arsenal)', () => {
  const html = inLocale('es', () => articleMarketSlot(forestArticle, { now: forest }));
  assert.match(html, /data-art-market/);
  assert.match(html, /data-am-locale="es"/);
  assert.match(html, /<b>PBE no ha emitido una selección oficial<\/b> para este evento\./);
  assert.doesNotMatch(html, /No official call|a favor de this|on this event/);
  const t = text(noVenueEnglish(html));
  for (const w of ['Live market watch', 'Pre-event prices', 'Since publication', 'Since first observed', 'Checked', 'Updated', 'ago', 'Prediction-market prices', 'Movement after publication']) assert.ok(!t.includes(w), w);
  assert.match(t, /Seguimiento del mercado en vivo/);
  assert.match(t, /(Comprobado)/);
  assert.match(html, />Kalshi</);
  assert.doesNotMatch(html, /\sstyle="/, 'strict CSP');
  // English page: unchanged wording
  const en = articleMarketSlot(forestArticle, { now: forest });
  assert.match(en, /<b>No official call<\/b> on this event/);
  assert.doesNotMatch(en, /data-am-locale/);
});

test('/es live vs result/settled: native titles and tags, prices and links identical to English', () => {
  for (const [p, title, tag] of [[dortmundLive(), 'Seguimiento del mercado en vivo', 'Precios previos al evento'], [dortmund, 'El resultado del mercado', 'Pendiente de liquidación']]) {
    const es = inLocale('es', () => articleMarketHtml(p));
    const en = articleMarketHtml(p);
    assert.match(es, new RegExp(`<h3>${title}</h3><span class="am__tag am__tag--\\w+">${tag}</span>`));
    assert.deepEqual(es.match(/[−+±]?\d+(?:\.\d)?¢/g), en.match(/[−+±]?\d+(?:\.\d)?¢/g), 'every price as observed');
    assert.deepEqual([...es.matchAll(/href="([^"]+)"/g)].map(m => m[1]), [...en.matchAll(/href="([^"]+)"/g)].map(m => m[1]), 'canonical market links only');
  }
  const fin = clone(dortmund); fin.packet.packet_state = 'FINAL';
  assert.match(inLocale('es', () => articleMarketHtml(fin)), /am__tag--settled">Liquidado</);
});

test('dual-venue multi-contract (real Dortmund v Bremen): four separate columns, every header unique and names its contract', () => {
  for (const l of ['en', 'es']) {
    const html = inLocale(l, () => articleMarketHtml(dortmundLive()));
    const hs = headers(html);
    assert.equal(hs.length, 4);
    assert.equal(new Set(hs).size, 4, hs.join(' || '));
    const want = l === 'es' ? ['Victoria local', 'Empate', 'Victoria visitante'] : ['Home win', 'Draw', 'Away win'];
    want.forEach((w, i) => assert.ok(hs[i + 1].startsWith(`Polymarket ${w}`), hs[i + 1]));
    assert.ok(hs.slice(1).every(h => /Will .*\?/.test(h)), 'exact venue market title kept for screen readers');
    assert.equal(hs[0], 'Kalshi');
  }
  // result: PBE comparison lines are distinct too; the rules notice stays on each related market
  const res = inLocale('es', () => articleMarketHtml(dortmund));
  assert.deepEqual([...res.matchAll(/<li><span>([^<]*)<\/span><span class="am__na">/g)].map(m => m[1]), ['Kalshi', 'Polymarket · Victoria local', 'Polymarket · Empate', 'Polymarket · Victoria visitante']);
  assert.equal((res.match(/REGLAS NO VERIFICADAS/g) || []).length >= 3, true);
});

test('missing market / ineligible / pre-activation: nothing rendered in Spanish either', () => {
  inLocale('es', () => {
    assert.equal(articleMarketHtml(null), '');
    assert.equal(articleMarketSlot({ ...forestArticle, published_at: '2026-10-01T10:00:00Z' }, { now: forest }), '');
    assert.equal(articleMarketSlot(forestArticle, { now: null }), '<div class="art-market" data-art-market></div>', 'reserved slot only, filled by the mount');
    assert.equal(articleMarketHtml({ ...forest, eligible: false }), '');
  });
});

test('late market refresh (30 s) and SPA language state: the mount paints in the page locale on every refresh', async () => {
  const host = { innerHTML: '', isConnected: true };
  const next = dortmundLive(); next.live.venues[0].outcomes[0].current = { mid_bp: 7700 };
  setCurrentLocale('es');
  try {
    const stop = mountArticleMarket(host, { base: '/api/markets', sport: 'soccer', eventId: '48fdbe3e-8dae-5710-a416-8f58b4d1d474', publishedAt: '2026-10-08T18:37:06+00:00', initial: dortmundLive(), refreshMs: 20, fetchImpl: async () => ({ ok: true, json: async () => next }), locale: currentLocale });
    await new Promise(r => setTimeout(r, 80));
    stop();
    assert.match(host.innerHTML, /<b data-am-px>77¢<\/b>/, 'refreshed');
    assert.match(host.innerHTML, /Seguimiento del mercado en vivo/);
    assert.doesNotMatch(host.innerHTML, /Live market watch|Checked/);
  } finally { setCurrentLocale('en'); }
  // the soccer mount passes the getter (not a snapshot), so a repaint after a language change follows the page
  const src = readFileSync('src/data/article-market.js', 'utf8');
  assert.match(src, /refreshMs: ARTICLE_MARKET_REFRESH_MS, locale: currentLocale \}/);
});

// ------------------------------------------------------------------ sidebar / related: verified Spanish only
const card = (slug, locale, desk = 'bundesliga', published_at = '2026-10-08T18:00:00Z', headline = slug) => ({ slug, desk, story_class: 'match_preview', headline, published_at, ...(locale ? { locale } : {}) });

test('servedInLocale: English pages list everything; a Spanish page only verified current Spanish cards', () => {
  assert.equal(servedInLocale(card('a', 'en'), 'en'), true);
  assert.equal(servedInLocale(card('a'), 'en'), true);
  assert.equal(servedInLocale(card('a', 'es'), 'es'), true);
  assert.equal(servedInLocale(card('a', 'en'), 'es'), false, 'English fallback from localizeCards');
  assert.equal(servedInLocale(card('a'), 'es'), false, 'no locale field = not verified');
  assert.equal(servedInLocale(null, 'es'), false);
});

test('related coverage: verified Spanish stories only on /es (English-only left out, never relabelled); English unchanged', () => {
  const a = { related: [card('es-1', 'es', 'bundesliga', '2026-10-08T00:00:00Z', 'Previa en español'), card('en-1', 'en', 'bundesliga', '2026-10-07T00:00:00Z', 'English only story'), card('raw', undefined, 'mls', '2026-10-06T00:00:00Z', 'Unknown')] };
  const es = inLocale('es', () => related(a));
  assert.match(es, /Previa en español/);
  assert.doesNotMatch(es, /English only story|Unknown/);
  assert.equal((es.match(/class="rel-card"/g) || []).length, 1);
  assert.equal(inLocale('es', () => related({ related: [card('en-1', 'en')] })), '', 'nothing native: no section at all');
  const en = related(a);
  assert.equal((en.match(/class="rel-card"/g) || []).length, 3, 'English page unchanged');
  // links stay plain article paths: the DOM pass adds /es only to stories that truly exist in Spanish
  assert.match(es, /href="\/news\/bundesliga\/es-1"/);
});

test('rail: Spanish page reads the shared 40-story window, keeps verified Spanish, own desk first then recency; English = latest five', () => {
  assert.equal(RAIL_NATIVE_LIMIT, 40);
  const art = { slug: 'self', desk: 'bundesliga' };
  const cards = [
    card('self', 'es'),
    card('mls-new', 'es', 'mls', '2026-10-09T10:00:00Z'),
    card('bl-old', 'es', 'bundesliga', '2026-10-01T10:00:00Z'),
    card('bl-new', 'es', 'bundesliga', '2026-10-09T09:00:00Z'),
    card('en-fallback', 'en', 'bundesliga', '2026-10-09T11:00:00Z'),
    card('intl', 'es', 'international', '2026-10-06T10:00:00Z'),
    card('no-loc', undefined, 'bundesliga', '2026-10-09T12:00:00Z'),
  ];
  assert.deepEqual(railStories(cards, art, 'es').map(c => c.slug), ['bl-new', 'bl-old', 'mls-new', 'intl']);
  assert.deepEqual(railStories(cards, art, 'en').map(c => c.slug), ['mls-new', 'bl-old', 'bl-new', 'en-fallback', 'intl'], 'English: original order, first five');
  assert.deepEqual(railStories([card('x', 'en')], art, 'es'), [], 'nothing native -> the rail is removed (never an English box)');
  const src = readFileSync('src/pages/article.js', 'utf8');
  assert.match(src, /newsLocale\(\{ limit: page === 'en' \? 8 : RAIL_NATIVE_LIMIT \}\)/);
  assert.match(src, /if \(!list\.length\) \{ rail\.remove\(\); return; \}/);
  // the Spanish news index reads the same window (shared cache key -> no extra request after /es/news)
  assert.match(readFileSync('src/pages/news.js', 'utf8'), /api\('news', newsLocale\(\{ limit: 40 \}\)\)/);
});

test('"In the news" on entity pages follows the same rule', () => {
  const src = readFileSync('src/components/related.js', 'utf8');
  assert.match(src, /\.filter\(a => servedInLocale\(a\)\)/);
});

test('article SEO and frozen text untouched: an English-only article on /es keeps English headline/body, no Spanish related', () => {
  const env = { data: { slug: 'fulham-hold-united', desk: 'premier-league', story_class: 'match_recap', headline: 'Fulham hold Manchester United 1-1', dek: 'A late equaliser.', published_at: '2026-10-05T18:00:00Z', locale: 'en', entities: [], body: { sections: [{ key: 'lead', paragraphs: ['Fulham drew 1-1.'] }] }, related: [card('en-1', 'en', 'premier-league')] }, meta: {} };
  const es = inLocale('es', () => renderArticle(env));
  assert.match(es, /<h1 class="art-title" lang="en" data-i18n-skip>Fulham hold Manchester United 1-1<\/h1>/);
  assert.doesNotMatch(es, /art-related/);
  assert.match(es, /data-share-url="https:\/\/soccer\.propbetedge\.ai\/news\/premier-league\/fulham-hold-united"/, 'English canonical URL for an untranslated story');
  const tr = { data: { ...env.data, locale: 'es', translation: { locale: 'es', version: 1 }, headline: 'Fulham empata 1-1', related: [card('es-1', 'es', 'premier-league', '2026-10-04T00:00:00Z', 'Previa'), card('en-1', 'en', 'premier-league')] }, meta: {} };
  const t = inLocale('es', () => renderArticle(tr));
  assert.match(t, /data-share-url="https:\/\/soccer\.propbetedge\.ai\/es\/news\/premier-league\/fulham-hold-united"/);
  assert.equal((t.match(/class="rel-card"/g) || []).length, 1);
});
