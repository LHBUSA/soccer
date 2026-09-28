#!/usr/bin/env node
// Competition logo surfaces (real Chrome): each surface must render competitionMark() as a loaded
// same-origin logo image (.clogo img, naturalWidth > 0), never the typographic mono, when a logo is approved.
//   node scripts/qa/competition-logos.mjs [--site https://soccer.propbetedge.ai]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const mid = (await (await fetch(`${SITE}/api/soccer/teams/bayern-munchen`)).json()).data.recent[0].id;
const dal = 'd4ad8521-0307-54bc-b612-ca070741c9ac';
const SURFACES = [
  ['homepage league cards', '/', '.comptile .clogo img, .ct-top .clogo img'],
  ['top competition navigation', '/', '.railrow .clogo img'],
  ['score ticker', '/', '#score-ticker .stk-comp .clogo img'],
  ['PBEcast hub', '/pbecast', '.hcard .clogo img'],
  ['PBEcast match', `/pbecast/${dal}`, '.ct-comp .clogo img'],
  ['match cards', '/matches', '.mcard .clogo img'],
  ['match page', `/matches/${mid}`, '.mh-comp .clogo img'],
  ['competition page', '/competitions/premier-league', '.lh-top .clogo img'],
  ['news kicker', '/news', '.clogo img'],
  ['tables', '/tables', '.tabs .clogo img'],
  ['Player DNA competition labels', '/players', '.clogo img'],
];
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-complogo-chrome', args: ['--no-first-run', '--disable-extensions'] });
const results = [];
for (const [name, path, sel] of SURFACES) {
  const page = await browser.newPage(); const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(async () => { document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; }); await new Promise(r => setTimeout(r, 1500)); });
  const r = await page.evaluate(s => {
    const imgs = [...document.querySelectorAll(s)];
    return { logos: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length, sameOrigin: imgs.every(i => /^\/api\/soccer\/media\/[0-9a-f]{64}$/.test(i.getAttribute('src'))), monos: document.querySelectorAll('.cmono').length, px: imgs[0] ? Math.round(imgs[0].getBoundingClientRect().width) : 0 };
  }, sel);
  const ok = r.logos > 0 && r.loaded === r.logos && r.sameOrigin && errors.length === 0;
  results.push({ surface: name, path, ok, ...r, console_errors: errors.length });
  console.log(`${ok ? 'LIVE' : 'FAIL'} ${name.padEnd(32)} logos ${r.loaded}/${r.logos} (${r.px}px) monos on page ${r.monos}`);
  await page.close();
}
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, live: results.filter(r => r.ok).length, total: results.length, results };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/competition-logos-${out.at.slice(0, 10)}${SITE.includes('127.0.0.1') ? '-local' : ''}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`COMPETITION LOGO SURFACES ${out.live}/${out.total}`);
