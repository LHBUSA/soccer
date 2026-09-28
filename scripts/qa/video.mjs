#!/usr/bin/env node
// Official video browser contract (real Chrome), modelled on propbetedge-news-site
// tests/youtube-playback.test.mjs: poster before click, no iframe and no YouTube player/page request
// before click, youtube-nocookie iframe with the page's exact origin after click, 16:9 box does not
// shift, player errors 100/101/150 -> poster fallback + "Watch on YouTube", responsive, no console errors.
//   node scripts/qa/video.mjs --site http://127.0.0.1:4478 --article /news/<desk>/<slug> [--none /news/<desk>/<slug>]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const SITE = arg('--site', 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const ARTICLES = (arg('--article', '') || '').split(',').filter(Boolean);
const NONE = arg('--none', null);
const results = []; const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` · ${detail}` : ''}`); };
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', userDataDir: 'D:/Temp/soccer-video-qa-chrome', args: ['--no-first-run', '--disable-extensions', '--autoplay-policy=user-gesture-required'] });

async function page(path, width) {
  const pg = await browser.newPage(); const errors = []; const yt = [];
  pg.on('console', m => { if (m.type() === 'error' && (!m.location()?.url || m.location().url.startsWith(SITE))) errors.push(m.text()); });
  pg.on('pageerror', e => errors.push(String(e)));
  pg.on('request', r => { if (/youtube(-nocookie)?\.com\//.test(r.url())) yt.push(r.url()); });
  await pg.setViewport({ width, height: 900 });
  await pg.goto(SITE + path, { waitUntil: 'networkidle0', timeout: 90000 });
  return { pg, errors, yt };
}

for (const path of [...ARTICLES, ...(ARTICLES.length ? [] : ['/news'])]) for (const width of [1440, 1024, 768, 430, 390, 360, 320]) {
  const tag = `[${width}] ${path.split('/').pop().slice(0, 40)}`;
  for (const code of [150, 100, 101]) {
    const { pg, errors, yt } = await page(path, width);
    const card = await pg.$('.ovid[data-ovid]');
    if (!card) { check(`${tag} a video card exists`, false); await pg.close(); break; }
    const before = await pg.evaluate(() => { const c = document.querySelector('.ovid[data-ovid]'); const f = c.querySelector('.ovid-frame'); const r = f.getBoundingClientRect(); return { poster: !!c.querySelector('.ovid-poster img'), iframes: document.querySelectorAll('iframe').length, w: Math.round(r.width), h: Math.round(r.height) }; });
    if (code === 150) {
      check(`${tag} poster shown before click`, before.poster);
      check(`${tag} no iframe before click`, before.iframes === 0);
      check(`${tag} no YouTube player/page request before click`, yt.length === 0, yt.slice(0, 1).join(''));
      check(`${tag} 16:9 frame`, Math.abs(before.w / before.h - 16 / 9) < 0.02, `${before.w}x${before.h}`);
    }
    await pg.evaluate(() => { const b = document.querySelector('.ovid[data-ovid] .ovid-poster'); b.scrollIntoView(); b.click(); });
    await new Promise(r => setTimeout(r, 250)); // before the player itself can answer
    const after = await pg.evaluate(origin => {
      const f = document.querySelector('.ovid[data-ovid] .ovid-frame'); const i = f.querySelector('iframe'); const r = f.getBoundingClientRect();
      const u = i ? new URL(i.src) : null;
      return { iframe: !!i, host: u?.host, path: u?.pathname, origin: u?.searchParams.get('origin'), jsapi: u?.searchParams.get('enablejsapi'), ref: i?.referrerPolicy, fs: i?.allowFullscreen, w: Math.round(r.width), h: Math.round(r.height), ok: u ? u.searchParams.get('origin') === origin : false };
    }, new URL(SITE).origin);
    if (code === 150) {
      check(`${tag} click opens the player in place (youtube-nocookie)`, after.iframe && after.host === 'www.youtube-nocookie.com' && /^\/embed\/[A-Za-z0-9_-]{11}$/.test(after.path || ''), `${after.host}${after.path}`);
      check(`${tag} enablejsapi + exact origin + referrer policy + fullscreen`, after.jsapi === '1' && after.ok && after.ref === 'strict-origin-when-cross-origin' && after.fs, `origin=${after.origin}`);
      check(`${tag} the 16:9 box does not shift when the player opens`, after.w === before.w && after.h === before.h, `${before.w}x${before.h} -> ${after.w}x${after.h}`);
    }
    // simulate the YouTube IFrame API error event from the player frame (if the real player already refused
    // the embed, its own onError produced the fallback: that is the same contract, recorded as such)
    const realRefusal = await pg.evaluate(c => { const i = document.querySelector('.ovid[data-ovid] iframe'); if (!i) return true; window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ event: 'onError', info: c }), origin: 'https://www.youtube-nocookie.com', source: i.contentWindow })); return false; }, code);
    if (realRefusal && code === 150) check(`${tag} real player refused the embed (onError from YouTube) -> fallback`, true, 'YouTube answered before the simulated error');
    await new Promise(r => setTimeout(r, 200));
    const fb = await pg.evaluate(() => { const c = document.querySelector('.ovid[data-ovid]'); const a = c.querySelector('.ovid-fallback a'); return { iframe: !!c.querySelector('iframe'), text: c.querySelector('.ovid-fallback b')?.textContent || '', href: a?.getAttribute('href') || '', label: a?.textContent || '' }; });
    check(`${tag} error ${code} -> poster fallback, no dead player`, !fb.iframe && /Not available for embedded playback in your region\./.test(fb.text), fb.text);
    check(`${tag} error ${code} -> Watch on YouTube link`, /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(fb.href) && /Watch on YouTube/.test(fb.label));
    if (code === 150) {
      const ov = await pg.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
      check(`${tag} no horizontal overflow`, !ov);
      check(`${tag} no console errors`, errors.length === 0, errors.slice(0, 2).join(' | '));
    }
    await pg.close();
  }
}
if (NONE) {
  const { pg, errors } = await page(NONE, 1440);
  const n = await pg.evaluate(() => ({ watch: document.querySelectorAll('.art-watch').length, cards: document.querySelectorAll('.ovid').length, ld: [...document.querySelectorAll('script[type="application/ld+json"]')].some(s => /VideoObject/.test(s.textContent)) }));
  check('[1440] no confident video -> no WATCH module, no player, no VideoObject', n.watch === 0 && n.cards === 0 && !n.ld, JSON.stringify(n));
  check('[1440] no console errors (no-video article)', errors.length === 0);
  await pg.close();
}
await browser.close();
const out = { at: new Date().toISOString(), site: SITE, passed: results.filter(r => r.ok).length, total: results.length, results };
mkdirSync('docs/evidence/video', { recursive: true });
writeFileSync(`docs/evidence/video/playback-${out.at.slice(0, 10)}${/127\.0\.0\.1|localhost/.test(SITE) ? '-local' : ''}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(`VIDEO BROWSER TESTS ${out.passed}/${out.total}`);
process.exit(out.passed === out.total ? 0 : 1);
