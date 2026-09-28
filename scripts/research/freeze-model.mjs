#!/usr/bin/env node
// 1. Snapshot the exact input data (Bundesliga league-stage finished results) with its hash.
// 2. Re-run the frozen model on the snapshot and prove it reproduces the reported holdout
//    metrics of docs/evidence/research/model-research-2026-09-27.json.
// 3. Record the frozen model card: seasons, features, coefficients, source hashes, prediction hashes.
//   node scripts/research/freeze-model.mjs [--refresh-snapshot]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runFrozen, FROZEN, SPLIT, ll3 } from './model-core.mjs';

const SNAP = 'docs/evidence/research/frozen/bundesliga-results-snapshot.json';
const sha = s => createHash('sha256').update(s).digest('hex');
mkdirSync('docs/evidence/research/frozen', { recursive: true });
if (!existsSync(SNAP) || process.argv.includes('--refresh-snapshot')) {
  const { storeFromEnv } = await import('../../workers/shared/postgrest.js');
  const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
  const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
  const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: 'bundesliga' }, limit: 1 });
  const seasons = new Map((await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: comp.id } })).map(s => [s.id, s.label]));
  const league = new Set((await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { season_id: [...seasons.keys()] } })).filter(s => s.stage_type === 'league').map(s => s.id));
  const ms = (await store.select('soccer_matches', { columns: ['id', 'season_id', 'stage_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'status'], eq: { competition_id: comp.id, status: 'finished' }, order: 'kickoff_at.asc' }))
    .filter(m => m.home_score !== null && m.away_score !== null && league.has(m.stage_id))
    .map(m => ({ id: m.id, season: seasons.get(m.season_id), kickoff_at: new Date(m.kickoff_at).toISOString(), home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_score: m.home_score, away_score: m.away_score }))
    .sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at) || (a.id < b.id ? -1 : 1));
  writeFileSync(SNAP, JSON.stringify(ms) + '\n');
}
const raw = readFileSync(SNAP, 'utf8');
const snapshot = JSON.parse(raw);
// The frozen run sorted by kickoff only (stable DB order within a kickoff); the snapshot keeps
// kickoff then id, and the reproduction below proves the order is equivalent for the metrics.
const matches = snapshot.map(m => ({ ...m, t: Date.parse(m.kickoff_at), r: m.home_score > m.away_score ? 0 : m.home_score === m.away_score ? 1 : 2 }));
const run = runFrozen(matches, { strict: false });
const H = run.rows.filter(r => r.split === 'holdout');
const metric = k => ({ log_loss: +(H.reduce((a, r) => a + ll3(r[k], r.y), 0) / H.length).toFixed(4), brier: +(H.reduce((a, r) => a + r[k].reduce((s, p, i) => s + (p - (i === r.y ? 1 : 0)) ** 2, 0), 0) / H.length).toFixed(4) });
const reported = JSON.parse(readFileSync('docs/evidence/research/model-research-2026-09-27.json', 'utf8')).results.holdout['1x2'];
const got = { baseline: metric('base'), elo_ologit: metric('elo'), poisson: metric('poisson') };
const reproduced = Object.keys(got).every(k => got[k].log_loss === reported[k].log_loss && got[k].brier === reported[k].brier);
const predHash = k => sha(JSON.stringify(run.rows.map(r => [r.id, ...r[k].map(x => +x.toFixed(10))])));
const card = {
  model_id: 'soccer-research-bundesliga-v1-frozen',
  frozen_at: new Date().toISOString(),
  source: { commit: '6fdf692', script: 'scripts/research/model-research.mjs', script_sha256: sha(readFileSync('scripts/research/model-research.mjs', 'utf8')), core: 'scripts/research/model-core.mjs', core_sha256: sha(readFileSync('scripts/research/model-core.mjs', 'utf8')) },
  data: { file: SNAP, sha256: sha(raw), matches: matches.length, first: matches[0].kickoff_at, last: matches[matches.length - 1].kickoff_at, scope: 'Bundesliga league-stage finished results (play-offs excluded), canonical graph' },
  splits: { train: '2004/05-2013/14 (first season warm-up, not evaluated)', dev: '2014/15-2018/19', holdout: '2019/20-2025/26', live: '2026/27 (partial, not used for any decision)' },
  features: {
    elo_ologit: 'pre-match Elo difference (K 10, home edge 60, margin multiplier, 2/3 season carry-over) -> ordered logit fitted on train',
    poisson: 'time-decayed (half-life 540 d, 5 half-life window) home/away league goal rates x team attack and defence ratios shrunk toward the league mean (10 match-equivalents) -> independent Poisson -> 1X2',
  },
  coefficients: { elo_ologit_theta: run.ologit_theta, hyper: FROZEN, baseline_train_frequencies: run.freq },
  reproduction: { reported, recomputed: got, reproduced },
  prediction_hashes: { baseline: predHash('base'), elo_ologit: predHash('elo'), poisson: predHash('poisson'), rows: run.rows.length },
};
writeFileSync('docs/evidence/research/frozen/model-card-v1.json', JSON.stringify(card, null, 2) + '\n');
console.log(JSON.stringify({ reproduced, got, data_sha256: card.data.sha256, prediction_hashes: card.prediction_hashes }, null, 1));
void SPLIT;
