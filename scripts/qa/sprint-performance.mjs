// Repeatable route + every API request timing. Cold means a fresh browser context;
// warm means same-context reload. Neither label claims a cold Cloudflare cache.
import puppeteer from 'puppeteer-core';
import { mkdirSync, writeFileSync } from 'node:fs';
const base = process.argv[2] || 'https://soccer.propbetedge.ai';
const label = process.argv[3] || 'baseline';
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run'], userDataDir: `${process.cwd()}/.proof/performance-chrome` });
const rows = [];
try {
  for (const route of ['/', '/matches', '/competitions/bundesliga', '/teams/bayern-munchen', '/players/robert-lewandowski', '/pbecast', '/pro']) {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.evaluateOnNewDocument(() => {
      window.__useful = null;
      const observe = () => {
        const main = document.querySelector('#main');
        if (main?.querySelector('h1') && !main.querySelector('.state.loading, .route-skeleton')) {
          window.__useful ??= performance.now();
        }
      };
      new MutationObserver(observe).observe(document, { childList: true, subtree: true });
    });
    for (const temperature of ['cold', 'warm']) {
      const errors = [];
      const onError = e => errors.push(String(e));
      page.on('pageerror', onError);
      await page.goto(base + route, { waitUntil: 'networkidle0', timeout: 120000 });
      await page.waitForFunction(() => window.__useful !== null, { timeout: 90000 });
      const info = await page.evaluate(() => {
        const requests = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/soccer/')).map(e => ({ endpoint: e.name.replace(location.origin, ''), start_ms: Math.round(e.startTime), ttfb_ms: Math.round(e.responseStart - e.startTime), total_ms: Math.round(e.duration), end_ms: Math.round(e.responseEnd), bytes: e.transferSize }));
        const slowest = [...requests].sort((a, b) => b.total_ms - a.total_ms)[0];
        return { first_meaningful_paint_ms: Math.round(window.__useful), fcp_ms: Math.round(performance.getEntriesByName('first-contentful-paint')[0]?.startTime || 0), total_route_data_ms: Math.max(0, ...requests.map(e => e.end_ms)), slowest_endpoint: slowest?.endpoint, endpoint_ttfb_ms: slowest?.ttfb_ms, http_requests: performance.getEntriesByType('resource').length + 1, api_requests: requests.length, requests, error_state: !!document.querySelector('.state.error') };
      });
      rows.push({ route, temperature, ...info, errors });
      console.log(JSON.stringify(rows.at(-1)));
      page.off('pageerror', onError);
    }
    await context.close();
  }
} finally { await browser.close(); }
mkdirSync('docs/evidence/performance', { recursive: true });
writeFileSync(`docs/evidence/performance/v4-${label}.json`, JSON.stringify({ base, at: new Date().toISOString(), definition: 'Meaningful paint = first main heading/content DOM insertion (paint proxy); cold = fresh browser context, warm = same-context reload; edge cache not purged. Total includes progressive API modules.', rows }, null, 2) + '\n');
