#!/usr/bin/env node
// SOCCER ALGO V2.1 POST-ACTIVATION CANARY (read-only). Every V2 ledger row is checked against the frozen rules
// (docs/evidence/algo/V2-ACCEPTANCE.md), and every forecast is recomputed bit-for-bit from its ARCHIVED input list.
// FAIL -> set ALGO_V2 = "off" in workers/soccer-ingest/wrangler.toml, release soccer-ingest, report before touching logic.
//   node scripts/algo/v2-postactivation-canary.mjs   -> docs/evidence/algo/v2-postactivation-canary.json
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { payloadKey } from '../../workers/shared/archive.js';
import { v2Forecast, ALGO_V2_SPEC as spec, ALGO_V2_DATASET as dataset } from '../../workers/soccer-ingest/src/algo-v2-lane.js';
import { inputHash } from '../../workers/soccer-ingest/src/shadow-lane.js';

const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const store = storeFromEnv(env);
const V = spec.algo_version; const LOCK = spec.lead_time.lock_minutes_before_kickoff * 60e3; const WIN = spec.lead_time.issue_window_days * 864e5;
const fail = []; const bad = (check, detail) => fail.push({ check, ...detail });

const events = await store.select('soccer_algo_events', { columns: ['at', 'event', 'match_id', 'detail'], eq: { algo_version: V }, order: 'at.asc' });
const started = events.find(e => e.event === 'started');
if (!started) bad('no_started_event', {});
const activationAt = started ? Date.parse(started.at) : Infinity;
const fcs = await store.select('soccer_algo_forecasts', { columns: ['id', 'match_id', 'issued_at', 'kickoff_at', 'input_hash', 'input_count', 'input_as_of', 'lambda_home', 'lambda_away', 'probabilities', 'game_best', 'algo_version', 'spec_hash', 'model_hash', 'competition_id'], eq: { algo_version: V }, order: 'kickoff_at.asc' });
const picks = await store.select('soccer_algo_picks', { columns: ['record_no', 'match_id', 'market', 'selection', 'model_probability', 'threshold', 'issued_at', 'lock_at', 'kickoff_at', 'status', 'algo_version', 'input_hash'], eq: { algo_version: V }, order: 'record_no.asc' });

