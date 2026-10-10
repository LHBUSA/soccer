// LHBUSA/soccer#16 — Spanish article polish. External review (94/100) found on a /es/ article:
//   1. "No official call a favor de this event": the DOM localizer translated one fragment of the article-market module
//      (catalog pattern /^on (.+)$/ -> "a favor de …"; `.am` was not a protected boundary);
//   2. adjacent "Polymarket" columns with identical headers (one binary contract per outcome);
//   3. English headlines (API fallbacks) in the Spanish article rail / related coverage.
// Market fixture: REAL production GET /api/markets/v1/article-market/soccer/65750069-… (Liverpool v Man City, read
// 2026-10-10T14:1xZ: LIVE_MARKET_WATCH, NO_PBE_DECISION, Kalshi + 3 Polymarket contracts). News cards: the REAL
// 2026-10-10 /api/soccer/news?locale=es shapes (verified Spanish card + English fallback card).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setCurrentLocale } from '../../src/i18n/current.js';
import { translateText } from '../../src/i18n/translate.js';
import { SKIP } from '../../src/i18n/dom.js';
import { articleMarketHtml } from '../../src/data/article-market.js';
import { articleMarketSlot, related, railHtml } from '../../src/pages/article.js';
import { newsCard } from '../../src/components/newscard.js';
import { mountRelatedNews } from '../../src/components/related.js';
import { foreignStory, inPageLanguage, storyLangTag } from '../../src/i18n/news-lang.js';

const liv = JSON.parse(readFileSync(new URL('./fixtures/article-market-soccer-65750069-liv-mci-live.json', import.meta.url), 'utf8'));
const MATCH = '65750069-4f34-5a2d-83da-0aa5d45aa5c3';
const article = { published_at: '2026-10-09T13:37:55Z', entities: [{ type: 'SportsEvent', name: 'Liverpool v Manchester City', href: `/matches/${MATCH}` }] };
const ES_CARD = { slug: 'borussia-dortmund-werder-bremen-preview-2026-10-09-2ffe56', desk: 'bundesliga', story_class: 'match_preview', locale: 'es', translations: { es: true }, published_at: '2026-10-08T18:37:06+00:00', headline: 'El líder de la Bundesliga, Borussia Dortmund, recibe al Werder Bremen' };
const EN_CARD = { slug: 'viktor-gyokeres-scoring-run-2026-10-05-170332', desk: 'international', story_class: 'player_form', locale: 'en', translations: {}, published_at: '2026-10-05T21:07:38+00:00', headline: 'Viktor Gyökeres extends Sweden scoring run to four Nations League games' };
const text = h => h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const inLocale = (l, f) => { setCurrentLocale(l); try { return f(); } finally { setCurrentLocale('en'); } };

test('P0: the Spanish market module is native copy — one sentence for NO_PBE_DECISION, no hybrid fragment', () => {
  const es = inLocale('es', () => articleMarketSlot(article, { now: liv }));
  assert.match(es, /<section class="am am--live"[^>]* lang="es" aria-label="El mercado en vivo">/);
  assert.match(es, /PBE no ha emitido una selección oficial para este evento\./);
  assert.doesNotMatch(es, /a favor de|No official call|this event|Live market watch|Since publication|Checked/);
  // English page: the original module
  const en = articleMarketSlot(article, { now: liv });
  assert.match(en, /<b>No official call<\/b> on this event/);
  assert.doesNotMatch(en, / lang="es"/);
});

test('P0: the DOM localizer never enters the market module, and no generic "on X" pattern exists any more', () => {
  for (const sel of ['.am', '[data-art-market]', '.kx', '.avm', '.art-body']) assert.ok(SKIP.split(/,\s*/).includes(sel), sel);
  for (const s of [' on this event', 'on Kalshi', 'on the road', 'on loan']) assert.equal(translateText(s, 'es'), s, `no fragment translation of "${s}"`);
  // the specific, whole-meaning entries still work
  assert.equal(translateText(' on target', 'es'), ' a puerta');
  assert.equal(translateText("on 63'", 'es'), "entra 63'");
});

test('audit: whole-string catalog fixes for half-English buttons found by i18n-coverage (no "ABRIR THE …")', () => {
  assert.equal(translateText('OPEN THE FULL MATCHUP ANALYZER · ALL ACCESS →', 'es'), 'ABRIR EL ANALIZADOR COMPLETO DEL PARTIDO · ALL ACCESS →');
  assert.equal(translateText(' WATCH THE LIVE PBECAST', 'es'), ' VER EL PBECAST EN VIVO');
  assert.equal(translateText('WATCH THE LIVE PBECAST →', 'es'), 'VER EL PBECAST EN VIVO →');
  assert.equal(translateText('9 matches in play', 'es'), '9 partidos en juego');
  assert.equal(translateText('Pie izquierdo · Throw-in Set Piece', 'es'), 'Pie izquierdo · Balón parado tras saque de banda');
  assert.equal(translateText('OPEN MLB →', 'es'), 'ABRIR MLB →', 'a bare network name still opens');
  assert.equal(translateText('OPEN THE NEW THING →', 'es'), 'OPEN THE NEW THING →', 'unknown English stays whole English, never a hybrid');
});

