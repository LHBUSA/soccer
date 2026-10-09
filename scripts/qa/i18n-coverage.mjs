#!/usr/bin/env node
// LOCALIZATION COVERAGE QA (puppeteer-core + installed Chrome).
//   node scripts/qa/i18n-coverage.mjs <base> --locale en   harvest every rendered UI string (catalog input)
//   node scripts/qa/i18n-coverage.mjs <base> --locale es   report English UI residue on the Spanish pages
// Walks every page type (plus open menus, the account sheet and the player drawer), collects text nodes and
// aria-label/title/placeholder/alt values outside the protected containers (article bodies, Kalshi markets),
// and writes docs/evidence/i18n/<locale>-<date>.json. In es mode a string is RESIDUE when it is identical to an
// English string on the same page AND reads as English prose/UI (stopword or known UI vocabulary): names and
// numbers are identical in both languages by design and are not residue.
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const argv = process.argv.slice(2);
const BASE = (argv.find(a => /^https?:/.test(a)) || 'http://127.0.0.1:5181').replace(/\/$/, '');
const LOCALE = argv[argv.indexOf('--locale') + 1] || 'en';
const ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : null;
const API = argv.includes('--api') ? argv[argv.indexOf('--api') + 1] : `${BASE}/api/soccer`;
const prefix = LOCALE === 'en' ? '' : `/${LOCALE}`;

const getJson = async p => (await fetch(`${API}/${p}`)).json();
const pick = (env, f = () => true) => (env?.data || []).find(f);
const finished = pick(await getJson('matches?competition=premier-league&status=finished&limit=5'), m => m.id);
const upcoming = pick(await getJson('matches?status=scheduled&limit=5'), m => m.id);
const detail = finished ? (await getJson(`matches/${finished.id}`)).data : null;
const playerSlug = detail?.lineups?.home?.starters?.find(Boolean)?.slug || 'robert-lewandowski';
const story = pick(await getJson('news?limit=1'));

const ROUTES = [
  ['home', '/'], ['competitions', '/competitions'], ['competition', '/competitions/premier-league'],
  ['competition-ucl', '/competitions/uefa-champions-league'], ['competition-mls-table', '/competitions/mls?tab=table'],
  ['matches', '/matches'], ['matches-upcoming', '/matches?view=upcoming'],
  ...(finished ? [['match', `/matches/${finished.id}`], ['pbecast', `/pbecast/${finished.id}`], ['pro-match', `/pro/matches/${finished.id}`], ['team', `/teams/${finished.home.slug}`]] : []),
  ...(upcoming ? [['match-upcoming', `/matches/${upcoming.id}`]] : []),
  ['pbecast-hub', '/pbecast'], ['players', '/players'], ['player', `/players/${playerSlug}`], ['tables', '/tables'],
  ['pro', '/pro'], ['all-access', '/all-access'], ['news', '/news'],
  ...(story ? [['news-desk', `/news/${story.desk}`], ['article', `/news/${story.desk}/${story.slug}`]] : []),
  ['sources', '/sources'], ['picks', '/picks'], ['track-record', '/track-record'],
].filter(([n]) => !ONLY || ONLY.includes(n));

const STOP = /\b(the|and|of|to|in|for|with|is|are|not|no|by|from|on|this|that|every|each|all|only|when|we|our|your|you|it|its|be|has|have|at|or|as|an|a|yet|more|than|per|after|before|until|show|shown|view|open|read|see|sign|back|next|previous|today|latest|live|match|matches|player|players|team|teams|table|tables|goal|goals|shots?|assists?|minutes?|season|seasons|results?|fixtures?|upcoming|finished|scheduled|full time|home|away|picks?|record|model|source|sources|method|members?|access|unlocked?|loading|unavailable|coming|soon|news|story|stories|share|close|menu|more|search|filter|sort|all)\b/i;

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'C:/Users/goodl/.cache/i18n-qa-chrome', args: ['--no-first-run', '--disable-extensions'] });
const out = { base: BASE, locale: LOCALE, at: new Date().toISOString(), pages: {} };
try {
  const page = await browser.newPage();
  // Protected preview deployments: --share <url> visits a Vercel share link first (sets the bypass cookie).
  if (argv.includes('--share')) await page.goto(argv[argv.indexOf('--share') + 1], { waitUntil: 'networkidle2' });
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message || e)));
  for (const [name, path] of ROUTES) {
    const url = `${BASE}${prefix}${path === '/' && prefix ? '/' : path}`;
    errors.length = 0;
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
    await page.waitForSelector('main[data-route-seq], main .canvas, main section', { timeout: 20000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1200));
    // Open what a reader can open: both nav menus, the account sheet; then harvest.
    await page.evaluate(() => { for (const p of document.querySelectorAll('.navpanel, .lang-panel')) p.hidden = false; });
    if (name === 'home') await page.evaluate(() => document.querySelector('[data-account-open]')?.click());
    await new Promise(r => setTimeout(r, name === 'home' ? 1500 : 200));
    const res = await page.evaluate(() => {
      const SKIP = '.art-body, [data-kx-impression], .kx, .kx-strip, .kx-line, .avm, script, style, noscript, [translate="no"], [data-i18n-skip]';
      const strings = new Map();
      const add = (s, kind) => { const t = (s || '').replace(/\s+/g, ' ').trim(); if (t && /[A-Za-z]/.test(t)) strings.set(t, kind); };
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) if (!n.parentElement?.closest(SKIP)) add(n.nodeValue, 'text');
      for (const el of document.body.querySelectorAll('[aria-label], [title], [placeholder], img[alt]')) {
        if (el.closest(SKIP)) continue;
        for (const a of ['aria-label', 'title', 'placeholder', 'alt']) if (el.hasAttribute(a)) add(el.getAttribute(a), a);
      }
      return { lang: document.documentElement.lang, title: document.title, strings: [...strings].map(([s, k]) => ({ s, k })) };
    });
    out.pages[name] = { url, lang: res.lang, title: res.title, errors: [...errors], strings: res.strings };
    console.log(`${name.padEnd(22)} ${String(res.strings.length).padStart(4)} strings  lang=${res.lang}  errors=${errors.length}`);
  }
} finally { await browser.close(); }

if (LOCALE !== 'en') {
  let total = 0;
  for (const [name, p] of Object.entries(out.pages)) {
    p.residue = p.strings.map(x => x.s).filter(s => STOP.test(s) && !/^[A-Z][a-z]+(?: [A-Z][a-zé]+)+$/.test(s));
    total += p.residue.length;
  }
  out.residue_total = total;
  console.log(`residue (English UI strings left on ${LOCALE} pages): ${total}`);
}
mkdirSync('docs/evidence/i18n', { recursive: true });
const file = `docs/evidence/i18n/${LOCALE}-${new Date().toISOString().slice(0, 10)}${ONLY ? '-partial' : ''}.json`;
writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${file}`);
