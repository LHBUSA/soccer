#!/usr/bin/env node
// Production-browser QA for the soccer web app (puppeteer-core + installed Chrome).
//   node scripts/qa/browser.mjs https://soccer.propbetedge.ai [--shots]
// Checks every route at 320/360/390/430/768/1024/1440: renders real content, no
// horizontal overflow, no console errors, no failed requests, same-origin API only,
// no provider calls, internal navigation works, internal files not served, no
// secrets in the bundle. Writes docs/evidence/qa/browser-<date>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = (process.argv[2] || 'http://localhost:4173').replace(/\/$/, '');
const SHOTS = process.argv.includes('--shots');
const WIDTHS = [320, 360, 390, 430, 768, 1024, 1440];
const ORIGIN = new URL(BASE).origin;
const ALLOWED_HOSTS = new Set([new URL(BASE).host, 'fonts.googleapis.com', 'fonts.gstatic.com']);
const FORBIDDEN = /espn\.com|openligadb|figshare|wyscout|supabase|workers\.dev/i;

const getJson = async p => (await fetch(`${BASE}/api/soccer/${p}`)).json();
const espnMatch = (await getJson('matches?competition=premier-league&status=finished&limit=1')).data[0];
const uclMatch = (await getJson('matches?competition=uefa-champions-league&status=finished&limit=1')).data[0];
const wyMatch = (await getJson('matches?competition=bundesliga&season=2017/18&status=finished&limit=1')).data[0];
const espnDetail = (await getJson(`matches/${espnMatch.id}`)).data;
const playerSlug = espnDetail.lineups?.home?.starters?.find(Boolean)?.slug;
const story = ((await getJson('news?limit=1')).data || [])[0];

