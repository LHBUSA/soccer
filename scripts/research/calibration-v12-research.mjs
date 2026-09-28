#!/usr/bin/env node
// Phase 4: calibration of the frozen Dixon-Coles model soccer-research-bundesliga-v1.2-dc.
// Rules: scripts/research/phase4-protocol.mjs (declared and committed first).
//   node scripts/research/calibration-v12-research.mjs --stage dev
//       reproduction + leakage gates, DEV leave-one-season-out selection, DEV-only final fits and
//       calibrated prediction hashes. Computes NO holdout metric. Writes phase4/dev-selection.json.
//   node scripts/research/calibration-v12-research.mjs --stage holdout [--dry-run-on-dev --out <file>]
//       refuses to run unless the protocol hash, the DEV selection, the parameters and every
//       prediction hash reproduce exactly; then evaluates and applies the keep rule.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { poissonSeries, eloSeries, SPLIT, ll3 } from './model-core.mjs';
import { structuralSeries, predictFrom, dc1x2 } from './structural-core.mjs';
import { metrics, eceClass, ece, auc, brier, reliability } from './metrics.mjs';
import { PROTOCOL } from './phase4-protocol.mjs';

const t0 = Date.now();
const arg = k => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] ?? true; };
const STAGE = arg('--stage'); const DRY = process.argv.includes('--dry-run-on-dev');
if (!['dev', 'holdout'].includes(STAGE)) throw new Error('--stage dev|holdout');
const OUT = 'docs/evidence/research/phase4';
const sha = s => createHash('sha256').update(s).digest('hex');
const fileSha = p => sha(readFileSync(p));
const SNAP = 'docs/evidence/research/frozen/bundesliga-results-snapshot.json';
const raw = readFileSync(SNAP, 'utf8');
const CARD = PROTOCOL.frozen_model.card;
const card = JSON.parse(readFileSync(CARD, 'utf8'));
if (sha(raw) !== card.data_sha256) throw new Error('snapshot differs from the frozen v1.2-dc card');
if (card.rho !== PROTOCOL.frozen_model.rho || card.prediction_hash !== PROTOCOL.frozen_model.prediction_hash) throw new Error('card differs from the protocol');
const RHO = card.rho;
const matches = JSON.parse(raw).map(m => ({ ...m, t: Date.parse(m.kickoff_at), r: m.home_score > m.away_score ? 0 : m.home_score === m.away_score ? 1 : 2 }));
const SCRIPTS = ['scripts/research/phase4-protocol.mjs', 'scripts/research/calibration-v12-research.mjs', 'scripts/research/structural-core.mjs', 'scripts/research/metrics.mjs', 'scripts/research/model-core.mjs'];
const PROTOCOL_SHA = fileSha('scripts/research/phase4-protocol.mjs');

// ------------------------------------------------------------------ frozen raw probabilities
const lam = structuralSeries(matches, { homeHl: 540 });
const elo = eloSeries(matches, 10, 60, 2 / 3);
const train = matches.filter(m => SPLIT(m.season) === 'train');
const freq = [0, 1, 2].map(r => train.filter(m => m.r === r).length / train.length);
const rows = [];
matches.forEach((m, i) => {
  if (!lam[i] || m.season <= '2005/06') return;
  rows.push({ i, id: m.id, season: m.season, split: SPLIT(m.season), t: m.t, y: m.r, elo_home: elo[i].rh, base: freq, raw: dc1x2(lam[i].lh, lam[i].la, RHO) });
});
const predHash = k => sha(JSON.stringify(rows.map(r => [r.id, ...r[k].map(x => +x.toFixed(10))])));