test('P1: Kalshi + three Polymarket contracts are four distinct column headers naming each contract (es + en)', () => {
  const heads = h => [...h.matchAll(/<th scope="col">([\s\S]*?)<\/th>/g)].map(m => text(m[1]));
  const es = inLocale('es', () => articleMarketHtml(liv));
  assert.deepEqual(heads(es), ['Kalshi', 'Polymarket Gana Liverpool Mercado relacionado · reglas no verificadas', 'Polymarket Empate Mercado relacionado · reglas no verificadas', 'Polymarket Gana Man City Mercado relacionado · reglas no verificadas']);
  const en = articleMarketHtml(liv);
  assert.deepEqual(heads(en), ['Kalshi', 'Polymarket Liverpool to win RELATED MARKET · RULES NOT VERIFIED', 'Polymarket Draw RELATED MARKET · RULES NOT VERIFIED', 'Polymarket Man City to win RELATED MARKET · RULES NOT VERIFIED']);
  // the same observed prices and the same contract links in both languages
  const px = h => h.match(/[−+±]?\d+(\.\d)?¢/g);
  assert.deepEqual(px(es), px(en));
  const links = h => [...h.matchAll(/href="(https:[^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(links(es), links(en));
});

test('P1: the article rail on a Spanish page lists verified Spanish stories only (never an unlabelled English card)', () => {
  const es = inLocale('es', () => railHtml([EN_CARD, ES_CARD], 'some-other-story'));
  assert.match(es, /El líder de la Bundesliga/);
  assert.doesNotMatch(es, /Gyökeres/);
  assert.equal(inLocale('es', () => railHtml([EN_CARD], 'x')), '', 'no Spanish story -> no rail (no empty box, no English filler)');
  assert.equal(inLocale('es', () => railHtml([ES_CARD], ES_CARD.slug)), '', 'never the article itself');
  // English pages: unchanged behaviour (every card, newest first as served)
  const en = railHtml([EN_CARD, ES_CARD], 'x');
  assert.match(en, /Gyökeres/);
  assert.doesNotMatch(en, /lang="en"|En inglés/);
});

test('P1: related coverage follows the same rule as the rail (API related + client guard)', () => {
  const es = inLocale('es', () => related({ related: [EN_CARD, ES_CARD] }));
  assert.match(es, /RELATED COVERAGE/);
  assert.match(es, /El líder de la Bundesliga/);
  assert.doesNotMatch(es, /Gyökeres/);
  assert.equal(inLocale('es', () => related({ related: [EN_CARD] })), '');
  assert.match(related({ related: [EN_CARD] }), /Gyökeres/);
});

test('audit: news lists that keep English originals on /es announce them — lang="en", DOM pass skipped, "En inglés"', () => {
  const es = inLocale('es', () => newsCard(EN_CARD, 'standard'));
  assert.match(es, /<h3 class="nwc-head" lang="en" data-i18n-skip>Viktor Gyökeres extends Sweden scoring run/);
  assert.match(es, /<span class="lang-tag" lang="es" data-i18n-skip>En inglés<\/span>/);
  const esOwn = inLocale('es', () => newsCard(ES_CARD, 'standard'));
  assert.doesNotMatch(esOwn, /lang="en"|En inglés/, 'a verified Spanish card is not tagged');
  assert.doesNotMatch(newsCard(EN_CARD, 'standard'), /lang="en"|En inglés|lang-tag/, 'English page unchanged');
  for (const v of ['featured', 'rail', 'compact']) assert.match(inLocale('es', () => newsCard(EN_CARD, v)), /lang="en" data-i18n-skip>Viktor/, v);
  assert.equal(foreignStory({ headline: 'x' }, 'es'), true, 'no locale on the card (videos) = the English original');
  assert.equal(storyLangTag(EN_CARD, 'en'), '');
  assert.deepEqual(inPageLanguage([EN_CARD, ES_CARD], 'es'), [ES_CARD]);
});

test('audit: entity "In the news" lists tag English originals on a Spanish page', async () => {
  const slot = { isConnected: true, innerHTML: '' };
  const root = { querySelector: () => slot };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ data: [ES_CARD, EN_CARD], meta: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    setCurrentLocale('es');
    await mountRelatedNews(root, { team: 'borussia-dortmund' });
  } finally { setCurrentLocale('en'); globalThis.fetch = realFetch; }
  assert.match(slot.innerHTML, /<span class="rel-head">El líder de la Bundesliga/);
  assert.match(slot.innerHTML, /<span class="rel-head" lang="en" data-i18n-skip>Viktor Gyökeres[^<]*<\/span><span class="rel-date">[^<]*<span class="lang-tag" lang="es" data-i18n-skip>En inglés<\/span>/);
});
