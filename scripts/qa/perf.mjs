#!/usr/bin/env node
// Production performance audit (mobile profile: 390x844, slow-4G, 4x CPU slowdown).
//   node scripts/qa/perf.mjs https://soccer.propbetedge.ai
// Records per page: TTFB, first-HTML bytes, JS/CSS/image/API bytes and counts, repeated
// API requests, LCP time + element, CLS. Writes docs/evidence/qa/perf-<date>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = (process.argv[2] || 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const j = async p => (await fetch(`${BASE}/api/soccer/${p}`)).json();
const epl = (await j('matches?competition=premier-league&status=finished&limit=1')).data[0];
const story = (await j('news?limit=1')).data[0];
const PAGES = ['/', '/competitions/mls', '/competitions/uefa-champions-league', `/matches/${epl.id}`, '/teams/arsenal', '/players/bukayo-saka', '/news', story ? `/news/${story.desk}/${story.slug}` : null].filter(Boolean);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
const out = { base: BASE, at: new Date().toISOString(), profile: { viewport: '390x844', network: 'slow 4G (1.6 Mbps down, 750 kbps up, 150 ms RTT)', cpu: '4x slowdown', cache: 'cold' }, pages: [] };
try {
  for (const path of PAGES) {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8 });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const res = new Map();
    cdp.on('Network.responseReceived', e => res.set(e.requestId, { url: e.response.url, type: e.type, status: e.response.status, mime: e.response.mimeType, bytes: 0, ttfb: e.response.timing ? e.response.timing.receiveHeadersEnd - e.response.timing.sendStart : null }));
    cdp.on('Network.loadingFinished', e => { const r = res.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });
    await page.evaluateOnNewDocument(() => {
      window.__lcp = null; window.__cls = 0;
      new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lcp = { t: Math.round(e.startTime), el: e.element ? `${e.element.tagName.toLowerCase()}${e.element.className ? '.' + String(e.element.className).split(' ')[0] : ''}` : null, size: e.size }; }).observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    });
    const t0 = Date.now();
    await page.goto(BASE + path, { waitUntil: 'networkidle0', timeout: 120000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.state.loading'), { timeout: 60000 }).catch(() => {});
    const loadMs = Date.now() - t0;
    const m = await page.evaluate(() => ({ lcp: window.__lcp, cls: Math.round(window.__cls * 1000) / 1000, imgs: [...document.images].map(i => ({ src: i.currentSrc.slice(-60), w: i.naturalWidth, h: i.naturalHeight, lazy: i.loading, rendered: Math.round(i.getBoundingClientRect().width) })) }));
    const rs = [...res.values()];
    const sum = f => rs.filter(f).reduce((a, r) => a + r.bytes, 0);
    const api = rs.filter(r => r.url.includes('/api/soccer/') && !r.url.includes('/api/soccer/media/'));
    const doc = rs.find(r => r.type === 'Document');
    const dupes = Object.entries(api.reduce((o, r) => { o[r.url] = (o[r.url] || 0) + 1; return o; }, {})).filter(([, n]) => n > 1).map(([u, n]) => `${u.replace(BASE, '')} x${n}`);
    const row = { path, load_ms: loadMs, ttfb_ms: doc?.ttfb ? Math.round(doc.ttfb) : null, html_bytes: doc?.bytes || null, js_bytes: sum(r => r.type === 'Script'), css_bytes: sum(r => r.type === 'Stylesheet'), font_bytes: sum(r => r.type === 'Font'),
      image_bytes: sum(r => r.type === 'Image'), images: m.imgs.length, oversized_images: m.imgs.filter(i => i.rendered && i.w > i.rendered * 2.5).length,
      api_requests: api.length, api_bytes: api.reduce((a, r) => a + r.bytes, 0), repeated_api: dupes, requests: rs.length, lcp_ms: m.lcp?.t ?? null, lcp_element: m.lcp?.el ?? null, cls: m.cls };
    out.pages.push(row);
    console.log(`${path.padEnd(48).slice(0, 48)} lcp ${String(row.lcp_ms).padStart(5)}ms (${row.lcp_element}) ttfb ${row.ttfb_ms} html ${row.html_bytes} js ${row.js_bytes} css ${row.css_bytes} img ${row.image_bytes}/${row.images} api ${row.api_requests} cls ${row.cls}${dupes.length ? ' DUPES ' + dupes.join(',') : ''}`);
    await page.close();
  }
} finally { await browser.close(); }
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/perf-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
