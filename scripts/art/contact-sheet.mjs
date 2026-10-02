#!/usr/bin/env node
// PBE editorial art: owner CONTACT SHEET (local only, nothing deployed or uploaded).
// Builds art specs for five production stories from the public read API (read-only), renders every
// direction x format with workers/shared/art/engine.js, rasterises with local Chrome, writes PNGs + an
// HTML contact sheet. Every text element comes from the API response; nothing is invented.
//   node scripts/art/contact-sheet.mjs --out D:/Temp/pbe-art
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DIRECTIONS, FORMATS, renderArt, ART_ENGINE_VERSION } from '../../workers/shared/art/engine.js';
const require = createRequire(import.meta.url);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const OUT = arg('--out', 'D:/Temp/pbe-art'); mkdirSync(OUT, { recursive: true });
const API = 'https://soccer-api.sales-fd3.workers.dev/v1';
const get = async p => { const r = await fetch(`${API}/${p}`); if (!r.ok) throw new Error(`${p} ${r.status}`); return (await r.json()).data; };
const surname = n => String(n || '').trim().split(/\s+/).slice(-1)[0];
const day = iso => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).toUpperCase();
const ord = n => `${n}${({ 1: 'ST', 2: 'ND', 3: 'RD' })[n] || 'TH'}`;

const specs = [];
// 1. Finland v Albania preview
{
  const a = await get('news/finland-albania-preview-2026-10-03-30a9da');
  const ev = a.entities.find(e => e.type === 'SportsEvent'); const mid = ev.href.split('/').pop();
  const m = await get(`matches/${mid}`);
  const tables = await get('table?competition=uefa-nations-league');
  let group = null;
  for (const g of tables.groups || []) { const t = await get(`table?competition=uefa-nations-league&group=${g.key}`); if (t.rows?.some(r => r.team.slug === m.home.slug)) { group = t; break; } }
  const row = slug => group.rows.find(r => r.team.slug === slug);
  const H = row(m.home.slug); const A = row(m.away.slug);
  specs.push({ id: 'finland-albania-preview', story: a.slug, spec: { kind: 'preview', competition: 'UEFA Nations League', stage: group.group?.name || 'Group', label: 'Preview',
    home: { name: m.home.name, standing: `${ord(H.position)} · ${H.points} PTS`, form: H.form }, away: { name: m.away.name, standing: `${ord(A.position)} · ${A.points} PTS`, form: A.form },
    when: `${(m.venue?.name || '').toUpperCase()} · ${day(m.kickoff_at)} · ${new Date(m.kickoff_at).toISOString().slice(11, 16)} UTC` } });
}
// 2. France v Italy match report (finished match, canonical events)
{
  const m = await get('matches/31fd9bd4-7816-5eac-9e52-310628cd7cc4/cast');
  specs.push({ id: 'france-italy-report', story: `match ${m.id}`, spec: { kind: 'report', competition: 'UEFA Nations League', stage: m.round || null, label: 'Match report',
    home: { name: m.home.name }, away: { name: m.away.name }, score: m.score,
    timeline: m.timeline.filter(t => ['goal', 'own_goal', 'card_red'].includes(t.type)).map(t => ({ minute: t.minute, display: t.display_minute, type: t.type, team: t.team, label: surname(t.player?.name) })),
    shots: m.sequence.filter(x => Number.isFinite(x.x) && (x.type === 'shot' || x.type === 'goal')).map(x => ({ x: x.x, y: x.y, team: x.team, goal: x.type === 'goal' })),
    when: `${(m.venue?.name || '').toUpperCase()} · ${day(m.kickoff_at)}` } });
}
// 3. Seattle team trend
{
  const a = await get('news/seattle-sounders-fc-8-league-matches-unbeaten-2026-10-02-adae3a');
  const v = a.body.visuals.find(x => x.id === 'run_results').data;
  specs.push({ id: 'seattle-team-trend', story: a.slug, spec: { kind: 'team_trend', competition: 'MLS', label: 'Team form', title: v.team.name, subtitle: null, big: v.games.length, bigLabel: 'MLS matches unbeaten',
    run: v.games.map(g => ({ result: g.result, top: `${g.goals_for}-${g.goals_against}`, bottom: day(g.date).slice(0, 6) })), when: `THROUGH ${day(v.games.at(-1).date)}` } });
}
// 4. Player form
{
  const a = await get('news/ivan-angulo-scoring-run-2026-09-26-0e2dbf');
  const v = a.body.visuals.find(x => x.id === 'scoring_run').data;
  specs.push({ id: 'angulo-player-form', story: a.slug, spec: { kind: 'player_form', competition: 'MLS', label: 'Player form', title: v.player.name, subtitle: v.team.name, big: v.run, bigLabel: 'straight scoring appearances',
    run: v.appearances.filter(x => x.in_run).map(x => ({ result: null, top: `${x.goals} G`, bottom: day(x.date).slice(0, 6) })), when: `THROUGH ${day(v.appearances.at(-1).date)}` } });
}
// 5. World Cup group table
{
  const t = await get('table?competition=fifa-world-cup&season=2026&group=a');
  specs.push({ id: 'world-cup-group-a', story: 'fifa-world-cup 2026 group A (verified group table)', spec: { kind: 'table', competition: 'FIFA World Cup 2026', label: 'Final group table', title: t.group?.name || 'Group A', advance: t.rows.filter(r => /advance/i.test(r.zone?.label || '')).length,
    rows: t.rows.map(r => ({ position: r.position, name: r.team.name, points: r.points, form: r.form })), when: `${t.matches_counted} MATCHES · VERIFIED AGAINST CANONICAL RESULTS` } });
}

