import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render as home } from '../../src/pages/home.js';
const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
test('top-fold hero uses two intentional lines without an empty desktop grid', () => {
  const html = home({ comps: {status:'pending'} });
  assert.match(html, /SOCCER INTELLIGENCE\./);
  assert.match(html, /BEYOND THE SCORE\./);
  assert.match(html, /home-hero-title/);
  assert.match(html, /href="\/pbecast"/);
  assert.match(html, /href="\/picks"/);
  assert.match(html, /href="\/competitions"/);
  assert.match(css, /\.hero\.home-v4 \.hero-grid \{ display: block;/);
});
test('brand, menus, premium navigation and verified account hook remain intact', () => {
  for (const token of ['brandMark()', 'data-menu-toggle', 'leagues-panel', 'intel-panel', 'data-account-open', 'LOCAL_ALL_ACCESS_PATH', 'mountScoreTicker', 'headerLabel(a)']) assert.ok(main.includes(token), token);
  assert.match(css, /min-width: 761px\) and \(max-width: 1380px/);
  assert.match(css, /\.nav-acct \{ min-width: 118px;/);
  assert.match(css, /white-space: nowrap; flex: none;/);
});
