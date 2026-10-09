#!/usr/bin/env node
// TRANSLATED-ARTICLE QA (soccer-article-i18n). For each article path, loads the English page and the /es/ page in fresh
// isolated contexts at 390 and 1440 px and checks:
//   - the Spanish page shows the verified translation (lang=es on the story, the verification notice, a working
//     "Leer en inglés" switch to the English URL), no page error, no horizontal overflow;
//   - UI RESIDUE: visible strings outside the story text that are identical on both pages and read as English
//     (2+ English function words) - names, numbers and brands are identical by design and are not residue;
//   - numbers parity: every digit run in the English story's charts (figures) appears in the Spanish ones.
//   node scripts/qa/article-i18n.mjs <base> <desk/slug> [<desk/slug> ...] [--shots <dir>]
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const BASE = (argv.find(a => /^https?:/.test(a)) || 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const SHOTS = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
const KEYS = argv.filter(a => /^[a-z-]+\/[a-z0-9-]+$/.test(a));
if (!KEYS.length) { console.error('usage: article-i18n.mjs <base> <desk/slug>...'); process.exit(2); }
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const EN_WORDS = /\b(the|and|with|of|for|from|this|that|how|was|were|has|have|is|are|by|on|in|to|at|after|before|read|more|all|latest|loading|open)\b/gi;

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-first-run', '--disable-extensions'] });
const fails = []; let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fails.push(msg); };
async function grab(path, width) {
  const ctx = await browser.createBrowserContext(); const page = await ctx.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.setViewport({ width, height: 900 });
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle2', timeout: 60000 });
  await page.$eval('[data-pbe-deny]', b => b.click()).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  const r = await page.evaluate(() => {
    const vis = e => e.offsetParent !== null || e.getClientRects().length;
    const ui = []; const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement; const t = n.nodeValue.trim();
      if (!t || !p || !vis(p) || p.closest('.art-body, .art-title, .art-dek, .art-trans, .kx, .art-market, script, style, [data-art-rail], .art-related, code')) continue;
      ui.push(t);
    }
    const figs = [...document.querySelectorAll('figure.viz')].map(f => f.innerText);
    const trans = document.querySelector('.art-trans a[data-lang-switch="en"]');
    return {
      htmlLang: document.documentElement.lang, storyLang: document.querySelector('.art-body')?.getAttribute('lang') || null,
      titleLang: document.querySelector('.art-title')?.getAttribute('lang') || null, title: document.querySelector('.art-title')?.textContent || '',
      notice: document.querySelector('.art-trans')?.textContent.trim() || null, switchHref: trans?.getAttribute('href') || null,
      overflow: document.documentElement.scrollWidth - innerWidth, ui, figs,
    };
  });
  if (SHOTS && width === 390) await page.screenshot({ path: `${SHOTS}/${path.split('/').pop()}${path.startsWith('/es/') ? '-es' : '-en'}-390.png`, fullPage: false });
  await ctx.close();
  return { ...r, errors };
}
try {
  for (const key of KEYS) {
    for (const w of [390, 1440]) {
      const en = await grab(`/news/${key}`, w); const es = await grab(`/es/news/${key}`, w);
      const tag = `${key} @${w}`;
      check(es.htmlLang === 'es' && es.storyLang === 'es' && es.titleLang === 'es', `${tag}: lang html=${es.htmlLang} story=${es.storyLang} title=${es.titleLang}`);
      check(es.title && es.title !== en.title, `${tag}: Spanish headline not shown`);
      check(/Traducción verificada/.test(es.notice || ''), `${tag}: verification notice missing (${es.notice})`);
      check(es.switchHref === `/news/${key}`, `${tag}: "Leer en inglés" -> ${es.switchHref}`);
      check(en.notice === null && en.storyLang === null, `${tag}: English page shows translation markers`);
      for (const [l, x] of [['en', en], ['es', es]]) { check(x.overflow <= 0, `${tag} ${l}: overflow ${x.overflow}px`); check(!x.errors.length, `${tag} ${l}: page error ${x.errors[0]}`); }
      const enSet = new Set(en.ui);
      const residue = [...new Set(es.ui.filter(t => enSet.has(t) && (t.match(EN_WORDS) || []).length >= 2))];
      check(!residue.length, `${tag}: English UI residue: ${residue.slice(0, 6).map(s => JSON.stringify(s.slice(0, 60))).join(', ')}`);
      const digits = s => (s.match(/\d+/g) || []).sort().join(' ');
      check(digits(en.figs.join(' ')) === digits(es.figs.join(' ')), `${tag}: chart numbers differ between languages`);
    }
  }
} finally { await browser.close(); }
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log('FAIL', f);
process.exit(fails.length ? 1 : 0);
