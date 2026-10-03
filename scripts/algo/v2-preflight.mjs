#!/usr/bin/env node
// SOCCER ALGO V2 PRE-ACTIVATION PREFLIGHT (read-only; nothing is written to the database, R2 or KV).
// V2 (soccer-algo-v2.1.0, spec status 'official') has never run in production and has no shadow lane, so there are no
// stored V2 forecasts for scripts/algo/reproduction-canary.mjs to verify. This preflight proves everything that CAN be
// proven before the first forecast, by running the production lane code (runAlgoV2) against production reads with
// every write captured in memory:
//   1. frozen membership: algo-v2-dataset.json ids hash to the recorded match_ids_sha256; spec hash / model hash /
//      model code sha unchanged
//   2. history inputs complete: every frozen member exists, and every past member is finished with a final score (or
//      void); no member is held for prior_result_unavailable
//   3. no contamination: no non-member historical match (e.g. a season backfilled after the freeze) enters the inputs;
//      every post-freeze input kicked off after frozen_at
//   4. reproduction: two independent dry runs (fresh module state, same clock) produce bit-for-bit identical forecasts,
//      input hashes and Official Pick decisions
//   5. lane outcome: what the first production run would issue (forecasts, picks, holds by reason)
// Activation itself stays an owner sign-off (as V1's G7): this script never changes ALGO_V2.
//   node scripts/algo/v2-preflight.mjs [--now 2026-10-03T02:00:00Z]
// Writes docs/evidence/algo/v2-preflight.json; exit 1 unless every invariant passes.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { storeFromEnv } from '../../workers/shared/postgrest.js';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const NOW = Date.parse(arg('--now') || new Date().toISOString());
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const real = storeFromEnv(env);
const CACHE = 'D:/Temp/claude/algo-v2-preflight-r2'; mkdirSync(CACHE, { recursive: true });

// read-through store: selects hit production, every write is captured and never sent
function dryStore() {
  const writes = [];
  const w = op => async (table, rows, opts) => { writes.push({ op, table, rows: structuredClone(rows), opts }); return rows; };
  return { writes, store: new Proxy(real, { get: (t, k) => (['insert', 'upsert', 'update', 'delete', 'rpc'].includes(k) ? w(k) : typeof t[k] === 'function' ? t[k].bind(t) : t[k]) }) };
}
// read-only R2 (archived ESPN captures for neutral-site flags), cached on disk between runs
const storage = {
  async get(key) {
    const f = join(CACHE, createHash('sha256').update(key).digest('hex'));
    if (!existsSync(f)) { try { execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `soccer-source/${key}`, '--remote', '--file', f], { cwd: 'workers/soccer-ingest', stdio: 'pipe', shell: true, env: { ...process.env, NODE_OPTIONS: '--require D:/Workers/exfat-readlink.cjs' } }); } catch { return null; } }
    return new Uint8Array(readFileSync(f));
  },
  puts: [],
  async head() { return false; },
  async put(key, body) { this.puts.push({ key, body: JSON.parse(body) }); }, // captured in memory, never sent to R2
};

const fail = []; const out = { at: new Date().toISOString(), now: new Date(NOW).toISOString() };
const lanePath = '../../workers/soccer-ingest/src/algo-v2-lane.js';
const spec = JSON.parse(readFileSync('workers/soccer-ingest/src/algo-v2.json', 'utf8'));
const dataset = JSON.parse(readFileSync('workers/soccer-ingest/src/algo-v2-dataset.json', 'utf8'));

// 1. frozen membership + spec
const idsSha = createHash('sha256').update(dataset.match_ids.join('\n')).digest('hex');
const codeSha = createHash('sha256').update(readFileSync(spec.model.code.path)).digest('hex');
out.frozen = { match_ids: dataset.match_ids.length, ids_sha256: idsSha, recorded: dataset.match_ids_sha256, frozen_at: dataset.frozen_at, spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, model_code_sha256: codeSha, status: spec.status, algo_version: spec.algo_version };
if (idsSha !== dataset.match_ids_sha256) fail.push({ check: 'frozen_membership_changed', ids_sha256: idsSha, recorded: dataset.match_ids_sha256 });
if (codeSha !== spec.model.code.sha256) fail.push({ check: 'model_code_changed', found: codeSha, frozen: spec.model.code.sha256 });
if (spec.spec_hash !== '53e6b8d7' && !spec.spec_hash.startsWith('53e6b8d7')) fail.push({ check: 'spec_hash_changed', found: spec.spec_hash });
if (spec.model.model_hash !== '4c40fa9c020073c3dfeb42dd8b286940b9989c44035e8d08bb4a46ca8f984002') fail.push({ check: 'model_hash_changed', found: spec.model.model_hash });

