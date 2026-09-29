// Soccer Algo V1 GO-LIVE PREFLIGHT (read-only; every database write happens inside a transaction that is rolled back).
// Encodes the owner's conditional G7 approval (2026-09-29). All seven must pass on/after 2026-10-02 18:30 UTC:
//   1. the production shadow lane has >= 1 real forecast
//   2. reproduction-canary --source shadow = PASS
//   3. every archived input hash matches        (inside the canary)
//   4. every recomputed forecast is bit-for-bit (inside the canary)
//   5. no spec / model / pick-policy drift from the frozen versions
//   6. all ledger guards intact (checks-1200 re-run against production, rolled back)
//   7. no Official Pick, forecast or Algo event exists yet (nothing seeded)
// Writes docs/evidence/algo/golive-preflight.json. Exit 1 unless every condition passes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { ALGO_SPEC as spec } from '../../workers/soccer-ingest/src/algo-lane.js';

const NOT_BEFORE = Date.parse('2026-10-02T18:30:00Z');
const FROZEN = { algo_version: 'soccer-algo-v1.0.0', spec_hash: '3156f6f9e3f217fbdd8732363a89ff289d831b695de3be5583691d8966bbc1e6', model_hash: 'd9cf3320842efacfc0437816fc74131515f71ff8eac51ead8c8a632d5bdcd7f2', core_sha256: 'c6f296eb3dd397ecec366a36fc28909527d3b2dc97cc834a5987d34f5f727746', pick_policy: 'soccer-algo-pick-policy/1.1', thresholds: { '1x2': 0.6, home_to_score: 0.875 } };
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const node = args => spawnSync(process.execPath, args, { encoding: 'utf8' });
const c = {};

c.time = { ok: Date.now() >= NOT_BEFORE, detail: `now ${new Date().toISOString()}; not before 2026-10-02T18:30:00Z` };
const shadowRows = await store.select('soccer_model_shadow_predictions', { columns: ['id'] });
c['1_shadow_forecast'] = { ok: shadowRows.length >= 1, detail: `${shadowRows.length} production shadow forecast(s)` };

const can = node(['scripts/algo/reproduction-canary.mjs', '--source', 'shadow']);
const report = JSON.parse(readFileSync('docs/evidence/algo/reproduction-canary-shadow.json', 'utf8'));
c['2_canary_pass'] = { ok: can.status === 0 && report.verdict === 'PASS', detail: can.stdout.trim().split('\n')[0] };
c['3_input_hash'] = { ok: report.results.length > 0 && report.results.every(r => r.checks.archive_hash && r.checks.input_count), detail: `${report.results.filter(r => r.checks.archive_hash).length}/${report.results.length} archive hashes match` };
c['4_bit_for_bit'] = { ok: report.results.length > 0 && report.results.every(r => r.checks.lambdas && r.checks.probabilities), detail: `${report.results.filter(r => r.checks.lambdas && r.checks.probabilities).length}/${report.results.length} recomputed exactly` };

const specCheck = node(['scripts/algo/build-spec.mjs', '--check']); const resCheck = node(['scripts/algo/build-research-summary.mjs', '--check']);
const coreSha = createHash('sha256').update(readFileSync('scripts/research/structural-core.mjs')).digest('hex');
const drift = [
  spec.algo_version === FROZEN.algo_version, spec.spec_hash === FROZEN.spec_hash, spec.model.model_hash === FROZEN.model_hash, spec.model.code.sha256 === FROZEN.core_sha256, coreSha === FROZEN.core_sha256,
  spec.pick_policy.version === FROZEN.pick_policy, JSON.stringify(Object.fromEntries(Object.entries(spec.pick_policy.markets).map(([k, v]) => [k, v.threshold]))) === JSON.stringify(FROZEN.thresholds), specCheck.status === 0, resCheck.status === 0,
];
c['5_no_drift'] = { ok: drift.every(Boolean), detail: `spec ${spec.spec_hash.slice(0, 8)}, model ${spec.model.model_hash.slice(0, 8)}, core ${coreSha.slice(0, 8)}, policy ${spec.pick_policy.version}, build-spec --check ${specCheck.status === 0 ? 'ok' : 'FAIL'}, research --check ${resCheck.status === 0 ? 'ok' : 'FAIL'}` };

const tmp = join(tmpdir(), 'algo-golive-guards.sql');
writeFileSync(tmp, `begin;\n${readFileSync('scripts/db/checks-1200-algo-picks.sql', 'utf8')}\nselect 'ALL_CHECKS_PASSED' as proof;\nrollback;\n`);
let guards = '';
try { guards = execFileSync('pwsh', ['-NoProfile', '-File', 'scripts/db/run_sql_file.ps1', '-File', tmp], { encoding: 'utf8' }); } catch (e) { guards = String(e.stdout || e.message); }
c['6_ledger_guards'] = { ok: /ALL_CHECKS_PASSED/.test(guards), detail: /ALL_CHECKS_PASSED/.test(guards) ? 'checks-1200 passed against production (rolled back)' : guards.slice(0, 300) };

const counts = {};
for (const t of ['soccer_algo_picks', 'soccer_algo_forecasts', 'soccer_algo_events']) counts[t] = (await store.select(t, { columns: ['id'] })).length;
c['7_nothing_seeded'] = { ok: Object.values(counts).every(n => n === 0), detail: JSON.stringify(counts) };

const pass = Object.values(c).every(x => x.ok);
const out = { preflight: 'soccer-algo-v1-golive', approval: 'owner conditional G7 approval 2026-09-29', ran_at: new Date().toISOString(), verdict: pass ? 'PASS' : 'FAIL', conditions: c };
mkdirSync('docs/evidence/algo', { recursive: true });
writeFileSync('docs/evidence/algo/golive-preflight.json', `${JSON.stringify(out, null, 2)}\n`);
for (const [k, v] of Object.entries(c)) console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${k}  ${v.detail}`);
console.log(`PREFLIGHT ${out.verdict}`);
process.exitCode = pass ? 0 : 1;
