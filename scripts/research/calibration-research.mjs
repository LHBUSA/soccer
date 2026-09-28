#!/usr/bin/env node
// Calibration research on the FROZEN model (no feature changes).
//   node scripts/research/calibration-research.mjs
// Declared BEFORE looking at holdout results:
//   primary model   : chosen on dev in the frozen run (Poisson, dev log loss 0.9973 < Elo 0.9993)
//   calibrators     : fitted on DEV seasons only (2014/15-2018/19); chosen by leave-one-season-out
//                     log loss within dev; ties within 0.0005 go to the simpler method
//   ACCEPT a calibrator only if, on the holdout:
//     (a) pooled log loss AND pooled mean classwise ECE improve over raw,
//     (b) no more than ONE of the 7 holdout seasons gets worse log loss by more than 0.002,
//     (c) ranking is preserved: one-vs-rest AUC for home/draw/away changes by < 0.005 and
//         favourite-identification accuracy changes by < 1 percentage point.
//   SHADOW READY requires: leakage checks pass, the (strict) model beats the baseline in every
//   holdout season on log loss AND Brier, and a calibrator (or raw, if already calibrated
//   within 0.01 mean classwise ECE) meets (a)-(c).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { runFrozen, poissonSeries, eloSeries, FROZEN, SPLIT, ll3 } from './model-core.mjs';

const t0 = Date.now();
const SNAP = 'docs/evidence/research/frozen/bundesliga-results-snapshot.json';
const raw = readFileSync(SNAP, 'utf8');
const matches = JSON.parse(raw).map(m => ({ ...m, t: Date.parse(m.kickoff_at), r: m.home_score > m.away_score ? 0 : m.home_score === m.away_score ? 1 : 2 }));
const sha = s => createHash('sha256').update(s).digest('hex');
const report = { generated_at: new Date().toISOString(), data_sha256: sha(raw), model_id: 'soccer-research-bundesliga-v1-frozen', declared: {
  primary_model: 'poisson (selected on dev in the frozen run)', calibration_fit: 'dev only (2014/15-2018/19)', selection: 'leave-one-season-out log loss within dev; simpler wins ties within 0.0005',
  accept: ['pooled holdout log loss and mean classwise ECE improve', '<= 1 of 7 holdout seasons worse by > 0.002 log loss', 'AUC changes < 0.005 per class and favourite accuracy change < 1 pt'],
} };

