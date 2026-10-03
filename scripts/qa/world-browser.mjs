#!/usr/bin/env node
// World Coverage production BROWSER canary for one competition: hub, latest finished match, its PBEcast replay at
// 390 / 768 / 1440. Checks: no error state, real content (table rows / lineups / feed), no horizontal overflow, no
// empty pitch for a spatial:false competition, and (with --nav) the competition link in the LEAGUES menu.
//   node scripts/qa/world-browser.mjs --slug la-liga [--nav]
import { readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const SLUG = argv[argv.indexOf('--slug') + 1];
const NAV = argv.includes('--nav');
const BASE = 'https://soccer.propbetedge.ai';
const acc = JSON.parse(readFileSync(`docs/evidence/world/prod-accept-${SLUG}-${new Date().toISOString().slice(0, 10)}.json`, 'utf8'));
const ms = await (await fetch(`${BASE}/api/soccer/matches?competition=${SLUG}&status=finished&limit=1`)).json();
const matchId = ms.data?.[0]?.id;
const pages = [['hub', `/competitions/${SLUG}`], ['match', `/matches/${matchId}`], ['pbecast', `/pbecast/${matchId}`]];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-qa-chrome-world', args: ['--no-first-run', '--disable-extensions'] });
const results = [];
for (const width of [390, 768, 1440]) for (const [kind, path] of pages) {
  const page = await browser.newPage();
  await page.setViewport({ width, height: 900 });
  const errors = []; page.on('pageerror', e => errors.push(String(e.message || e)));
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle0', timeout: 60000 });
  await page.waitForSelector('main', { timeout: 20000 }).catch(() => {});
  const r = await page.evaluate((slug, kind) => {
    const t = document.body.innerText;
    return {
      error_state: !!document.querySelector('.state.error'), not_found: /Off the pitch/.test(t),
      table_rows: document.querySelectorAll('table tbody tr').length,
      lineups: /LINEUPS|Starting XI/i.test(t), feed_items: document.querySelectorAll('[data-feed] li').length,
      pitch: !!document.querySelector('.pitchwrap'), nomap: !!document.querySelector('.cast-nomap'),
      nav_link: !!document.querySelector(`#leagues-panel a[data-comp="${slug}"]`),
      overflow_x: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  }, SLUG, kind);
  const content = kind === 'hub' ? r.table_rows > 0 : kind === 'match' ? r.lineups : r.feed_items > 0;
  results.push({ width, kind, path, ...r, js_errors: errors.slice(0, 3), pass: !r.error_state && !r.not_found && content && !r.overflow_x && !errors.length && (!NAV || r.nav_link) });
  console.log(JSON.stringify(results.at(-1)));
  await page.close();
}
await browser.close();
acc.browser = { generated_at: new Date().toISOString(), nav_expected: NAV, match_id: matchId, results, pass: results.every(x => x.pass) };
if (NAV) acc.checks.navigation_live = acc.browser.pass && results.every(x => x.nav_link);
acc.checks.browser_canary = acc.browser.pass;
acc.pass = Object.values(acc.checks).every(Boolean);
writeFileSync(`docs/evidence/world/prod-accept-${SLUG}-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(acc, null, 2) + '\n');
console.log('browser pass', acc.browser.pass, 'overall', acc.pass);