// 2. history inputs complete (every frozen member, read from production)
const members = [];
for (let i = 0; i < dataset.match_ids.length; i += 100) members.push(...await real.select('soccer_matches', { columns: ['id', 'kickoff_at', 'status', 'home_score', 'away_score'], in: { id: dataset.match_ids.slice(i, i + 100) } }));
const missing = dataset.match_ids.filter(id => !members.some(m => m.id === id));
const VOID = new Set(['postponed', 'cancelled', 'abandoned']);
const incomplete = members.filter(m => Date.parse(m.kickoff_at) < NOW && !VOID.has(m.status) && (m.status !== 'finished' || m.home_score === null || m.away_score === null));
out.history = { members_found: members.length, missing: missing.length, past_without_final_score: incomplete.length, sample: incomplete.slice(0, 5).map(m => `${m.id}:${m.status}`) };
if (missing.length) fail.push({ check: 'frozen_member_missing', count: missing.length, ids: missing.slice(0, 10) });
if (incomplete.length) fail.push({ check: 'history_inputs_incomplete', count: incomplete.length, sample: out.history.sample });

// 3 + 4 + 5. two independent dry runs of the production lane code
async function dryRun(tag) {
  const mod = await import(`${lanePath}?run=${tag}`);
  const { writes, store } = dryStore();
  const res = await mod.runAlgoV2({ store, storage, kv: null, now: NOW, force: true, env: { ALGO_V2: 'on' } });
  const forecasts = writes.filter(w => w.table === 'soccer_algo_forecasts').flatMap(w => w.rows).map(({ id, ...r }) => r);
  const picks = writes.filter(w => w.table === 'soccer_algo_picks').flatMap(w => w.rows).map(({ id, forecast_id, ...r }) => r);
  return { res, forecasts, picks, writes: writes.map(w => `${w.op}:${w.table}:${Array.isArray(w.rows) ? w.rows.length : 1}`), v2Member: mod.v2Member };
}
const A = await dryRun('a'); const B = await dryRun('b');
const canon = x => JSON.stringify(x);
out.reproduction = { run_a: { forecasts: A.forecasts.length, picks: A.picks.length }, run_b: { forecasts: B.forecasts.length, picks: B.picks.length }, identical: canon(A.forecasts) === canon(B.forecasts) && canon(A.picks) === canon(B.picks) };
if (!out.reproduction.identical) fail.push({ check: 'reproduction_not_bit_for_bit' });
out.lane = { result: A.res.results ?? A.res, writes_captured: A.writes, forecasts: A.forecasts.map(f => ({ match_id: f.match_id, kickoff_at: f.kickoff_at, input_hash: f.input_hash, input_count: f.input_count, input_as_of: f.input_as_of, game_best: f.game_best })), picks: A.picks.map(p => ({ match_id: p.match_id, market: p.market, selection: p.selection, probability: p.probability, threshold: p.threshold, lock_at: p.lock_at })) };
const holds = A.writes.length ? (A.res.results?.holds ?? null) : null;
if (A.res.skipped) fail.push({ check: 'lane_skipped', reason: A.res.skipped });
const heldUnavailable = JSON.stringify(A.res).includes('prior_result_unavailable');
if (heldUnavailable) fail.push({ check: 'lane_holds_prior_result_unavailable' });
// contamination: the inputs the lane used must all be members (frozen id or kickoff after frozen_at)
const inputHashes = [...new Set(A.forecasts.map(f => f.input_hash))];
const frozenIds = new Set(dataset.match_ids); const frozenAt = Date.parse(dataset.frozen_at);
const inputDocs = storage.puts.filter(p => p.body.algo_version === spec.algo_version);
const usedInputs = inputDocs.length ? inputDocs[0].body.inputs : [];
const contaminated = usedInputs.filter(([id, kickoff]) => !frozenIds.has(id) && Date.parse(kickoff) <= frozenAt);
const postFreeze = usedInputs.filter(([id, kickoff]) => !frozenIds.has(id) && Date.parse(kickoff) > frozenAt);
const recomputed = inputDocs.length ? createHash('sha256').update(JSON.stringify(inputDocs[0].body.inputs)).digest('hex') : null;
if (contaminated.length) fail.push({ check: 'historical_non_member_in_inputs', count: contaminated.length, ids: contaminated.slice(0, 10).map(x => x[0]) });
if (postFreeze.some(([, k]) => Date.parse(k) >= NOW)) fail.push({ check: 'post_freeze_input_not_before_issue' });
out.contamination = { inputs_used: usedInputs.length, frozen_members_used: usedInputs.filter(([id]) => frozenIds.has(id)).length, post_freeze_inputs: postFreeze.length, historical_non_members: contaminated.length, input_hashes: inputHashes, input_count: A.forecasts[0]?.input_count ?? null, input_as_of: A.forecasts[0]?.input_as_of ?? null };
if (inputHashes.length > 1) fail.push({ check: 'multiple_input_sets_in_one_run', hashes: inputHashes });
const asOf = A.forecasts[0]?.input_as_of;
if (asOf && Date.parse(asOf) > NOW) fail.push({ check: 'input_after_issue_time', input_as_of: asOf });
out.checks_failed = fail; out.pass = fail.length === 0; out.holds = holds;
mkdirSync('docs/evidence/algo', { recursive: true });
writeFileSync('docs/evidence/algo/v2-preflight.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify({ pass: out.pass, failed: fail.map(f => f.check), frozen: { ids: out.frozen.match_ids, sha_ok: idsSha === dataset.match_ids_sha256 }, history: out.history, reproduction: out.reproduction, forecasts: out.lane.forecasts.length, picks: out.lane.picks.length, contamination: out.contamination }, null, 1));
process.exit(out.pass ? 0 : 1);
