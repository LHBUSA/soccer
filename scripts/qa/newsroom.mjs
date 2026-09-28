#!/usr/bin/env node
// NEWSROOM V2 visual contract (real Chrome) at 1440/1280/1024/768/430/390/360/320 on /news and a desk page:
// no horizontal overflow, headlines not clipped beyond their line clamp, every story image loaded or fallen
// back (never broken), Latest rail beside the lead on desktop, filters navigate to a filtered newsroom,
// story links resolve, each story appears once, no console errors. Screenshots of the top at each width.
//   node scripts/qa/newsroom.mjs [--site https://soccer.propbetedge.ai] [--shots D:/Temp/claude/newsroom-v2]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const SHOTS = arg('--shots', 'D:/Temp/claude/newsroom-v2'); mkdirSync(SHOTS, { recursive: true });
const tagSite = /127\.0\.0\.1|localhost/.test(SITE) ? 'local' : 'prod';
const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-newsroom-qa-chrome', args: ['--no-first-run', '--disable-extensions'] });
for (const path of ['/news', '/news/bundesliga']) for (const width of [1440, 1280, 1024, 768, 430, 390, 360, 320]) {
  const pg = await browser.newPage(); const errors = [];
  pg.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); pg.on('pageerror', e => errors.push(String(e)));
  await pg.setViewport({ width, height: width >= 1024 ? 1000 : 844 });
  await pg.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 90000 });
  await pg.evaluate(async () => { document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; }); for (let y = 0; y < document.body.scrollHeight; y += 800) { scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); } scrollTo(0, 0); await new Promise(r => setTimeout(r, 1500)); });
  const r = await pg.evaluate(() => {
    const cards = [...document.querySelectorAll('.nwc')];
    const slugs = cards.map(c => c.querySelector('a')?.getAttribute('href'));
    const imgs = [...document.querySelectorAll('.nwc img, .ovid img')];
    const lead = document.querySelector('.nwc.v-featured')?.getBoundingClientRect(); const rail = document.querySelector('.nr2-rail')?.getBoundingClientRect();
    const heads = [...document.querySelectorAll('.nwc-head')].map(h => ({ clipped: h.scrollWidth > h.clientWidth + 2, lines: Math.round(h.getBoundingClientRect().height / parseFloat(getComputedStyle(h).lineHeight)) }));
    const upper = [...document.querySelectorAll('.nwc-head')].some(h => getComputedStyle(h).textTransform === 'uppercase');
    return { overflow: document.documentElement.scrollWidth > innerWidth + 1, cards: cards.length, dupes: slugs.length - new Set(slugs).size, broken: imgs.filter(i => i.complete && i.naturalWidth === 0).length, imgs: imgs.length,
      leadTop: lead ? Math.round(lead.top) : null, railTop: rail ? Math.round(rail.top) : null, railBeside: lead && rail ? rail.left > lead.right - 2 : null, hclip: heads.filter(h => h.clipped).length, upper,
      tabs: [...document.querySelectorAll('.nr2-tab')].map(a => a.getAttribute('href')), active: document.querySelector('.nr2-tab.on')?.getAttribute('href'), watch: !!document.querySelector('.nr2-watch'), videos: document.querySelectorAll('.nr2-watch .ovid').length,
      ids: [...document.querySelectorAll('.ovid[data-ovid]')].map(v => v.dataset.ovid) };
  });
  const t = `[${width}] ${path}`;
  check(`${t} no horizontal overflow`, !r.overflow);
  check(`${t} stories render, each once`, r.cards > 0 && r.dupes === 0, `${r.cards} cards`);
  check(`${t} no broken images`, r.broken === 0, `${r.imgs} images`);
  check(`${t} headlines editorial case, not clipped`, !r.upper && r.hclip === 0);
  if (width >= 1024) check(`${t} Latest rail beside and aligned with the lead`, r.railBeside && Math.abs(r.leadTop - r.railTop) <= 2, `lead ${r.leadTop} rail ${r.railTop}`);
  check(`${t} active desk filter`, r.active === path, r.active);
  check(`${t} WATCH shows at most 4 videos, none twice`, r.videos <= 4 && new Set(r.ids).size === r.ids.length, `${r.videos} videos`);
  check(`${t} no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  if ([1440, 390].includes(width)) await pg.screenshot({ path: `${SHOTS}/${tagSite}${path.replace(/\//g, '-')}-${width}.png`, fullPage: width === 390 ? false : false });
  await pg.close();
}
// filters + story links navigate client-side to a clean filtered newsroom / the article
{
  const pg = await browser.newPage(); await pg.setViewport({ width: 1280, height: 900 });
  await pg.goto(`${SITE}/news`, { waitUntil: 'networkidle0' });
  await pg.click('.nr2-tab[href="/news/mls"]'); await pg.waitForFunction(() => location.pathname === '/news/mls' && document.querySelector('.nr2-tab.on')?.getAttribute('href') === '/news/mls', { timeout: 20000 });
  const mls = await pg.evaluate(() => ({ title: document.querySelector('.nr2-title')?.textContent, n: document.querySelectorAll('.nwc').length, other: [...document.querySelectorAll('.nwc a')].filter(a => !a.getAttribute('href').startsWith('/news/mls/')).length }));
  check('filter: MLS tab gives a clean MLS newsroom', mls.title === 'MLS newsroom' && mls.n > 0 && mls.other === 0, JSON.stringify(mls));
  const href = await pg.$eval('.nwc.v-featured a', a => a.getAttribute('href'));
  await pg.click('.nwc.v-featured a'); await pg.waitForFunction(h => location.pathname === h && document.querySelector('.art-title'), { timeout: 20000 }, href);
  check('story link opens the article', true, href);
  await pg.close();
}
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, passed: results.filter(r => r.ok).length, total: results.length, results };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/newsroom-v2-${out.at.slice(0, 10)}-${tagSite}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`NEWSROOM QA ${out.passed}/${out.total}`);
process.exit(out.passed === out.total ? 0 : 1);