// scope: Nations League league phase, kicking off after activation
const [unl] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: spec.competition_scope.competition_slug } });
const ms = fcs.length ? await store.select('soccer_matches', { columns: ['id', 'competition_id', 'stage_id', 'kickoff_at', 'status'], in: { id: fcs.map(f => f.match_id) } }) : [];
const st = ms.length ? await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { id: [...new Set(ms.map(m => m.stage_id))] } }) : [];
const stageType = new Map(st.map(s => [s.id, s.stage_type])); const match = new Map(ms.map(m => [m.id, m]));
const seen = new Set();
for (const f of fcs) {
  const m = match.get(f.match_id); const tag = { match_id: f.match_id };
  if (seen.has(f.match_id)) bad('duplicate_forecast', tag); seen.add(f.match_id);
  if (!m || m.competition_id !== unl.id || stageType.get(m.stage_id) !== spec.competition_scope.stage_type) bad('out_of_scope', tag);
  if (Date.parse(f.kickoff_at) <= activationAt) bad('kickoff_not_after_activation', tag);
  if (Date.parse(f.issued_at) < activationAt) bad('issued_before_activation', tag);
  if (Date.parse(f.issued_at) > Date.parse(f.kickoff_at) - LOCK) bad('issued_after_lock', tag);
  if (Date.parse(f.kickoff_at) - Date.parse(f.issued_at) > WIN) bad('issued_before_window', tag);
  if (f.algo_version !== V || f.spec_hash !== spec.spec_hash || f.model_hash !== spec.model.model_hash) bad('version_or_hash_mismatch', tag);
  if (Date.parse(f.input_as_of) >= Date.parse(f.issued_at)) bad('future_input', tag);
}
// archived inputs: membership, as-of, hash, and bit-for-bit recompute of every forecast
const frozenIds = new Set(dataset.match_ids); const frozenAt = Date.parse(dataset.frozen_at);
const hashes = [...new Set(fcs.map(f => f.input_hash))]; const inputs = new Map();
for (const h of hashes) {
  const file = join(tmpdir(), `v2-canary-${h}.json`);
  if (!existsSync(file)) { try { execFileSync('npx', ['wrangler', 'r2', 'object', 'get', `soccer-source/${payloadKey('algo_inputs', h)}`, '--remote', '--file', file], { cwd: 'workers/soccer-ingest', stdio: 'pipe', shell: true, env: { ...process.env, NODE_OPTIONS: '--require D:/Workers/exfat-readlink.cjs' } }); } catch { bad('input_archive_missing', { input_hash: h }); continue; } }
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const rows = doc.inputs.map(([id, kickoff_at, home_team_id, away_team_id, home_score, away_score, neutral]) => ({ id, kickoff_at, t: Date.parse(kickoff_at), home_team_id, away_team_id, home_score, away_score, neutral }));
  if ((await inputHash(rows)) !== h) bad('input_hash_mismatch', { input_hash: h });
  const nonMember = rows.filter(r => !frozenIds.has(r.id) && r.t <= frozenAt);
  if (nonMember.length) bad('historical_non_member_input', { input_hash: h, count: nonMember.length });
  inputs.set(h, rows);
}
const neutral = new Map(events.filter(e => e.event === 'forecast').map(e => [e.match_id, e.detail?.neutral === true]));
let reproduced = 0; let exact = 0; let maxDiff = 0;
for (const f of fcs) {
  const rows = inputs.get(f.input_hash); if (!rows) continue;
  const issued = Date.parse(f.issued_at);
  if (rows.some(r => r.t >= issued)) bad('input_not_before_issue', { match_id: f.match_id });
  const fc = v2Forecast(rows, { kickoff_at: f.kickoff_at, ...(await teamsOf(f.match_id)), neutral: neutral.get(f.match_id) === true });
  // Reproduction rule: every Game Best / Official Pick DECISION identical, every probability within 1e-12. Exact
  // equality is counted and reported: Cloudflare Workers and local Node may round Math.exp/pow differently by one ulp
  // (2026-10-03 activation: 28/33 exact, max 1.1e-16, all decisions identical). jsonb reorders keys: compare by value.
  if (!fc) { bad('forecast_not_reproduced', { match_id: f.match_id, reason: 'no forecast recomputed' }); continue; }
  const flat = p => [p['1x2'].home, p['1x2'].draw, p['1x2'].away, p.over_2_5, p.home_to_score, p.away_to_score, p.btts];
  const A = flat(f.probabilities); const B = flat(fc.probabilities);
  const diff = Math.max(...A.map((x, i) => Math.abs(x - B[i])));
  maxDiff = Math.max(maxDiff, diff); if (diff === 0) exact++;
  const g1 = f.game_best; const g2 = fc.game_best;
  const decision = g1.market === g2.market && g1.selection === g2.selection && g1.qualifies === g2.qualifies;
  if (decision && diff <= 1e-12) reproduced++; else bad('forecast_not_reproduced', { match_id: f.match_id, max_abs_difference: diff, decision_identical: decision });
}
function canon(v) { return JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x)); }
async function teamsOf(id) { const [m] = await store.select('soccer_matches', { columns: ['home_team_id', 'away_team_id'], eq: { id } }); return m; }
// picks: market, threshold, one per match, lock, equals its forecast
const fcBy = new Map(fcs.map(f => [f.match_id, f])); const pickSeen = new Set();
for (const p of picks) {
  const tag = { record_no: Number(p.record_no), match_id: p.match_id }; const f = fcBy.get(p.match_id);
  if (pickSeen.has(p.match_id)) bad('more_than_one_pick_per_match', tag); pickSeen.add(p.match_id);
  if (!(p.market in spec.pick_policy.markets)) bad('inactive_market', tag);
  if (Number(p.threshold) !== spec.pick_policy.markets[p.market]?.threshold || Number(p.model_probability) < Number(p.threshold)) bad('below_threshold', tag);
  if (Date.parse(p.lock_at) !== Date.parse(p.kickoff_at) - LOCK) bad('lock_not_kickoff_minus_60', tag);
  if (Date.parse(p.issued_at) >= Date.parse(p.lock_at)) bad('issued_after_lock', tag);
  if (!f || f.input_hash !== p.input_hash) bad('pick_without_matching_forecast', tag);
  else { const prob = p.selection === 'yes' ? f.probabilities[p.market] : 1 - f.probabilities[p.market]; if (Math.abs(prob - Number(p.model_probability)) > 1e-9) bad('pick_probability_differs_from_forecast', tag); }
  if (p.status !== 'pending' && Date.parse(p.kickoff_at) > Date.now()) bad('future_pick_settled', tag);
}
// every forecast whose active market qualifies has its pick (none missing)
for (const f of fcs) { const q = Object.entries(spec.pick_policy.markets).some(([mk, x]) => Math.max(f.probabilities[mk], 1 - f.probabilities[mk]) >= x.threshold); if (q && !pickSeen.has(f.match_id)) bad('qualifying_forecast_without_pick', { match_id: f.match_id }); }
const v1 = { forecasts: (await store.select('soccer_algo_forecasts', { columns: ['id'], eq: { algo_version: 'soccer-algo-v1.0.0' } })).length, picks: (await store.select('soccer_algo_picks', { columns: ['record_no'], eq: { algo_version: 'soccer-algo-v1.0.0' } })).map(p => Number(p.record_no)) };
const out = { at: new Date().toISOString(), algo_version: V, activation_at: started?.at || null, forecasts: fcs.length, official_picks: picks.length, holds: events.filter(e => e.event === 'hold').length, reproduced_within_1e12_decisions_identical: `${reproduced}/${fcs.length}`, probabilities_bit_exact: `${exact}/${fcs.length}`, max_abs_probability_difference: maxDiff, input_hashes: hashes, ledger_ids: picks.map(p => Number(p.record_no)), public_record_numbers: picks.map((_, i) => i + 1), settlement: picks.reduce((o, p) => ({ ...o, [p.status]: (o[p.status] || 0) + 1 }), {}), v1_ledger: v1, checks_failed: fail, pass: fail.length === 0 };
mkdirSync('docs/evidence/algo', { recursive: true });
writeFileSync('docs/evidence/algo/v2-postactivation-canary.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