// ------------------------------------------------------------------ calibrators: z = W log p + b, softmax
const I3 = () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const PRIOR = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0]; const REG = 0.01;
const CAL = {
  none: { n: 0, init: [], map: () => ({ W: I3(), b: [0, 0, 0] }), grad: () => [] },
  temperature: { n: 1, init: [1], map: t => ({ W: I3().map(r => r.map(v => v / t[0])), b: [0, 0, 0] }), grad: (gW, gb, t) => [-(gW[0][0] + gW[1][1] + gW[2][2]) / (t[0] * t[0])] },
  bias: { n: 2, init: [0, 0], map: t => ({ W: I3(), b: [0, t[0], t[1]] }), grad: (gW, gb) => [gb[1], gb[2]] },
  vector: { n: 5, init: [1, 1, 1, 0, 0], map: t => ({ W: [[t[0], 0, 0], [0, t[1], 0], [0, 0, t[2]]], b: [0, t[3], t[4]] }), grad: (gW, gb) => [gW[0][0], gW[1][1], gW[2][2], gb[1], gb[2]] },
  matrix: { n: 11, init: [...PRIOR], reg: true, map: t => ({ W: [[t[0], t[1], t[2]], [t[3], t[4], t[5]], [t[6], t[7], t[8]]], b: [0, t[9], t[10]] }), grad: (gW, gb) => [...gW[0], ...gW[1], ...gW[2], gb[1], gb[2]] },
};
const ORDER = PROTOCOL.simplicity_order;
function applyWith(W, b, p) {
  const l = p.map(x => Math.log(Math.max(1e-12, x)));
  const z = [0, 1, 2].map(k => W[k][0] * l[0] + W[k][1] * l[1] + W[k][2] * l[2] + b[k]);
  const mx = Math.max(...z); const e = z.map(v => Math.exp(v - mx)); const s = e[0] + e[1] + e[2];
  return [e[0] / s, e[1] / s, e[2] / s];
}
const apply = (m, th, p) => (m === 'none' ? p : applyWith(...Object.values(CAL[m].map(th)), p));
function lossGrad(m, th, xs) {
  const { W, b } = CAL[m].map(th); let L = 0; const gW = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; const gb = [0, 0, 0];
  for (const r of xs) {
    const l = r.raw.map(x => Math.log(Math.max(1e-12, x))); const q = applyWith(W, b, r.raw);
    L -= Math.log(Math.max(1e-12, q[r.y]));
    for (let k = 0; k < 3; k++) { const g = q[k] - (k === r.y ? 1 : 0); gb[k] += g; for (let j = 0; j < 3; j++) gW[k][j] += g * l[j]; }
  }
  const n = xs.length; L /= n; for (let k = 0; k < 3; k++) { gb[k] /= n; for (let j = 0; j < 3; j++) gW[k][j] /= n; }
  const g = CAL[m].grad(gW, gb, th);
  if (CAL[m].reg) th.forEach((v, i) => { L += REG * (v - PRIOR[i]) ** 2 / th.length; g[i] += 2 * REG * (v - PRIOR[i]) / th.length; });
  return { L, g };
}
function fit(m, xs) {
  if (m === 'none') return { params: [], loss: xs.reduce((a, r) => a + ll3(r.raw, r.y), 0) / xs.length, iterations: 0 };
  let th = [...CAL[m].init]; let cur = lossGrad(m, th, xs); let lr = 0.5; let it = 0;
  for (; it < 20000; it++) {
    const cand = th.map((v, i) => v - lr * cur.g[i]); const next = lossGrad(m, cand, xs);
    if (next.L < cur.L) { th = cand; cur = next; lr = Math.min(lr * 1.25, 50); } else lr *= 0.5;
    if (lr < 1e-12 || Math.max(...cur.g.map(Math.abs)) < 1e-9) break;
  }
  return { params: th.map(v => +v.toFixed(8)), loss: cur.L, iterations: it, max_abs_gradient: Math.max(0, ...cur.g.map(Math.abs)) };
}

