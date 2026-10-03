#!/usr/bin/env node
// PREMIER LEAGUE MODEL RESEARCH, phase 1 (research only: no live model, no pick, no public number).
// Rules: scripts/research/pl-protocol.mjs (committed first, ad92ef8). Stages run serially:
//   --stage dataset   freeze the exact input rows (published seasons, 2009/10 + 2026/27 excluded) to
//                     docs/evidence/research/pl/dataset.json with its sha256 (the only read of the production store)
//   --stage select    train + dev ONLY: fit mapping parameters on train, choose each family's hyperparameters and
//                     the single candidate on dev. Computes NO holdout metric. Writes select-freeze.json.
//   --stage holdout   refuses unless the protocol and dataset hashes match the freeze AND the select stage reproduces
//                     it exactly; then evaluates the holdout ONCE. Writes holdout-results.json.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { eloSeries, fitOlogit, ologit, poissonSeries, poisson1x2, pOver25 } from './model-core.mjs';
import { dc1x2, dcGrid, fitRho } from './structural-core.mjs';
import { ece } from './metrics.mjs';
import { PROTOCOL } from './pl-protocol.mjs';

const STAGE = process.argv[process.argv.indexOf('--stage') + 1];
const DIR = 'docs/evidence/research/pl'; mkdirSync(DIR, { recursive: true });
const sha = x => createHash('sha256').update(x).digest('hex');
const PROTOCOL_SHA = sha(readFileSync('scripts/research/pl-protocol.mjs'));
const SPLIT = s => (s <= '2001/02' ? 'warmup' : s <= '2012/13' ? 'train' : s <= '2018/19' ? 'dev' : s <= '2025/26' ? 'holdout' : 'live');
const EXCLUDED = new Set(Object.keys(PROTOCOL.data.excluded_seasons));
const eps = 1e-12;
const ll3 = (p, r) => -Math.log(Math.max(eps, p[r]));
const br3 = (p, r) => p.reduce((a, x, i) => a + (x - (i === r ? 1 : 0)) ** 2, 0);
const llb = (p, y) => -Math.log(Math.max(eps, y ? p : 1 - p));
const brb = (p, y) => (p - (y ? 1 : 0)) ** 2;
const r4 = x => Math.round(x * 1e4) / 1e4;

