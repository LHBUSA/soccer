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

test('a passing gate pushes; a gate that fails after the rebase blocks the push', () => {
  const ok = { ok: true, steps: [] }; const bad = { ok: false, steps: [{ label: 'tests', status: 1 }] };
  const c1 = [];
  assert.equal(guardedPush({ gateFn: () => ok, gitFn: fakeGit(c1), log: () => {} }).pushed, true);
  assert.ok(c1.some(c => c.startsWith('push')));
  assert.ok(c1.indexOf(c1.find(c => c.startsWith('push'))) < c1.lastIndexOf('rev-parse origin/main'), 'origin/main is re-read after the push (verified, not assumed)');
  let n = 0; const c2 = [];
  const r = guardedPush({ gateFn: () => (n++ === 0 ? ok : bad), gitFn: fakeGit(c2, { moved: true }), log: () => {} });
  assert.equal(r.pushed, false); assert.match(r.reason, /after rebase/);
  assert.ok(!c2.some(c => c.startsWith('push')));
});

test('uncommitted tracked changes refuse before the gate runs', () => {
  let ran = false; const calls = [];
  const r = guardedPush({ gateFn: () => { ran = true; return { ok: true, steps: [] }; }, gitFn: fakeGit(calls, { dirty: ' M src/x.js' }), log: () => {} });
  assert.equal(r.pushed, false); assert.equal(ran, false);
});