// ------------------------------------------------------------------ 1. leakage checks
const v1 = runFrozen(matches, { strict: false });
const v11 = runFrozen(matches, { strict: true });
const byId = rows => new Map(rows.map(r => [r.id, r]));
const A = byId(v1.rows); const B = byId(v11.rows);
let maxDiff = 0; let changed = 0;
for (const [id, r] of A) { const d = Math.max(...r.poisson.map((p, i) => Math.abs(p - B.get(id).poisson[i]))); if (d > 1e-12) changed += 1; if (d > maxDiff) maxDiff = d; }
// Truncation invariance: a match's prediction must be identical when every match at or after
// its kickoff is removed from the data (except the match itself, which is the last element).
function truncationCheck(strict, sampleN = 60) {
  const hold = matches.map((m, i) => i).filter(i => SPLIT(matches[i].season) === 'holdout');
  const step = Math.floor(hold.length / sampleN); let fail = 0; const probes = [];
  for (let k = 0; k < sampleN; k++) {
    const i = hold[k * step]; const m = matches[i];
    const truncated = [...matches.filter(x => x.t < m.t), m];
    const full = poissonSeries(matches.slice(0, i + 1), FROZEN.poisson.half_life_days, FROZEN.poisson.shrink, { strict })[i];
    const trunc = poissonSeries(truncated, FROZEN.poisson.half_life_days, FROZEN.poisson.shrink, { strict }).at(-1);
    const eloFull = eloSeries(matches.slice(0, i + 1), FROZEN.elo.K, FROZEN.elo.home_edge)[i].d;
    const eloTrunc = eloSeries(truncated, FROZEN.elo.K, FROZEN.elo.home_edge).at(-1).d;
    const ok = Math.abs(full.lh - trunc.lh) < 1e-12 && Math.abs(full.la - trunc.la) < 1e-12 && Math.abs(eloFull - eloTrunc) < 1e-9;
    if (!ok) { fail += 1; probes.push({ match: m.id, kickoff: m.kickoff_at, lh_full: full.lh, lh_truncated: trunc.lh }); }
  }
  return { sampled: sampleN, failures: fail, examples: probes.slice(0, 3) };
}
const sameKickoff = matches.filter((m, i) => matches.some((x, j) => j !== i && x.t === m.t)).length;
const dupPairs = new Set(); let dup = 0;
for (const m of matches) { const k = `${m.kickoff_at.slice(0, 10)}|${m.home_team_id}`; if (dupPairs.has(k)) dup += 1; dupPairs.add(k); const k2 = `${m.kickoff_at.slice(0, 10)}|${m.away_team_id}`; if (dupPairs.has(k2)) dup += 1; dupPairs.add(k2); }
report.leakage = {
  same_kickoff_matches: sameKickoff,
  v1_same_kickoff_leak: { matches_with_changed_prediction: changed, max_probability_change: +maxDiff.toFixed(6), note: 'v1 lets simultaneous matches earlier in the list enter the Poisson league averages; v1.1 (strict) removes it' },
  truncation_invariance: { v1: truncationCheck(false), v1_1_strict: truncationCheck(true) },
  team_playing_twice_same_day: dup,
  fitted_on: { ologit: 'train only', poisson_hyperparameters: 'dev (frozen)', baseline: 'train frequencies', calibrators: 'dev only' },
  holdout_touched_for_decisions: false,
};

