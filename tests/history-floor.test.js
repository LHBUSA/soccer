// Discovery floor (scripts/history/discovery-floor.mjs): only listings PROVEN to be extra representations of a discovered,
// played fixture lower the floor. It is discovery accounting, never a way to make an expected count pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoveryFloor } from '../scripts/history/discovery-floor.mjs';

const NOW = Date.parse('2026-10-03T00:00:00Z');
const ev = (h, a, d, st, sc) => ({ h, a, d, stype: '1', ...(st ? { st } : {}), ...(sc ? { sc } : {}) });
const cursor = fixtures => ({ index: Object.keys(fixtures), fixtures });
const uniques = n => Object.fromEntries(Array.from({ length: n }, (_, i) => [`u${i}`, ev(`H${i}`, `A${i}`, '2003-09-01T15:00:00Z')]));

test('one fixture listed twice: exactly one extra listing comes off the floor', () => {
  const r = discoveryFloor(cursor({ ...uniques(5), p1: ev('X', 'Y', '2003-12-20T15:00:00Z', 'postponed'), f1: ev('X', 'Y', '2004-03-03T19:45:00Z', 'finished', { h: 3, a: 1 }) }), { now: NOW });
  assert.equal(r.complete, true); assert.equal(r.events, 7); assert.equal(r.extras, 1); assert.equal(r.floor, 6);
  assert.deepEqual(r.removed.map(x => x.id), ['p1']);
});

test('one fixture listed three times (Premier League 2003/04 shape): two extras come off', () => {
  const r = discoveryFloor(cursor({ ...uniques(5), p1: ev('X', 'Y', '2003-12-20T15:00:00Z', 'postponed'), p2: ev('X', 'Y', '2004-02-03T19:45:00Z', 'postponed'), f1: ev('X', 'Y', '2004-03-03T19:45:00Z', 'finished', { h: 3, a: 1 }) }), { now: NOW });
  assert.equal(r.extras, 2); assert.equal(r.floor, 6);
});

test('two genuinely separate matches between the same clubs: neither is removed', () => {
  const r = discoveryFloor(cursor({ ...uniques(3), m1: ev('CHI', 'COL', '2004-05-23T19:00:00Z', 'finished', { h: 1, a: 3 }), m2: ev('CHI', 'COL', '2004-10-06T23:30:00Z', 'finished', { h: 0, a: 1 }) }), { now: NOW });
  assert.equal(r.extras, 0); assert.equal(r.floor, 5);
});

test('a stale never-played listing beside played meetings is an extra; the played meetings are not', () => {
  const r = discoveryFloor(cursor({ m1: ev('CHI', 'COL', '2004-05-23T19:00:00Z', 'finished', { h: 1, a: 3 }), s1: ev('CHI', 'COL', '2004-09-12T23:00:00Z', 'scheduled'), m2: ev('CHI', 'COL', '2004-10-06T23:30:00Z', 'finished', { h: 0, a: 1 }) }), { now: NOW });
  assert.deepEqual(r.removed.map(x => [x.id, x.kind]), [['s1', 'stale_scheduled_listing']]); assert.equal(r.floor, 2);
});

test('an unresolved UNIQUE event never reduces the floor, whatever its status', () => {
  for (const st of [undefined, 'postponed', 'cancelled', 'scheduled', 'unknown', 'abandoned']) {
    const r = discoveryFloor(cursor({ ...uniques(4), lone: ev('X', 'Y', '2004-01-01T15:00:00Z', st) }), { now: NOW });
    assert.equal(r.floor, 5, `status ${st}`);
  }
});

test('nothing comes off a pairing without a finished, score-read meeting, nor for abandoned/unknown listings', () => {
  const noPlayed = discoveryFloor(cursor({ p1: ev('X', 'Y', '2004-01-01T15:00:00Z', 'postponed'), p2: ev('X', 'Y', '2004-02-01T15:00:00Z', 'postponed') }), { now: NOW });
  assert.equal(noPlayed.floor, 2);
  const odd = discoveryFloor(cursor({ a1: ev('X', 'Y', '2004-01-01T15:00:00Z', 'abandoned'), u1: ev('X', 'Y', '2004-01-15T15:00:00Z', 'unknown'), f1: ev('X', 'Y', '2004-02-01T15:00:00Z', 'finished', { h: 1, a: 0 }) }), { now: NOW });
  assert.equal(odd.floor, 3);
  const future = discoveryFloor(cursor({ f1: ev('X', 'Y', '2026-08-01T15:00:00Z', 'finished', { h: 1, a: 0 }), s1: ev('X', 'Y', '2027-01-01T15:00:00Z', 'scheduled') }), { now: NOW });
  assert.equal(future.floor, 2, 'a future scheduled meeting is not stale');
});

test('incomplete discovery gets NO adjustment (unread status, unread score, unfetched event)', () => {
  const unread = discoveryFloor(cursor({ p1: ev('X', 'Y', '2004-01-01T15:00:00Z'), f1: ev('X', 'Y', '2004-02-01T15:00:00Z', 'finished', { h: 1, a: 0 }) }), { now: NOW });
  assert.equal(unread.complete, false); assert.equal(unread.extras, 0); assert.equal(unread.floor, 2); assert.equal(unread.incomplete.repeat_status_unread, 1);
  const noScore = discoveryFloor(cursor({ p1: ev('X', 'Y', '2004-01-01T15:00:00Z', 'postponed'), f1: ev('X', 'Y', '2004-02-01T15:00:00Z', 'finished') }), { now: NOW });
  assert.equal(noScore.complete, false); assert.equal(noScore.floor, 2);
  const c = cursor({ p1: ev('X', 'Y', '2004-01-01T15:00:00Z', 'postponed'), f1: ev('X', 'Y', '2004-02-01T15:00:00Z', 'finished', { h: 1, a: 0 }) }); c.index.push('never-fetched');
  const missing = discoveryFloor(c, { now: NOW });
  assert.equal(missing.complete, false); assert.equal(missing.extras, 0); assert.equal(missing.floor, 3, 'the unfetched event still counts');
});

test('the floor never mutates the cursor', () => {
  const c = cursor({ p1: ev('X', 'Y', '2004-01-01T15:00:00Z', 'postponed'), f1: ev('X', 'Y', '2004-02-01T15:00:00Z', 'finished', { h: 1, a: 0 }) });
  const before = structuredClone(c); discoveryFloor(c, { now: NOW }); assert.deepEqual(c, before);
});