// ------------------------------------------------------------------ DEV selection (deterministic; uses DEV rows only)
function devSelection(allRows) {
  const dev = allRows.filter(r => r.split === 'dev');
  const seasons = [...new Set(dev.map(r => r.season))].sort();
  const loso = {};
  for (const m of ORDER) {
    const per = seasons.map(s => { const tr = dev.filter(r => r.season !== s); const te = dev.filter(r => r.season === s); const f = fit(m, tr);
      const k = `__loso_${m}`; for (const r of te) r[k] = apply(m, f.params.map(Number), r.raw);
      const res = { season: s, log_loss: te.reduce((a, r) => a + ll3(r[k], r.y), 0) / te.length, brier: te.reduce((a, r) => a + brier(r[k], r.y), 0) / te.length, ece: ece(te, k) };
      for (const r of te) delete r[k]; return res; });
    const mean = f => per.reduce((a, x) => a + x[f], 0) / per.length;
    loso[m] = { log_loss: +mean('log_loss').toFixed(6), brier: +mean('brier').toFixed(6), ece: +mean('ece').toFixed(6), per_season: per.map(x => ({ season: x.season, log_loss: +x.log_loss.toFixed(6), brier: +x.brier.toFixed(6), ece: +x.ece.toFixed(5) })) };
  }
  const tieWinner = ORDER.reduce((b, m) => (loso[m].log_loss < loso[b].log_loss - 0.0005 ? m : b), 'none');
  let selected = tieWinner; const guard = {};
  if (tieWinner !== 'none') {
    guard.brier_worse_than_none_by = +(loso[tieWinner].brier - loso.none.brier).toFixed(6);
    guard.dev_seasons_worse_than_none_by_more_than_0_002 = loso[tieWinner].per_season.filter((x, k) => x.log_loss - loso.none.per_season[k].log_loss > 0.002).map(x => x.season);
    if (guard.brier_worse_than_none_by > 0.0005 || guard.dev_seasons_worse_than_none_by_more_than_0_002.length > 1) selected = 'none';
  }
  const fitted = Object.fromEntries(ORDER.map(m => { const f = fit(m, dev); return [m, { params: f.params, dev_loss: +f.loss.toFixed(8), iterations: f.iterations, max_abs_gradient: f.max_abs_gradient ?? 0 }]; }));
  return { fit_input_seasons: seasons, fit_input_rows: dev.length, loso, tie_rule_winner: tieWinner, secondary_guard: guard, selected, fitted };
}
function attach(sel) { for (const m of ORDER) for (const r of rows) r[`cal_${m}`] = apply(m, sel.fitted[m].params, r.raw); }

// ------------------------------------------------------------------ reproduction + leakage gates
function gates() {
  const out = {};
  const ref = poissonSeries(matches, 540, 10, { strict: true }); let lamFail = 0; let probFail = 0;
  ref.forEach((p, i) => { const q = lam[i]; if ((p === null) !== (q === null) || (p && (p.lh !== q.lh || p.la !== q.la))) lamFail += 1; });
  for (const r of rows) { const p = ref[r.i]; const q = dc1x2(p.lh, p.la, RHO); if (q.some((v, k) => v !== r.raw[k])) probFail += 1; }
  out.G1_frozen_reproduction = { lambdas_vs_model_core_strict_bitwise_failures: lamFail, probabilities_bitwise_failures: probFail, raw_prediction_hash: predHash('raw'), card_prediction_hash: card.prediction_hash, pass: lamFail === 0 && probFail === 0 && predHash('raw') === card.prediction_hash };
  const holdIdx = matches.map((m, i) => i).filter(i => SPLIT(matches[i].season) === 'holdout');
  const step = Math.floor(holdIdx.length / 60); const g60 = Array.from({ length: 60 }, (_, k) => holdIdx[k * step]);
  const dh = matches.map((m, i) => i).filter(i => ['dev', 'holdout'].includes(SPLIT(matches[i].season)));
  const st3 = Math.floor(dh.length / 300); const g300 = Array.from({ length: 300 }, (_, k) => dh[k * st3 + 7]);
  const trunc = idxs => { let fail = 0; for (const i of idxs) { const m = matches[i]; const prior = matches.filter(x => x.t < m.t); const tr = predictFrom(prior, 0, prior.length, m, { homeHl: 540 }); const f = lam[i];
    if ((f === null) !== (tr === null) || (f && (f.lh !== tr.lh || f.la !== tr.la))) fail += 1; } return { cases: idxs.length, failures: fail }; };
  out.G2_truncation = { phase2_gate_60: trunc(g60), expanded_300: trunc(g300) }; out.G2_truncation.pass = out.G2_truncation.phase2_gate_60.failures + out.G2_truncation.expanded_300.failures === 0;
  let seed = 20260928; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seasonStarts = [...new Set(matches.map(m => m.season))].filter(s => ['dev', 'holdout'].includes(SPLIT(s))).map(s => matches.find(m => m.season === s).t);
  const cuts = [...seasonStarts, ...Array.from({ length: 8 }, () => matches[dh[Math.floor(rnd() * dh.length)]].t)];
  let compared = 0; let mfail = 0;
  for (const c of cuts) { const mut = matches.map(m => (m.t >= c ? { ...m, home_score: Math.floor(rnd() * 7), away_score: Math.floor(rnd() * 7) } : m)); const s2 = structuralSeries(mut, { homeHl: 540 });
    matches.forEach((m, i) => { if (m.t > c) return; compared += 1; const a = lam[i]; const b = s2[i]; if ((a === null) !== (b === null) || (a && (a.lh !== b.lh || a.la !== b.la))) mfail += 1; }); }
  out.G3_future_score_mutation = { cutoffs: cuts.length, predictions_compared: compared, failures: mfail, pass: mfail === 0 };
  const groups = new Map(); matches.forEach(m => { if (!groups.has(m.t)) groups.set(m.t, []); groups.get(m.t).push(m); });
  const perm = [...groups.keys()].sort((a, b) => a - b).flatMap(t => [...groups.get(t)].reverse()); const s2 = structuralSeries(perm, { homeHl: 540 }); const byId = new Map(perm.map((m, k) => [m.id, s2[k]]));
  let pfail = 0; let pmax = 0; matches.forEach((m, i) => { const a = lam[i]; const b = byId.get(m.id); if ((a === null) !== (b === null)) { pfail += 1; return; } if (!a) return; const d = Math.max(Math.abs(a.lh - b.lh), Math.abs(a.la - b.la)); pmax = Math.max(pmax, d); if (d > 1e-12) pfail += 1; });
  out.G4_same_kickoff_permutation = { failures: pfail, max_abs_diff: pmax, pass: pfail === 0 };
  return out;
}

