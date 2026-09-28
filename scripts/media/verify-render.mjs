#!/usr/bin/env node
// Production render check for APPROVED media (not database rows): opens real pages in Chrome and
// confirms each approved crest / portrait image actually loads, from the same-origin media route,
// with no console / CSP errors, on the correct entity's page. Read-only.
//   node scripts/media/verify-render.mjs [--site https://soccer.propbetedge.ai] [--players 50]
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const API = `${SITE}/api/soccer`;
const N = Number(arg('--players', '50'));
const COMPS = ['mls', 'premier-league', 'bundesliga', 'uefa-champions-league'];
const get = async p => (await (await fetch(`${API}/${p}`)).json()).data;

// Approved crests: every active team whose API object carries a crest.
const crestTeams = new Map();
for (const c of COMPS) for (const t of (await get(`competitions/${c}`)).current?.teams || []) { const td = await get(`teams/${t.slug}`); if (td.crest) crestTeams.set(t.slug, { name: td.name, comp: c }); }
// Approved portraits: an even sample across competitions of directory players that carry one.
const players = [];
for (const c of COMPS) { const x = await get(`players?competition=${c}&limit=100`); players.push(...x.players.filter(p => p.portrait).slice(0, Math.ceil(N / COMPS.length)).map(p => ({ slug: p.slug, name: p.name, comp: c }))); }

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-media-verify-chrome', args: ['--no-first-run', '--disable-extensions'] });
const results = [];
async function check(path, selector, expectName) {
  const page = await browser.newPage(); const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width: 1280, height: 900 });
  const res = await page.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 60000 });
  const info = await page.evaluate((sel) => { const img = document.querySelector(sel); return { h1: document.querySelector('h1')?.textContent?.trim() || '', src: img?.getAttribute('src') || null, loaded: !!img && img.complete && img.naturalWidth > 0 }; }, selector);
  await page.close();
  const ok = (res.status() === 200 || res.status() === 304) && info.loaded && /^\/api\/soccer\/media\/[0-9a-f]{64}$/.test(info.src || '') && info.h1.includes(expectName) && !errors.some(e => /Content Security Policy|Refused to load/i.test(e));
  results.push({ path, ok, status: res.status(), ...info, csp_errors: errors.filter(e => /Content Security Policy|Refused/i.test(e)).length });
}
for (const [slug, t] of crestTeams) await check(`/teams/${slug}`, '.th-top .tmark img', t.name);
for (const p of players) await check(`/players/${p.slug}`, '.ph-pic img', p.name);
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, crests_checked: crestTeams.size, portraits_checked: players.length, failures: results.filter(r => !r.ok), by_competition: Object.fromEntries(COMPS.map(c => [c, { crests: [...crestTeams.values()].filter(t => t.comp === c).length, portraits: players.filter(p => p.comp === c).length }])), results };
const file = `docs/evidence/media/render-verify-${out.at.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ crests_checked: out.crests_checked, portraits_checked: out.portraits_checked, failures: out.failures.length, by_competition: out.by_competition }, null, 2));
if (out.failures.length) console.log(JSON.stringify(out.failures.slice(0, 5), null, 2));
