// PBE editorial art engine: deterministic (content-hashable), every direction x format renders, and the
// output can carry no third-party imagery: no <image>, no external href/url, no embedded raster data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTIONS, FORMATS, renderArt } from '../workers/shared/art/engine.js';

const specs = [
  { kind: 'preview', competition: 'UEFA Nations League', stage: 'Group C1', label: 'Preview', home: { name: 'Finland', standing: '2ND · 4 PTS', form: ['W', 'D'] }, away: { name: 'Albania', standing: '1ST · 6 PTS', form: ['W', 'W'] }, when: 'HELSINKI · 3 OCT 2026' },
  { kind: 'report', competition: 'UEFA Nations League', label: 'Match report', home: { name: 'France' }, away: { name: 'Italy' }, score: { home: 1, away: 1 }, timeline: [{ minute: 55, display: "55'", type: 'goal', team: 'home', label: 'Olise' }], shots: [{ x: 95, y: 30, team: 'home', goal: true }], when: 'STADE DE FRANCE' },
  { kind: 'team_trend', competition: 'MLS', label: 'Team form', title: 'Seattle Sounders FC', big: 8, bigLabel: 'MLS matches unbeaten', run: [{ result: 'W', top: '2-1', bottom: '2 OCT' }], when: 'THROUGH 2 OCT' },
  { kind: 'player_form', competition: 'MLS', label: 'Player form', title: 'Iván Angulo', subtitle: 'Orlando City SC', big: 4, bigLabel: 'straight scoring appearances', run: [{ result: null, top: '1 G', bottom: '26 SEP' }], when: 'THROUGH 26 SEP' },
  { kind: 'table', competition: 'FIFA World Cup 2026', label: 'Final group table', title: 'Group A', advance: 2, rows: [{ position: 1, name: 'Mexico', points: 9, form: ['W', 'W', 'W'] }], when: '72 MATCHES' },
];

test('every spec renders in every direction and format, deterministically, with no external imagery', () => {
  for (const spec of specs) for (const direction of DIRECTIONS) for (const format of Object.keys(FORMATS)) {
    const a = renderArt(spec, { direction, format }); const b = renderArt(spec, { direction, format });
    assert.equal(a, b, `${spec.kind}/${direction}/${format} deterministic`);
    const [w, h] = FORMATS[format];
    assert.match(a, new RegExp(`^<svg [^>]*width="${w}" height="${h}"`));
    assert.doesNotMatch(a, /<image|xlink:href|href="http|url\(http|data:image/i, 'no third-party or raster imagery');
    assert.doesNotMatch(a, /undefined|NaN/, 'every text comes from the spec');
  }
});

test('text is escaped (names are data, never markup)', () => {
  const svg = renderArt({ ...specs[2], title: 'A & B <script>' }, { direction: 'poster', format: 'og' });
  assert.match(svg, /A &amp; B &lt;SCRIPT&gt;/); assert.doesNotMatch(svg, /<script/i);
});
