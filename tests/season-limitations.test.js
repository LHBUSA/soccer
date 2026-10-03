// Promotion writes (scripts/history/season-limitations.mjs): reviewed limitations are never dropped, re-promotion is
// idempotent, evidence and publication state are separate writes. Fixture: the restored MLS 2001 notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeLimitations, promotionWrites, COVERAGE_LINE } from '../scripts/history/season-limitations.mjs';

const restored = JSON.parse(readFileSync(new URL('../docs/evidence/history/review/mls-2001-limitations-restored.json', import.meta.url), 'utf8')).after;
const FORMAT = restored.find(l => l.startsWith('Stage classification from reviewed format manifest'));
const DATE_EXC = restored.find(l => l.startsWith('ESPN event 17679'));
const COVERAGE = ['lineups for 0% of finished matches', 'team statistics for 0% of finished matches', 'event record for 0% of finished matches'];
const AT = '2026-10-03T01:00:00.000Z';
const published = { limitations: restored, publication_state: 'published', published_at: '2026-10-02T23:28:00.000Z', publication_note: 'Pass A accepted 2026-10-02 (scripts/history/accept-season.mjs)' };

test('fixture: the restored MLS 2001 notes carry the format review and the date exception', () => {
  assert.ok(FORMAT && DATE_EXC); assert.ok(!COVERAGE_LINE.test(FORMAT) && !COVERAGE_LINE.test(DATE_EXC));
});

test('promotion does not overwrite format-review notes or date exceptions', () => {
  const { evidence } = promotionWrites({ current: published, coverage: COVERAGE, tier: 'RESULTS', providers: ['espn'], at: AT, note: 'x' });
  assert.ok(evidence.limitations.includes(FORMAT)); assert.ok(evidence.limitations.includes(DATE_EXC));
  // the pre-fix behaviour (coverage lines only) is exactly what this guards against
  assert.notDeepEqual(evidence.limitations, COVERAGE);
});

test('coverage lines are recomputed (replaced), never duplicated', () => {
  const { evidence } = promotionWrites({ current: published, coverage: ['lineups for 40% of finished matches'], at: AT, note: 'x' });
  assert.deepEqual(evidence.limitations, [FORMAT, DATE_EXC, 'lineups for 40% of finished matches']);
});

test('a later promotion/reconciliation appends a new limitation without deleting prior ones', () => {
  const NEW = 'ESPN event 168975 kickoff time disagrees with the reviewed source; canonical kickoff kept as published by ESPN.';
  const merged = mergeLimitations(restored, [NEW], COVERAGE);
  assert.deepEqual(merged, [FORMAT, DATE_EXC, NEW, ...COVERAGE]);
  for (const l of restored) assert.ok(merged.includes(l));
});

test('repeated promotion is idempotent (same limitations, original published_at and note kept)', () => {
  const a = promotionWrites({ current: published, coverage: COVERAGE, tier: 'RESULTS', providers: ['espn'], at: AT, note: 'Pass A accepted 2026-10-03' });
  const after = { ...published, ...a.evidence, ...a.state };
  const b = promotionWrites({ current: after, coverage: COVERAGE, tier: 'RESULTS', providers: ['espn'], at: '2026-10-04T00:00:00.000Z', note: 'Pass A accepted 2026-10-04' });
  assert.deepEqual(b.evidence, a.evidence);
  assert.equal(b.state.published_at, published.published_at); assert.equal(b.state.publication_note, published.publication_note);
  assert.deepEqual(mergeLimitations(mergeLimitations(restored, [], COVERAGE), [], COVERAGE), mergeLimitations(restored, [], COVERAGE));
});

test('evidence state and data state are separate writes with disjoint fields', () => {
  const { evidence, state } = promotionWrites({ current: { limitations: [], publication_state: 'held' }, reviewLimitations: [FORMAT], coverage: COVERAGE, tier: 'MATCH', providers: ['espn'], at: AT, note: 'n' });
  assert.deepEqual(Object.keys(evidence).sort(), ['coverage_tier', 'limitations', 'source_families']);
  assert.deepEqual(Object.keys(state).sort(), ['publication_note', 'publication_state', 'published_at', 'reviewed_at']);
  assert.equal(state.publication_state, 'published'); assert.equal(state.published_at, AT);
  assert.ok(evidence.limitations.includes(FORMAT));
});