const ROUTES = [
  { path: '/', expect: ['SOCCER INTELLIGENCE', 'One canonical field', 'MLS', 'BUNDESLIGA', 'PREMIER LEAGUE', 'CHAMPIONS LEAGUE'], name: 'home' },
  { path: '/competitions', expect: ['Competitions on the canonical graph'], name: 'competitions' },
  { path: '/competitions/bundesliga', expect: ['Bundesliga', 'TABLE'], name: 'bundesliga' },
  { path: '/competitions/premier-league', expect: ['Premier League', 'TABLE'], name: 'epl' },
  { path: '/competitions/uefa-champions-league', expect: ['Champions League', 'League phase'], name: 'ucl' },
  { path: '/competitions/mls', expect: ['Major League Soccer', 'OVERVIEW', 'TEAMS'], name: 'mls' },
  { path: '/competitions/mls?tab=table', expect: ['Major League Soccer', 'PTS'], name: 'mls-table' },
  { path: '/matches', expect: ['From result to event map'], name: 'matches' },
  { path: '/matches?view=upcoming', expect: ['Upcoming'], name: 'matches-upcoming' },
  { path: `/matches/${espnMatch.id}`, expect: ['MATCH INTELLIGENCE', 'EVENT LOCATIONS — NOT PLAYER TRACKING', 'SOURCE MATCH STATISTICS', 'STARTING XI', 'ESPN', 'SHOT INTELLIGENCE', 'PLAYER IMPACT'], marks: true, name: 'match-espn-epl' },
  { path: `/matches/${uclMatch.id}`, expect: ['EVENT LOCATIONS — NOT PLAYER TRACKING', 'SOURCE MATCH STATISTICS'], marks: true, name: 'match-espn-ucl' },
  { path: `/matches/${wyMatch.id}`, expect: ['EVENT LOCATIONS — NOT PLAYER TRACKING', 'PBE DERIVED COUNTS', 'Wyscout'], marks: true, name: 'match-wyscout' },
  { path: `/teams/${espnMatch.home.slug}`, expect: ['TEAM', 'Recent results'], name: 'team' },
  { path: '/teams/bayern-munchen', expect: ['Bayern'], name: 'team-bayern' },
  ...(playerSlug ? [{ path: `/players/${playerSlug}`, expect: ['PLAYER INTELLIGENCE', 'Player DNA is descriptive'], name: 'player-espn' }] : []),
  { path: '/players/robert-lewandowski', expect: ['PLAYER INTELLIGENCE', '2017/18'], name: 'player-wyscout' },
  { path: '/tables', expect: ['TABLES', 'Pts'], name: 'tables' },
  { path: '/tables?competition=premier-league', expect: ['Premier League', 'Pts'], name: 'tables-epl' },
  { path: '/tables?competition=uefa-champions-league', expect: ['Champions League'], name: 'tables-ucl' },
  ...(story ? [
    { path: '/news', expect: ['PROPBETEDGE SOCCER NEWSROOM', 'Soccer news', story.headline], name: 'news' },
    { path: `/news/${story.desk}`, expect: ['news', story.headline], name: 'news-desk' },
    { path: `/news/${story.desk}/${story.slug}`, expect: [story.headline, 'EVIDENCE AND METHOD', 'Evidence packet'], name: 'article' },
  ] : [{ path: '/news', expect: ['PROPBETEDGE SOCCER NEWSROOM', 'Evidence-backed soccer reporting is coming online.'], name: 'news' }]),
  { path: '/sources', expect: ['Where every fact comes from'], name: 'sources' },
  { path: '/this-route-does-not-exist', expect: ['Off the pitch'], name: 'notfound' },
];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-qa-chrome', args: ['--no-first-run', '--disable-extensions'] });
const results = []; const failures = [];
const fail = (r, msg) => { failures.push(`${r}: ${msg}`); };
try {
  for (const route of ROUTES) {
    for (const width of WIDTHS) {
      const page = await browser.newPage();
      await page.setViewport({ width, height: width < 768 ? 844 : 900, deviceScaleFactor: 1 });
      const consoleErrors = []; const failed = []; const hosts = new Set(); const apiCalls = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
      page.on('pageerror', e => consoleErrors.push(String(e)));
      page.on('requestfailed', r => failed.push(`${r.url()} ${r.failure()?.errorText}`));
      page.on('request', r => { const u = new URL(r.url()); hosts.add(u.host); if (u.pathname.startsWith('/api/')) apiCalls.push(u.pathname); if (FORBIDDEN.test(u.host)) failed.push(`FORBIDDEN HOST ${u.host}`); });
      const res = await page.goto(BASE + route.path, { waitUntil: 'networkidle0', timeout: 45000 });
      await page.waitForFunction(() => !document.querySelector('.state.loading'), { timeout: 30000 }).catch(() => {});
      const info = await page.evaluate(() => ({
        text: document.body.innerText, overflow: document.documentElement.scrollWidth - window.innerWidth,
        marks: document.querySelectorAll('.pitch .mark').length, title: document.title, errorState: !!document.querySelector('.state.error'),
      }));
      const tag = `${route.name}@${width}`;
      const missing = route.expect.filter(t => !info.text.toLowerCase().includes(t.toLowerCase()));
      if (res.status() >= 400 && route.name !== 'notfound') fail(tag, `HTTP ${res.status()}`);
      if (missing.length) fail(tag, `missing text: ${missing.join(' | ')}`);
      if (info.overflow > 1) fail(tag, `horizontal overflow ${info.overflow}px`);
      // The 404 route's own document is a real 404 (SEO): that single resource error is expected.
      if (route.name === 'notfound') { const i = consoleErrors.findIndex(e => /status of 404/.test(e)); if (i >= 0) consoleErrors.splice(i, 1); }
      if (consoleErrors.length) fail(tag, `console errors: ${consoleErrors.slice(0, 3).join(' || ')}`);
      if (failed.length) fail(tag, `failed requests: ${failed.slice(0, 3).join(' || ')}`);
      if (info.errorState) fail(tag, 'error state rendered');
      if (route.marks && info.marks < 1) fail(tag, 'event map has no events');
      for (const h of hosts) if (!ALLOWED_HOSTS.has(h)) fail(tag, `unexpected host ${h}`);
      if (apiCalls.some(p => !p.startsWith('/api/soccer/'))) fail(tag, 'API call outside /api/soccer');
      results.push({ route: route.path, width, status: res.status(), overflow: info.overflow, marks: info.marks, console_errors: consoleErrors.length, failed_requests: failed.length, api_calls: apiCalls.length, hosts: [...hosts], title: info.title });
      if (SHOTS && (width === 390 || width === 1440)) { mkdirSync('.proof/qa-shots', { recursive: true }); await page.screenshot({ path: `.proof/qa-shots/${route.name}-${width}.png`, fullPage: true }); }
      await page.close();
    }
    console.log(`${route.name.padEnd(18)} done`);
  }
  // Tap an event-map mark at 390 and check the detail panel; internal navigation from home.
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.goto(`${BASE}/matches/${espnMatch.id}`, { waitUntil: 'networkidle0' });
  await page.click('.pitchwrap.port .mark');
  const detail = await page.$eval('.emap-detail', n => n.innerText);
  if (!/'/.test(detail)) fail('tap-detail', `detail not shown: ${detail}`);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
  await page.click('.mc-cta');
  await page.waitForFunction(() => location.pathname.startsWith('/matches/') && !document.querySelector('.state.loading'), { timeout: 20000 });
  const navOk = await page.evaluate(() => document.body.innerText.toUpperCase().includes('MATCH INTELLIGENCE'));
  if (!navOk) fail('internal-nav', 'match page did not render after clicking a card');
  await page.close();
} finally { await browser.close(); }

// Bundle + file exposure checks.
const html = await (await fetch(BASE + '/')).text();
const assets = [...html.matchAll(/\/assets\/[\w.-]+\.(js|css)/g)].map(m => m[0]);
for (const a of assets) {
  const body = await (await fetch(BASE + a)).text();
  if (/service_role|eyJhbGciOi|SUPABASE|workers\.dev|sbp_|INGEST_ADMIN/i.test(body)) fail('bundle', `secret-like or upstream string in ${a}`);
}
const exposure = [];
for (const p of ['/workers/soccer-ingest/src/index.js', '/supabase/migrations/20260927000100_soccer_core.sql', '/package.json', '/tests/core.test.js', '/scripts/guard-truth.mjs', '/docs/RELEASE.md', '/data/registry/competitions.json', '/api/soccer.js', '/.env', '/vercel.json']) {
  const r = await fetch(BASE + p); const t = await r.text();
  const leaked = /create table|export default|"scripts"|import |registry_version|\$schema|node:test/.test(t) && !t.includes('<div id="app">');
  exposure.push({ path: p, status: r.status, leaked });
  if (r.status !== 404) fail('exposure', `${p} returned ${r.status}, want 404`);
  if (leaked) fail('exposure', `${p} served source content`);
}
const proxyChecks = [];
for (const [p, want] of [['/api/soccer/health', 200], ['/api/soccer/competitions', 200], ['/api/soccer/..%2F..%2Fetc%2Fpasswd', 'reject'], ['/api/soccer/https:%2F%2Fevil.example', 'reject'], ['/api/soccer/matches/not-a-uuid', 'reject']]) {
  const r = await fetch(BASE + p); proxyChecks.push({ path: p, status: r.status }); if (want === 'reject' ? r.status < 400 : r.status !== want) fail('proxy', `${p} -> ${r.status}, want ${want}`);
}
const post = await fetch(BASE + '/api/soccer/competitions', { method: 'POST' });
proxyChecks.push({ path: 'POST /api/soccer/competitions', status: post.status });
if (post.status < 400) fail('proxy', `POST allowed (${post.status})`);

const out = { base: BASE, at: new Date().toISOString(), widths: WIDTHS, routes: ROUTES.map(r => r.path), checks: results.length, failures, pass: failures.length === 0, exposure, proxy: proxyChecks, results };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/browser-${out.at.slice(0, 10)}-${new URL(BASE).hostname}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`checks ${results.length}, failures ${failures.length}`);
for (const f of failures.slice(0, 40)) console.log(' -', f);
process.exit(failures.length ? 1 : 0);
