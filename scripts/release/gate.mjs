#!/usr/bin/env node
// FAIL-CLOSED check gate: truth guard + full test suite. `npm run check`, `npm test` and the release script all use it.
//   node scripts/release/gate.mjs              guard + tests
//   node scripts/release/gate.mjs --tests-only tests
// Every step is a direct child process (spawnSync, no shell, no pipe): its exit status is read directly, and any
// non-zero status, signal or spawn error stops the gate with a non-zero exit. Nothing is reported as passing unless
// the step itself exited 0.
//
// Test scheduling. Each test file runs in its own process. Files that build in-memory PGlite databases
// (store-pglite) are memory- and I/O-heavy WASM workloads; run all at once (default: one process per core) they
// exhausted memory (`WebAssembly.Memory(): could not allocate memory`) or hit transient ESM resolution failures on
// the exFAT volume (`ERR_MODULE_NOT_FOUND .../pglite/dist/chunk-*.js`, then cached by the loader so every later
// PGlite test in that file failed in < 1 ms). They share no state; they share the machine. So that group runs with
// bounded concurrency; every other file stays fully parallel.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PGLITE_CONCURRENCY = 3;

export function testFiles(dir = 'tests') {
  const out = [];
  const walk = d => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (f.endsWith('.test.js')) out.push(p); } };
  walk(dir);
  return out.sort();
}

export function testGroups(files = testFiles()) {
  const heavy = files.filter(f => readFileSync(f, 'utf8').includes('store-pglite'));
  return { parallel: files.filter(f => !heavy.includes(f)), pglite: heavy };
}

function run(label, args, quiet = false) {
  if (!quiet) console.log(`[gate] ${label}: node ${args.slice(0, 3).join(' ')}${args.length > 3 ? ` … (${args.length} args)` : ''}`);
  // NODE_TEST_CONTEXT (set by node:test in its child processes) makes a nested `node --test` report to a parent
  // instead of exiting non-zero on failure: never inherit it, or a failing suite could exit 0.
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, args, { stdio: quiet ? 'ignore' : 'inherit', shell: false, env });
  const ok = !r.error && r.signal === null && r.status === 0;
  return { label, ok, status: r.status, signal: r.signal, error: r.error ? String(r.error.message || r.error) : null };
}

/** Runs the gate; returns { ok, steps }. Stops at the first failing step. */
export function gate({ guard = true, files, quiet = false } = {}) {
  const g = testGroups(files);
  const steps = [];
  const plan = [
    ...(guard ? [['truth guard', ['scripts/guard-truth.mjs']]] : []),
    ...(g.parallel.length ? [[`tests (parallel group, ${g.parallel.length} files)`, ['--test', ...g.parallel]]] : []),
    ...(g.pglite.length ? [[`tests (PGlite group, ${g.pglite.length} files, concurrency ${PGLITE_CONCURRENCY})`, ['--test', `--test-concurrency=${PGLITE_CONCURRENCY}`, ...g.pglite]]] : []),
  ];
  if (!plan.some(([label]) => label.startsWith('tests'))) return { ok: false, steps: [{ label: 'tests', ok: false, status: null, signal: null, error: 'no test files found' }] };
  for (const [label, args] of plan) {
    const s = run(label, args, quiet);
    steps.push(s);
    if (!s.ok) return { ok: false, steps };
  }
  return { ok: true, steps };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/release/gate.mjs')) {
  const res = gate({ guard: !process.argv.includes('--tests-only') });
  for (const s of res.steps) console.log(`[gate] ${s.ok ? 'PASS' : 'FAIL'} ${s.label} (exit ${s.status}${s.signal ? `, signal ${s.signal}` : ''}${s.error ? `, ${s.error}` : ''})`);
  console.log(`[gate] ${res.ok ? 'GATE PASSED' : 'GATE FAILED: nothing may be pushed or released'}`);
  process.exitCode = res.ok ? 0 : 1;
}
