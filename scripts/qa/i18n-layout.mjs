#!/usr/bin/env node
// LOCALIZATION LAYOUT QA: header + key pages in every ready locale at desktop/tablet/phone widths.
//   node scripts/qa/i18n-layout.mjs <base> [--shots <dir>]
// Fails (exit 1) on: horizontal page overflow, a header taller than its single-row design on desktop,
// the language control missing/not operable, a page error, or <html lang> not matching the URL locale.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const BASE = (argv.find(a => /^https?:/.test(a)) || 'http://127.0.0.1:5181').replace(/\/$/, '');
const SHOTS = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WIDTHS = [1520, 1440, 1381, 1380, 1100, 1024, 768, 430, 390, 360, 320];
const PAGES = ['/', '/matches', '/competitions/premier-league', '/picks', '/all-access', '/pbecast'];
const LOCALES = ['', '/es'];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-first-run', '--disable-extensions'] });
const fails = [];
let checks = 0;
try {
  // DETERMINISTIC LANGUAGE STATE: no persistent profile. Every locale pass (and the operability steps) runs in its own
  // fresh, isolated browser context, so a language cookie left by an earlier (or killed) run can never leak into a
  // check. Each check also asserts the cookie/URL state it expects and reports both on a mismatch.
  const errors = [];
  let ctx = null; let page = null;
  const fresh = async () => {
    if (ctx) await ctx.close();
    ctx = await browser.createBrowserContext();
    page = await ctx.newPage();
    page.on('pageerror', e => errors.push(String(e.message || e)));
    // Protected preview deployments: --share <url> visits a Vercel share link first (sets the bypass cookie).
    if (argv.includes('--share')) await page.goto(argv[argv.indexOf('--share') + 1], { waitUntil: 'networkidle2' });
  };
  for (const loc of LOCALES) {
    await fresh();
    for (const p of PAGES) {
      for (const w of WIDTHS) {
        errors.length = 0;
        await page.setViewport({ width: w, height: 900 });
        const url = `${BASE}${loc}${p === '/' && loc ? '/' : p}`;
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await page.waitForSelector('#lang-panel', { timeout: 15000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 900));
        const r = await page.evaluate(() => {
          const top = document.querySelector('header.top');
          const btn = document.querySelector('.lang-btn');
          const bs = btn ? getComputedStyle(btn) : null;
          const nav = document.querySelector('#nav');
          const items = nav ? [...nav.children].filter(e => e.offsetParent !== null) : [];
          const mids = items.map(e => { const b = e.getBoundingClientRect(); return b.top + b.height / 2; });
          const rows = mids.length ? (Math.max(...mids) - Math.min(...mids) > 12 ? 2 : 1) : 0;
          return {
            lang: document.documentElement.lang,
            path: location.pathname,
            cookie: (document.cookie.match(/(?:^|;\s*)pbe_lang=([a-z]{2})/) || [])[1] || null,
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            headerH: top ? Math.round(top.getBoundingClientRect().height) : 0,
            navRows: rows,
            langBtnVisible: !!btn && bs.display !== 'none' && btn.offsetParent !== null,
            langLinks: document.querySelectorAll('#lang-panel a[data-lang-switch]').length,
            navOverflow: nav ? nav.scrollWidth - nav.clientWidth : 0,
          };
        });
        checks++;
        const want = loc ? 'es' : 'en';
        const tag = `${want} ${p} @${w}`;
        if (r.lang !== want) fails.push(`${tag}: html lang=${r.lang} (path ${r.path}, pbe_lang cookie ${r.cookie})`);
        // A fresh context carries no language choice: no cookie, and the URL is the one requested (no redirect).
        if (r.cookie !== null) fails.push(`${tag}: unexpected pbe_lang=${r.cookie} in a fresh context`);
        if ((loc ? r.path.startsWith('/es') : !r.path.startsWith('/es')) === false) fails.push(`${tag}: landed on ${r.path}`);
        if (r.overflow > 1) fails.push(`${tag}: page overflows by ${r.overflow}px`);
        if (r.langLinks !== 2) fails.push(`${tag}: ${r.langLinks} language links`);
        if (w >= 1381 && !r.langBtnVisible) fails.push(`${tag}: globe not visible on desktop`);
        if (w >= 1381 && r.navRows > 1) fails.push(`${tag}: desktop nav wraps to ${r.navRows} rows (header ${r.headerH}px)`);
        if (w >= 1381 && r.navOverflow > 1) fails.push(`${tag}: nav content clipped by ${r.navOverflow}px`);
        if (errors.length) fails.push(`${tag}: ${errors[0]}`);
        if (SHOTS && p === '/' && [1440, 1381, 768, 390].includes(w)) {
          await page.bringToFront();
          await page.screenshot({ path: `${SHOTS}/${want}-home-${w}.png`, clip: { x: 0, y: 0, width: w, height: 260 } });
        }
      }
    }
  }
  // Operability: open the selector on desktop, choose Español, land on /es/ with the cookie set.
  await fresh();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(`${BASE}/matches?view=upcoming`, { waitUntil: 'networkidle2' });
  await page.click('.lang-btn');
  const open = await page.$eval('#lang-panel', el => !el.hidden);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2' }), page.click('#lang-panel a[data-lang-switch="es"]')]);
  const after = await page.evaluate(() => ({ path: location.pathname + location.search, lang: document.documentElement.lang, cookie: document.cookie, nav: document.querySelector('#nav a[data-pages*="matches"]')?.textContent, href: document.querySelector('#nav a[data-pages*="matches"]')?.getAttribute('href') }));
  checks++;
  if (!open) fails.push('selector: panel did not open');
  if (after.path !== '/es/matches?view=upcoming' || after.lang !== 'es' || !/pbe_lang=es/.test(after.cookie) || after.href !== '/es/matches') fails.push(`selector: switch to es -> ${JSON.stringify(after)}`);
  if (SHOTS) {
    await page.click('.lang-btn');
    await page.bringToFront();
    await page.screenshot({ path: `${SHOTS}/es-selector-open-1440.png`, clip: { x: 760, y: 0, width: 680, height: 260 } });
  }
  // Mobile: the MORE menu shows the two-option language row. A first visit answers the privacy banner first (it sits
  // over the bottom bar until the visitor chooses, in every language).
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/es/`, { waitUntil: 'networkidle2' });
  const consent = await page.$eval('[data-pbe-deny]', el => el.textContent).catch(() => null);
  checks++;
  if (consent !== null && consent !== 'Rechazar analítica') fails.push(`consent banner not localized: ${consent}`);
  await page.click('[data-pbe-deny]').catch(() => {});
  await page.click('[data-more]');
  await new Promise(r => setTimeout(r, 300));
  const mob = await page.evaluate(() => [...document.querySelectorAll('#lang-panel a')].map(a => ({ t: a.textContent, vis: a.offsetParent !== null, w: Math.round(a.getBoundingClientRect().width) })));
  checks++;
  if (mob.length !== 2 || mob.some(x => !x.vis || x.w < 44)) fails.push(`mobile: language row ${JSON.stringify(mob)}`);
  if (SHOTS) {
    await page.evaluate(() => document.querySelector('#lang-panel').scrollIntoView({ block: 'center' }));
    await new Promise(r => setTimeout(r, 200));
    await page.bringToFront();
    await page.screenshot({ path: `${SHOTS}/es-mobile-menu-390.png` });
  }
  // Back to English through the selector: the cookie flips and the path drops the prefix.
  // A switch that never navigates is a FAILURE with its state (what received the tap), never a crash or a skip.
  const target = await page.evaluate(() => { const a = document.querySelector('#lang-panel a[data-lang-switch="en"]'); const r = a.getBoundingClientRect(); const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return h === a || a.contains(h) ? null : (h?.id || h?.tagName || 'nothing'); });
  if (target) fails.push(`mobile: the English switch is covered by ${target}`);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => fails.push(`selector: switch to en did not navigate (${e.message})`)), page.click('#lang-panel a[data-lang-switch="en"]')]);
  const back = await page.evaluate(() => ({ path: location.pathname, lang: document.documentElement.lang, cookie: document.cookie }));
  checks++;
  if (back.path !== '/' || back.lang !== 'en' || !/pbe_lang=en/.test(back.cookie)) fails.push(`selector: switch to en -> ${JSON.stringify(back)}`);
} finally { await browser.close(); }

console.log(`${checks} checks, ${fails.length} failures`);
for (const f of fails) console.log(`FAIL ${f}`);
process.exit(fails.length ? 1 : 0);
