// Competition accent contract: every enabled competition's `accent` resolves to a real theme, and an
// unknown accent falls back to a dark, readable tile instead of an unresolved (transparent) one.
// Regression: FIFA World Cup shipped with accent 'fifa' and no `.a-fifa`, so its home tile lost its
// dark ground and rendered white text on the light canvas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALL_COMPS, FEATURED_COMPS } from '../../src/lib/competitions.js';
import { competitionMark } from '../../src/components/media.js';
import { coverageCards } from '../../src/pages/home.js';

const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
const root = css.match(/:root\s*\{([^}]*)\}/)[1];

test('every enabled competition accent has a token and a theme class', () => {
  assert.ok(FEATURED_COMPS.length >= 6);
  for (const c of FEATURED_COMPS) {
    assert.match(root, new RegExp(`--a-${c.accent}:\\s*#[0-9a-f]{6}`, 'i'), `${c.slug}: --a-${c.accent} token`);
    assert.match(css, new RegExp(`\\.a-${c.accent}\\s*\\{\\s*--accent:\\s*var\\(--a-${c.accent}\\);\\s*\\}`), `${c.slug}: .a-${c.accent} class`);
  }
});

test('an unknown accent can never leave a tile without its dark ground', () => {
  assert.match(root, /--accent:\s*var\(--a-x\)/, ':root carries a default --accent that unknown classes inherit');
  const tile = css.match(/\.comptile\s*\{([^}]*)\}/)[1];
  assert.match(tile, /background:\s*var\(--shell\);/, 'solid dark fallback before the gradient');
  assert.match(tile, /var\(--accent,\s*var\(--a-x\)\)/, 'gradient carries its own accent fallback');
  assert.match(tile, /color:\s*#fff/);
});

test('FIFA World Cup: first-class tile and a readable mark', () => {
  const fifa = ALL_COMPS.find(c => c.slug === 'fifa-world-cup');
  assert.ok(fifa.enabled);
  const html = coverageCards({ data: [{ slug: 'fifa-world-cup', name: 'FIFA World Cup', latest_season: '2026', matches: 104, seasons: 1 }] }, null);
  assert.match(html, /class="comptile a-fifa"/);
  assert.match(html, /FIFA World Cup/); assert.match(html, /<b>104<\/b>matches/); assert.match(html, /OPEN COMPETITION HUB/);
  // No approved FIFA logo: the owned typographic mono, never an empty or broken image.
  assert.match(competitionMark('fifa-world-cup', 'lg', { tone: 'dark' }), /class="cmono a-fifa lg"[^>]*>FIFA</);
  assert.match(css, /\.cmono\.lg\s*\{[^}]*display:\s*inline-flex/, 'the legend .lg dot rule cannot collapse the mono');
});
