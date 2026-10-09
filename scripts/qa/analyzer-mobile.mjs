#!/usr/bin/env node
// MOBILE POLISH QA (owner directive 2026-10-09): the network privacy control and the free Matchup Analyzer preview on
// phone widths, English and Spanish.
//   node scripts/qa/analyzer-mobile.mjs <base> <matchId> [--shots <dir>] [--share <url>]
// Fails (exit 1) on: the privacy pill or consent banner overlapping the bottom navigation, a pill touch target under
// 44px or without an accessible name, horizontal overflow, a page error, an internal slug or provider signature in the
// analyzer, or different analyzer numbers between English and Spanish.
// The consent script only renders on *.propbetedge.ai; on a local base its host check is opened for this run only.
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const BASE = (argv.find(a => /^https?:/.test(a)) || 'http://127.0.0.1:5181').replace(/\/$/, '');
const MATCH = argv.find(a => /^[0-9a-f-]{36}$/.test(a));
if (!MATCH) { console.error('usage: analyzer-mobile.mjs <base> <matchId>'); process.exit(2); }
const SHOTS = argv.includes('--shots') ? argv[argv.indexOf('--shots') + 1] : null;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const WIDTHS = [320, 360, 390, 430, 760];
const LEAK = /espn|:source|:derived|premier-league|uefa-|la-liga|serie-a/i;
const local = !/propbetedge\.ai/.test(BASE);

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-first-run', '--disable-extensions'] });
const fails = []; let checks = 0; const numbers = {};
const check = (ok, msg) => { checks++; if (!ok) fails.push(msg); };
const overlap = (a, b) => a && b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
try {
  for (const loc of ['', '/es']) {
    for (const w of WIDTHS) {
      const ctx = await browser.createBrowserContext(); // fresh cookies: the banner opens first
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', e => errors.push(String(e.message || e)));
      if (local) {
        await page.setRequestInterception(true);
        page.on('request', async r => {
          if (!r.url().endsWith('/pbe-consent-v1.js')) return r.continue();
          const body = await (await fetch(r.url())).text();
          r.respond({ status: 200, contentType: 'application/javascript', body: body.replace(/var production=[^;]+;/, 'var production=true;') });
        });
      }
      if (argv.includes('--share')) await page.goto(argv[argv.indexOf('--share') + 1], { waitUntil: 'networkidle2' });
      await page.setViewport({ width: w, height: 800, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      const tag = `${loc || '/en'} @${w}`;
      await page.goto(`${BASE}${loc}/matches/${MATCH}`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('.analyzer-preview', { timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 700));
      const geo = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; }, sel);
      const nav = await geo('.botnav');
      check(w > 760 || nav, `${tag}: bottom nav missing`);
      // 1. consent banner (first visit) clears the bottom navigation
      const banner = await geo('#pbe-consent');
      check(!!banner, `${tag}: consent banner did not open`);
      check(!overlap(banner, nav), `${tag}: consent banner overlaps bottom nav ${JSON.stringify({ banner, nav })}`);
      if (SHOTS && w === 390) await page.screenshot({ path: `${SHOTS}/banner${loc.replace('/', '-') || '-en'}-${w}.png` });
      await page.click('[data-pbe-deny]');
      await page.waitForSelector('#pbe-privacy-choice', { timeout: 5000 }).catch(() => {});
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await new Promise(r => setTimeout(r, 300));
      // 2. privacy pill: above the nav, never over a tab, 44px target, accessible name in the page language
      const pill = await geo('#pbe-privacy-choice');
      check(!!pill, `${tag}: privacy pill missing`);
      if (pill && nav) {
        check(pill.bottom <= nav.top, `${tag}: pill bottom ${pill.bottom} below nav top ${nav.top}`);
        const tabs = await page.$$eval('.botnav a, .botnav button', els => els.map(e => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; }));
        check(!tabs.some(t => overlap(pill, t)), `${tag}: pill overlaps a bottom-nav tab`);
        // the tab under the pill's old spot receives the tap
        const hit = await page.evaluate(() => { const a = document.querySelector('.botnav a'); const r = a.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === a; });
        check(hit, `${tag}: first bottom-nav tab is not the tap target at its centre`);
      }
      if (pill) check(pill.height >= 44 && pill.width >= 44, `${tag}: pill touch target ${pill.width}x${pill.height}`);
      const name = await page.$eval('#pbe-privacy-choice', e => e.textContent.trim()).catch(() => '');
      check(name === (loc ? 'Opciones de privacidad' : 'Privacy choices'), `${tag}: pill label "${name}"`);
      await page.keyboard.press('Shift'); // keyboard modality, so :focus-visible applies as it does for a Tab user
      const focus = await page.evaluate(() => { const b = document.getElementById('pbe-privacy-choice'); b.focus(); return document.activeElement === b && b.matches(':focus-visible') && getComputedStyle(b).outlineStyle !== 'none'; });
      check(focus, `${tag}: pill not focusable with a visible focus ring`);
      // the footer's last line can scroll clear of the pill
      const foot = await page.evaluate(() => { const f = [...document.querySelectorAll('footer *')].filter(e => e.children.length === 0 && e.textContent.trim()).pop(); return f ? f.getBoundingClientRect().bottom : null; });
      if (pill && foot !== null) check(foot <= pill.top + 1, `${tag}: footer last line (${foot}) hidden behind pill (${pill.top})`);
      // 3. analyzer: names and attribution, no slug / signature
      const pv = await page.$eval('.analyzer-preview', e => e.innerText).catch(() => null);
      check(!!pv, `${tag}: analyzer preview not rendered`);
      if (pv) {
        check(!LEAK.test(pv), `${tag}: internal identifier in analyzer: ${(pv.match(LEAK) || [])[0]}`);
        check(/Premier League|LaLiga|Serie A|Bundesliga|MLS|Champions League/.test(pv), `${tag}: no league name in analyzer note`);
        const nums = (pv.match(/-?\d+(?:\.\d+)?/g) || []).join('|');
        if (w === 390) numbers[loc || 'en'] = nums;
      }
      const ovf = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
      check(ovf <= 0, `${tag}: horizontal overflow ${ovf}px`);
      check(!errors.length, `${tag}: page error ${errors[0]}`);
      if (SHOTS && w === 390) {
        await page.evaluate(() => document.querySelector('.analyzer-preview')?.scrollIntoView());
        await page.screenshot({ path: `${SHOTS}/analyzer${loc.replace('/', '-') || '-en'}-${w}.png` });
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.screenshot({ path: `${SHOTS}/pill${loc.replace('/', '-') || '-en'}-${w}.png` });
      }
      await ctx.close();
    }
  }
  check(numbers.en && numbers.en === numbers['/es'], `analyzer numbers differ EN vs ES:\n  en ${numbers.en}\n  es ${numbers['/es']}`);
} finally { await browser.close(); }
console.log(`${checks - fails.length}/${checks} checks passed`);
for (const f of fails) console.log('FAIL', f);
process.exit(fails.length ? 1 : 0);
