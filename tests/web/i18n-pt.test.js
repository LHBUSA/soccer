// Brazilian Portuguese (pt-BR) — BUILD-READY, NOT PUBLIC (LHBUSA/soccer#15 Stage 2). The catalog exists and is tested;
// LOCALES.pt.ready stays false, so /pt is a 404, nothing links to it, nothing is indexed. Coverage is measured against
// the REAL English UI harvest (docs/evidence/i18n/en-2026-10-09.json, scripts/qa/i18n-coverage.mjs) and the approved
// Spanish catalog: pt must translate every string es translates, keep numbers/symbols/names, and never fall back to Spanish.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import es from '../../src/i18n/catalog/es.js';
import pt from '../../src/i18n/catalog/pt.js';
import esPro from '../../src/i18n/catalog/es-pro.js';
import ptPro from '../../src/i18n/catalog/pt-pro.js';
import { translateText, registerCatalog } from '../../src/i18n/translate.js';
import { LOCALES, READY_LOCALES, splitLocale, localizePath, readLangCookie, alternateLinks } from '../../src/i18n/locales.js';
import { proCopy, TABLES } from '../../src/i18n/pro-copy.js';
import { localizeMeta } from '../../src/seo/meta-i18n.js';

// Not shipped until launch (bundle weight): registered here exactly as the launch import will.
registerCatalog('pt', pt);
TABLES.pt = ptPro;

const harvest = JSON.parse(readFileSync(new URL('../../docs/evidence/i18n/en-2026-10-09.json', import.meta.url), 'utf8'));
const strings = [...new Set(Object.values(harvest.pages).flatMap(p => p.strings.map(x => x.s)))];
// Words that exist in Spanish UI copy but not in Portuguese: a pt value containing one fell back to Spanish.
const SPANISH = /\b(del|partido|partidos|jugador|jugadores|equipo|goles|tiros?|clasificación|también|según|aquí|ningún|está|más)\b|[ñ¿¡]/i;
const digits = s => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).join(' ');
const symbols = s => (String(s).match(/[→·—▶↗◆$%#|]/g) || []).join('');

test('not public: pt.ready stays false, /pt is not a locale, no hreflang, no cookie honoured', () => {
  assert.equal(LOCALES.pt.ready, false);
  assert.ok(!READY_LOCALES.includes('pt'));
  assert.deepEqual(splitLocale('/pt/news'), { locale: 'en', path: '/pt/news' });
  assert.equal(localizePath('/news', 'pt'), '/news');
  assert.equal(readLangCookie('pbe_lang=pt'), null);
  assert.ok(!alternateLinks('/').some(l => /^pt/.test(l.hreflang)));
  // regional targeting for when it opens: the content is Brazilian Portuguese
  assert.equal(LOCALES.pt.hreflang, 'pt-BR'); assert.equal(LOCALES.pt.htmlLang, 'pt-BR'); assert.equal(LOCALES.pt.og, 'pt_BR');
});

test('parity with the approved Spanish catalog: same exact keys, same pattern count, same html keys, same Pro keys', () => {
  assert.deepEqual(Object.keys(pt.exact).sort(), Object.keys(es.exact).sort());
  assert.equal(pt.patterns.length, es.patterns.length);
  pt.patterns.forEach(([re], i) => assert.equal(re.source, es.patterns[i][0].source, `pattern ${i} regex differs from es`));
  assert.deepEqual(Object.keys(pt.html), Object.keys(es.html));
  const shape = o => (o && typeof o === 'object' && !Array.isArray(o) ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)])) : Array.isArray(o) ? o.length : typeof o);
  assert.deepEqual(shape(ptPro), shape(esPro));
});

test('every exact value: non-empty, translated, same numbers/symbols, same whitespace, never Spanish', () => {
  const bad = [];
  for (const [k, v] of Object.entries(pt.exact)) {
    if (typeof v !== 'string' || !v.trim()) { bad.push(`empty: ${k}`); continue; }
    if (digits(v) !== digits(k) && digits(es.exact[k]) === digits(k)) bad.push(`numbers: ${k} -> ${v}`);
    if (symbols(v) !== symbols(es.exact[k]) && symbols(v) !== symbols(k)) bad.push(`symbols: ${k} -> ${v}`);
    if (/^\s|\s$/.test(k) !== /^\s|\s$/.test(v)) bad.push(`whitespace: ${JSON.stringify(k)}`);
    if (SPANISH.test(v)) bad.push(`spanish: ${k} -> ${v}`);
  }
  assert.deepEqual(bad, []);
});

