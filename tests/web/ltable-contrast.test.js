// .ltable contrast regression (P0 visual fix, 2026-10-04). The shared table primitive is always a white surface, so it
// must set its OWN foreground. Before the fix a table inside a dark parent (.band.dark { color: #fff }) inherited white
// text onto white cells (historical results page). This mounts .ltable with the real stylesheet inside a light parent
// AND a dark parent in Chrome and asserts the COMPUTED foreground/background pairs meet WCAG AA (4.5:1) for body
// cells, row headers, links, the sticky first column, muted cells, header cells, hover rows and highlighted rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const require = createRequire(import.meta.url);
const css = fs.readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');

const table = `<div class="tablewrap"><table class="ltable"><thead><tr><th class="tm" scope="col">Season</th><th class="pos" scope="col">Pos</th><th scope="col">P</th><th scope="col">Pts</th></tr></thead><tbody>
  <tr><th class="tm" scope="row"><a href="/seasons/2025-26"><span>2025-26</span></a></th><td class="pos">3</td><td>34</td><td class="pts">61</td></tr>
  <tr class="hl"><th class="tm" scope="row"><a href="/seasons/2024-25"><span>2024-25</span></a></th><td class="pos">1</td><td>34</td><td class="pts">74</td></tr>
  <tr><th class="tm" scope="row">2023-24</th><td class="pos">—</td><td>34</td><td class="pts">50</td></tr>
</tbody></table></div>`;

function lum(rgb) {
  const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test('.ltable keeps AA contrast on its white surface inside a light AND a dark parent', { skip: !fs.existsSync(CHROME) && 'Chrome not installed' }, async () => {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-first-run'] });
  try {
    const page = await browser.newPage();
    for (const width of [390, 1440]) {
      await page.setViewport({ width, height: 900 });
      await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body>
        <section class="band" id="light"><div class="wrap">${table}</div></section>
        <section class="band dark" id="dark"><div class="wrap">${table}</div></section></body></html>`);
      for (const parent of ['light', 'dark']) {
        const pairs = await page.evaluate((id) => {
          const rgb = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
          const bgOf = (el) => { for (let e = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\(0, 0, 0, 0\)|transparent/.test(c)) return rgb(c); } return [255, 255, 255]; };
          const root = document.getElementById(id);
          const pick = (sel, name) => [...root.querySelectorAll(sel)].map((el, i) => ({ name: `${name}#${i}`, fg: rgb(getComputedStyle(el).color), bg: bgOf(el) }));
          return [
            ...pick('tbody td:not(.pos)', 'body cell'), ...pick('tbody th.tm', 'row header / sticky column'), ...pick('tbody th.tm a', 'season link'),
            ...pick('tbody td.pos', 'muted cell'), ...pick('tbody td.pts', 'pts'), ...pick('thead th', 'header cell'),
          ];
        }, parent);
        assert.ok(pairs.length >= 15, `${parent}: cells found`);
        for (const p of pairs) {
          const r = ratio(p.fg, p.bg);
          assert.ok(r >= 4.5, `${width}px ${parent} parent: ${p.name} contrast ${r.toFixed(2)}:1 (fg ${p.fg} on bg ${p.bg})`);
        }
        // the table surface itself stays white (the fix is foreground, never a dark table)
        const cellBg = await page.evaluate((id) => getComputedStyle(document.querySelector(`#${id} tbody td`)).backgroundColor, parent);
        assert.equal(cellBg, 'rgb(255, 255, 255)', `${parent}: white table surface preserved`);
        // hover keeps AA contrast
        await page.hover(`#${parent} tbody tr:first-child td:nth-child(3)`);
        const hover = await page.evaluate((id) => { const td = document.querySelector(`#${id} tbody tr:first-child td:nth-child(3)`); const s = getComputedStyle(td); return [s.color, s.backgroundColor]; }, parent);
        const num = (s) => (s.match(/\d+(\.\d+)?/g) || []).slice(0, 3).map(Number);
        assert.ok(ratio(num(hover[0]), num(hover[1])) >= 4.5, `${width}px ${parent}: hover row contrast`);
        // no horizontal page overflow introduced (the table scrolls inside its own wrapper on narrow screens)
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
        assert.equal(overflow, false, `${width}px: no page-level horizontal overflow`);
      }
    }
  } finally {
    await browser.close();
  }
});