// ------------------------------------------------------------------ metrics
const brier = (p, y) => p.reduce((a, x, i) => a + (x - (i === y ? 1 : 0)) ** 2, 0);
function ece(rows, key, bins = 10) { // mean classwise expected calibration error
  let tot = 0;
  for (let c = 0; c < 3; c++) {
    let e = 0;
    for (let b = 0; b < bins; b++) {
      const xs = rows.filter(r => Math.min(bins - 1, Math.floor(r[key][c] * bins)) === b);
      if (!xs.length) continue;
      e += (xs.length / rows.length) * Math.abs(xs.reduce((a, r) => a + r[key][c], 0) / xs.length - xs.filter(r => r.y === c).length / xs.length);
    }
    tot += e;
  }
  return tot / 3;
}
function auc(scores, labels) {
  const pos = []; const neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map(s => [s, 1]), ...neg.map(s => [s, 0])].sort((a, b) => a[0] - b[0]);
  let rank = 0; let sumPos = 0; let i = 0;
  while (i < all.length) { let j = i; while (j < all.length && all[j][0] === all[i][0]) j++; const avg = (i + j + 1) / 2; for (let k = i; k < j; k++) if (all[k][1]) sumPos += avg; rank = j; i = j; }
  void rank; return (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
function metrics(rows, key) {
  const n = rows.length;
  const argmax = p => p.indexOf(Math.max(...p));
  const conf = [...rows].sort((a, b) => Math.max(...b[key]) - Math.max(...a[key]));
  const top = f => { const xs = conf.slice(0, Math.max(1, Math.round(n * f))); return +(xs.filter(r => argmax(r[key]) === r.y).length / xs.length).toFixed(4); };
  // upset ranking: does 1 - P(model favourite) rank the matches the favourite failed to win?
  const upsetAuc = auc(rows.map(r => 1 - Math.max(...r[key])), rows.map(r => argmax(r[key]) !== r.y));
  return {
    n, log_loss: +(rows.reduce((a, r) => a + ll3(r[key], r.y), 0) / n).toFixed(4), brier: +(rows.reduce((a, r) => a + brier(r[key], r.y), 0) / n).toFixed(4), ece: +ece(rows, key).toFixed(4),
    mean_pred: [0, 1, 2].map(c => +(rows.reduce((a, r) => a + r[key][c], 0) / n).toFixed(4)), observed: [0, 1, 2].map(c => +(rows.filter(r => r.y === c).length / n).toFixed(4)),
    auc: [0, 1, 2].map(c => { const v = auc(rows.map(r => r[key][c]), rows.map(r => r.y === c)); return v === null ? null : +v.toFixed(4); }),
    favourite_accuracy: +(rows.filter(r => argmax(r[key]) === r.y).length / n).toFixed(4), top10_accuracy: top(0.1), top20_accuracy: top(0.2), upset_auc: upsetAuc === null ? null : +upsetAuc.toFixed(4),
  };
}
function reliability(rows, key, cls, bins = 10) {
  return Array.from({ length: bins }, (_, b) => { const xs = rows.filter(r => Math.min(bins - 1, Math.floor(r[key][cls] * bins)) === b); return xs.length ? { band: `${(b / bins).toFixed(1)}-${((b + 1) / bins).toFixed(1)}`, n: xs.length, predicted: +(xs.reduce((a, r) => a + r[key][cls], 0) / xs.length).toFixed(3), observed: +(xs.filter(r => r.y === cls).length / xs.length).toFixed(3) } : null; }).filter(Boolean);
}

// Use the STRICT (leakage-free) model for everything from here; v1 figures are kept for comparison.
const rows = v11.rows;
const dev = rows.filter(r => r.split === 'dev'); const hold = rows.filter(r => r.split === 'holdout');
const seasonsOf = rs => [...new Set(rs.map(r => r.season))].sort();
report.raw = {
  v1_frozen_holdout: { poisson: metrics(v1.rows.filter(r => r.split === 'holdout'), 'poisson'), elo: metrics(v1.rows.filter(r => r.split === 'holdout'), 'elo'), baseline: metrics(v1.rows.filter(r => r.split === 'holdout'), 'base') },
  v1_1_strict_holdout: { poisson: metrics(hold, 'poisson'), elo: metrics(hold, 'elo'), baseline: metrics(hold, 'base') },
  v1_1_strict_dev: { poisson: metrics(dev, 'poisson'), elo: metrics(dev, 'elo'), baseline: metrics(dev, 'base') },
};

// ------------------------------------------------------------------ 2. diagnostics (raw strict Poisson)
report.diagnostics = {
  by_season: seasonsOf(hold).map(s => { const xs = hold.filter(r => r.season === s); const m = metrics(xs, 'poisson'); return { season: s, n: m.n, predicted_home_draw_away: m.mean_pred, observed_home_draw_away: m.observed, bias_pts: m.mean_pred.map((p, i) => +((p - m.observed[i]) * 100).toFixed(1)), log_loss: m.log_loss, brier: m.brier, ece: m.ece, reliability_home: reliability(xs, 'poisson', 0, 5) }; }),
  pooled_reliability: { home: reliability(hold, 'poisson', 0), draw: reliability(hold, 'poisson', 1), away: reliability(hold, 'poisson', 2) },
};
// bias decomposition
const bias = (xs, key = 'poisson') => [0, 1, 2].map(c => +((xs.reduce((a, r) => a + r[key][c], 0) / xs.length - xs.filter(r => r.y === c).length / xs.length) * 100).toFixed(1));
const devElo = dev.map(r => r.elo_home).sort((a, b) => a - b); const q1 = devElo[Math.floor(devElo.length / 3)]; const q2 = devElo[Math.floor(2 * devElo.length / 3)];
const tier = r => (r.elo_home < q1 ? 'weak home team' : r.elo_home < q2 ? 'mid home team' : 'strong home team');
const fav = r => { const p = Math.max(...r.poisson); return p < 0.45 ? '<0.45' : p < 0.55 ? '0.45-0.55' : p < 0.65 ? '0.55-0.65' : '>=0.65'; };
const group = (f) => Object.fromEntries([...new Set(hold.map(f))].sort().map(k => { const xs = hold.filter(r => f(r) === k); return [k, { n: xs.length, bias_home_draw_away_pts: bias(xs) }]; }));
report.diagnostics.bias = {
  pooled_pts: bias(hold), dev_pooled_pts: bias(dev),
  by_season_pts: Object.fromEntries(seasonsOf(hold).map(s => [s, bias(hold.filter(r => r.season === s))])),
  by_home_team_strength: group(tier), by_favourite_strength: group(fav),
  favourite_is_home_vs_away: group(r => (r.poisson[0] >= r.poisson[2] ? 'home favoured' : 'away favoured')),
};

// ------------------------------------------------------------------ 3. calibrators (dev only)
const lg = p => p.map(x => Math.log(Math.max(1e-12, x)));
const softmax = z => { const m = Math.max(...z); const e = z.map(x => Math.exp(x - m)); const s = e.reduce((a, b) => a + b, 0); return e.map(x => x / s); };
const METHODS = {
  temperature: { n: 1, init: [1], apply: (w, p) => softmax(lg(p).map(z => z / w[0])) },
  bias_shift: { n: 2, init: [0, 0], apply: (w, p) => { const z = lg(p); return softmax([z[0], z[1] + w[0], z[2] + w[1]]); } },
  vector_scaling: { n: 5, init: [1, 1, 1, 0, 0], apply: (w, p) => { const z = lg(p); return softmax([w[0] * z[0], w[1] * z[1] + w[3], w[2] * z[2] + w[4]]); } },
  matrix_scaling_l2: { n: 11, init: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], reg: 0.01, prior: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0], apply: (w, p) => { const z = lg(p); return softmax([0, 1, 2].map(k => w[3 * k] * z[0] + w[3 * k + 1] * z[1] + w[3 * k + 2] * z[2] + (k === 0 ? 0 : w[8 + k]))); } },
};
function fit(method, xs) {
  const M = METHODS[method];
  const loss = w => xs.reduce((a, r) => a + ll3(M.apply(w, r.poisson), r.y), 0) / xs.length + (M.reg ? M.reg * w.reduce((a, v, i) => a + (v - M.prior[i]) ** 2, 0) / w.length : 0);
  let w = [...M.init]; let lr = 0.05; let cur = loss(w);
  for (let it = 0; it < 400; it++) {
    const g = w.map((_, i) => { const h = 1e-5; const w2 = [...w]; w2[i] += h; return (loss(w2) - cur) / h; });
    const cand = w.map((v, i) => v - lr * g[i]); const l = loss(cand);
    if (l < cur) { w = cand; cur = l; lr = Math.min(lr * 1.2, 1); } else lr *= 0.5;
    if (lr < 1e-7) break;
  }
  return { w: w.map(v => +v.toFixed(6)), loss: cur };
}
const devSeasons = seasonsOf(dev);
const loso = {};
for (const method of Object.keys(METHODS)) {
  const perSeason = devSeasons.map(s => { const tr = dev.filter(r => r.season !== s); const te = dev.filter(r => r.season === s); const f = fit(method, tr); return te.reduce((a, r) => a + ll3(METHODS[method].apply(f.w, r.poisson), r.y), 0) / te.length; });
  loso[method] = +(perSeason.reduce((a, b) => a + b, 0) / perSeason.length).toFixed(5);
}
loso.none = +(devSeasons.map(s => { const te = dev.filter(r => r.season === s); return te.reduce((a, r) => a + ll3(r.poisson, r.y), 0) / te.length; }).reduce((a, b) => a + b, 0) / devSeasons.length).toFixed(5);
const order = ['none', 'temperature', 'bias_shift', 'vector_scaling', 'matrix_scaling_l2']; // simplest first
const best = order.reduce((b, m) => (loso[m] < loso[b] - 0.0005 ? m : b), 'none');
report.calibration = { methods_tested: order, isotonic: 'not tested: piecewise-constant per-class isotonic maps break within-match probability coherence and ordering at this sample size (about 1,500 dev matches)', loso_dev_log_loss: loso, selected_on_dev: best, fitted: {} };
for (const m of Object.keys(METHODS)) report.calibration.fitted[m] = fit(m, dev).w;

