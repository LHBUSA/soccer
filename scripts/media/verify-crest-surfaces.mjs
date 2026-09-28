#!/usr/bin/env node
// Crest render proof, surface by surface (read-only): approved primary crest rows in the database ->
// the production API payloads that feed each surface -> real Chrome renders of the production site.
// A crest "renders" only when an <img> inside a .tmark loads from /api/soccer/media/<sha256>
// (same origin) with a non-zero natural size. Monograms are counted separately as fallbacks.
//   node scripts/media/verify-crest-surfaces.mjs [--site https://soccer.propbetedge.ai] [--tag after]
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const TAG = arg('--tag', 'check');
const API = `${SITE}/api/soccer`;
const COMPS = ['mls', 'premier-league', 'bundesliga', 'uefa-champions-league'];
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const get = async p => { const r = await fetch(`${API}/${p}`); if (!r.ok) throw new Error(`${p} HTTP ${r.status}`); return (await r.json()).data; };

// 1. database: approved primary crests
const rows = await store.select('soccer_entity_media', { columns: ['entity_id', 'content_sha256', 'cached_url'], eq: { entity_type: 'team', media_type: 'crest', rights_status: 'approved', is_primary: true } });
const teamRows = rows.length ? await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], in: { id: rows.map(r => r.entity_id) } }) : [];
const approved = teamRows.map(t => ({ ...t, sha: rows.find(r => r.entity_id === t.id).content_sha256 }));

// 2. API: the payload each surface renders from
const api = [];
for (const t of approved) {
  const td = await get(`teams/${t.slug}`);
  const m = td.recent?.[0] || td.upcoming?.[0] || null;
  const md = m ? await get(`matches/${m.id}`) : null;
  const side = md ? [md.home, md.away].find(x => x?.slug === t.slug) : null;
  api.push({ slug: t.slug, name: t.name, team_crest: !!td.crest?.url && td.crest.url.includes(t.sha), match_id: m?.id || null, match_crest: side ? !!side.crest?.url?.includes(t.sha) : null, list_crest: m ? !![m.home, m.away].find(x => x?.slug === t.slug)?.crest?.url : null });
  t.match = m?.id || null;
}
const live = await get('live');
const tickerTeams = [...(live.live || []), ...(live.upcoming || []), ...(live.recent || [])].flatMap(x => [x.home, x.away]);
const tickerApi = { teams: tickerTeams.length, with_crest: tickerTeams.filter(x => x?.crest?.url).length };

// 3. production render
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-crest-verify-chrome', args: ['--no-first-run', '--disable-extensions'] });
const pages = [];
async function visit(surface, path, expectSha = null) {
  const page = await browser.newPage(); const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 1280, height: 900 });
  const res = await page.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 60000 }).catch(e => ({ status: () => `ERR ${e.message}` }));
  await page.evaluate(async () => { for (const img of document.querySelectorAll('.tmark img')) { img.loading = 'eager'; } window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1500)); });
  const info = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('.tmark img')];
    return { crest_imgs: imgs.length, loaded: imgs.filter(i => i.complete && i.naturalWidth > 0).length, broken: imgs.filter(i => i.complete && i.naturalWidth === 0).map(i => i.getAttribute('src')), offorigin: imgs.filter(i => !/^\/api\/soccer\/media\/[0-9a-f]{64}$/.test(i.getAttribute('src') || '')).length, monograms: document.querySelectorAll('.tmark:not(.img)').length, srcs: [...new Set(imgs.filter(i => i.naturalWidth > 0).map(i => i.getAttribute('src')))] };
  });
  await page.close();
  const expect_ok = expectSha ? info.srcs.some(s => s.endsWith(expectSha)) : null;
  pages.push({ surface, path, status: res.status(), ...info, srcs: undefined, distinct_crests: info.srcs.length, expected_crest_rendered: expect_ok, csp_errors: errors.filter(e => /Content Security Policy|Refused/i.test(e)).length });
}
await visit('homepage + ticker', '/');
await visit('pbecast hub', '/pbecast');
await visit('matches', '/matches');
await visit('tables', '/tables');
await visit('news', '/news');
await visit('players (DNA directory)', '/players');
for (const c of COMPS) await visit(`competition ${c}`, `/competitions/${c}`);
for (const t of approved) {
  await visit('team page', `/teams/${t.slug}`, t.sha);
  if (t.match) { await visit('match page', `/matches/${t.match}`, t.sha); await visit('pbecast', `/pbecast/${t.match}`, t.sha); }
}
await browser.close();

const failures = pages.filter(p => p.broken.length || p.offorigin || p.expected_crest_rendered === false || p.csp_errors || !(p.status === 200 || p.status === 304));
const apiFailures = api.filter(a => !a.team_crest || a.match_crest === false || a.list_crest === false);
const out = {
  at: new Date().toISOString(), site: SITE, tag: TAG,
  approved_in_db: approved.length, returned_by_api: api.filter(a => a.team_crest).length,
  rendering_in_production: approved.filter(t => pages.some(p => p.path === `/teams/${t.slug}` && p.expected_crest_rendered)).length,
  api_failures: apiFailures, render_failures: failures, ticker_api: tickerApi,
  samples: { pages: pages.length, crest_images_loaded: pages.reduce((s, p) => s + p.loaded, 0) },
  api, pages,
};
const file = `docs/evidence/media/crest-surfaces-${out.at.slice(0, 10)}-${TAG}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ approved_in_db: out.approved_in_db, returned_by_api: out.returned_by_api, rendering_in_production: out.rendering_in_production, api_failures: apiFailures.length, render_failures: failures.length, ticker_api: tickerApi, samples: out.samples }, null, 2));
for (const p of pages) console.log(`${p.status} ${p.surface.padEnd(28)} ${p.path.padEnd(60)} crests ${p.loaded}/${p.crest_imgs} monograms ${p.monograms}${p.expected_crest_rendered === false ? ' EXPECTED CREST MISSING' : ''}${p.broken.length ? ' BROKEN' : ''}`);
console.log('wrote', file);
