// Soccer Algo V1 REPRODUCTION CANARY (read-only). For every stored forecast, fetch the exact input list from the
// write-once R2 archive, verify sha256(inputs) = the stored input_hash, recompute with the frozen Algo forecast
// (workers/soccer-ingest/src/algo-lane.js) and require bit-for-bit equality with what was stored.
//   node scripts/algo/reproduction-canary.mjs --source algo     Official Algo forecasts + picks (after go-live)
//   node scripts/algo/reproduction-canary.mjs --source shadow   production shadow lane (same frozen model; pre-live proof)
// Writes docs/evidence/algo/reproduction-canary-<source>.json. Exit 1 on any mismatch.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { payloadKey } from '../../workers/shared/archive.js';
import { algoForecast, decide, ALGO_SPEC as spec } from '../../workers/soccer-ingest/src/algo-lane.js';
import { inputHash } from '../../workers/soccer-ingest/src/shadow-lane.js';

const source = process.argv.includes('--source') ? process.argv[process.argv.indexOf('--source') + 1] : 'algo';
if (!['algo', 'shadow'].includes(source)) throw new Error('--source algo|shadow');
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const BUCKET = 'soccer-source';
const cache = new Map();
function archived(family, hash) {
  if (cache.has(hash)) return cache.get(hash);
  const file = join(tmpdir(), `algo-canary-${hash}.json`);
  // read-only R2 get through wrangler (the account's own OAuth session); never a write
  execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `${BUCKET}/${payloadKey(family, hash)}`, '--remote', '--file', file], { cwd: 'workers/soccer-ingest', stdio: 'pipe', shell: true });
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  cache.set(hash, doc);
  return doc;
}
const toInputs = doc => doc.inputs.map(([id, kickoff_at, home_team_id, away_team_id, home_score, away_score]) => ({ id, kickoff_at, t: Date.parse(kickoff_at), home_team_id, away_team_id, home_score, away_score }));

const rows = source === 'algo'
  ? await store.select('soccer_algo_forecasts', { columns: ['id', 'match_id', 'kickoff_at', 'input_hash', 'input_count', 'lambda_home', 'lambda_away', 'probabilities', 'game_best', 'algo_version', 'spec_hash'], eq: { algo_version: spec.algo_version }, order: 'kickoff_at.asc' })
  : await store.select('soccer_model_shadow_predictions', { columns: ['id', 'match_id', 'kickoff_at', 'input_hash', 'input_count', 'lambda_home', 'lambda_away', 'p_home', 'p_draw', 'p_away', 'model_hash'], order: 'kickoff_at.asc' });
const picks = source === 'algo' ? new Map((await store.select('soccer_algo_picks', { columns: ['match_id', 'record_no', 'market', 'selection', 'model_probability', 'input_hash'], eq: { algo_version: spec.algo_version } })).map(p => [p.match_id, p])) : new Map();
const matches = new Map();
for (let i = 0; i < rows.length; i += 150) for (const m of await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id'], in: { id: rows.slice(i, i + 150).map(r => r.match_id) } })) matches.set(m.id, m);

const results = [];
for (const r of rows) {
  const m = matches.get(r.match_id);
  const doc = archived(source === 'algo' ? 'algo_inputs' : 'model_shadow_inputs', r.input_hash);
  const inputs = toInputs(doc);
  const checks = { archive_hash: inputHash(inputs) === r.input_hash, input_count: inputs.length === r.input_count };
  const f = algoForecast(inputs, { kickoff_at: new Date(r.kickoff_at).toISOString(), home_team_id: m.home_team_id, away_team_id: m.away_team_id });
  checks.lambdas = f.lambda_home === r.lambda_home && f.lambda_away === r.lambda_away;
  if (source === 'algo') {
    checks.probabilities = JSON.stringify(f.probabilities) === JSON.stringify(r.probabilities);
    checks.game_best = JSON.stringify(f.game_best) === JSON.stringify(r.game_best);
    const p = picks.get(r.match_id);
    checks.official_pick = p ? Boolean(f.official) && f.official.market === p.market && f.official.selection === p.selection && f.official.probability === p.model_probability && p.input_hash === r.input_hash : !f.official;
  } else {
    const v = f.probabilities['1x2'];
    checks.probabilities = v.home === r.p_home && v.draw === r.p_draw && v.away === r.p_away;
  }
  const ok = Object.values(checks).every(Boolean);
  results.push({ match_id: r.match_id, kickoff_at: r.kickoff_at, input_hash: r.input_hash, ok, checks, ...(source === 'shadow' ? { algo_decision_now: decide(f.probabilities).game_best } : { record_no: picks.get(r.match_id)?.record_no ?? null }) });
}
const failed = results.filter(x => !x.ok);
const out = { canary: 'soccer-algo-reproduction', source, algo_version: spec.algo_version, spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, ran_at: new Date().toISOString(), forecasts: results.length, archives: cache.size, passed: results.length - failed.length, failed: failed.length, verdict: results.length && !failed.length ? 'PASS' : results.length ? 'FAIL' : 'NO_FORECASTS', results };
mkdirSync('docs/evidence/algo', { recursive: true });
writeFileSync(`docs/evidence/algo/reproduction-canary-${source}.json`, `${JSON.stringify(out, null, 2)}\n`);
console.log(`${out.verdict}: ${out.passed}/${out.forecasts} forecasts reproduced bit-for-bit from ${out.archives} archived input lists (${source})`);
for (const f of failed.slice(0, 10)) console.log('MISMATCH', f.match_id, JSON.stringify(f.checks));
process.exitCode = out.verdict === 'FAIL' ? 1 : 0;