test('coverage against the real English UI harvest: pt translates every string Spanish translates', () => {
  const SAME = new Set(['Menu', 'Passes', 'REPLAY', 'REPLAYS']); // the same word in Brazilian Portuguese
  const gaps = strings.filter(s => !SAME.has(s) && translateText(s, 'es') !== s && translateText(s, 'pt') === s);
  assert.deepEqual(gaps, []);
  const leaks = strings.filter(s => !SPANISH.test(s)).map(s => translateText(s, 'pt')).filter(v => SPANISH.test(v)); // names like "Dux Logroño" pass through
  assert.deepEqual(leaks, []);
});

test('patterns: names and numbers pass through, words around them are Brazilian Portuguese', () => {
  const t = s => translateText(s, 'pt');
  assert.equal(t('Arsenal vs Chelsea Live Match Intelligence | PropBetEdge'), 'Arsenal x Chelsea: inteligência da partida ao vivo | PropBetEdge');
  assert.equal(t('3 goals'), '3 gols'); assert.equal(t('1 goal'), '1 gol');
  assert.equal(t('12 shots · 5 on target'), '12 finalizações · 5 no gol');
  assert.equal(t('4 min ago'), 'há 4 min');
  assert.equal(t("63' Yellow card Bukayo Saka"), "63' Cartão amarelo Bukayo Saka");
  assert.equal(t('Form, newest first: Win, Draw, Loss'), 'Retrospecto, do mais recente ao mais antigo: Vitória, Empate, Derrota');
  assert.equal(t('3W'), '3V'); assert.equal(t('2L'), '2D');
  assert.equal(t('OPEN MLB →'), 'ABRIR MLB →');
  assert.equal(t('OPEN THE NEW THING →'), 'OPEN THE NEW THING →', 'unknown English stays whole, never a hybrid');
  assert.equal(t(' on this event'), ' on this event');
});

test('Pro copy renders in pt-BR from codes; meaning guard (no probability/prediction claim added)', () => {
  const t = proCopy('pt');
  assert.match(t.ratingLabel('PBE MATCHUP RATING: descriptive component score. Not a win probability or prediction.'), /Não é uma probabilidade de vitória nem uma previsão/);
  assert.equal(t.competition('fifa-world-cup'), 'Copa do Mundo da FIFA');
  assert.equal(t.unit('goals/m'), 'gols/j');
  for (const v of Object.values(ptPro.analyzer.components)) assert.ok(!SPANISH.test(`${v.label} ${v.basis || ''}`), v.label);
});

test('SEO: pt metadata is native pt-BR (never the Spanish description builder)', () => {
  const meta = { title: 'Arsenal vs Chelsea Match Intelligence | PropBetEdge', description: 'x', canonical: 'https://soccer.propbetedge.ai/matches/m1', jsonld: [], imageAlt: '' };
  const m = { status: 'finished', home: { name: 'Arsenal' }, away: { name: 'Chelsea' }, score: { home: 2, away: 1 }, competition: { name: 'Premier League' }, season: '2026/27', kickoff_at: '2026-10-04T14:00:00Z', shots: [1, 2, 3], lineups: true, timeline: [1] };
  const out = localizeMeta(meta, { locale: 'pt', path: '/matches/m1', page: 'match', results: [{ data: m }] });
  assert.equal(out.htmlLang, 'pt-BR');
  assert.equal(out.title, 'Arsenal x Chelsea: inteligência da partida | PropBetEdge');
  assert.match(out.description, /^Arsenal 2–1 Chelsea · Premier League 2026\/27 · 4 de outubro de 2026\. Encerrado\. Inteligência da partida: mapa de eventos \(3 finalizações\), escalações, linha do/, 'description clipped at 165 chars by design');
  assert.ok(!SPANISH.test(out.description));
  // Spanish is unchanged by the refactor
  const outEs = localizeMeta(meta, { locale: 'es', path: '/matches/m1', page: 'match', results: [{ data: m }] });
  assert.match(outEs.description, /Final\. Inteligencia del partido: mapa de eventos \(3 tiros\)/);
});