// ------------------------------------------------------------------ DEV stage
if (STAGE === 'dev') {
  const g = gates();
  const sel = devSelection(rows);
  // G5: holdout (and train) outcomes cannot influence calibration: scramble every non-DEV outcome and
  // re-run the whole selection and every fit; the result must be identical.
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const scrambled = rows.map(r => (r.split === 'dev' ? r : { ...r, y: Math.floor(rnd() * 3) }));
  const sel2 = devSelection(scrambled);
  g.G5_dev_only_calibration = { fit_input_seasons: sel.fit_input_seasons, fit_input_rows: sel.fit_input_rows, non_dev_outcomes_scrambled: scrambled.filter(r => r.split !== 'dev').length, identical_after_scramble: JSON.stringify(sel) === JSON.stringify(sel2), pass: sel.fit_input_seasons.every(s => SPLIT(s) === 'dev') && JSON.stringify(sel) === JSON.stringify(sel2) };
  g.all_pass = Object.values(g).every(v => v.pass);
  attach(sel);
  const hashes = { raw: predHash('raw'), ...Object.fromEntries(ORDER.map(m => [`cal_${m}`, predHash(`cal_${m}`)])), rows: rows.length };
  const report = { stage: 'dev', generated_at: new Date().toISOString(), protocol_id: PROTOCOL.id, protocol_sha256: PROTOCOL_SHA, protocol: PROTOCOL, frozen_model: card.model_id, frozen_card_sha256: fileSha(CARD),
    data_sha256: sha(raw), script_sha256: Object.fromEntries(SCRIPTS.map(p => [p, fileSha(p)])), gates: g, selection: sel, prediction_hashes: hashes, holdout_metrics_computed: false, runtime_s: +((Date.now() - t0) / 1000).toFixed(1) };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/dev-selection.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ gates: Object.fromEntries(Object.entries(g).map(([k, v]) => [k, v.pass ?? v])), loso: Object.fromEntries(ORDER.map(m => [m, { ll: sel.loso[m].log_loss, brier: sel.loso[m].brier, ece: sel.loso[m].ece, per: sel.loso[m].per_season.map(x => x.log_loss) }])),
    tie_winner: sel.tie_rule_winner, guard: sel.secondary_guard, selected: sel.selected, fitted: Object.fromEntries(ORDER.map(m => [m, sel.fitted[m]])), hashes, runtime_s: report.runtime_s }, null, 1));
  process.exit(0);
}

