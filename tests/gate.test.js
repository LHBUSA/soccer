// The check gate fails closed: a failing test file makes gate() return ok:false with the child's real exit status.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gate, testGroups, testFiles } from '../scripts/release/gate.mjs';

test('PGlite-backed files run in the bounded group; every test file is in exactly one group', () => {
  const all = testFiles();
  const g = testGroups(all);
  assert.ok(g.pglite.some(f => f.endsWith('shadow.test.js')) && g.pglite.some(f => f.endsWith('algo.test.js')));
  assert.equal(g.parallel.length + g.pglite.length, all.length);
  assert.ok(!g.parallel.some(f => readFileSync(f, 'utf8').includes('store-pglite')));
});

test('a failing test stops the gate with its real exit status; a passing one passes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  try {
    const bad = join(dir, 'bad.test.js'); const good = join(dir, 'good.test.js');
    writeFileSync(bad, "import test from 'node:test'; import assert from 'node:assert/strict'; test('fails', () => assert.equal(1, 2));\n");
    writeFileSync(good, "import test from 'node:test'; test('passes', () => {});\n");
    const failed = gate({ guard: false, files: [good, bad], quiet: true });
    assert.equal(failed.ok, false); assert.equal(failed.steps.at(-1).status, 1);
    const passed = gate({ guard: false, files: [good], quiet: true });
    assert.equal(passed.ok, true); assert.equal(passed.steps.at(-1).status, 0);
    assert.equal(gate({ guard: false, files: [], quiet: true }).ok, false, 'no test files is a failure, never a pass');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
