// Release discipline (2026-10-03): a failing test must block the push path. Regression for 0d8ec97, pushed with 3
// failing tests because `test | grep && git push` read grep's exit status instead of the suite's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gate } from '../scripts/release/gate.mjs';
import { guardedPush } from '../scripts/release/push-main.mjs';

const fakeGit = (calls, { dirty = '', moved = false } = {}) => (...a) => {
  calls.push(a.join(' '));
  if (a[0] === 'status') return dirty;
  if (a[0] === 'rev-parse') return moved && calls.filter(c => c.startsWith('rebase')).length ? 'after' : 'before';
  return '';
};

test('a REAL failing test file makes the gate fail with its real exit status, and nothing is pushed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'push-main-'));
  const f = join(dir, 'deliberately-failing.test.js');
  writeFileSync(f, "import test from 'node:test'; import assert from 'node:assert'; test('fails on purpose', () => assert.equal(1, 2));\n");
  const calls = [];
  const r = guardedPush({ gateFn: () => gate({ guard: false, files: [f], quiet: true }), gitFn: fakeGit(calls), log: () => {} });
  assert.equal(r.pushed, false);
  assert.match(r.reason, /gate failed/);
  assert.ok(!calls.some(c => c.startsWith('push')), 'git push never ran');
});

test('order: rebase first, then gate the rebased tree, then push; a failing gate after the rebase blocks the push', () => {
  const ok = { ok: true, steps: [] }; const bad = { ok: false, steps: [{ label: 'tests', status: 1 }] };
  const c1 = []; let gatedAfter = null;
  const r1 = guardedPush({ gateFn: () => { gatedAfter = c1.slice(); return ok; }, gitFn: fakeGit(c1), log: () => {} });
  assert.equal(r1.pushed, true);
  assert.ok(gatedAfter.some(c => c.startsWith('rebase')), 'the gate runs on the rebased tree');
  assert.ok(c1.indexOf(c1.find(c => c.startsWith('push'))) < c1.lastIndexOf('rev-parse origin/main'), 'origin/main is re-read after the push (verified, not assumed)');
  const c2 = [];
  const r2 = guardedPush({ gateFn: () => bad, gitFn: fakeGit(c2), log: () => {} });
  assert.equal(r2.pushed, false); assert.ok(!c2.some(c => c.startsWith('push')));
});

test('a failed rebase or a rejected push is refused, never forced', () => {
  const ok = { ok: true, steps: [] };
  const conflict = (calls) => (...a) => { calls.push(a.join(' ')); if (a[0] === 'rebase' && a[1] === '-q') throw new Error('CONFLICT'); return a[0] === 'status' ? '' : 'x'; };
  const c1 = []; const r1 = guardedPush({ gateFn: () => ok, gitFn: conflict(c1), log: () => {} });
  assert.equal(r1.pushed, false); assert.match(r1.reason, /rebase/); assert.ok(c1.includes('rebase --abort')); assert.ok(!c1.some(c => c.startsWith('push')));
  const rejected = (calls) => (...a) => { calls.push(a.join(' ')); if (a[0] === 'push') throw new Error('non-fast-forward'); return a[0] === 'status' ? '' : 'x'; };
  const c2 = []; const r2 = guardedPush({ gateFn: () => ok, gitFn: rejected(c2), log: () => {} });
  assert.equal(r2.pushed, false); assert.match(r2.reason, /rejected/); assert.ok(!c2.some(c => /--force|(^| )-f( |$)/.test(c)));
});

test('uncommitted tracked changes refuse before the gate runs', () => {
  let ran = false; const calls = [];
  const r = guardedPush({ gateFn: () => { ran = true; return { ok: true, steps: [] }; }, gitFn: fakeGit(calls, { dirty: ' M src/x.js' }), log: () => {} });
  assert.equal(r.pushed, false); assert.equal(ran, false);
});