// Apply every calibrator (fitted on full dev) to the holdout, for transparency; the DECISION uses `best` only.
for (const m of Object.keys(METHODS)) for (const r of rows) r[`cal_${m}`] = METHODS[m].apply(report.calibration.fitted[m], r.poisson);
const evalKeys = ['poisson', ...Object.keys(METHODS).map(m => `cal_${m}`), 'base'];
report.calibrated = { holdout_pooled: Object.fromEntries(evalKeys.map(k => [k, metrics(hold, k)])) };

// ------------------------------------------------------------------ 4/5. ranking + season durability
report.durability = seasonsOf(hold).map(s => { const xs = hold.filter(r => r.season === s); return { season: s, n: xs.length, ...Object.fromEntries(evalKeys.map(k => { const m = metrics(xs, k); return [k, { log_loss: m.log_loss, brier: m.brier, ece: m.ece }]; })) }; });
function verdictFor(key) {
  if (key === 'poisson') return null;
  const R = report.calibrated.holdout_pooled.poisson; const C = report.calibrated.holdout_pooled[key];
  const worse = report.durability.filter(d => d[key].log_loss - d.poisson.log_loss > 0.002).map(d => d.season);
  const aucOk = C.auc.every((v, i) => Math.abs(v - R.auc[i]) < 0.005);
  const favOk = Math.abs(C.favourite_accuracy - R.favourite_accuracy) < 0.01;
  return { pooled_log_loss_improves: C.log_loss < R.log_loss, pooled_ece_improves: C.ece < R.ece, seasons_worse_by_more_than_0_002: worse, ranking_preserved: aucOk && favOk,
    accept: C.log_loss < R.log_loss && C.ece < R.ece && worse.length <= 1 && aucOk && favOk };
}
report.acceptance = Object.fromEntries(Object.keys(METHODS).map(m => [m, verdictFor(`cal_${m}`)]));
const H = report.calibrated.holdout_pooled;
const baselineBeatenEverySeason = report.durability.every(d => d.poisson.log_loss < d.base.log_loss && d.poisson.brier < d.base.brier);
const leakOk = report.leakage.truncation_invariance.v1_1_strict.failures === 0 && report.leakage.team_playing_twice_same_day === 0;
const selectedAccept = best === 'none' ? H.poisson.ece <= 0.01 : report.acceptance[best].accept;
report.verdict = { leakage_ok: leakOk, strict_model_beats_baseline_every_holdout_season: baselineBeatenEverySeason, selected_calibrator: best, selected_calibrator_accepted: selectedAccept,
  result: leakOk && baselineBeatenEverySeason && selectedAccept ? 'SHADOW READY' : leakOk && baselineBeatenEverySeason ? 'MORE RESEARCH' : 'REJECT' };