// ------------------------------------------------------------------ HOLDOUT stage
const frozen = JSON.parse(readFileSync(`${OUT}/dev-selection.json`, 'utf8'));
if (frozen.protocol_sha256 !== PROTOCOL_SHA) throw new Error('protocol changed after the DEV stage');
if (frozen.data_sha256 !== sha(raw) || frozen.frozen_card_sha256 !== fileSha(CARD)) throw new Error('data or frozen card changed');
if (predHash('raw') !== frozen.prediction_hashes.raw) throw new Error('raw predictions do not reproduce');
const sel = devSelection(rows);
if (JSON.stringify(sel) !== JSON.stringify(frozen.selection)) throw new Error('DEV selection / parameters do not reproduce');
attach(sel);
for (const m of ORDER) if (predHash(`cal_${m}`) !== frozen.prediction_hashes[`cal_${m}`]) throw new Error(`calibrated hash ${m} does not reproduce`);
const EVAL = DRY ? 'dev' : 'holdout';
const ev = rows.filter(r => r.split === EVAL);
const seasons = [...new Set(ev.map(r => r.season))].sort();
const KEYS = ['raw', ...ORDER.filter(m => m !== 'none').map(m => `cal_${m}`), 'base'];
const SELK = sel.selected === 'none' ? 'raw' : `cal_${sel.selected}`;
const pooled = Object.fromEntries(KEYS.map(k => [k, metrics(ev, k)]));
const argmax = p => p.indexOf(Math.max(...p));
const ranks = xs => { const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = new Array(xs.length); let i = 0; while (i < idx.length) { let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++; for (let k = i; k < j; k++) r[idx[k][1]] = (i + j + 1) / 2; i = j; } return r; };
const pearson = (a, b) => { const ma = a.reduce((x, y) => x + y, 0) / a.length; const mb = b.reduce((x, y) => x + y, 0) / b.length; let n = 0; let da = 0; let db = 0; a.forEach((v, i) => { n += (v - ma) * (b[i] - mb); da += (v - ma) ** 2; db += (b[i] - mb) ** 2; }); return n / Math.sqrt(da * db); };
const spearman = (a, b) => pearson(ranks(a), ranks(b));
function ranking(k) {
  return { auc: pooled[k].auc, favourite_accuracy: pooled[k].favourite_accuracy, favourite_identity_changes_vs_raw: ev.filter(r => argmax(r[k]) !== argmax(r.raw)).length,
    top10_accuracy: pooled[k].top10_accuracy, top20_accuracy: pooled[k].top20_accuracy, upset_auc: pooled[k].upset_auc,
    spearman_vs_raw: [0, 1, 2].map(c => +spearman(ev.map(r => r[k][c]), ev.map(r => r.raw[c])).toFixed(5)) };
}
function pathology(k) {
  let mn = 1; let mx = 0; let dmn = 1; let dmx = 0; let shift = 0;
  for (const r of ev) { mn = Math.min(mn, ...r[k]); mx = Math.max(mx, ...r[k]); dmn = Math.min(dmn, r[k][1]); dmx = Math.max(dmx, r[k][1]); shift = Math.max(shift, ...r[k].map((v, c) => Math.abs(v - r.raw[c]))); }
  return { min_probability: +mn.toFixed(4), max_probability: +mx.toFixed(4), draw_range: [+dmn.toFixed(4), +dmx.toFixed(4)], max_shift_vs_raw: +shift.toFixed(4) };
}
const bySeason = seasons.map(s => { const xs = ev.filter(r => r.season === s); return { season: s, n: xs.length, ...Object.fromEntries(KEYS.map(k => { const m = metrics(xs, k); return [k, { log_loss: m.log_loss, log_loss_exact: m.log_loss_exact, brier: m.brier, ece: m.ece, bias_pts: m.bias_pts }]; })) }; });
function keep(k) {
  const X = pooled[k]; const R = pooled.raw; const rk = ranking(k); const pa = pathology(k);
  const dLL = X.log_loss_exact - R.log_loss_exact; const dBr = X.brier_exact - R.brier_exact; const dEce = ece(ev, k) - ece(ev, 'raw');
  const worse = bySeason.filter(s => s[k].log_loss_exact - s.raw.log_loss_exact > 0.002).map(s => s.season);
  const dAuc = [0, 1, 2].map(c => auc(ev.map(r => r[k][c]), ev.map(r => r.y === c)) - auc(ev.map(r => r.raw[c]), ev.map(r => r.y === c)));
  const checks = {
    K1_log_loss: dLL <= -0.0005, K2_brier: dBr <= 0.0005, K3_ece: dEce < 0, K4_seasons: worse.length <= 1,
    K5_ranking: dAuc.every(v => Math.abs(v) < 0.005) && rk.spearman_vs_raw.every(v => v >= 0.99),
    K6_ordering: rk.favourite_identity_changes_vs_raw <= 0.02 * ev.length && Math.abs(X.favourite_accuracy - R.favourite_accuracy) < 0.01 && X.top10_accuracy - R.top10_accuracy >= -0.02 && X.top20_accuracy - R.top20_accuracy >= -0.02,
    K7_pathology: pa.min_probability >= 0.02 && pa.max_probability <= 0.95 && pa.draw_range[0] >= 0.05 && pa.draw_range[1] <= 0.45 && pa.max_shift_vs_raw <= 0.10,
  };
  return { d_log_loss: +dLL.toFixed(6), d_brier: +dBr.toFixed(6), d_ece: +dEce.toFixed(6), seasons_worse_by_more_than_0_002: worse, d_auc: dAuc.map(v => +v.toFixed(5)), pathology: pa, checks, accepted: Object.values(checks).every(Boolean) };
}
const keepAll = Object.fromEntries(KEYS.filter(k => k.startsWith('cal_')).map(k => [k, keep(k)]));
const baselineEvery = bySeason.every(s => s.raw.log_loss_exact < s.base.log_loss_exact && s.raw.brier_exact < s.base.brier_exact);
const gatesOk = frozen.gates.all_pass;
const selectedAccepted = sel.selected !== 'none' && keepAll[SELK].accepted;
const verdict = !gatesOk ? 'MORE RESEARCH' : !baselineEvery ? 'REJECT' : selectedAccepted ? 'CALIBRATED MODEL READY FOR SHADOW' : 'RAW DIXON-COLES READY FOR SHADOW';

