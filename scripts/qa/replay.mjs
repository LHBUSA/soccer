#!/usr/bin/env node
// PBEcast REPLAY browser contract (real Chrome, deterministic finished match). At every replay position V
// nothing after V may exist in the replay view: feed rows, pitch marks, score, clock, current event,
// caption. Exercises reset, scrubber, play / pause / speed, key-moment chip, timeline marker, feed row and
// pitch mark clicks, final position; also counts real portraits vs silhouettes on the cast.
//   node scripts/qa/replay.mjs [--site http://localhost:4318] [--match <uuid>] [--widths 1440,390]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildTimeline, isLocated } from '../../src/lib/cast.js';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const MATCH = arg('--match', 'd4ad8521-0307-54bc-b612-ca070741c9ac'); // FC Dallas 1-0 LAFC, 2026-09-27 (owner's regression case)
const WIDTHS = arg('--widths', '1440,390').split(',').map(Number);
const SHOTS = arg('--shots', 'D:/Temp/claude/replay-shots');
mkdirSync(SHOTS, { recursive: true });

const cast = (await (await fetch(`${SITE}/api/soccer/matches/${MATCH}/cast`)).json()).data;
const tl = buildTimeline(cast.sequence || []);
// Independent expectations straight from the API sequence (source minutes), not from the page code.
const expect = v => {
  const seen = tl.items.filter(x => (x.v !== null ? x.v <= v : v >= tl.total));
  const last = [...seen].reverse().find(x => x.score);
  return { n: seen.length, located: seen.filter(isLocated).length, score: v >= tl.total && cast.score ? cast.score : last ? last.score : { home: 0, away: 0 } };
};