if (STAGE === 'dataset') {
  const { storeFromEnv } = await import('../../workers/shared/postgrest.js');
  const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
  const store = storeFromEnv(env);
  const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: 'premier-league' }, limit: 1 });
  const seasons = (await store.select('soccer_seasons', { columns: ['id', 'label', 'publication_state'], eq: { competition_id: comp.id } }));
  const use = seasons.filter(s => s.publication_state === 'published' && !EXCLUDED.has(s.label));
  const label = new Map(use.map(s => [s.id, s.label]));
  const league = new Set((await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { season_id: use.map(s => s.id) } })).filter(s => s.stage_type === 'league').map(s => s.id));
  const rows = [];
  for (const s of use) for (let off = 0; ; off += 1000) { const part = await store.select('soccer_matches', { columns: ['id', 'season_id', 'stage_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'status'], eq: { season_id: s.id, status: 'finished' }, order: 'kickoff_at.asc', limit: 1000, offset: off }); rows.push(...part); if (part.length < 1000) break; }
  const data = rows.filter(m => league.has(m.stage_id) && Number.isInteger(m.home_score) && Number.isInteger(m.away_score))
    .map(m => ({ id: m.id, season: label.get(m.season_id), kickoff_at: new Date(m.kickoff_at).toISOString(), home: m.home_team_id, away: m.away_team_id, hs: m.home_score, as: m.away_score }))
    .sort((a, b) => a.kickoff_at.localeCompare(b.kickoff_at) || a.id.localeCompare(b.id));
  const body = JSON.stringify(data);
  const perSeason = data.reduce((o, m) => ({ ...o, [m.season]: (o[m.season] || 0) + 1 }), {});
  writeFileSync(`${DIR}/dataset.json`, `${JSON.stringify({ protocol_sha256: PROTOCOL_SHA, created_at: new Date().toISOString(), rows: data.length, seasons: perSeason, excluded: PROTOCOL.data.excluded_seasons, sha256: sha(body), matches: data })}\n`);
  console.log(JSON.stringify({ rows: data.length, seasons: Object.keys(perSeason).length, sha256: sha(body), per_season: perSeason }));
  process.exit(0);
}

// ---------------------------------------------------------------- shared: load the frozen dataset
const ds = JSON.parse(readFileSync(`${DIR}/dataset.json`, 'utf8'));
const DATA_SHA = sha(JSON.stringify(ds.matches));
if (DATA_SHA !== ds.sha256) throw new Error('dataset file does not match its own sha256');
const matches = ds.matches.map(m => ({ id: m.id, season: m.season, t: Date.parse(m.kickoff_at), home_team_id: m.home, away_team_id: m.away, home_score: m.hs, away_score: m.as, r: m.hs > m.as ? 0 : m.hs === m.as ? 1 : 2 }));
const split = matches.map(m => SPLIT(m.season));
const idxOf = s => matches.map((_, i) => i).filter(i => split[i] === s);
const TRAIN = idxOf('train'); const DEV = idxOf('dev'); const HOLD = idxOf('holdout');
const P = PROTOCOL.models;

// baseline B0 from train
const freq = [0, 1, 2].map(r => TRAIN.filter(i => matches[i].r === r).length / TRAIN.length);
const ev = { over_2_5: m => m.home_score + m.away_score > 2, home_to_score: m => m.home_score > 0, away_to_score: m => m.away_score > 0, btts: m => m.home_score > 0 && m.away_score > 0 };
const rate = Object.fromEntries(Object.entries(ev).map(([k, f]) => [k, TRAIN.filter(i => f(matches[i])).length / TRAIN.length]));
const binFrom = (lh, la, grid) => { // binary market probabilities from a score grid (or independent Poisson)
  if (grid) { const { g, S } = grid; let o = 0; let hs = 0; let as = 0; let bt = 0; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = g[i * 11 + j] / S; if (i + j > 2) o += p; if (i > 0) hs += p; if (j > 0) as += p; if (i > 0 && j > 0) bt += p; } return { over_2_5: o, home_to_score: hs, away_to_score: as, btts: bt }; }
  const ph0 = Math.exp(-lh); const pa0 = Math.exp(-la);
  return { over_2_5: pOver25(lh, la), home_to_score: 1 - ph0, away_to_score: 1 - pa0, btts: (1 - ph0) * (1 - pa0) };
};
const ll1x2 = (idx, pred) => idx.reduce((a, i) => a + ll3(pred[i], matches[i].r), 0) / idx.length;

function selectStage() {
  // M1 Elo grid: ordered logit fit on train, scored on dev
  const m1 = [];
  for (const K of P.M1_elo.grid.K) for (const he of P.M1_elo.grid.home_edge) {
    const e = eloSeries(matches, K, he, P.M1_elo.carry);
    const th = fitOlogit(TRAIN.map(i => e[i].d), TRAIN.map(i => matches[i].r));
    const pred = matches.map((_, i) => ologit(e[i].d, th));
    m1.push({ K, home_edge: he, theta: th.map(r4), dev_log_loss: r4(ll1x2(DEV, pred)) });
  }
  // M2 Poisson grid (strict); rows without enough history fall back to B0 for scoring and are counted
  const m2 = [];
  for (const hl of P.M2_poisson.grid.half_life_days) for (const sh of P.M2_poisson.grid.shrink) {
    const po = poissonSeries(matches, hl, sh, { strict: true });
    const pred = matches.map((_, i) => (po[i] ? poisson1x2(po[i].lh, po[i].la) : freq));
    m2.push({ half_life_days: hl, shrink: sh, dev_log_loss: r4(ll1x2(DEV, pred)), dev_without_history: DEV.filter(i => !po[i]).length });
  }
  const best = arr => arr.reduce((b, x) => (x.dev_log_loss < b.dev_log_loss ? x : b));
  const b1 = best(m1); const b2 = best(m2);
  // M3: Dixon-Coles rho fit on train at M2's chosen hyperparameters
  const po = poissonSeries(matches, b2.half_life_days, b2.shrink, { strict: true });
  const rho = fitRho(TRAIN.filter(i => po[i]).map(i => ({ lh: po[i].lh, la: po[i].la, hs: matches[i].home_score, as: matches[i].away_score, home_score: matches[i].home_score, away_score: matches[i].away_score })));
  const rhoV = typeof rho === 'number' ? rho : rho.rho;
  const p3 = matches.map((_, i) => (po[i] ? dc1x2(po[i].lh, po[i].la, rhoV) : freq));
  const b3 = { half_life_days: b2.half_life_days, shrink: b2.shrink, rho: r4(rhoV), dev_log_loss: r4(ll1x2(DEV, p3)) };
  const fam = [['M1_elo', b1], ['M2_poisson', b2], ['M3_poisson_dc', b3]];
  const cand = fam.reduce((b, x) => (x[1].dev_log_loss < b[1].dev_log_loss ? x : b));
  const base = { dev_log_loss: r4(ll1x2(DEV, matches.map(() => freq))) };
  // prediction hash over train+dev rows of the chosen candidate (reproducibility check for the holdout stage)
  const predCand = candidatePreds(cand[0], cand[1]);
  const predHash = sha(JSON.stringify([...TRAIN, ...DEV].map(i => predCand[i].map(r4))));
  return { protocol_sha256: PROTOCOL_SHA, dataset_sha256: DATA_SHA, rows: { warmup: idxOf('warmup').length, train: TRAIN.length, dev: DEV.length, holdout_rows_not_evaluated: HOLD.length }, b0: { freq: freq.map(r4), rates: Object.fromEntries(Object.entries(rate).map(([k, v]) => [k, r4(v)])), ...base }, m1_grid: m1, m2_grid: m2, chosen: { M1_elo: b1, M2_poisson: b2, M3_poisson_dc: b3 }, candidate: { family: cand[0], params: cand[1] }, prediction_hash_train_dev: predHash };
}
function candidatePreds(family, p) {
  if (family === 'M1_elo') { const e = eloSeries(matches, p.K, p.home_edge, P.M1_elo.carry); const th = fitOlogit(TRAIN.map(i => e[i].d), TRAIN.map(i => matches[i].r)); return matches.map((_, i) => ologit(e[i].d, th)); }
  const po = poissonSeries(matches, p.half_life_days, p.shrink, { strict: true });
  if (family === 'M2_poisson') return matches.map((_, i) => (po[i] ? poisson1x2(po[i].lh, po[i].la) : freq));
  return matches.map((_, i) => (po[i] ? dc1x2(po[i].lh, po[i].la, p.rho) : freq));
}

if (STAGE === 'select') {
  const t0 = Date.now(); const f = selectStage();
  writeFileSync(`${DIR}/select-freeze.json`, `${JSON.stringify({ stage: 'select', at: new Date().toISOString(), elapsed_s: Math.round((Date.now() - t0) / 1000), ...f }, null, 1)}\n`);
  console.log(JSON.stringify({ candidate: f.candidate, b0_dev: f.b0.dev_log_loss, chosen: f.chosen, rows: f.rows }, null, 1));
  process.exit(0);
}

if (STAGE === 'holdout') {
  if (!existsSync(`${DIR}/select-freeze.json`)) throw new Error('no select freeze');
  const frozen = JSON.parse(readFileSync(`${DIR}/select-freeze.json`, 'utf8'));
  if (frozen.protocol_sha256 !== PROTOCOL_SHA) throw new Error('REFUSED: protocol changed since the select freeze');
  if (frozen.dataset_sha256 !== DATA_SHA) throw new Error('REFUSED: dataset changed since the select freeze');
  const again = selectStage();
  for (const k of ['candidate', 'chosen', 'prediction_hash_train_dev']) if (JSON.stringify(again[k]) !== JSON.stringify(frozen[k])) throw new Error(`REFUSED: select stage does not reproduce the freeze (${k})`);
  // evaluate the holdout ONCE: every family at its frozen choice + B0, judged: the pre-selected candidate only
  const fams = { B0: matches.map(() => freq), M1_elo: candidatePreds('M1_elo', frozen.chosen.M1_elo), M2_poisson: candidatePreds('M2_poisson', frozen.chosen.M2_poisson), M3_poisson_dc: candidatePreds('M3_poisson_dc', frozen.chosen.M3_poisson_dc) };
  const ch = frozen.chosen.M3_poisson_dc; const po = poissonSeries(matches, ch.half_life_days, ch.shrink, { strict: true });
  const seasons = [...new Set(HOLD.map(i => matches[i].season))];
  const summary = (pred, idx) => ({ n: idx.length, log_loss: r4(ll1x2(idx, pred)), brier: r4(idx.reduce((a, i) => a + br3(pred[i], matches[i].r), 0) / idx.length), accuracy: r4(idx.filter(i => pred[i].indexOf(Math.max(...pred[i])) === matches[i].r).length / idx.length), ece: r4(ece(idx.map(i => ({ p: pred[i], y: matches[i].r })), 'p')) });
  const out = { stage: 'holdout', at: new Date().toISOString(), protocol_sha256: PROTOCOL_SHA, dataset_sha256: DATA_SHA, select_freeze_at: frozen.at, candidate: frozen.candidate, holdout_rows: HOLD.length, holdout_without_poisson_history: HOLD.filter(i => !po[i]).length, seasons, '1x2': {}, per_season: {}, binary: {}, reliability_home: [] };
  for (const [k, pred] of Object.entries(fams)) { out['1x2'][k] = summary(pred, HOLD); out.per_season[k] = Object.fromEntries(seasons.map(s => [s, r4(ll1x2(HOLD.filter(i => matches[i].season === s), pred))])); }
  // binary markets: B0 rates vs Poisson (M2) vs Dixon-Coles (M3) at their frozen choices
  const p2 = poissonSeries(matches, frozen.chosen.M2_poisson.half_life_days, frozen.chosen.M2_poisson.shrink, { strict: true });
  for (const [mk, f] of Object.entries(ev)) {
    const y = i => f(matches[i]);
    const score = getP => ({ log_loss: r4(HOLD.reduce((a, i) => a + llb(getP(i), y(i)), 0) / HOLD.length), brier: r4(HOLD.reduce((a, i) => a + brb(getP(i), y(i)), 0) / HOLD.length) });
    out.binary[mk] = { B0: score(() => rate[mk]), M2_poisson: score(i => (p2[i] ? binFrom(p2[i].lh, p2[i].la)[mk] : rate[mk])), M3_poisson_dc: score(i => (po[i] ? binFrom(null, null, dcGrid(po[i].lh, po[i].la, ch.rho))[mk] : rate[mk])) };
  }
  const cp = fams[frozen.candidate.family];
  for (let b = 0; b < 10; b++) { const xs = HOLD.filter(i => Math.min(9, Math.floor(cp[i][0] * 10)) === b); if (xs.length) out.reliability_home.push({ bin: `${b / 10}-${(b + 1) / 10}`, n: xs.length, predicted: r4(xs.reduce((a, i) => a + cp[i][0], 0) / xs.length), observed: r4(xs.filter(i => matches[i].r === 0).length / xs.length) }); }
  const c = out['1x2'][frozen.candidate.family]; const b0 = out['1x2'].B0;
  const seasonsBeat = seasons.filter(s => out.per_season[frozen.candidate.family][s] < out.per_season.B0[s]).length;
  out.verdict = { candidate: frozen.candidate.family, beats_b0_log_loss: c.log_loss < b0.log_loss, beats_b0_brier: c.brier < b0.brier, seasons_beating_b0: `${seasonsBeat}/${seasons.length}`, pass: c.log_loss < b0.log_loss && c.brier < b0.brier && seasonsBeat >= 5, rule: PROTOCOL.pass_rule };
  writeFileSync(`${DIR}/holdout-results.json`, `${JSON.stringify(out, null, 1)}\n`);
  console.log(JSON.stringify({ verdict: out.verdict, '1x2': out['1x2'], per_season_candidate: out.per_season[frozen.candidate.family], binary: out.binary }, null, 1));
  process.exit(0);
}
throw new Error('usage: --stage dataset | select | holdout');
