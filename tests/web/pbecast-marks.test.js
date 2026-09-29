// PBEcast pitch-mark contract: the pitch is a shot map. Only located shots, goals and own goals
// are drawn, one marker per source event; only the current replay event is highlighted/pulsed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildTimeline, pitchItems, pitchKind, replayView } from '../../src/lib/cast.js';
import { castPitch, pitchMarks } from '../../src/pages/pbecast.js';

const m = { home: { short_name: 'H' }, away: { short_name: 'A' } };
const marks = html => (html.match(/<g class="cmark[^"]*"/g) || []);
const at = (type, extra = {}) => ({ minute: 10, period: '1H', team: 'home', type, x: 90, y: 30, score: { home: 0, away: 0 }, ...extra });
const one = item => pitchMarks(buildTimeline([item]).items, false);

test('A/B: a card or a substitution with coordinates draws no pitch marker', () => {
  for (const t of ['card_yellow', 'card_red', 'sub', 'foul', 'offside']) {
    assert.equal(pitchKind(at(t)), null, t);
    assert.equal(marks(one(at(t))).length, 0, t);
  }
});

test('C/D/E/F: shots, goals and own goals draw exactly one correctly classified marker', () => {
  const cases = [[at('shot', { outcome: 'off_target' }), 'off'], [at('shot', { outcome: 'blocked' }), 'blocked'], [at('shot', { outcome: 'on_target' }), 'on'],
    [at('goal', { outcome: 'goal' }), 'goal'], [at('shot', { outcome: 'goal' }), 'goal'], [at('own_goal'), 'og'], [at('shot', { outcome: 'post' }), 'post']];
  for (const [item, kind] of cases) {
    const html = one(item);
    assert.equal(marks(html).length, 1, `${item.type}/${item.outcome}`);
    assert.match(html, new RegExp(`class="cmark k-${kind}"`), `${item.type}/${item.outcome} -> ${kind}`);
  }
  assert.match(one(at('goal', { outcome: 'goal' })), /class="ring"/, 'goal ring');
  assert.match(one(at('own_goal')), /class="ring og"/, 'own-goal ring');
  assert.doesNotMatch(one(at('shot', { outcome: 'off_target' })), /ring/, 'a normal shot has no halo');
  assert.equal(pitchKind({ type: 'shot', outcome: 'off_target' }), null, 'unlocated shot is not drawn');
});

test('G: the replay cursor excludes future shots', () => {
  const tl = buildTimeline([at('shot', { minute: 5, outcome: 'on_target' }), at('shot', { minute: 50, period: '2H', outcome: 'off_target', x: 80 })]);
  const rv = replayView(20, tl);
  const html = castPitch(tl, m, { items: rv.seen, current: rv.current });
  assert.equal(marks(html).length, 1);
  assert.doesNotMatch(html, /data-v="50"/);
});

test('H: only the current replay event is highlighted, only it pulses, none at full time', () => {
  const tl = buildTimeline([at('shot', { minute: 5, outcome: 'on_target' }), at('shot', { minute: 8, outcome: 'off_target', x: 80 }), at('goal', { minute: 12, outcome: 'goal', x: 95 })]);
  const rv = replayView(8, tl);
  const html = pitchMarks(rv.seen, false, { current: rv.current, pulse: true });
  assert.equal((html.match(/ cur"/g) || []).length, 1);
  assert.match(html, /class="cmark k-off cur" data-ci="1"/);
  assert.equal((html.match(/class="cpulse"/g) || []).length, 1);
  assert.doesNotMatch(html, /class="pulse"/, 'never the page loading-dot class');
  const end = replayView(tl.total, tl);
  assert.doesNotMatch(castPitch(tl, m, { items: end.seen }), / cur"|cpulse/);
});

test('I: one marker per source event (a goal also recorded as a shot is drawn once)', () => {
  const g = at('goal', { minute: 30, outcome: 'goal' }); const s = at('shot', { minute: 30, outcome: 'goal' });
  const tl = buildTimeline([s, g]);
  assert.equal(pitchItems(tl.items).length, 1);
  assert.equal(pitchItems(tl.items)[0].type, 'goal');
  const html = pitchMarks(tl.items, false);
  assert.equal(new Set((html.match(/data-ci="\d+"/g) || [])).size, marks(html).length, 'no duplicated data-ci');
});

test('J + production regression (Vancouver 3-3 D.C. United): landscape = portrait = located shots, no ghosts', () => {
  const fx = JSON.parse(readFileSync(new URL('../fixtures/cast/vancouver-dc-united-2026-09-27.json', import.meta.url)));
  const tl = buildTimeline(fx.sequence);
  const shots = fx.sequence.filter(x => ['shot', 'goal', 'own_goal'].includes(x.type) && Number.isFinite(x.x)).length;
  const land = castPitch(tl, fx); const port = castPitch(tl, fx, { portrait: true });
  assert.equal(marks(land).length, shots);
  assert.equal(marks(port).length, shots);
  assert.equal((land.match(/k-goal/g) || []).length, 6, 'six goals');
  assert.equal((land.match(/<circle class="ring"/g) || []).length, 6, 'a ring per goal only');
  assert.doesNotMatch(land, /class="pulse"|cpulse|cur"/, 'no halo, no highlight at full time');
  assert.equal(replayView(tl.total, tl, fx.score).located, shots);
  for (let v = 0; v <= tl.total; v += 7) {
    const rv = replayView(v, tl, fx.score);
    assert.equal(marks(castPitch(tl, fx, { items: rv.seen, current: rv.current })).length, marks(castPitch(tl, fx, { portrait: true, items: rv.seen, current: rv.current })).length);
  }
});

test('CSS: SVG marks never share the loading dot class; pitch pulse is one-shot', () => {
  const css = readFileSync(new URL('../../src/styles/main.css', import.meta.url), 'utf8');
  assert.match(css, /^span\.pulse \{/m, 'loading dot scoped to span');
  assert.doesNotMatch(css, /^\.pulse \{/m);
  assert.match(css, /\.cpulse \{[^}]*animation: castpulse 1\.1s ease-out 1;/);
  assert.doesNotMatch(css, /rgba\(0,0,0,\.25\)/, 'no translucent miss discs');
});
