#!/usr/bin/env node
// Nations League media audit: every team mark and player portrait on the key surfaces.
//   node scripts/qa/nations-media.mjs <base> [--widths all] [--shots]
// Per route x width: team marks rendered as <img> vs initials (with the team names that fell back),
// portraits vs silhouettes, image responses (status, content-type, host), CSP errors, ESPN hotlinks.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const WIDTHS = process.argv.includes('--widths') && process.argv[process.argv.indexOf('--widths') + 1] === 'all' ? [1440, 1280, 1024, 768, 430, 390, 360, 320] : [1440];
const SHOTS = process.argv.includes('--shots');
const getJson = async p => (await fetch(`${BASE}/api/soccer/${p}`)).json();
const fin = (await getJson('matches?competition=uefa-nations-league&status=finished&limit=1')).data[0];
const sched = (await getJson('matches?competition=uefa-nations-league&status=scheduled&order=asc&limit=1')).data[0];
const eng = (await getJson('teams/england')).data;
const pl = eng.players_observed.players.find(p => p.portrait)?.slug || eng.players_observed.players[0]?.slug;

const ROUTES = [
  ['hub', '/competitions/uefa-nations-league'],
  ['hub-tables', '/competitions/uefa-nations-league?tab=table'],
  ['hub-nations', '/competitions/uefa-nations-league?tab=teams'],
  ['hub-results', '/competitions/uefa-nations-league?tab=results'],
  ['tables', '/tables?competition=uefa-nations-league'],
  ['team-england', '/teams/england'], ['team-france', '/teams/france'], ['team-spain', '/teams/spain'],
  ['match', `/matches/${fin.id}`], ['match-scheduled', `/matches/${sched.id}`],
  ['pbecast', `/pbecast/${fin.id}`], ['pbecast-hub', '/pbecast'],
  ['player', `/players/${pl}`], ['matches', '/matches?view=upcoming'], ['home', '/'],
];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: process.env.QA_PROFILE || 'D:/Temp/soccer-qa-media', args: ['--no-first-run', '--disable-extensions'] });
const rows = []; const failures = [];
if (SHOTS) mkdirSync('D:/Temp/nations/media-shots', { recursive: true });
try {
  for (const [name, path] of ROUTES) for (const width of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: width < 768 ? 844 : 900 });
    const imgs = []; const csp = [];
    page.on('response', r => { if (r.request().resourceType() === 'image') imgs.push({ url: r.url(), status: r.status(), type: r.headers()['content-type'] || '' }); });
    page.on('console', m => { if (/Content Security Policy|Refused to load/i.test(m.text())) csp.push(m.text().slice(0, 160)); });
    await page.goto(BASE + path, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.state.loading'), { timeout: 30000 }).catch(() => {});
    // scroll through the page so lazy images request
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 60)); } window.scrollTo(0, 0); });
    await new Promise(r => setTimeout(r, 600));
    const dom = await page.evaluate(() => {
      const scope = document.querySelector('#main');
      const marks = [...scope.querySelectorAll('.tmark')];
      const named = el => (el.closest('a,li,tr,.mc-team,.th-top,.sc-team,.fm-side,.pb-side')?.innerText || '').trim().split('\n').find(Boolean)?.slice(0, 30) || '?';
      const pics = [...scope.querySelectorAll('.pic')];
      return {
        marks: marks.length, img_marks: marks.filter(m => m.classList.contains('img') && m.querySelector('img')?.naturalWidth > 0).length,
        initials: marks.filter(m => !m.classList.contains('img')).map(named).slice(0, 12),
        broken: [...scope.querySelectorAll('img')].filter(i => i.complete && i.naturalWidth === 0 && i.getAttribute('loading') !== 'lazy').length,
        pics: pics.length, portraits: pics.filter(p => !p.classList.contains('sil')).length,
        ticker_marks: document.querySelectorAll('#score-ticker .tmark.img, #score-ticker img').length,
      };
    });
    const hot = imgs.filter(i => /espncdn|espn\.com/.test(i.url));
    const bad = imgs.filter(i => i.status >= 400 || !/^image\//.test(i.type));
    rows.push({ route: name, width, ...dom, images: imgs.length, bad: bad.length, hotlinks: hot.length, csp: csp.length });
    if (hot.length) failures.push(`${name}@${width}: ESPN hotlink ${hot[0].url}`);
    if (bad.length) failures.push(`${name}@${width}: bad image ${bad[0].status} ${bad[0].type} ${bad[0].url}`);
    if (csp.length) failures.push(`${name}@${width}: CSP ${csp[0]}`);
    if (dom.broken) failures.push(`${name}@${width}: ${dom.broken} broken images`);
    if (SHOTS && (width === 1440 || width === 390)) await page.screenshot({ path: `D:/Temp/nations/media-shots/${name}-${width}.png` });
    await page.close();
  }
} finally { await browser.close(); }
for (const r of rows.filter(r => r.width === 1440)) console.log(`${r.route.padEnd(16)} marks ${r.img_marks}/${r.marks} img  initials ${JSON.stringify(r.initials)}  portraits ${r.portraits}/${r.pics}  ticker ${r.ticker_marks}  imgs ${r.images} bad ${r.bad} hot ${r.hotlinks}`);
const out = { base: BASE, at: new Date().toISOString(), rows, failures };
mkdirSync('docs/evidence/media', { recursive: true });
writeFileSync(`docs/evidence/media/nations-media-audit-${/localhost|127\./.test(BASE) ? 'preview' : 'production'}-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`${failures.length} failures`); for (const f of failures.slice(0, 20)) console.log('FAIL', f);
