#!/usr/bin/env node
// Soccer Algo V2 REPRODUCTION canary (read-only). The live lane must reproduce the frozen research: build the lane's
// inputs exactly as runAlgoV2 does from PRODUCTION canonical rows (UNL + World Cup, finished with a score, sides with
// an isNational=false provider record excluded), then
//   1. input set: every research dataset row (by ESPN event id) is a canonical input and vice versa, up to the
//      research build time;
//   2. predictions: for every HOLDOUT primary row, the lane-style prediction from canonical inputs equals the frozen
//      research prediction (1X2 + away-to-score, max abs difference <= 1e-9; only summation order may differ).
//   node scripts/canary/algo-v2-reproduction.mjs  -> docs/evidence/research/algo-v2/reproduction-<date>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { ntPredict, marketsFrom } from '../research/national-core.mjs';
import spec from '../../workers/soccer-ingest/src/algo-v2.json' with { type: 'json' };

const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const { manifest, rows } = JSON.parse(readFileSync('docs/evidence/research/algo-v2/national-dataset.json', 'utf8'));
const built = Date.parse(manifest.built_at);
const M = spec.model;

// ---- canonical inputs (lane rules)
const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { slug: spec.input_competitions } });
let ms = [];
for (const c of comps) ms = ms.concat(await store.select('soccer_matches', { columns: ['id', 'competition_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], eq: { competition_id: c.id, status: 'finished' } }));
ms = ms.filter(m => m.home_score !== null && m.away_score !== null);
const flagged = new Set();
for (const part of chunkArr([...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))], 150)) for (const x of await store.select('soccer_team_external_ids', { columns: ['team_id', 'evidence'], eq: { provider: 'espn' }, in: { team_id: part } })) if (/isNational=false/.test(x.evidence || '')) flagged.add(x.team_id);
const nonNational = [];
for (const part of chunkArr([...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))], 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'team_type'], in: { id: part } })) if (t.team_type !== 'national') nonNational.push(t.id);
const inputsAll = ms.filter(m => !flagged.has(m.home_team_id) && !flagged.has(m.away_team_id));
const ev = new Map();
for (const part of chunkArr(inputsAll.map(m => m.id), 150)) for (const x of await store.select('soccer_match_external_ids', { columns: ['match_id', 'external_id'], eq: { provider: 'espn' }, in: { match_id: part } })) ev.set(x.match_id, x.external_id);
const inputs = inputsAll.map(m => ({ id: m.id, key: `espn:${ev.get(m.id)}`, t: Date.parse(m.kickoff_at), home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_score: m.home_score, away_score: m.away_score, neutral: false })).sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));

// ---- 1. input set equality up to the research build time
const canonKeys = new Set(inputs.filter(x => x.t < built).map(x => x.key));
const researchKeys = new Set(rows.map(r => r.match_key));
const missingInCanon = [...researchKeys].filter(k => !canonKeys.has(k));
const extraInCanon = [...canonKeys].filter(k => !researchKeys.has(k));
const scoreDiff = rows.filter(r => { const c = inputs.find(x => x.key === r.match_key); return c && (c.home_score !== r.home_score || c.away_score !== r.away_score); }).map(r => r.match_key);

// ---- 2. predictions on HOLDOUT primary rows
const research = rows.map(r => ({ key: r.match_key, t: Date.parse(r.kickoff_at), home_team_id: r.home_team_id, away_team_id: r.away_team_id, home_score: r.home_score, away_score: r.away_score, neutral: r.neutral_site === true, primary: r.competition_id === 'uefa-nations-league' && r.stage_type === 'group' })).sort((a, b) => a.t - b.t || a.key.localeCompare(b.key));
const hold = research.filter(r => r.t >= Date.parse('2024-09-01T00:00:00Z') && r.primary);
let maxDiff = 0; let compared = 0; const unmatched = [];
for (const r of hold) {
  const c = inputs.find(x => x.key === r.key);
  if (!c) { unmatched.push(r.key); continue; }
  const pr = ntPredict(research, r, { hl: M.half_life_days, k: M.shrink_k });
  const pc = ntPredict(inputs, c, { hl: M.half_life_days, k: M.shrink_k });
  if (!pr || !pc) { unmatched.push(`${r.key}:no-prediction`); continue; }
  const a = marketsFrom(pr.lh, pr.la, M.rho); const b = marketsFrom(pc.lh, pc.la, M.rho);
  for (const k of ['home', 'draw', 'away']) maxDiff = Math.max(maxDiff, Math.abs(a['1x2'][k] - b['1x2'][k]));
  maxDiff = Math.max(maxDiff, Math.abs(a.away_to_score - b.away_to_score));
  compared += 1;
}
const report = {
  generated_at: new Date().toISOString(), mode: 'read-only production canonical', spec_hash: spec.spec_hash, dataset_sha256: manifest.rows_sha256,
  inputs: { canonical_finished: ms.length, excluded_isNational_false_side: ms.length - inputsAll.length, flagged_teams: flagged.size, non_national_teams_in_inputs: nonNational.length, used: inputs.length },
  input_set: { research_rows: researchKeys.size, canonical_before_research_build: canonKeys.size, missing_in_canonical: missingInCanon.length, extra_in_canonical: extraInCanon.length, score_differences: scoreDiff.length, samples: { missing: missingInCanon.slice(0, 10), extra: extraInCanon.slice(0, 10), score: scoreDiff.slice(0, 10) } },
  predictions: { holdout_primary_rows: hold.length, compared, unmatched: unmatched.length, unmatched_samples: unmatched.slice(0, 10), max_abs_difference: maxDiff },
};
report.pass = missingInCanon.length === 0 && extraInCanon.length === 0 && scoreDiff.length === 0 && nonNational.length === 0 && unmatched.length === 0 && compared === hold.length && maxDiff <= 1e-9;
mkdirSync('docs/evidence/research/algo-v2', { recursive: true });
const out = `docs/evidence/research/algo-v2/reproduction-${report.generated_at.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out, 'pass', report.pass, JSON.stringify({ inputs: report.inputs, input_set: { ...report.input_set, samples: undefined }, predictions: { ...report.predictions, unmatched_samples: undefined } }));
