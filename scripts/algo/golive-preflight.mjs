// Soccer Algo V1 POST-ACTIVATION VERIFICATION (read-only; every database write happens inside a transaction that is
// rolled back). V1 went live on owner G7 sign-off 2026-09-29; this is a production verification requirement, not a
// publication gate. Run on/after 2026-10-02 18:30 UTC once the first real forecast exists:
//   1. the production shadow lane has >= 1 real forecast
//   2. reproduction-canary --source shadow = PASS (and --source algo once Algo forecasts exist)
//   3. every archived input hash matches        (inside the canaries)
//   4. every recomputed forecast is bit-for-bit (inside the canaries)
//   5. no spec / model / pick-policy drift from the frozen versions
//   6. all ledger guards intact (checks-1200 re-run against production, rolled back)
//   7. nothing seeded: no forecast/pick issued before activation, record numbers start at #1 with no gaps,
//      every pick issued before its lock
// FAIL -> immediately set ALGO_OFFICIAL = "off" in workers/soccer-ingest/wrangler.toml, release soccer-ingest,
// and report the exact mismatch (docs/evidence/algo/golive-preflight.json).
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
// The live Algo ledger's own forecasts are verified the same way as soon as any exist (NO_FORECASTS = not yet due).
const canA = node(['scripts/algo/reproduction-canary.mjs', '--source', 'algo']);
const reportA = JSON.parse(readFileSync('docs/evidence/algo/reproduction-canary-algo.json', 'utf8'));
const algoOk = reportA.verdict === 'PASS' || reportA.verdict === 'NO_FORECASTS';
const both = [...report.results, ...reportA.results];
const mismatches = both.filter(r => !r.ok).map(r => ({ match_id: r.match_id, input_hash: r.input_hash, checks: r.checks }));
c['2_canary_pass'] = { ok: can.status === 0 && report.verdict === 'PASS' && canA.status === 0 && algoOk, detail: `shadow: ${can.stdout.trim().split('\n')[0]} | algo: ${canA.stdout.trim().split('\n')[0]}`, mismatches };
c['3_input_hash'] = { ok: report.results.length > 0 && both.every(r => r.checks.archive_hash && r.checks.input_count), detail: `${both.filter(r => r.checks.archive_hash).length}/${both.length} archive hashes match` };
c['4_bit_for_bit'] = { ok: report.results.length > 0 && both.every(r => Object.entries(r.checks).filter(([k]) => !['archive_hash', 'input_count'].includes(k)).every(([, v]) => v)), detail: `${both.filter(r => r.ok).length}/${both.length} recomputed exactly` };

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

// Nothing seeded: activation = the first 'started' event; every forecast and pick was issued at/after it, record
// numbers are 1..n with no gap, and every pick was issued at or before its lock (lock = kickoff - 60 min).
const [started] = await store.select('soccer_algo_events', { columns: ['at'], eq: { algo_version: spec.algo_version, event: 'started' }, order: 'at.asc', limit: 1 });
const fcs = await store.select('soccer_algo_forecasts', { columns: ['issued_at'] });
const pks = await store.select('soccer_algo_picks', { columns: ['record_no', 'issued_at', 'lock_at', 'kickoff_at'], order: 'record_no.asc' });
const t0 = started ? Date.parse(started.at) : Infinity;
const seeded = [...fcs, ...pks].filter(r => Date.parse(r.issued_at) < t0).length;
const gapless = pks.every((p, i) => Number(p.record_no) === i + 1);
const lockOk = pks.every(p => Date.parse(p.issued_at) <= Date.parse(p.lock_at) && Date.parse(p.kickoff_at) - Date.parse(p.lock_at) === 60 * 60e3);
c['7_nothing_seeded'] = { ok: seeded === 0 && gapless && lockOk && (fcs.length === 0 || Boolean(started)), detail: `activated ${started?.at || 'n/a'}; ${fcs.length} forecasts, ${pks.length} picks; issued before activation: ${seeded}; record numbers 1..n: ${gapless}; issued <= lock = kickoff-60m: ${lockOk}` };

const pass = Object.values(c).every(x => x.ok);
const out = { preflight: 'soccer-algo-v1-post-activation-verification', approval: 'owner G7 sign-off 2026-09-29 (canary = post-activation verification, not a publication gate)', ran_at: new Date().toISOString(), verdict: pass ? 'PASS' : 'FAIL', conditions: c };
mkdirSync('docs/evidence/algo', { recursive: true });
writeFileSync('docs/evidence/algo/golive-preflight.json', `${JSON.stringify(out, null, 2)}\n`);
for (const [k, v] of Object.entries(c)) console.log(`${v.ok ? 'PASS' : 'FAIL'}  ${k}  ${v.detail}`);
console.log(`PREFLIGHT ${out.verdict}`);
process.exitCode = pass ? 0 : 1;