report.runtime_s = +((Date.now() - t0) / 1000).toFixed(1);
mkdirSync('docs/evidence/research', { recursive: true });
writeFileSync(`docs/evidence/research/calibration-research-${report.generated_at.slice(0, 10)}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ leakage: { v1_changed: report.leakage.v1_same_kickoff_leak, trunc_v1: report.leakage.truncation_invariance.v1.failures, trunc_strict: report.leakage.truncation_invariance.v1_1_strict.failures, dup: dup },
  raw_v1: report.raw.v1_frozen_holdout.poisson.log_loss, raw_strict: { ll: H.poisson.log_loss, brier: H.poisson.brier, ece: H.poisson.ece, mean_pred: H.poisson.mean_pred, observed: H.poisson.observed },
  bias_pooled: report.diagnostics.bias.pooled_pts, dev_bias: report.diagnostics.bias.dev_pooled_pts, loso: report.calibration.loso_dev_log_loss, selected: best,
  pooled: Object.fromEntries(evalKeys.map(k => [k, { ll: H[k].log_loss, brier: H[k].brier, ece: H[k].ece, auc: H[k].auc, fav: H[k].favourite_accuracy }])),
  acceptance: report.acceptance, verdict: report.verdict, runtime_s: report.runtime_s }, null, 1));