const puppeteer = require('puppeteer-core');
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/pbe-art-chrome', args: ['--no-first-run'] });
const page = await browser.newPage();
const FONTS = '<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800&family=Inter:wght@700;800&family=JetBrains+Mono:wght@700&display=block" rel="stylesheet">';
const manifest = [];
await page.setContent(`<!doctype html><html><head>${FONTS}<style>html,body{margin:0;background:#000}</style></head><body><span style="font:800 20px 'Barlow Condensed'">A</span><span style="font:800 20px Inter">A</span><span style="font:700 20px 'JetBrains Mono'">A</span></body></html>`, { waitUntil: 'load', timeout: 90000 });
await page.evaluate(() => document.fonts.ready);
for (const { id, story, spec } of specs) for (const direction of DIRECTIONS) for (const format of Object.keys(FORMATS)) {
  const svg = renderArt(spec, { direction, format }); const [w, h] = FORMATS[format];
  const name = `${id}--${direction}--${format}`;
  writeFileSync(`${OUT}/${name}.svg`, svg);
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.evaluate(html => { document.body.innerHTML = html; }, svg);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${OUT}/${name}.png`, clip: { x: 0, y: 0, width: w, height: h } });
  manifest.push({ id, story, direction, format, w, h, svg_sha256: createHash('sha256').update(svg).digest('hex'), file: `${name}.png` });
}
await browser.close();
const sheet = `<!doctype html><meta charset="utf-8"><title>PBE Art contact sheet</title><style>body{margin:0;background:#0a1628;color:#dfe9f6;font:14px Inter,Arial;padding:24px}h2{font:800 28px 'Barlow Condensed',Arial;letter-spacing:.06em;margin:34px 0 6px}h3{margin:14px 0 6px;color:#f0c65a;letter-spacing:.12em;font-size:12px}.row{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}.row img{border:1px solid #233a60;border-radius:6px}figure{margin:0}figcaption{font:12px monospace;color:#9aa9c2}</style>
<h1>PBE Editorial Art Engine — contact sheet (${ART_ENGINE_VERSION})</h1><p>Original, deterministic SVG art from production story data. No photographs, likenesses, crests, logos or kits. Local review only — nothing deployed.</p>
${specs.map(({ id, story }) => `<h2>${id}</h2><p>${story}</p>${DIRECTIONS.map(d => `<h3>${d.toUpperCase()}</h3><div class="row">${Object.entries(FORMATS).map(([f, [w, h]]) => `<figure><img src="${id}--${d}--${f}.png" width="${Math.round(w / (h > w ? 6.5 : 4.2))}"><figcaption>${f} ${w}×${h}</figcaption></figure>`).join('')}</div>`).join('')}`).join('')}`;
writeFileSync(`${OUT}/contact-sheet.html`, sheet);
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ engine: ART_ENGINE_VERSION, generated_at: new Date().toISOString(), specs, assets: manifest }, null, 1));
console.log(`rendered ${manifest.length} assets -> ${OUT}`);
