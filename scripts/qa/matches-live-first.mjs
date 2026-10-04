#!/usr/bin/env node
// /matches live-first + competition identity acceptance (real Chrome, real API data).
//   node scripts/qa/matches-live-first.mjs [--site https://soccer.propbetedge.ai] [--shots <dir>]
// Checks at 390 / 768 / 1440: LIVE NOW is the first section whenever anything is live and every live card precedes
// every non-live card; no duplicate match cards; no broken image; no horizontal page scroll; every competition chip
// shows its approved logo or its deliberate mono; filters keep live state; Match Intelligence -> Back restores the
// filtered list (URL + scroll).
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { COMPETITION_MEDIA } from '../../src/lib/competition-media.js';
import { FEATURED_COMPS } from '../../src/lib/competitions.js';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const SHOTS = arg('--shots', null);
const WIDTHS = [390, 768, 1440];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-livefirst-chrome', args: ['--no-first-run', '--disable-extensions'] });
const results = [];
const check = (name, ok, detail = {}) => { results.push({ name, ok, ...detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${Object.keys(detail).length ? ' ' + JSON.stringify(detail) : ''}`); };

async function open(path, width) {
  const page = await browser.newPage(); const errors = [];
  page.on('console', m => { if (m.type() === 'error' && !/favicon|Failed to load resource.*(markets|kalshi)/i.test(m.text())) errors.push(m.text()); });
  await page.setViewport({ width, height: width < 700 ? 844 : 900 });
  await page.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(async () => { document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; }); await new Promise(r => setTimeout(r, 1500)); });
  return { page, errors };
}
const inspect = page => page.evaluate(() => {
  const cards = [...document.querySelectorAll('main .mcard')];
  const ids = cards.map(c => c.querySelector('a.mc-cta')?.getAttribute('href'));
  const st = cards.map(c => (c.className.match(/st-(\w+)/) || [])[1]);
  return {
    sections: [...document.querySelectorAll('[data-mgroup]')].map(s => s.dataset.mgroup),
    liveHead: document.querySelector('.mg-live .mg-head')?.textContent.trim() || null,
    states: st, dupes: ids.length - new Set(ids).size,
    liveBeforeOthers: st.lastIndexOf('live') < (st.findIndex(s => s !== 'live') === -1 ? Infinity : st.findIndex(s => s !== 'live')),
    broken: [...document.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')),
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    liveSectionTop: Math.round(document.querySelector('.mg-live')?.getBoundingClientRect().top + scrollY) || null,
    firstCardTop: Math.round(cards[0]?.getBoundingClientRect().top + scrollY) || null,
    chips: [...document.querySelectorAll('.cfilter a')].map(a => ({ comp: new URL(a.href).searchParams.get('competition'), logo: a.querySelector('.clogo img')?.getAttribute('src') || null, mono: a.querySelector('.cmono')?.textContent || null, live: a.querySelector('.cf-live')?.textContent.replace(/\D/g, '') || null })),
  };
});

const liveNow = (await (await fetch(`${SITE}/api/soccer/matches?status=live&limit=100`)).json()).data;
console.log(`live matches in the API right now: ${liveNow.length}`);

for (const w of WIDTHS) {
  for (const path of ['/matches?view=today', '/matches']) {
    const { page, errors } = await open(path, w);
    const r = await inspect(page);
    const tag = `${path} @${w}`;
    if (liveNow.length) {
      check(`${tag}: LIVE NOW is the first section`, r.sections[0] === 'live', { sections: r.sections, head: r.liveHead });
      check(`${tag}: every live card precedes every non-live card`, r.liveBeforeOthers, { states: r.states.join(',') });
      check(`${tag}: live section is the first match block on the page`, r.liveSectionTop !== null && r.liveSectionTop <= r.firstCardTop, { liveSectionTop: r.liveSectionTop, firstCardTop: r.firstCardTop });
    }
    check(`${tag}: no duplicate match cards`, r.dupes === 0, { cards: r.states.length });
    check(`${tag}: no broken images`, r.broken.length === 0, { broken: r.broken });
    check(`${tag}: no horizontal page scroll`, !r.overflowX);
    check(`${tag}: no console errors`, errors.length === 0, { errors: errors.slice(0, 3) });
    if (path === '/matches?view=today') {
      const bad = r.chips.filter(c => c.comp && (COMPETITION_MEDIA[c.comp] ? !(c.logo === COMPETITION_MEDIA[c.comp].url || c.logo === COMPETITION_MEDIA[c.comp].url_dark) : !c.mono));
      check(`${tag}: every competition chip = its own approved logo or its mono`, bad.length === 0, { chips: r.chips.length, bad });
      const missing = FEATURED_COMPS.filter(c => !r.chips.some(x => x.comp === c.slug)).map(c => c.slug);
      check(`${tag}: no enabled competition hidden from the filter`, missing.length === 0, { missing });
    }
    if (SHOTS) { mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/after-${path.includes('today') ? 'today' : 'recent'}-${w}.png`, fullPage: true }); }
    await page.close();
  }
}

// Filters keep live state + Match Intelligence round trip.
if (liveNow.length) {
  const comp = liveNow[0].competition.slug;
  const { page } = await open(`/matches?view=today&competition=${comp}`, 1440);
  const r = await inspect(page);
  check(`competition filter (${comp}) keeps its live matches under LIVE NOW`, r.sections[0] === 'live' && r.states.filter(s => s === 'live').length === liveNow.filter(m => m.competition.slug === comp).length, { sections: r.sections, live: r.states.filter(s => s === 'live').length });
  const others = liveNow.filter(m => m.competition.slug !== comp).length;
  if (others) check('competition filter links back to live matches elsewhere', await page.$eval('.live-elsewhere', e => e.textContent).then(t => t.includes(String(others))).catch(() => false), { others });
  await page.goto(`${SITE}/matches?view=today&state=live`, { waitUntil: 'networkidle0' });
  const rl = await inspect(page);
  check('state filter LIVE shows only live matches', rl.sections.join() === 'live' && rl.states.every(s => s === 'live'), { states: rl.states.join(',') });
  // Round trip from a filtered, scrolled list.
  await page.goto(`${SITE}/matches?view=today&competition=${comp}`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => window.scrollTo(0, 300)); await new Promise(r => setTimeout(r, 300));
  const y0 = await page.evaluate(() => Math.round(scrollY));
  await page.click('main .mcard a.mc-cta');
  await page.waitForFunction(() => /^\/matches\/[0-9a-f-]{36}/.test(location.pathname) && !document.querySelector('main[aria-busy="true"]'), { timeout: 30000 });
  await new Promise(r => setTimeout(r, 800));
  await page.goBack(); await page.waitForFunction(() => document.querySelector('[data-mgroup]'), { timeout: 30000 }); await new Promise(r => setTimeout(r, 800));
  const back = await page.evaluate(() => ({ url: location.pathname + location.search, y: Math.round(scrollY), on: document.querySelector('.cfilter a.on')?.getAttribute('href') }));
  check('Match Intelligence -> Back restores the filtered list and scroll', back.url === `/matches?view=today&competition=${comp}` && back.on?.includes(comp) && Math.abs(back.y - y0) < 40, { y0, ...back });
  await page.close();
}
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, live_in_api: liveNow.length, pass: results.filter(r => r.ok).length, total: results.length, results };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/matches-live-first-${out.at.slice(0, 10)}${/127\.0\.0\.1|localhost/.test(SITE) ? '-local' : ''}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`MATCHES LIVE-FIRST ${out.pass}/${out.total}`);
process.exit(out.pass === out.total ? 0 : 1);
