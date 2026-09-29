#!/usr/bin/env node
// Browser QA for UEFA Nations League (+ Soccer Pro when --pro) at 8 widths.
//   node scripts/qa/nations-pro.mjs <base> [--pro] [--shots]
// Checks per route x width: expected text, forbidden text (club on national surfaces, premium values
// for a free reader), horizontal overflow, clipped content, console errors, failed requests.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = (process.argv[2] || 'http://localhost:4180').replace(/\/$/, '');
const PRO = process.argv.includes('--pro'); const SHOTS = process.argv.includes('--shots');
const WIDTHS = [1440, 1280, 1024, 768, 430, 390, 360, 320];
const getJson = async p => (await fetch(`${BASE}/api/soccer/${p}`)).json();
const fin = (await getJson('matches?competition=uefa-nations-league&status=finished&limit=1')).data[0];
const next = (await getJson('matches?competition=uefa-nations-league&status=scheduled&order=asc&limit=1')).data[0];
const italy = (await getJson('teams/italy')).data;
const player = italy.players_observed.players.find(p => p.slug)?.slug;
const NATIONAL_NO_CLUB = /\bclubs?\b/i;

const ROUTES = [
  { path: '/competitions/uefa-nations-league', expect: ['UEFA Nations League', 'INTERNATIONAL', 'GROUP STANDINGS', 'UPCOMING', 'RESULTS', 'DATA COVERAGE'], noClub: true, name: 'hub' },
  { path: '/competitions/uefa-nations-league?tab=table', expect: ['League A', 'League B', 'League C', 'League D', 'Group A1', 'VERIFIED', 'Nation'], maxRows: 4, noClub: true, name: 'hub-tables' },
  { path: '/competitions/uefa-nations-league?tab=teams', expect: ['NATIONS', 'national teams', 'Italy'], noClub: true, name: 'hub-nations' },
  { path: '/tables?competition=uefa-nations-league', expect: ['UEFA Nations League', 'League A', 'Group A1', 'HOW GROUP TABLES ARE VERIFIED'], maxRows: 4, name: 'tables' },
  { path: '/teams/italy', expect: ['NATIONAL TEAM', 'Italy', 'SQUAD', 'Group A1'], noClub: true, name: 'team-national' },
  { path: `/matches/${fin.id}`, expect: ['MATCH INTELLIGENCE', 'STARTING XI', 'SOURCE MATCH STATISTICS'], name: 'match' },
  { path: `/pbecast/${fin.id}`, expect: ['PBECAST', 'REPLAY FEED', 'REPLAY FROM KICK-OFF'], name: 'pbecast' },
  ...(next ? [{ path: `/matches/${next.id}`, expect: [next.home.name, next.away.name], name: 'match-scheduled' }] : []),
  ...(player ? [{ path: `/players/${player}`, expect: ['PLAYER INTELLIGENCE', 'Nations League'], name: 'player-dna' }] : []),
  { path: '/competitions/mls', expect: ['Major League Soccer', 'CLUB'], name: 'club-hub-unchanged' },
  { path: '/', expect: ['INTERNATIONAL', 'MLS', 'CHAMPIONS LEAGUE'], name: 'home' },
  ...(PRO ? [
    { path: '/pro', expect: ['SOCCER PRO', 'The match before the score', 'MATCHUP LAB', 'FATIGUE INTELLIGENCE', 'MODEL LAB', 'RESEARCH IN PROGRESS', '$29/month', 'THEEDGE25', 'GET ALL ACCESS'], forbid: [/"score"/, /TEAM FATIGUE INDEX\s*\d/], name: 'pro' },
    { path: `/pro/matches/${next?.id || fin.id}`, expect: ['All Access required', 'GET ALL ACCESS'], forbid: [/\/100\b/], name: 'pro-match-locked' },
    { path: '/news', expect: ['INTELLIGENCE', 'ALL ACCESS', 'SPORT NETWORK', 'SOCCER', 'CURRENT', 'NFL', 'TENNIS', 'SOCCER PRO', 'Matchup Lab', 'PropSports API', 'X @PROPBETEDGE', 'PROPBETEDGE ALL ACCESS'], name: 'shell-footer' },
  ] : []),
];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-qa-chrome-unl', args: ['--no-first-run', '--disable-extensions'] });
const failures = []; const results = [];
if (SHOTS) mkdirSync('D:/Temp/nations/shots', { recursive: true });
try {
  for (const r of ROUTES) for (const width of WIDTHS) {
    const page = await browser.newPage();
    await page.setViewport({ width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1 });
    const errs = []; const bad = []; const premium = [];
    page.on('console', m => { if (m.type() === 'error' && !/favicon|ERR_BLOCKED_BY_CLIENT|googletagmanager/.test(m.text())) errs.push(m.text()); });
    page.on('pageerror', e => errs.push(String(e)));
    page.on('requestfailed', q => { if (!/google|gtag/.test(q.url())) bad.push(`${q.url()} ${q.failure()?.errorText}`); });
    page.on('response', async res => { const u = new URL(res.url()); if (/\/api\/soccer\/pro\/(board|matches|teams)/.test(u.pathname)) premium.push(`${u.pathname} ${res.status()}`); });
    await page.goto(BASE + r.path, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => !document.querySelector('.state.loading'), { timeout: 30000 }).catch(() => {});
    const info = await page.evaluate(() => ({
      text: document.body.innerText, html: document.getElementById('main')?.innerHTML || '', overflow: document.documentElement.scrollWidth - window.innerWidth,
      clipped: [...document.querySelectorAll('#main *, .top *, footer *')].filter(el => { const b = el.getBoundingClientRect(); if (!b.width || b.right <= window.innerWidth + 1 || getComputedStyle(el).display === 'none') return false; for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { if (getComputedStyle(a).overflowX !== 'visible') return false; } return true; }).slice(0, 3).map(el => `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`),
      error: !!document.querySelector('.state.error'),
      maxRows: Math.max(0, ...[...document.querySelectorAll('#main table.ltable')].map(t => t.tBodies[0]?.rows.length || 0)),
    }));
    const id = `${r.name}@${width}`;
    // innerText follows CSS text-transform, so text is compared case-insensitively
    const low = info.text.toLowerCase();
    const miss = (r.expect || []).filter(t => !low.includes(t.toLowerCase()));
    if (r.maxRows && info.maxRows > r.maxRows) failures.push(`${id}: a table with ${info.maxRows} rows (group tables have at most ${r.maxRows}; no overall table)`);
    if (miss.length) failures.push(`${id}: missing ${JSON.stringify(miss)}`);
    for (const re of r.forbid || []) if (re.test(info.text) || re.test(info.html)) failures.push(`${id}: forbidden ${re}`);
    if (r.noClub && NATIONAL_NO_CLUB.test(info.text.replace(/club football|club-league|CLUB\n/gi, ''))) { const m = info.text.match(/.{0,40}\bclubs?\b.{0,40}/i); failures.push(`${id}: 'club' on a national surface: ${m?.[0]}`); }
    if (info.overflow > 0) failures.push(`${id}: horizontal overflow ${info.overflow}px`);
    if (info.clipped.length) failures.push(`${id}: clipped ${info.clipped.join(',')}`);
    if (info.error) failures.push(`${id}: error state`);
    if (errs.length) failures.push(`${id}: console ${errs.slice(0, 2).join(' | ')}`);
    if (bad.length) failures.push(`${id}: failed ${bad.slice(0, 2).join(' | ')}`);
    if (PRO && premium.some(p => !/ 403$/.test(p))) failures.push(`${id}: premium route answered a free reader: ${premium.join(',')}`);
    if (SHOTS && [1440, 390, 320].includes(width)) await page.screenshot({ path: `D:/Temp/nations/shots/${r.name}-${width}.png`, fullPage: false });
    results.push({ id, ok: !failures.some(f => f.startsWith(`${id}:`)) });
    await page.close();
  }
} finally { await browser.close(); }
const out = { base: BASE, at: new Date().toISOString(), checks: results.length, passed: results.filter(r => r.ok).length, failures };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/nations${PRO ? '-pro' : ''}-${/localhost|127\./.test(BASE) ? 'preview' : 'production'}-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`${out.passed}/${out.checks} checks passed`); for (const f of failures.slice(0, 40)) console.log('FAIL', f);
process.exit(failures.length ? 1 : 0);
