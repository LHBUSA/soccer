#!/usr/bin/env node
// SPANISH ARTICLE POLISH QA (LHBUSA/soccer#16): the reviewed article in en + es at 320-1440 px.
//   node scripts/qa/es-article-polish.mjs <base> [--shots <dir>] [--refresh]
// Fails (exit 1) on: horizontal page overflow; an English module phrase inside the Spanish market module (outside
// lang="en"); "a favor de" anywhere in the module; duplicate market column headers; a Spanish rail / related card
// that is not a verified Spanish story; an unlabelled English card on /es/news; a page error.
// Also injects the REAL Liverpool v Man City live payload (3 Polymarket contracts, tests/web/fixtures) into the
// article's market slot to check the widest live table at every width. --refresh: intercepts the module's own 30 s
// read (QA only: the same real payload with one Kalshi price +1¢) and checks the repaint stays Spanish.
// Reports CLS / LCP per page at 390 and 1440.
import { mkdirSync, readFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';
import { articleMarketModule } from '../../src/vendor/kalshi/article-market-ui.js';

const argv = process.argv.slice(2);
const BASE = (argv.find(a => /^https?:/.test(a)) || 'http://127.0.0.1:5191').replace(/\/$/, '');
const SHOTS = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1440];
const ART = '/news/bundesliga/borussia-dortmund-werder-bremen-preview-2026-10-09-2ffe56';
const EN_ONLY = '/news/international/viktor-gyokeres-scoring-run-2026-10-05-170332';
const PAGES = [`/es${ART}`, ART, `/es${EN_ONLY}`];
const liv = JSON.parse(readFileSync(new URL('../../tests/web/fixtures/article-market-soccer-65750069-liv-mci-live.json', import.meta.url), 'utf8'));
const ENGLISH = /No official call|on this event|Not observed|Live market watch|The market result|Since (publication|first)|Checked|Updated|Settle(d|ment)|Final trade|Pre-event|First observed|At (publication|PBE lock)|Focus contract|RELATED MARKET|RULES|observed prices|pre-event path|PBE vs market|side (won|lost)|Result pending|not scored|Not comparable|Awaiting|Prediction-market prices|Movement after publication|to win|\bDraw\b|\bYes\b|\bLIVE\b/;

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-first-run', '--disable-extensions'] });
const fails = []; const notes = []; let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };

