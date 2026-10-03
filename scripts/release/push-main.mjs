#!/usr/bin/env node
// The ONLY way to push to main from a session: commit first, then
//   node scripts/release/push-main.mjs
// It runs the fail-closed check gate (scripts/release/gate.mjs: truth guard + full suite, every exit status read
// directly from the child process, no shell, no pipe), and pushes only when the gate passed. A failing test can never
// look green here: there is no filter, grep or `;` between the test command and the push (incident 2026-10-03:
// `npm run test:web | grep ... && git commit && git push` pushed 0d8ec97 with 3 failing tests because grep's exit
// status replaced the suite's).
// Refuses: a dirty tracked tree, a failing gate. Rebases on origin/main, re-runs the gate if the rebase brought commits,
// pushes, and verifies HEAD == origin/main.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { gate as realGate } from './gate.mjs';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Pure decision core (tested): push happens only after every gate run passed. */
// Order: rebase on origin/main FIRST, then gate the exact tree that will be pushed (a gate run before the rebase tested
// a tree nobody pushes: 2026-10-03 it failed on a vendored-client parity that origin had already fixed).
export function guardedPush({ gateFn = realGate, gitFn = git, log = console.log } = {}) {
  if (gitFn('status', '--porcelain', '--untracked-files=no')) return { pushed: false, reason: 'tracked changes not committed' };
  gitFn('fetch', '-q', 'origin');
  try { gitFn('rebase', '-q', 'origin/main'); } catch (e) { try { gitFn('rebase', '--abort'); } catch {} return { pushed: false, reason: `rebase on origin/main failed (aborted, nothing pushed): ${String(e.message || e).slice(0, 200)}` }; }
  const head = gitFn('rev-parse', 'HEAD');
  log(`[push-main] gating ${head.slice(0, 7)} (rebased on origin/main)`);
  const g = gateFn();
  if (!g.ok) return { pushed: false, reason: `gate failed at "${g.steps.at(-1)?.label}" (exit ${g.steps.at(-1)?.status})` };
  // A plain (non-force) push: if origin moved while the gate ran, git rejects it as non-fast-forward -> refuse, re-run.
  try { gitFn('push', '-q', 'origin', 'HEAD:main'); } catch (e) { return { pushed: false, reason: `push rejected (origin moved during the gate?): ${String(e.message || e).slice(0, 200)}` }; }
  gitFn('fetch', '-q', 'origin');
  const remote = gitFn('rev-parse', 'origin/main');
  if (remote !== gitFn('rev-parse', 'HEAD')) return { pushed: false, reason: `push not visible: origin/main ${remote}` };
  return { pushed: true, head: remote };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = guardedPush();
  console.log(`[push-main] ${r.pushed ? `PUSHED ${r.head.slice(0, 7)}` : `REFUSED: ${r.reason}`}`);
  process.exit(r.pushed ? 0 : 1);
}