// ---- classwise, buckets, reliability, drift
const B = PROTOCOL.fixed_bins;
const classwise = Object.fromEntries(KEYS.filter(k => k !== 'base').map(k => [k, ['home', 'draw', 'away'].map((name, c) => ({ class: name, mean_predicted: pooled[k].mean_pred[c], observed: pooled[k].observed[c], bias_pts: pooled[k].bias_pts[c], ece: pooled[k].ece_class[c],
  reliability: reliability(ev, k, c, c === 1 ? B.reliability_draw : B.reliability_home_away) }))]));
const devTier = rows.filter(r => r.split === 'dev').map(r => r.elo_home).sort((a, b) => a - b); const q1 = devTier[Math.floor(devTier.length / 3)]; const q2 = devTier[Math.floor(2 * devTier.length / 3)];
const bucket = (f) => [...new Set(ev.map(f))].sort().map(g => { const xs = ev.filter(r => f(r) === g); return { group: g, n: xs.length, observed: [0, 1, 2].map(c => +(xs.filter(r => r.y === c).length / xs.length).toFixed(4)),
  ...Object.fromEntries(KEYS.filter(k => k !== 'base').map(k => [k, { mean_pred: [0, 1, 2].map(c => +(xs.reduce((a, r) => a + r[k][c], 0) / xs.length).toFixed(4)), bias_pts: [0, 1, 2].map(c => +((xs.reduce((a, r) => a + r[k][c], 0) - xs.filter(r => r.y === c).length) / xs.length * 100).toFixed(2)), log_loss: +(xs.reduce((a, r) => a + ll3(r[k], r.y), 0) / xs.length).toFixed(4) }])) }; });
const buckets = {
  favourite_strength_raw: bucket(r => { const p = Math.max(...r.raw); return p < 0.45 ? 'a <0.45' : p < 0.55 ? 'b 0.45-0.55' : p < 0.65 ? 'c 0.55-0.65' : 'd >=0.65'; }),
  home_team_strength: bucket(r => (r.elo_home < q1 ? 'a weak' : r.elo_home < q2 ? 'b mid' : 'c strong')),
};
// chi-square upper tail via the regularised lower incomplete gamma series
const lgamma = x => { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = x; const tmp = x + 5.5 - (x + 0.5) * Math.log(x + 5.5); let ser = 1.000000000190015; for (const v of c) ser += v / ++y; return -tmp + Math.log(2.5066282746310005 * ser / x); };
const chiSqP = (x, df) => { const a = df / 2; const z = x / 2; if (z <= 0) return 1; let sum = 1 / a; let term = 1 / a; for (let n = 1; n < 500; n++) { term *= z / (a + n); sum += term; if (term < sum * 1e-15) break; } return 1 - Math.exp(-z + a * Math.log(z) - lgamma(a)) * sum; };
function drift(k) {
  return ['home', 'draw', 'away'].map((name, c) => { const zs = seasons.map(s => { const xs = ev.filter(r => r.season === s); const pred = xs.reduce((a, r) => a + r[k][c], 0); const obs = xs.filter(r => r.y === c).length; const se = Math.sqrt(xs.reduce((a, r) => a + r[k][c] * (1 - r[k][c]), 0)); return { season: s, bias_pts: +((pred - obs) / xs.length * 100).toFixed(2), z: +((pred - obs) / se).toFixed(2) }; });
    const chi = zs.reduce((a, x) => a + x.z ** 2, 0); return { class: name, seasons: zs, chi_square: +chi.toFixed(2), df: zs.length, p_value: +chiSqP(chi, zs.length).toFixed(4), seasons_abs_z_over_1_96: zs.filter(x => Math.abs(x.z) > 1.96).map(x => x.season) }; });
}
const driftAll = Object.fromEntries(KEYS.filter(k => k !== 'base').map(k => [k, drift(k)]));
const staticSufficient = driftAll[SELK].every(d => d.p_value >= 0.05);

