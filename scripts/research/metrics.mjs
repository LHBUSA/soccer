// Evaluation metrics shared by the Phase 3 research (same definitions as calibration-research.mjs,
// which stays frozen with the Phase 2 evidence).
import { ll3 } from './model-core.mjs';

export const brier = (p, y) => p.reduce((a, x, i) => a + (x - (i === y ? 1 : 0)) ** 2, 0);
export function eceClass(rows, key, c, bins = 10) {
  let e = 0;
  for (let b = 0; b < bins; b++) {
    const xs = rows.filter(r => Math.min(bins - 1, Math.floor(r[key][c] * bins)) === b);
    if (!xs.length) continue;
    e += (xs.length / rows.length) * Math.abs(xs.reduce((a, r) => a + r[key][c], 0) / xs.length - xs.filter(r => r.y === c).length / xs.length);
  }
  return e;
}
export const ece = (rows, key, bins = 10) => (eceClass(rows, key, 0, bins) + eceClass(rows, key, 1, bins) + eceClass(rows, key, 2, bins)) / 3;
export function auc(scores, labels) {
  const pos = []; const neg = [];
  scores.forEach((s, i) => (labels[i] ? pos : neg).push(s));
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map(s => [s, 1]), ...neg.map(s => [s, 0])].sort((a, b) => a[0] - b[0]);
  let sumPos = 0; let i = 0;
  while (i < all.length) { let j = i; while (j < all.length && all[j][0] === all[i][0]) j++; const avg = (i + j + 1) / 2; for (let k = i; k < j; k++) if (all[k][1]) sumPos += avg; i = j; }
  return (sumPos - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length);
}
const r4 = x => +x.toFixed(4);
export const logLoss = (rows, key) => rows.reduce((a, r) => a + ll3(r[key], r.y), 0) / rows.length;
export function metrics(rows, key) {
  const n = rows.length;
  const argmax = p => p.indexOf(Math.max(...p));
  const conf = [...rows].sort((a, b) => Math.max(...b[key]) - Math.max(...a[key]));
  const top = f => { const xs = conf.slice(0, Math.max(1, Math.round(n * f))); return r4(xs.filter(r => argmax(r[key]) === r.y).length / xs.length); };
  const upsetAuc = auc(rows.map(r => 1 - Math.max(...r[key])), rows.map(r => argmax(r[key]) !== r.y));
  const mean = [0, 1, 2].map(c => rows.reduce((a, r) => a + r[key][c], 0) / n);
  const obs = [0, 1, 2].map(c => rows.filter(r => r.y === c).length / n);
  return {
    n, log_loss: r4(logLoss(rows, key)), log_loss_exact: logLoss(rows, key), brier: r4(rows.reduce((a, r) => a + brier(r[key], r.y), 0) / n), brier_exact: rows.reduce((a, r) => a + brier(r[key], r.y), 0) / n,
    ece: r4(ece(rows, key)), ece_class: [0, 1, 2].map(c => r4(eceClass(rows, key, c))),
    mean_pred: mean.map(r4), observed: obs.map(r4), bias_pts: mean.map((p, i) => +((p - obs[i]) * 100).toFixed(2)),
    auc: [0, 1, 2].map(c => { const v = auc(rows.map(r => r[key][c]), rows.map(r => r.y === c)); return v === null ? null : r4(v); }),
    favourite_accuracy: r4(rows.filter(r => argmax(r[key]) === r.y).length / n), top10_accuracy: top(0.1), top20_accuracy: top(0.2), upset_auc: upsetAuc === null ? null : r4(upsetAuc),
  };
}
export function reliability(rows, key, cls, edges) {
  const out = [];
  for (let b = 0; b < edges.length - 1; b++) {
    const xs = rows.filter(r => r[key][cls] >= edges[b] && r[key][cls] < edges[b + 1]);
    if (xs.length) out.push({ band: `${edges[b]}-${edges[b + 1]}`, n: xs.length, predicted: +(xs.reduce((a, r) => a + r[key][cls], 0) / xs.length).toFixed(4), observed: +(xs.filter(r => r.y === cls).length / xs.length).toFixed(4) });
  }
  return out;
}
