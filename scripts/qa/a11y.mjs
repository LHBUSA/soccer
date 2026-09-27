#!/usr/bin/env node
// Accessibility audit with axe-core (WCAG 2.1 A/AA rules) on key pages at 390 and 1440.
//   node scripts/qa/a11y.mjs https://soccer.propbetedge.ai
// Plus checks axe cannot make: every <img> has an alt attribute, headings do not skip
// levels, interactive targets are at least 24x24 CSS px. Writes docs/evidence/qa/a11y-<date>.json.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = (process.argv[2] || 'https://soccer.propbetedge.ai').replace(/\/$/, '');
const AXE = readFileSync('node_modules/axe-core/axe.min.js', 'utf8');
const j = async p => (await fetch(`${BASE}/api/soccer/${p}`)).json();
const epl = (await j('matches?competition=premier-league&status=finished&limit=1')).data[0];
const story = (await j('news?limit=1')).data[0];
const PAGES = ['/', '/competitions/mls?tab=table', '/competitions/uefa-champions-league?tab=table', `/matches/${epl.id}`, '/teams/arsenal', '/players/bukayo-saka', '/tables', '/news', story ? `/news/${story.desk}/${story.slug}` : null, '/sources'].filter(Boolean);
const browser = await puppeteer.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new', args: ['--no-sandbox'] });
const out = { base: BASE, at: new Date().toISOString(), standard: 'axe-core wcag2a + wcag2aa + wcag21a + wcag21aa + best-practice', pages: [] };
const byRule = {};
try {
  for (const path of PAGES) for (const width of [390, 1440]) {
    const page = await browser.newPage();
    await page.setBypassCSP(true); // production CSP blocks the injected axe script (as it should)
    await page.setViewport({ width, height: 900 });
    await page.goto(BASE + path, { waitUntil: 'networkidle0', timeout: 90000 }).catch(() => {});
    await page.waitForFunction(() => !document.querySelector('.state.loading'), { timeout: 60000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    await page.addScriptTag({ content: AXE });
    const res = await page.evaluate(async () => {
      const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] } });
      const imgs = [...document.images].filter(i => !i.hasAttribute('alt')).length;
      const hs = [...document.querySelectorAll('main h1, main h2, main h3, main h4')].map(h => Number(h.tagName[1]));
      let skips = 0; for (let i = 1; i < hs.length; i++) if (hs[i] > hs[i - 1] + 1) skips += 1;
      const h1 = document.querySelectorAll('main h1').length;
      const small = [...document.querySelectorAll('main a, main button, main select, header a, header button')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && (b.width < 24 || b.height < 24) && getComputedStyle(e).display !== 'inline'; }).length;
      return { violations: r.violations.map(v => ({ id: v.id, impact: v.impact, nodes: v.nodes.length, sample: v.nodes[0]?.target?.join(' ') })), imgs_without_alt: imgs, heading_skips: skips, h1_count: h1, small_targets: small };
    });
    for (const v of res.violations) { byRule[v.id] = byRule[v.id] || { impact: v.impact, pages: [] }; byRule[v.id].pages.push(`${path}@${width} (${v.nodes}) ${v.sample}`); }
    out.pages.push({ path, width, ...res });
    console.log(`${String(width).padEnd(5)} ${path.slice(0, 44).padEnd(44)} violations ${res.violations.length} ${res.violations.map(v => `${v.id}:${v.impact}:${v.nodes}`).join(' ')} | no-alt ${res.imgs_without_alt} h-skips ${res.heading_skips} h1 ${res.h1_count} small ${res.small_targets}`);
    await page.close();
  }
} finally { await browser.close(); }
out.by_rule = byRule;
mkdirSync('docs/evidence/qa', { recursive: true });
writeFileSync(`docs/evidence/qa/a11y-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log('rules:', JSON.stringify(Object.fromEntries(Object.entries(byRule).map(([k, v]) => [k, `${v.impact} on ${v.pages.length}`]))));
