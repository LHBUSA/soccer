#!/usr/bin/env node
// Safe Worker release with a checked-in ledger (docs/deployments.jsonl).
//   node scripts/release/release-worker.mjs <soccer-api|soccer-ingest|soccer-news> [--canary <path>] [--dry]
// 1. refuses unless HEAD == origin/main and workers/ + data/ (+ the frozen research core) are clean
// 2. builds from a clean `git archive` of HEAD
// 3. records the CURRENT production version (the rollback target)
// 4. uploads a version, canaries its preview URL (/health or --canary path must be 2xx)
// 5. promotes EXACTLY that version to 100%
// 6. verifies the live deployment is that version (never "deployed" because upload worked)
// 7. canaries production, appends the ledger row, and prints the rollback command
import { execSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const [worker, ...rest] = process.argv.slice(2);
const opt = k => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : null; };
const DRY = rest.includes('--dry');
if (!['soccer-api', 'soccer-ingest', 'soccer-news'].includes(worker)) throw new Error('worker: soccer-api | soccer-ingest | soccer-news');
const canaryPath = opt('--canary') || '/health';
// Git Bash rewrites '/v1/...' arguments into Windows paths unless MSYS_NO_PATHCONV=1 is set.
if (!/^\/[A-Za-z0-9/_.?=&%-]*$/.test(canaryPath)) throw new Error(`canary path is not a URL path: ${canaryPath} (run with MSYS_NO_PATHCONV=1)`);
const ROOT = process.cwd();
const sh = (cmd, cwd = ROOT) => execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '--require D:/Workers/exfat-readlink.cjs' } });
const log = (...a) => console.log('[release]', ...a);

sh('git fetch -q origin');
const head = sh('git rev-parse HEAD').trim();
if (head !== sh('git rev-parse origin/main').trim()) throw new Error('HEAD != origin/main: push first');
// The model shadow lane imports the frozen research core directly (single source of truth).
if (sh('git status --porcelain -- workers data scripts/research/structural-core.mjs').trim()) throw new Error('uncommitted changes under workers/, data/ or the frozen research core');
const short = head.slice(0, 7);
const OUT = `D:/Workers/_deploy/soccer-${short}`;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
execSync(`git archive HEAD workers data package.json scripts/research/structural-core.mjs | tar -x -C "${OUT}"`, { cwd: ROOT, shell: 'bash' });
const wdir = join(OUT, 'workers', worker);
const wr = args => sh(`npx wrangler ${args}`, wdir);
const liveVersion = () => { const d = JSON.parse(wr('deployments list --json')); const last = d[d.length - 1]; return { deployment: last.id, versions: last.versions }; };

const before = liveVersion();
const previous = before.versions.length === 1 ? before.versions[0].version_id : null;
log(worker, 'commit', short, 'current production', previous || JSON.stringify(before.versions));
if (DRY) { log('dry run: stop before upload'); process.exit(0); }

const up = wr(`versions upload --message "soccer ${short}"`);
const version = (up.match(/Worker Version ID: ([0-9a-f-]{36})/) || [])[1];
const preview = (up.match(/Version Preview URL: (\S+)/) || [])[1];
if (!version) throw new Error(`upload did not report a version id:\n${up.slice(-600)}`);
log('uploaded', version, preview || '(no preview url)');
// Up to 15 attempts, 15 s apart: a freshly uploaded version's preview hostname can take
// a few minutes to become reachable. Only soccer-news may answer /health with 503
// (it is 503 until its first run). curl in a fresh process; its exit code is recorded.
const canary = async base => {
  let last = null;
  for (let i = 0; i < 15; i++) {
    const url = `${base.replace(/\/$/, '')}${canaryPath}`;
    const r = spawnSync('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '45', url], { encoding: 'utf8' });
    const status = Number(r.stdout.trim()) || 0;
    last = { status, curl_exit: r.status, ok: (status >= 200 && status < 300) || (worker === 'soccer-news' && canaryPath === '/health' && status === 503), attempts: i + 1 };
    if (last.ok) return last;
    await new Promise(res => setTimeout(res, 15000));
  }
  return last;
};
const pre = preview ? await canary(preview) : { status: null, ok: true, skipped: 'no preview url' };
if (!pre.ok) throw new Error(`preview canary failed: ${JSON.stringify(pre)} (version ${version} NOT promoted; production unchanged at ${previous})`);

wr(`versions deploy ${version}@100% --yes --message "soccer ${short}"`);
const after = liveVersion();
const live = after.versions.length === 1 && after.versions[0].percentage === 100 ? after.versions[0].version_id : null;
if (live !== version) throw new Error(`promotion NOT verified: live ${JSON.stringify(after.versions)} expected ${version}`);
const host = { 'soccer-api': 'https://soccer-api.sales-fd3.workers.dev', 'soccer-ingest': 'https://soccer-ingest.sales-fd3.workers.dev', 'soccer-news': 'https://soccer-news.sales-fd3.workers.dev' }[worker];
const prod = await canary(host);
const row = { at: new Date().toISOString(), worker, commit: head, uploaded_version: version, promoted_version: live, previous_version: previous, rollback_version: previous, deployment_id: after.deployment, preview_canary: pre, production_canary: { path: canaryPath, ...prod } };
mkdirSync(join(ROOT, 'docs'), { recursive: true });
appendFileSync(join(ROOT, 'docs', 'deployments.jsonl'), JSON.stringify(row) + '\n');
log('LIVE', worker, live, 'production canary', JSON.stringify(prod));
log(`rollback: cd workers/${worker} && npx wrangler versions deploy ${previous}@100% --yes`);
if (!prod.ok) { console.error('[release] PRODUCTION CANARY FAILED — roll back with the command above'); process.exit(2); }