const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-replay-qa-chrome', args: ['--no-first-run', '--disable-extensions'] });
let portraitReport = null;
for (const width of WIDTHS) {
  const page = await browser.newPage(); const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', e => errors.push(String(e)));
  await page.setViewport({ width, height: 1000 });
  await page.goto(`${SITE}/pbecast/${MATCH}`, { waitUntil: 'networkidle0', timeout: 90000 });
  const state = () => page.evaluate(() => {
    const root = document.querySelector('.cast-body')?.closest('main') || document;
    const vis = el => el.getBoundingClientRect().width > 0 && getComputedStyle(el).display !== 'none';
    const feed = [...document.querySelectorAll('[data-feed] [data-fi]')];
    const marks = [...document.querySelectorAll('.pitch.cast .cmark')];
    return {
      v: Number(document.querySelector('[data-rp-range]').value), clock: document.querySelector('[data-ct-clock]').textContent,
      score: { home: Number(document.querySelector('[data-sh]').textContent), away: Number(document.querySelector('[data-sa]').textContent) },
      feedV: feed.map(li => Number(li.dataset.v)), feedVisible: feed.filter(vis).length, cur: document.querySelector('[data-feed] .fi.cur')?.dataset.v ?? null,
      markV: marks.map(g => Number(g.dataset.v)), marksVisibleLand: [...document.querySelectorAll('.pitchwrap.land .cmark')].filter(vis).length, marksVisiblePort: [...document.querySelectorAll('.pitchwrap.port .cmark')].filter(vis).length,
      caption: document.querySelector('[data-rp-caption]').textContent, now: document.querySelector('[data-rp-now-text]')?.textContent || '',
      futMarkers: [...document.querySelectorAll('.tl-m')].filter(b => b.classList.contains('fut')).map(b => Number(b.dataset.seek)),
      liveMarkers: [...document.querySelectorAll('.tl-m')].filter(b => !b.classList.contains('fut')).map(b => Number(b.dataset.seek)),
      curMarker: document.querySelector('.tl-m.cur')?.dataset.seek ?? null, play: document.querySelector('[data-rp-play]').textContent,
    };
  });
  const invariant = async (label) => {
    const s = await state(); const e = expect(s.v);
    const futureFeed = s.feedV.filter(x => x > s.v).length; const futurePitch = s.markV.filter(x => x > s.v).length;
    check(`[${width}] ${label}: no future feed rows`, futureFeed === 0, `v=${s.v} rows=${s.feedV.length} future=${futureFeed}`);
    check(`[${width}] ${label}: no future pitch marks`, futurePitch === 0, `marks=${s.markV.length / 2} future=${futurePitch}`);
    check(`[${width}] ${label}: feed = every event through V`, s.feedV.length === e.n, `${s.feedV.length}/${e.n}`);
    check(`[${width}] ${label}: pitch = located shots through V`, s.markV.length === 2 * e.located && s.marksVisibleLand + s.marksVisiblePort === e.located, `land ${s.marksVisibleLand} port ${s.marksVisiblePort} expected ${e.located}`);
    check(`[${width}] ${label}: score through V`, s.score.home === e.score.home && s.score.away === e.score.away, `${s.score.home}-${s.score.away}`);
    check(`[${width}] ${label}: caption counts through V`, s.v >= tl.total ? s.caption.startsWith(`${e.located} LOCATED`) && s.caption.includes('NOT PLAYER TRACKING') : s.caption === `${e.located} LOCATED ${e.located === 1 ? 'SHOT' : 'SHOTS'} THROUGH ${s.clock}`, s.caption);
    check(`[${width}] ${label}: timeline markers split at V`, s.futMarkers.every(x => x > s.v) && s.liveMarkers.every(x => x <= s.v));
    return s;
  };
  // full time (initial)
  let s = await invariant('full time');
  check(`[${width}] full time: all sourced events`, s.feedV.length === tl.items.length && s.clock === 'FT');
  // reset to kick-off: start then pause immediately
  await page.$eval('[data-rp-play]', b => b.click()); await page.$eval('[data-rp-play]', b => b.click());
  s = await invariant('reset');
  check(`[${width}] reset: 0' / 0-0 / empty feed + pitch`, s.v <= 0.5 && s.score.home === 0 && s.score.away === 0 && s.feedV.length === 0 && s.markV.length === 0, `v=${s.v}`);
  // key moment chip (owner's case: 34' Goal Urhoghide)
  await page.evaluate(() => [...document.querySelectorAll('.rp-moments .chip')].find(b => /34'/.test(b.textContent)).click());
  s = await invariant("34' chip");
  check(`[${width}] 34': clock, current event, current feed row`, s.clock === "34'" && /^34' Goal · Osaze Urhoghide/.test(s.now) && s.cur === '34' && s.curMarker === '34', `${s.clock} | ${s.now}`);
  if (width === WIDTHS[0]) {
    await page.evaluate(() => document.querySelector('.cast-grid').scrollIntoView());
    await page.screenshot({ path: `${SHOTS}/replay-34-${width}.png` });
    const at34 = s;
    portraitReport = await page.evaluate(() => {
      const scope = [...document.querySelectorAll('.cast-body .pic')];
      const real = scope.filter(p => !p.classList.contains('sil'));
      const seen = new Map(); for (const p of scope) { const chip = p.closest('[data-player-slug]') || p.parentElement.querySelector('[data-player-slug]') || p.closest('.pchip')?.querySelector('a'); const key = chip?.getAttribute('data-player-slug') || chip?.getAttribute('href') || p.nextElementSibling?.textContent; if (key) seen.set(key, !p.classList.contains('sil')); }
      return { rendered: scope.length, real: real.length, silhouettes: scope.length - real.length, distinct_players: seen.size, distinct_real: [...seen.values()].filter(Boolean).length, broken: real.filter(p => { const i = p.querySelector('img'); return i.complete && i.naturalWidth === 0; }).length };
    });
    results.push({ name: 'acceptance-34', ok: true, detail: JSON.stringify({ clock: at34.clock, future_feed: at34.feedV.filter(x => x > at34.v).length, future_pitch: at34.markV.filter(x => x > at34.v).length, shot_count: at34.caption, score: at34.score, current: at34.now, portraits: portraitReport }) });
  }
  // scrubber to 60
  await page.$eval('[data-rp-range]', r => { r.value = '60'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  s = await invariant('scrubber 60');
  check(`[${width}] scrubber: clock follows`, s.v === 60);
  // timeline marker click (first marker after 60 or any)
  const mk = await page.evaluate(() => { const b = [...document.querySelectorAll('.tl-m')].find(x => Number(x.dataset.seek) > 0); b.click(); return Number(b.dataset.seek); });
  s = await invariant('timeline click');
  check(`[${width}] timeline click selects that event`, s.v === mk && s.curMarker === String(mk), `marker ${mk} -> v ${s.v}`);
  // go to full time, feed row click (a row without clicking its player link)
  await page.$eval('[data-rp-range]', r => { r.value = r.max; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const fv = await page.evaluate(() => { const li = [...document.querySelectorAll('[data-feed] li[data-seek]')][6]; li.querySelector('.fi-min').click(); return Number(li.dataset.seek); });
  s = await invariant('feed click');
  check(`[${width}] feed click seeks to that event`, s.v === fv, `row ${fv} -> v ${s.v}`);
  // pitch mark click
  await page.$eval('[data-rp-range]', r => { r.value = r.max; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const pv = await page.evaluate(() => { const g = [...document.querySelectorAll('.pitch.cast .cmark[data-seek]')].find(x => x.getBoundingClientRect().width > 0); g.dispatchEvent(new MouseEvent('click', { bubbles: true })); return Number(g.dataset.seek); });
  s = await invariant('pitch click');
  check(`[${width}] pitch click seeks to that shot`, s.v === pv, `mark ${pv} -> v ${s.v}`);
  // play with speed 3 from 10', pause
  await page.$eval('[data-rp-range]', r => { r.value = '10'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.select('[data-rp-speed]', '3'); await page.$eval('[data-rp-play]', b => b.click());
  await new Promise(r => setTimeout(r, 2100));
  let mid = await invariant('autoplay (running)');
  await new Promise(r => setTimeout(r, 1100)); await page.$eval('[data-rp-play]', b => b.click());
  s = await invariant('autoplay paused');
  check(`[${width}] play / speed / pause: advanced ~3 min/s then held`, mid.v > 14 && s.v > mid.v && /RESUME/.test(s.play), `10 -> ${mid.v} -> ${s.v}`);
  await new Promise(r => setTimeout(r, 800)); const held = await state();
  check(`[${width}] pause holds position`, held.v === s.v);
  // final position
  await page.$eval('[data-rp-range]', r => { r.value = r.max; r.dispatchEvent(new Event('input', { bubbles: true })); });
  s = await invariant('final');
  check(`[${width}] final: all events visible`, s.feedV.length === tl.items.length && s.clock === 'FT');
  check(`[${width}] no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
  await page.close();
}
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, match: MATCH, widths: WIDTHS, events: tl.items.length, located_total: tl.items.filter(isLocated).length, passed: results.filter(r => r.ok).length, total: results.length, portraits: portraitReport, results };
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/replay-${out.at.slice(0, 10)}${/localhost|127.0.0.1/.test(SITE) ? '-local' : ''}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`\nREPLAY BROWSER TESTS ${out.passed}/${out.total}`, JSON.stringify(portraitReport));
process.exit(out.passed === out.total ? 0 : 1);
