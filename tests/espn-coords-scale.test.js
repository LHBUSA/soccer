// ESPN coordinate scale (per match). Measured 2026-10-02: ESPN served 0-100 fieldPosition values for
// matches from ~July 2026 and 0-1 values (a different, unverified frame) for earlier matches
// (MLS 2026-02-21..05-25, Nations League 2024/25). A unit-scale match must never be mapped onto the
// canonical pitch (that put every shot ~0.3 m from a corner flag); its source values are kept.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ESPN_COORDS, ESPN_UNIT_COORDS, parsePlays } from '../workers/providers/espn.js';

const play = (id, text, x, y, extra = {}) => ({ id: String(id), valid: true, type: { text }, period: { number: 1 }, clock: { value: id * 60 }, team: { $ref: 'http://x/teams/1' }, participants: [{ order: 1, athlete: { $ref: 'http://x/athletes/9' } }], fieldPositionX: x, fieldPositionY: y, ...extra });

test('0-100 match: shots map to the canonical pitch (penalty spot ~12 m out, centred)', () => {
  const r = parsePlays([play(1, 'Pass', 40, 50), play(2, 'Foul', 60, 20), play(3, 'Penalty - Scored', 88.5, 50), play(4, 'Shot Off Target', 80, 40), play(5, 'Throw In', 30, 0)], { eventId: 1 });
  assert.equal(r.coordinate_scale, ESPN_COORDS);
  const pen = r.events.find(e => e.set_piece === 'penalty');
  assert.equal(pen.source_coordinate_system, ESPN_COORDS);
  assert.ok(Math.abs(pen.x_m - 92.93) < 0.05 && Math.abs(pen.y_m - 34) < 0.05, `${pen.x_m},${pen.y_m}`);
});

test('0-1 match: no canonical location for any play; source values kept and labelled', () => {
  const r = parsePlays([play(1, 'Pass', 0.4, 0.5), play(2, 'Foul', 0.956, 0.2), play(3, 'Penalty - Scored', 0.23, 0.5), play(4, 'Shot Off Target', 0.43, 0.7), play(5, 'Throw In', 0.3, 1), play(6, 'Kickoff', 0, 0)], { eventId: 1 });
  assert.equal(r.coordinate_scale, ESPN_UNIT_COORDS);
  for (const e of r.events.filter(e => e.source_x !== null)) {
    assert.equal(e.x_m, null); assert.equal(e.y_m, null); assert.equal(e.end_x_m, null);
    assert.equal(e.source_coordinate_system, ESPN_UNIT_COORDS);
  }
  assert.equal(r.events.find(e => e.set_piece === 'penalty').source_x, 0.23);
});

test('a 0-100 match with a few near-corner plays is still 0-100 (needs every located play <= 1)', () => {
  const r = parsePlays([play(1, 'Pass', 0.5, 0.5), play(2, 'Corner Awarded', 100, 0), play(3, 'Shot On Target', 90, 45), play(4, 'Pass', 50, 50), play(5, 'Pass', 1, 1)], { eventId: 1 });
  assert.equal(r.coordinate_scale, ESPN_COORDS);
});

test('season types: MLS 2001-2016 "Regular Season <year>" is the league stage; non-competitive types stay excluded', async () => {
  const { seasonTypeRole } = await import('../workers/providers/espn.js');
  assert.equal(seasonTypeRole('Regular Season 2001'), 'league');
  assert.equal(seasonTypeRole('Regular Season'), 'league');
  assert.equal(seasonTypeRole('2002 Playoffs'), 'playoff');
  for (const t of ['All-Star Game', 'Preseason', 'Combined']) assert.equal(seasonTypeRole(t), 'excluded', t);
});
