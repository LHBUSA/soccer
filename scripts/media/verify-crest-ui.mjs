#!/usr/bin/env node
// Production UI proof for identity media (read-only, real Chrome): per page, crest <img> inside .tmark that
// actually decoded (naturalWidth > 0) vs initials fallbacks, portraits, broken images, media requests >= 400,
// console errors, horizontal overflow. Includes the score ticker, the Bayern 7-0 article and responsive widths.
//   node scripts/media/verify-crest-ui.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const SITE = 'https://soccer.propbetedge.ai'; const API = `${SITE}/api/soccer`;
const get = async p => (await (await fetch(`${API}/${p}`)).json()).data;
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const ARTICLE = '/news/bundesliga/bayern-munchen-1-fc-union-berlin-2026-09-18-3ce080';

const matchOf = async slug => { const t = await get(`teams/${slug}`); return (t.recent?.[0] || t.upcoming?.[0])?.id; };
const [mlsM, eplM, blM, uclM] = await Promise.all(['atlanta-united-fc', 'arsenal', '1-fc-union-berlin', 'real-madrid'].map(matchOf));
// a player whose photo came from the new provider path
const [np] = await store.select('soccer_entity_media', { columns: ['entity_id'], eq: { entity_type: 'player', media_type: 'portrait', is_primary: true, rights_status: 'owner_approved_identification' }, limit: 1 });
const [npl] = await store.select('soccer_players', { columns: ['slug'], eq: { id: np.entity_id } });
const bayern = (await get('teams/bayern-munchen')).crest.url; const union = (await get('teams/1-fc-union-berlin')).crest.url;

const SAMPLES = [
  ['homepage + ticker', '/'], ['pbecast hub', '/pbecast'], ['pbecast MLS', `/pbecast/${mlsM}`], ['pbecast EPL', `/pbecast/${eplM}`],
  ['match BL', `/matches/${blM}`], ['match UCL', `/matches/${uclM}`], ['match MLS', `/matches/${mlsM}`], ['matches list', '/matches'],
  ['team MLS Inter Miami', '/teams/inter-miami-cf'], ['team MLS Atlanta', '/teams/atlanta-united-fc'], ['team EPL Arsenal', '/teams/arsenal'], ['team EPL Liverpool', '/teams/liverpool'],
  ['team BL Union', '/teams/1-fc-union-berlin'], ['team UCL Real Madrid', '/teams/real-madrid'], ['team UCL Roma', '/teams/as-roma'],
  ['competition MLS', '/competitions/mls'], ['competition EPL', '/competitions/premier-league'], ['competition BL', '/competitions/bundesliga'], ['competition UCL', '/competitions/uefa-champions-league'],
  ['tables', '/tables'], ['news', '/news'], ['news article Bayern 7-0', ARTICLE], ['players directory', '/players'], ['player (new provider photo)', `/players/${npl.slug}`],
];

const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-crest-ui-chrome', args: ['--no-first-run', '--disable-extensions'] });
async function probe(label, path, width = 1280) {
  const page = await browser.newPage(); const consoleErrors = []; const badMedia = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push(String(e).slice(0, 200)));
  page.on('response', r => { if (/\/api\/soccer\/media\//.test(r.url()) && r.status() >= 400) badMedia.push(`${r.status()} ${r.url()}`); });
  await page.setViewport({ width, height: 900 });
  const res = await page.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 90000 });
  await page.evaluate(async () => { document.querySelectorAll('img[loading=lazy]').forEach(i => { i.loading = 'eager'; }); for (let y = 0; y < document.body.scrollHeight; y += 700) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 1500)); });
  const info = await page.evaluate((b, u) => {
    const crestImgs = [...document.querySelectorAll('.tmark.img img')];
    const tk = document.getElementById('score-ticker');
    const tkImgs = tk ? [...tk.querySelectorAll('.stk-track:not(.stk-clone) .tmark.img img, .stk-track > :not(.stk-clone) .tmark.img img')] : [];
    const tkAll = tk ? [...tk.querySelectorAll('.tmark.img img')] : [];
    const tkMono = tk ? tk.querySelectorAll('.tmark:not(.img)').length : 0;
    const portraits = [...document.querySelectorAll('.pic img, .ph-pic img')];
    const broken = [...document.images].filter(i => i.complete && i.naturalWidth === 0 && /\/api\/soccer\/media\//.test(i.src)).map(i => i.getAttribute('src'));
    const srcs = new Set(crestImgs.filter(i => i.naturalWidth > 0).map(i => i.getAttribute('src')));
    return {
      crest_loaded: crestImgs.filter(i => i.complete && i.naturalWidth > 0).length, crest_imgs: crestImgs.length, monograms: document.querySelectorAll('.tmark:not(.img)').length,
      distinct_crests: srcs.size, ticker: { crest_loaded: tkAll.filter(i => i.naturalWidth > 0).length, distinct: new Set(tkAll.filter(i => i.naturalWidth > 0).map(i => i.getAttribute('src'))).size, monograms: tkMono, items: tk ? tk.querySelectorAll('.stk-side').length : 0 },
      portraits_loaded: portraits.filter(i => i.complete && i.naturalWidth > 0).length, portraits: portraits.length,
      broken, offorigin_crests: crestImgs.filter(i => !/^\/api\/soccer\/media\/[0-9a-f]{64}$/.test(i.getAttribute('src') || '')).length,
      credit_titles: crestImgs.filter(i => (i.getAttribute('title') || '').length > 10).length,
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      bayern_crest: srcs.has(b), union_crest: srcs.has(u),
    };
  }, bayern, union);
  await page.close();
  return { label, path, width, status: res.status(), ...info, bad_media_requests: badMedia, console_errors: consoleErrors };
}
const results = [];
for (const [label, path] of SAMPLES) { const r = await probe(label, path); results.push(r); console.log(`${r.status} ${label.padEnd(28)} crests ${r.crest_loaded}/${r.crest_imgs} (${r.distinct_crests} distinct) mono ${r.monograms} | ticker ${r.ticker.crest_loaded} crests/${r.ticker.distinct} distinct, mono ${r.ticker.monograms} | portraits ${r.portraits_loaded}/${r.portraits} | broken ${r.broken.length} bad ${r.bad_media_requests.length} console ${r.console_errors.length} overflow ${r.overflow}`); }
const responsive = [];
for (const w of [320, 360, 390, 430, 768, 1024, 1440]) for (const path of [ARTICLE, `/pbecast/${mlsM}`]) { const r = await probe(`w${w}`, path, w); responsive.push(r); console.log(`w${w} ${path.slice(0, 40).padEnd(40)} crests ${r.crest_loaded}/${r.crest_imgs} broken ${r.broken.length} bad ${r.bad_media_requests.length} console ${r.console_errors.length} overflow ${r.overflow}${path === ARTICLE ? ` bayern ${r.bayern_crest} union ${r.union_crest}` : ''}`); }
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, samples: results.length, results, responsive };
writeFileSync(`docs/evidence/media/crest-ui-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
