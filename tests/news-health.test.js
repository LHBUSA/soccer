// Newsroom publication health: a dead pipeline, a failing run, a newsroom held by its gates and a newsroom with nothing
// to say are all distinguishable; quiet is never "fixed" by filler. Also the editorial plural-opener false positive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publicationDiagnostic } from '../workers/soccer-news/src/news-health.js';
import { validateEditorial } from '../workers/soccer-news/src/desk.js';
import { readFileSync } from 'node:fs';
const B = JSON.parse(readFileSync('tests/fixtures/news/bayern-packet.json', 'utf8'));

const NOW = Date.parse('2026-10-03T01:10:00Z');
const at = min => new Date(NOW - min * 6e4).toISOString();
const comp = (o = {}) => ({ candidates: 0, new: 0, published: 0, held: 0, holds: {}, ...o });
// the production shape observed 2026-10-03 00:37: 10 candidates, every one an existing story, most of them HELD
const prodRun = { at: at(32), competitions: { bundesliga: comp(), 'premier-league': comp(), 'uefa-champions-league': comp(), 'uefa-nations-league': comp({ candidates: 7, existing: { published: 2, held: 5, other: 0, held_reasons: { 'editorial:new_number_not_in_packet': 4, 'editorial:new_player_or_team': 2 } } }), mls: comp({ candidates: 3, existing: { published: 1, held: 2, other: 0, held_reasons: { 'editorial:new_number_not_in_packet': 2 } } }) } };

test('fresh tick, newest story 9 h old, existing material held: healthy but HELD BY GATES (with reasons), not dead', () => {
  const d = publicationDiagnostic({ tick: { at: at(3), outcome: 'ran' }, last: prodRun, newestPublishedAt: '2026-10-02T16:07:18Z', now: NOW });
  assert.equal(d.ok, true); assert.equal(d.state, 'healthy_material_held_by_gates');
  assert.equal(d.held_existing, 7); assert.deepEqual(d.held_reasons, { 'editorial:new_number_not_in_packet': 6, 'editorial:new_player_or_team': 2 });
  assert.equal(d.candidates_detected, 10); assert.equal(d.newest_published_age_min, 543);
  assert.deepEqual(Object.keys(d.competitions).sort(), ['bundesliga', 'mls', 'premier-league', 'uefa-champions-league', 'uefa-nations-league'], 'every enabled competition is reported individually');
});

test('fresh tick, old newest story, nothing detected or held: pipeline healthy / no publishable material', () => {
  const d = publicationDiagnostic({ tick: { at: at(3), outcome: 'ran' }, last: { at: at(3), competitions: { bundesliga: comp(), mls: comp() } }, newestPublishedAt: at(600), now: NOW });
  assert.equal(d.ok, true); assert.equal(d.state, 'healthy_no_publishable_material'); assert.equal(d.message, 'pipeline healthy / no publishable material');
});

test('a stale tick (> 2 h) is a failure whatever the article age; a failing run is a failure', () => {
  const dead = publicationDiagnostic({ tick: { at: at(130), outcome: 'ran' }, last: prodRun, newestPublishedAt: at(10), now: NOW });
  assert.equal(dead.ok, false); assert.equal(dead.state, 'cron_not_firing');
  assert.equal(publicationDiagnostic({ tick: null, last: null, newestPublishedAt: null, now: NOW }).state, 'cron_not_firing');
  const failing = publicationDiagnostic({ tick: { at: at(3), outcome: 'failed' }, last: { at: at(200), competitions: {} }, newestPublishedAt: at(10), now: NOW });
  assert.equal(failing.ok, false); assert.equal(failing.state, 'run_failing');
});

test('recent publication: publishing', () => {
  assert.equal(publicationDiagnostic({ tick: { at: at(3), outcome: 'ran' }, last: prodRun, newestPublishedAt: at(90), now: NOW }).state, 'publishing');
});

// RC2: the desk 2.2.0 plural-opener test is excluded with the desk change itself (RC2 keeps production desk 2.1.1).