const strip = m => { const { log_loss_exact, brier_exact, ...rest } = m; void log_loss_exact; void brier_exact; return rest; };
const report = { stage: DRY ? 'dry-run-on-dev (NOT the holdout)' : 'holdout', evaluated_split: EVAL, generated_at: new Date().toISOString(), protocol_id: PROTOCOL.id, protocol_sha256: PROTOCOL_SHA,
  dev_selection_sha256: fileSha(`${OUT}/dev-selection.json`), frozen_model: card.model_id, frozen_card_sha256: fileSha(CARD), data_sha256: sha(raw), script_sha256: Object.fromEntries(SCRIPTS.map(p => [p, fileSha(p)])),
  selected: sel.selected, selected_key: SELK, parameters: Object.fromEntries(ORDER.map(m => [m, sel.fitted[m].params])), prediction_hashes: frozen.prediction_hashes,
  raw_reference_check: DRY ? null : { phase3_B: { log_loss: 0.9952, brier: 0.5938, ece: 0.0171 }, raw: { log_loss: pooled.raw.log_loss, brier: pooled.raw.brier, ece: pooled.raw.ece }, match: pooled.raw.log_loss === 0.9952 && pooled.raw.brier === 0.5938 && pooled.raw.ece === 0.0171 },
  pooled: Object.fromEntries(KEYS.map(k => [k, strip(pooled[k])])),
  by_season: bySeason.map(s => ({ season: s.season, n: s.n, ...Object.fromEntries(KEYS.map(k => [k, { log_loss: s[k].log_loss, brier: s[k].brier, ece: s[k].ece, bias_pts: s[k].bias_pts }])) })),
  keep_rule: { selected: sel.selected === 'none' ? 'none selected on DEV: nothing to accept' : keepAll[SELK], diagnostic_only_not_adoptable: Object.fromEntries(Object.entries(keepAll).filter(([k]) => k !== SELK)) },
  ranking: Object.fromEntries(KEYS.filter(k => k !== 'base').map(k => [k, ranking(k)])), pathology: Object.fromEntries(KEYS.filter(k => k.startsWith('cal_')).map(k => [k, pathology(k)])),
  classwise, buckets, drift: { by_calibrator: driftAll, static_sufficient_for_selected: staticSufficient },
  gates_all_pass: gatesOk, raw_beats_baseline_every_season: baselineEvery, verdict, runtime_s: +((Date.now() - t0) / 1000).toFixed(1) };
const outFile = arg('--out') || (DRY ? null : `${OUT}/holdout-results.json`);
if (!outFile) throw new Error('--dry-run-on-dev needs --out <scratch file>');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stage: report.stage, ref: report.raw_reference_check, selected: sel.selected, pooled: Object.fromEntries(KEYS.map(k => [k, { ll: pooled[k].log_loss, brier: pooled[k].brier, ece: pooled[k].ece, ece_class: pooled[k].ece_class, bias: pooled[k].bias_pts }])),
  keep: Object.fromEntries(Object.entries(keepAll).map(([k, v]) => [k, { dLL: v.d_log_loss, dBr: v.d_brier, dEce: v.d_ece, worse: v.seasons_worse_by_more_than_0_002, checks: v.checks, accepted: v.accepted }])),
  drift: Object.fromEntries(Object.entries(driftAll).map(([k, v]) => [k, v.map(d => `${d.class} chi2 ${d.chi_square} p ${d.p_value}`)])), static_sufficient: staticSufficient, verdict, runtime_s: report.runtime_s }, null, 1));