async function fresh() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.evaluateOnNewDocument(() => {
    window.__cls = 0; window.__lcp = 0;
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(l => { const e = l.getEntries().at(-1); if (e) window.__lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  });
  return { ctx, page, errors };
}

// Everything the module shows, minus deliberately-marked English.
const moduleState = page => page.evaluate(() => {
  const am = document.querySelector('.am');
  if (!am) return null;
  const c = am.cloneNode(true);
  for (const x of c.querySelectorAll('[lang="en"]')) x.remove();
  const heads = [...am.querySelectorAll('thead th[scope="col"]')].map(th => th.textContent.replace(/\s+/g, ' ').trim());
  const tw = am.querySelector('.am__tw');
  const clipped = [...am.querySelectorAll('thead th[scope="col"]')].filter(th => th.scrollWidth > th.clientWidth + 1).length;
  return { lang: am.getAttribute('lang'), text: c.textContent.replace(/\s+/g, ' '), aria: [...c.querySelectorAll('[aria-label]')].map(x => x.getAttribute('aria-label')).join(' | '), heads, innerScroll: tw ? tw.scrollWidth - tw.clientWidth : 0, clipped, height: am.getBoundingClientRect().height };
});

try {
  for (const path of PAGES) {
    const es = path.startsWith('/es/');
    for (const w of WIDTHS) {
      const { ctx, page, errors } = await fresh();
      await page.setViewport({ width: w, height: 900 });
      await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
      await page.waitForFunction(() => !document.querySelector('[data-art-rail]') || document.querySelector('[data-art-rail]').children.length > 0 || !document.querySelector('[data-art-rail]').isConnected, { timeout: 15000 }).catch(() => {});
      const tag = `${path} @${w}`;
      const ov = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
      ok(ov <= 0, `${tag}: page overflows by ${ov}px`);
      ok(errors.length === 0, `${tag}: page errors ${errors.join(' / ')}`);
      // market module (the reviewed article has one; the English-only story has none)
      const m = await moduleState(page);
      if (path.endsWith(ART)) {
        ok(!!m, `${tag}: market module missing`);
        if (m) {
          ok(new Set(m.heads).size === m.heads.length, `${tag}: duplicate column headers ${JSON.stringify(m.heads)}`);
          ok(!/a favor de/.test(m.text), `${tag}: "a favor de" in module`);
          if (es) {
            ok(m.lang === 'es', `${tag}: module lang=${m.lang}`);
            const leak = ENGLISH.exec(m.text) || ENGLISH.exec(m.aria);
            ok(!leak, `${tag}: English "${leak?.[0]}" in Spanish module: …${leak ? m.text.slice(Math.max(0, leak.index - 50), leak.index + 50) : ''}…`);
          }
          if (m.innerScroll > 0 || m.clipped) notes.push(`${tag}: result table inner scroll ${m.innerScroll}px, clipped headers ${m.clipped}`);
        }
      }
      // sidebars on a Spanish page: verified Spanish stories only (the API card locale is not in the DOM: a Spanish
      // card carries no lang="en" and no "En inglés" tag; the rail/related never list English fallbacks)
      if (es) {
        const side = await page.evaluate(() => [...document.querySelectorAll('.rail-item, .rel-card')].map(a => ({ en: !!a.querySelector('[lang="en"]') || /En inglés/.test(a.textContent), head: a.querySelector('b')?.textContent || '' })));
        for (const s of side) ok(!s.en, `${tag}: English card in a Spanish sidebar: ${s.head}`);
        if (w === 1440) notes.push(`${tag}: sidebar cards ${side.length}: ${side.map(s => s.head.slice(0, 40)).join(' | ')}`);
      }
      if (w === 390 || w === 1440) notes.push(`${tag}: CLS ${(await page.evaluate(() => window.__cls)).toFixed(4)} LCP ${Math.round(await page.evaluate(() => window.__lcp))} ms`);
      // the widest live table: the real Liverpool v Man City payload injected into this article's market slot
      if (path.endsWith(ART)) {
        await page.evaluate(html => { const s = document.querySelector('[data-art-market]'); if (s) s.innerHTML = html; }, articleMarketModule(liv, { placement: 'soccer-article', locale: es ? 'es' : 'en' }));
        const L = await moduleState(page);
        ok(L && L.heads.length === 4 && new Set(L.heads).size === 4, `${tag}: live table headers ${JSON.stringify(L?.heads)}`);
        const ov2 = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
        ok(ov2 <= 0, `${tag}: live table overflows the page by ${ov2}px`);
        if (L && (L.innerScroll > 0 || L.clipped)) notes.push(`${tag}: LIVE table inner scroll ${L.innerScroll}px, clipped headers ${L.clipped}`);
        if (es && L) { const leak = ENGLISH.exec(L.text); ok(!leak, `${tag}: English "${leak?.[0]}" in Spanish live module`); }
        if (SHOTS) { const el = await page.$('.am'); if (el) await el.screenshot({ path: `${SHOTS}/live-${es ? 'es' : 'en'}-${w}.png` }); }
      }
      if (SHOTS && path.endsWith(ART)) { await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2' }); const el = await page.$('.am'); if (el) await el.screenshot({ path: `${SHOTS}/result-${es ? 'es' : 'en'}-${w}.png` }); }
      if (SHOTS && w === 390) await page.screenshot({ path: `${SHOTS}/page-${es ? 'es' : 'en'}-${path.includes('gyokeres') ? 'enonly' : 'art'}-${w}.png`, fullPage: true });
      await ctx.close();
    }
  }
  // /es/news: English originals are announced (lang="en" + "En inglés"), Spanish ones are not
  for (const w of [390, 1440]) {
    const { ctx, page } = await fresh();
    await page.setViewport({ width: w, height: 900 });
    await page.goto(`${BASE}/es/news`, { waitUntil: 'networkidle2', timeout: 60000 });
    const cards = await page.evaluate(() => [...document.querySelectorAll('.nwc-head, .nl-head, .nc2-head')].map(h => ({ lang: h.getAttribute('lang'), tag: !!h.closest('a')?.querySelector('.lang-tag'), head: h.textContent })));
    ok(cards.length > 0, `/es/news @${w}: no cards`);
    for (const c of cards) ok((c.lang === 'en') === c.tag, `/es/news @${w}: card language not announced consistently: ${c.head}`);
    notes.push(`/es/news @${w}: ${cards.filter(c => c.lang === 'en').length} English originals tagged, ${cards.filter(c => !c.lang).length} Spanish`);
    const ov = await page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);
    ok(ov <= 0, `/es/news @${w}: page overflows by ${ov}px`);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/es-news-${w}.png` });
    await ctx.close();
  }
  // live refresh (QA interception): first read = the real live payload, the 30 s read = the same with Kalshi +1¢
  if (argv.includes('--refresh')) {
    const { ctx, page, errors } = await fresh();
    await page.setViewport({ width: 390, height: 900 });
    let n = 0;
    await page.setRequestInterception(true);
    page.on('request', r => {
      if (!r.url().includes('/api/markets/v1/article-market/soccer/')) return r.continue();
      n++;
      const p = structuredClone(liv);
      p.live.venues[0].outcomes[0].current.mid_bp += n > 1 ? 100 : 0;
      r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(p) });
    });
    await page.goto(`${BASE}/es${ART}`, { waitUntil: 'networkidle2', timeout: 60000 });
    await page.evaluate(() => document.querySelector('[data-art-market]')?.scrollIntoView({ block: 'center' }));
    const first = await page.evaluate(() => document.querySelector('.am [data-am-px]')?.textContent);
    await new Promise(r => setTimeout(r, 33000));
    const after = await moduleState(page);
    const second = await page.evaluate(() => document.querySelector('.am [data-am-px]')?.textContent);
    ok(n >= 2, `refresh: module read ${n} time(s) in 33 s`);
    ok(first === '32.5¢' && second === '33.5¢', `refresh: price ${first} -> ${second} (expected 32.5¢ -> 33.5¢)`);
    ok(after?.lang === 'es' && !ENGLISH.exec(after.text), `refresh: repaint not Spanish (${after?.lang}) ${ENGLISH.exec(after?.text || '')?.[0] || ''}`);
    ok(errors.length === 0, `refresh: page errors ${errors.join(' / ')}`);
    notes.push(`refresh: ${n} reads, ${first} -> ${second}, lang ${after?.lang}`);
    await ctx.close();
  }
} finally { await browser.close(); }

for (const n of notes) console.log('note', n);
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log('FAIL', f);
process.exit(fails.length ? 1 : 0);
