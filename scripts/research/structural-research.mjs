#!/usr/bin/env node
// Phase 3 structural research: A = frozen Poisson v1.1, B = A + Dixon-Coles, C = A + adaptive league
// home advantage, D = B + adaptive home. Rules: scripts/research/phase3-protocol.mjs (declared first).
//   node scripts/research/structural-research.mjs --stage dev
//       DEV-only selection (rho, home half-life), leakage tests, prediction hashes. Computes NO
//       holdout metric. Writes docs/evidence/research/phase3/dev-selection.json (commit it first).
//   node scripts/research/structural-research.mjs --stage holdout [--dry-run-on-dev --out <file>]
//       Refuses to run unless the protocol hash and the DEV selection reproduce exactly; then
//       evaluates A/B/C/D and applies the keep rule. --dry-run-on-dev exercises the evaluation code
//       on DEV seasons only (for debugging without looking at the holdout).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { poissonSeries, eloSeries, SPLIT, ll3 } from './model-core.mjs';
import { structuralSeries, predictFrom, dc1x2, dcGrid, fitRho, scoreLogLik } from './structural-core.mjs';
import { metrics, eceClass, auc, brier, reliability } from './metrics.mjs';
import { PROTOCOL } from './phase3-protocol.mjs';

const t0 = Date.now();
const arg = k => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] ?? true; };
const STAGE = arg('--stage'); const DRY = process.argv.includes('--dry-run-on-dev');
if (!['dev', 'holdout'].includes(STAGE)) throw new Error('--stage dev|holdout');
const OUT = 'docs/evidence/research/phase3';
const sha = s => createHash('sha256').update(s).digest('hex');
const fileSha = p => sha(readFileSync(p));
const SNAP = 'docs/evidence/research/frozen/bundesliga-results-snapshot.json';
const raw = readFileSync(SNAP, 'utf8');
const card = JSON.parse(readFileSync('docs/evidence/research/frozen/model-card-v1.json', 'utf8'));
if (sha(raw) !== card.data.sha256) throw new Error('snapshot hash differs from the frozen model card');
const matches = JSON.parse(raw).map(m => ({ ...m, t: Date.parse(m.kickoff_at), r: m.home_score > m.away_score ? 0 : m.home_score === m.away_score ? 1 : 2 }));
const HLS = [90, 180, 270, 365, 540];
const SCRIPTS = ['scripts/research/phase3-protocol.mjs', 'scripts/research/structural-core.mjs', 'scripts/research/structural-research.mjs', 'scripts/research/metrics.mjs', 'scripts/research/model-core.mjs'];
const PROTOCOL_SHA = fileSha('scripts/research/phase3-protocol.mjs');

// ------------------------------------------------------------------ series + rows (outcome-free features)
const series = Object.fromEntries(HLS.map(h => [h, structuralSeries(matches, { homeHl: h })]));
const elo = eloSeries(matches, 10, 60, 2 / 3);
const train = matches.filter(m => SPLIT(m.season) === 'train');
const freq = [0, 1, 2].map(r => train.filter(m => m.r === r).length / train.length);
const rows = [];
matches.forEach((m, i) => {
  if (!series[540][i] || m.season <= '2005/06') return;
  const lam = Object.fromEntries(HLS.map(h => [h, series[h][i]]));
  rows.push({ i, id: m.id, season: m.season, split: SPLIT(m.season), t: m.t, month: m.kickoff_at.slice(0, 7), y: m.r, hs: m.home_score, as: m.away_score, elo_home: elo[i].rh, base: freq, lam });
});
const withLam = (rs, h) => rs.map(r => ({ lh: r.lam[h].lh, la: r.lam[h].la, hs: r.hs, as: r.as, split: r.split, season: r.season }));
const devRows = rows.filter(r => r.split === 'dev');

// ------------------------------------------------------------------ DEV selection (deterministic)
function devSelection() {
  const fitInputSeasons = [...new Set(devRows.map(r => r.season))];
  if (devRows.some(r => r.split !== 'dev')) throw new Error('non-dev row in fit input');
  const rho = {}; const rhoLL = {};
  for (const h of HLS) { const f = fitRho(withLam(devRows, h)); rho[h] = f.rho; rhoLL[h] = +f.ll.toFixed(4); }
  const devLL = (h, rh) => devRows.reduce((a, r) => a + ll3(dc1x2(r.lam[h].lh, r.lam[h].la, rh), r.y), 0) / devRows.length;
  const C = Object.fromEntries(HLS.map(h => [h, devLL(h, 0)]));
  const D = Object.fromEntries(HLS.map(h => [h, devLL(h, rho[h])]));
  const pick = grid => { const best = HLS.reduce((b, h) => (grid[h] < grid[b] ? h : b), 540); return grid[540] - grid[best] > 0.0005 ? best : 540; };
  // sensitivity only (NOT used): rho that minimises DEV 1X2 log loss on A lambdas
  let rho1x2 = { rho: 0, ll: Infinity };
  for (let k = 0; k <= 180; k++) { const r0 = +(-0.30 + k * 0.0025).toFixed(4); const l = devLL(540, r0); if (l < rho1x2.ll) rho1x2 = { rho: r0, ll: l }; }
  return {
    fit_input_seasons: fitInputSeasons,
    B: { rho: rho[540], dev_scoreline_loglik: rhoLL[540], dev_1x2_log_loss: +D[540].toFixed(6) },
    C: { grid_dev_1x2_log_loss: Object.fromEntries(HLS.map(h => [h, +C[h].toFixed(6)])), selected_home_half_life: pick(C) },
    D: { grid: Object.fromEntries(HLS.map(h => [h, { rho: rho[h], dev_scoreline_loglik: rhoLL[h], dev_1x2_log_loss: +D[h].toFixed(6) }])), selected_home_half_life: pick(D) },
    A: { dev_1x2_log_loss: +C[540].toFixed(6) },
    sensitivity_not_used: { rho_minimising_dev_1x2_log_loss_on_A: rho1x2.rho, its_dev_log_loss: +rho1x2.ll.toFixed(6) },
  };
}
function attachProbs(sel) {
  const hC = sel.C.selected_home_half_life; const hD = sel.D.selected_home_half_life; const rB = sel.B.rho; const rD = sel.D.grid[hD].rho;
  for (const r of rows) {
    r.A = dc1x2(r.lam[540].lh, r.lam[540].la, 0); r.B = dc1x2(r.lam[540].lh, r.lam[540].la, rB);
    r.C = dc1x2(r.lam[hC].lh, r.lam[hC].la, 0); r.D = dc1x2(r.lam[hD].lh, r.lam[hD].la, rD);
    for (const h of HLS) { r[`C_${h}`] = dc1x2(r.lam[h].lh, r.lam[h].la, 0); r[`D_${h}`] = dc1x2(r.lam[h].lh, r.lam[h].la, sel.D.grid[h].rho); }
    r.lamC = r.lam[hC]; r.lamD = r.lam[hD];
  }
}
const predHash = k => sha(JSON.stringify(rows.map(r => [r.id, ...r[k].map(x => +x.toFixed(10))])));

// ------------------------------------------------------------------ leakage tests
function leakageTests(sel) {
  const out = {};
  // L1: h = 540 reproduces the frozen model-core strict series bit-for-bit; general formula within 1e-12
  const ref = poissonSeries(matches, 540, 10, { strict: true });
  let bitFail = 0; let genMax = 0;
  const gen = structuralSeries(matches, { homeHl: 540, forceShare: true });
  ref.forEach((p, i) => {
    const q = series[540][i];
    if ((p === null) !== (q === null) || (p && (p.lh !== q.lh || p.la !== q.la))) bitFail += 1;
    if (p) genMax = Math.max(genMax, Math.abs(gen[i].lh - p.lh) / p.lh, Math.abs(gen[i].la - p.la) / p.la);
  });
  out.L1_reproduces_frozen_v1_1 = { compared: ref.length, bitwise_failures: bitFail, general_home_share_formula_max_relative_diff: genMax, pass: bitFail === 0 && genMax < 1e-12 };
  const configs = [...new Set([540, 90, sel.C.selected_home_half_life, sel.D.selected_home_half_life])];
  // L2: truncation gate (phase 2's 60 holdout cases, plus 300 across dev+holdout): prediction from
  // ONLY matches that kicked off strictly before == the prediction inside the full series.
  const trunc = (idxs) => {
    let fail = 0; let maxd = 0;
    for (const i of idxs) { const m = matches[i]; const prior = matches.filter(x => x.t < m.t);
      for (const h of configs) { const full = series[h][i]; const tr = predictFrom(prior, 0, prior.length, m, { homeHl: h });
        if ((full === null) !== (tr === null)) { fail += 1; continue; } if (!full) continue;
        const d = Math.max(Math.abs(full.lh - tr.lh), Math.abs(full.la - tr.la)); maxd = Math.max(maxd, d); if (d > 1e-12) fail += 1; } }
    return { cases: idxs.length, configs, failures: fail, max_abs_diff: maxd };
  };
  const holdIdx = matches.map((m, i) => i).filter(i => SPLIT(matches[i].season) === 'holdout');
  const step = Math.floor(holdIdx.length / 60);
  const g60 = Array.from({ length: 60 }, (_, k) => holdIdx[k * step]);
  const dh = matches.map((m, i) => i).filter(i => ['dev', 'holdout'].includes(SPLIT(matches[i].season)));
  const st3 = Math.floor(dh.length / 300); const g300 = Array.from({ length: 300 }, (_, k) => dh[k * st3 + 7]);
  out.L2_truncation = { phase2_gate_60: trunc(g60), expanded_300: trunc(g300) };
  out.L2_truncation.pass = out.L2_truncation.phase2_gate_60.failures === 0 && out.L2_truncation.expanded_300.failures === 0;
  // L3: mutation. Scramble the scores of every match at or after a cutoff kickoff; every prediction for
  // a match at or before the cutoff (INCLUDING the cutoff's own simultaneous matches) must be identical.
  let seed = 20260928; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const seasonStarts = [...new Set(matches.map(m => m.season))].filter(s => ['dev', 'holdout'].includes(SPLIT(s))).map(s => matches.find(m => m.season === s).t);
  const randomCuts = Array.from({ length: 8 }, () => matches[dh[Math.floor(rnd() * dh.length)]].t);
  const cuts = [...seasonStarts, ...randomCuts];
  let compared = 0; let mfail = 0; let sameKick = 0;
  for (const c of cuts) {
    const mut = matches.map(m => (m.t >= c ? { ...m, home_score: Math.floor(rnd() * 7), away_score: Math.floor(rnd() * 7) } : m));
    for (const h of configs) {
      const s2 = structuralSeries(mut, { homeHl: h });
      matches.forEach((m, i) => { if (m.t > c) return; compared += 1; if (m.t === c) sameKick += 1; const a = series[h][i]; const b = s2[i];
        if ((a === null) !== (b === null) || (a && (a.lh !== b.lh || a.la !== b.la))) mfail += 1; });
    }
  }
  out.L3_mutation = { cutoffs: cuts.length, season_start_cutoffs: seasonStarts.length, configs, predictions_compared: compared, of_which_at_the_cutoff_kickoff: sameKick, failures: mfail, pass: mfail === 0 };
  // L4: permutation. Reverse the list order inside every same-kickoff group; predictions must not change
  // (summation order of earlier groups changes, so equality is to 1e-12).
  const groups = new Map(); matches.forEach(m => { if (!groups.has(m.t)) groups.set(m.t, []); groups.get(m.t).push(m); });
  const perm = [...groups.keys()].sort((a, b) => a - b).flatMap(t => [...groups.get(t)].reverse());
  let pmax = 0; let pfail = 0;
  for (const h of configs) { const s2 = structuralSeries(perm, { homeHl: h }); const byId = new Map(perm.map((m, k) => [m.id, s2[k]]));
    matches.forEach((m, i) => { const a = series[h][i]; const b = byId.get(m.id); if ((a === null) !== (b === null)) { pfail += 1; return; } if (!a) return; const d = Math.max(Math.abs(a.lh - b.lh), Math.abs(a.la - b.la)); pmax = Math.max(pmax, d); if (d > 1e-12) pfail += 1; }); }
  out.L4_same_kickoff_permutation = { same_kickoff_groups: [...groups.values()].filter(g => g.length > 1).length, configs, failures: pfail, max_abs_diff: pmax, pass: pfail === 0 };
  // L5: parameters fitted only on DEV
  out.L5_fit_inputs = { rho_and_half_life_fitted_on: sel.fit_input_seasons, pass: sel.fit_input_seasons.every(s => SPLIT(s) === 'dev') };
  out.team_playing_twice_same_day = (() => { const seen = new Set(); let d = 0; for (const m of matches) for (const tm of [m.home_team_id, m.away_team_id]) { const k = `${m.kickoff_at.slice(0, 10)}|${tm}`; if (seen.has(k)) d += 1; seen.add(k); } return d; })();
  out.all_pass = out.L1_reproduces_frozen_v1_1.pass && out.L2_truncation.pass && out.L3_mutation.pass && out.L4_same_kickoff_permutation.pass && out.L5_fit_inputs.pass && out.team_playing_twice_same_day === 0;
  return out;
}

// ------------------------------------------------------------------ DEV stage
if (STAGE === 'dev') {
  const sel = devSelection(); attachProbs(sel);
  const devKeys = ['A', 'B', 'C', 'D', 'base'];
  const dev = { pooled: Object.fromEntries(devKeys.map(k => [k, metrics(devRows, k)])),
    grid: Object.fromEntries(HLS.flatMap(h => [[`C_${h}`, metrics(devRows, `C_${h}`)], [`D_${h}`, metrics(devRows, `D_${h}`)]])) };
  const leakage = leakageTests(sel);
  const report = { stage: 'dev', generated_at: new Date().toISOString(), protocol_id: PROTOCOL.id, protocol_sha256: PROTOCOL_SHA, protocol: PROTOCOL,
    data_sha256: sha(raw), frozen_model: card.model_id, script_sha256: Object.fromEntries(SCRIPTS.map(p => [p, fileSha(p)])),
    selection: sel, dev_results: dev, leakage,
    prediction_hashes: { A: predHash('A'), B: predHash('B'), C: predHash('C'), D: predHash('D'), rows: rows.length, frozen_card_poisson: card.prediction_hashes.poisson },
    holdout_metrics_computed: false, runtime_s: +((Date.now() - t0) / 1000).toFixed(1) };
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/dev-selection.json`, JSON.stringify(report, null, 2) + '\n');
  const brief = k => ({ ll: dev.pooled[k].log_loss, brier: dev.pooled[k].brier, ece: dev.pooled[k].ece, draw_bias: dev.pooled[k].bias_pts[1] });
  console.log(JSON.stringify({ selection: sel, dev: Object.fromEntries(devKeys.map(k => [k, brief(k)])), leakage: { L1: leakage.L1_reproduces_frozen_v1_1, L2: leakage.L2_truncation, L3: leakage.L3_mutation, L4: leakage.L4_same_kickoff_permutation, L5: leakage.L5_fit_inputs, all: leakage.all_pass }, hashes: report.prediction_hashes, runtime_s: report.runtime_s }, null, 1));
  process.exit(0);
}

// ------------------------------------------------------------------ HOLDOUT stage
const frozen = JSON.parse(readFileSync(`${OUT}/dev-selection.json`, 'utf8'));
if (frozen.protocol_sha256 !== PROTOCOL_SHA) throw new Error('protocol changed after the DEV stage');
if (frozen.data_sha256 !== sha(raw)) throw new Error('data changed after the DEV stage');
const sel = devSelection();
if (JSON.stringify(sel) !== JSON.stringify(frozen.selection)) throw new Error('DEV selection does not reproduce');
attachProbs(sel);
for (const k of ['A', 'B', 'C', 'D']) if (predHash(k) !== frozen.prediction_hashes[k]) throw new Error(`prediction hash ${k} differs from the DEV freeze`);
const EVAL = DRY ? 'dev' : 'holdout';
const ev = rows.filter(r => r.split === EVAL);
const seasons = [...new Set(ev.map(r => r.season))].sort();
const KEYS = ['A', 'B', 'C', 'D', 'base'];
const pooled = Object.fromEntries(KEYS.map(k => [k, metrics(ev, k)]));
const bySeason = seasons.map(s => { const xs = ev.filter(r => r.season === s); return { season: s, n: xs.length, ...Object.fromEntries(KEYS.map(k => [k, metrics(xs, k)])) }; });

// ---- keep rule (exactly as declared in the protocol)
const RANK = { REJECT: 0, INCONCLUSIVE: 1, KEEP: 2 };
const sd = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const homeBias = (xs, k) => xs.reduce((a, r) => a + r[k][0], 0) / xs.length - xs.filter(r => r.y === 0).length / xs.length;
const drawBias = (xs, k) => xs.reduce((a, r) => a + r[k][1], 0) / xs.length - xs.filter(r => r.y === 1).length / xs.length;
function compare(X, R, kind) {
  const d = r => ll3(r[X], r.y) - ll3(r[R], r.y);
  const dLL = ev.reduce((a, r) => a + d(r), 0) / ev.length;
  const dBr = ev.reduce((a, r) => a + brier(r[X], r.y) - brier(r[R], r.y), 0) / ev.length;
  const perSeason = seasons.map(s => { const xs = ev.filter(r => r.season === s); return { season: s, d_log_loss: xs.reduce((a, r) => a + d(r), 0) / xs.length }; });
  const flags = [];
  const K1 = dLL <= -0.0005 ? 'pass' : dLL < 0 ? 'INCONCLUSIVE' : 'REJECT';
  const K2 = dBr <= 0.0005 ? 'pass' : dBr <= 0.002 ? 'INCONCLUSIVE' : 'REJECT';
  let K3; let k3detail;
  if (kind === 'dc') { const bx = Math.abs(drawBias(ev, X)); const br = Math.abs(drawBias(ev, R)); const ex = eceClass(ev, X, 1); const er = eceClass(ev, R, 1);
    K3 = bx < br && ex < er ? 'pass' : 'INCONCLUSIVE'; k3detail = { abs_draw_bias_pts: [+(br * 100).toFixed(3), +(bx * 100).toFixed(3)], draw_ece: [+er.toFixed(5), +ex.toFixed(5)] };
  } else { const sx = sd(seasons.map(s => homeBias(ev.filter(r => r.season === s), X))); const sr = sd(seasons.map(s => homeBias(ev.filter(r => r.season === s), R)));
    K3 = sx < sr ? 'pass' : 'INCONCLUSIVE'; k3detail = { sd_season_home_bias_pts: [+(sr * 100).toFixed(3), +(sx * 100).toFixed(3)] }; }
  const worse = perSeason.filter(p => p.d_log_loss > 0.002).map(p => p.season); const improved = perSeason.filter(p => p.d_log_loss < 0).length;
  const K4 = worse.length >= 2 ? 'REJECT' : improved < 4 ? 'INCONCLUSIVE' : 'pass';
  const bestS = perSeason.reduce((b, p) => (p.d_log_loss < b.d_log_loss ? p : b), perSeason[0]).season;
  const rest = ev.filter(r => r.season !== bestS); const dRest = rest.reduce((a, r) => a + d(r), 0) / rest.length;
  const K5 = dRest < 0 ? 'pass' : 'INCONCLUSIVE';
  const aucs = k => [0, 1, 2].map(c => auc(ev.map(r => r[k][c]), ev.map(r => r.y === c)));
  const ax = aucs(X); const ar = aucs(R); const dAuc = ax.map((v, i) => v - ar[i]);
  const argmax = p => p.indexOf(Math.max(...p));
  const fav = k => ev.filter(r => argmax(r[k]) === r.y).length / ev.length;
  const dFav = fav(X) - fav(R); const dTop = pooled[X].top10_accuracy - pooled[R].top10_accuracy;
  const K6 = dAuc.every(v => Math.abs(v) < 0.005) && Math.abs(dFav) < 0.01 && dTop >= -0.02 ? 'pass' : 'REJECT';
  const ks = { K1, K2, K3, K4, K5, K6 };
  const verdict = Object.values(ks).includes('REJECT') ? 'REJECT' : Object.values(ks).every(v => v === 'pass') ? 'KEEP' : 'INCONCLUSIVE';
  void flags;
  return { candidate: X, reference: R, kind, d_log_loss: +dLL.toFixed(6), d_brier: +dBr.toFixed(6), per_season_d_log_loss: perSeason.map(p => ({ ...p, d_log_loss: +p.d_log_loss.toFixed(5) })),
    seasons_worse_by_more_than_0_002: worse, seasons_improved: improved, most_improved_season: bestS, d_log_loss_without_it: +dRest.toFixed(6), K3_detail: k3detail,
    d_auc: dAuc.map(v => +v.toFixed(5)), d_favourite_accuracy: +dFav.toFixed(5), d_top10_accuracy: +dTop.toFixed(4), checks: ks, verdict };
}
const cmp = { B_vs_A: compare('B', 'A', 'dc'), C_vs_A: compare('C', 'A', 'home'), D_vs_B: compare('D', 'B', 'home'), D_vs_C: compare('D', 'C', 'dc') };
const verdicts = {
  B: cmp.B_vs_A.verdict,
  C: sel.C.selected_home_half_life === 540 ? 'REJECT' : cmp.C_vs_A.verdict,
  D: sel.D.selected_home_half_life === 540 ? 'REJECT' : [cmp.D_vs_B.verdict, cmp.D_vs_C.verdict].sort((a, b) => RANK[a] - RANK[b])[0],
};
const devLL = { B: sel.B.dev_1x2_log_loss, C: sel.C.grid_dev_1x2_log_loss[sel.C.selected_home_half_life], D: sel.D.grid[sel.D.selected_home_half_life].dev_1x2_log_loss };
const final = verdicts.D === 'KEEP' ? 'D' : ['B', 'C'].filter(k => verdicts[k] === 'KEEP').sort((a, b) => devLL[a] - devLL[b])[0] ?? null;
const baselineEvery = k => bySeason.every(s => s[k].log_loss_exact < s.base.log_loss_exact && s[k].brier_exact < s.base.brier_exact);
const leakOk = frozen.leakage.all_pass;
let overall;
if (!leakOk) overall = 'MORE RESEARCH';
else if (final && baselineEvery(final)) overall = 'STRUCTURAL MODEL READY FOR CALIBRATION';
else if (final) overall = 'REJECT';
else if (Object.values(verdicts).some(v => v === 'INCONCLUSIVE')) overall = 'MORE RESEARCH';
else overall = 'REJECT';

// ---- diagnostics
const devTier = devRows.map(r => r.elo_home).sort((a, b) => a - b); const q1 = devTier[Math.floor(devTier.length / 3)]; const q2 = devTier[Math.floor(2 * devTier.length / 3)];
const groupers = {
  season: r => r.season,
  predicted_draw_band_A: r => { const p = r.A[1]; return p < 0.18 ? 'a <0.18' : p < 0.21 ? 'b 0.18-0.21' : p < 0.24 ? 'c 0.21-0.24' : p < 0.27 ? 'd 0.24-0.27' : 'e >=0.27'; },
  favourite_strength_A: r => { const p = Math.max(...r.A); return p < 0.45 ? 'a <0.45' : p < 0.55 ? 'b 0.45-0.55' : p < 0.65 ? 'c 0.55-0.65' : 'd >=0.65'; },
  home_team_strength: r => (r.elo_home < q1 ? 'a weak' : r.elo_home < q2 ? 'b mid' : 'c strong'),
  expected_total_goals_A: r => { const t = r.lam[540].lh + r.lam[540].la; return t < 2.6 ? 'a <2.6' : t < 3.0 ? 'b 2.6-3.0' : t < 3.4 ? 'c 3.0-3.4' : 'd >=3.4'; },
};
const drawDiag = Object.fromEntries(Object.entries(groupers).map(([g, f]) => [g, [...new Set(ev.map(f))].sort().map(k => { const xs = ev.filter(r => f(r) === k); const obs = xs.filter(r => r.y === 1).length / xs.length;
  return { group: k, n: xs.length, observed_draw: +obs.toFixed(4), ...Object.fromEntries(['A', 'B', 'C', 'D'].map(m => { const p = xs.reduce((a, r) => a + r[m][1], 0) / xs.length; return [m, { predicted: +p.toFixed(4), bias_pts: +((p - obs) * 100).toFixed(2) }]; })) }; })]));
drawDiag.reliability = Object.fromEntries(['A', 'B', 'C', 'D'].map(m => [m, reliability(ev, m, 1, [0, 0.15, 0.18, 0.21, 0.24, 0.27, 0.30, 0.35, 1])]));
const scorelines = ['0-0', '1-0', '0-1', '1-1', '2-0', '0-2', '2-1', '1-2', '2-2', '3-0', '0-3', '3-1', '1-3', '3-2', '2-3', '3-3'];
const scoreDist = (() => {
  const obs = Object.fromEntries(scorelines.map(s => [s, 0])); let other = 0;
  for (const r of ev) { const k = `${r.hs}-${r.as}`; if (k in obs) obs[k] += 1; else other += 1; }
  const model = (lamKey, rho) => { const acc = Object.fromEntries(scorelines.map(s => [s, 0])); let ll = 0;
    for (const r of ev) { const L = r[lamKey]; const { g, S } = dcGrid(L.lh, L.la, rho); for (const s of scorelines) { const [i, j] = s.split('-').map(Number); acc[s] += g[i * 11 + j] / S; } ll -= Math.log(g[Math.min(10, r.hs) * 11 + Math.min(10, r.as)] / S); }
    return { predicted_share: Object.fromEntries(scorelines.map(s => [s, +(acc[s] / ev.length).toFixed(4)])), scoreline_log_loss: +(ll / ev.length).toFixed(4) }; };
  for (const r of ev) r.lamA = r.lam[540];
  return { observed_share: Object.fromEntries(scorelines.map(s => [s, +(obs[s] / ev.length).toFixed(4)])), observed_other: +(other / ev.length).toFixed(4),
    A: model('lamA', 0), B: model('lamA', sel.B.rho), C: model('lamC', 0), D: model('lamD', sel.D.grid[sel.D.selected_home_half_life].rho) };
})();
const homeDiag = seasons.map(s => { const xs = ev.filter(r => r.season === s); const n = xs.length; const mean = f => +(xs.reduce((a, r) => a + f(r), 0) / n).toFixed(4);
  return { season: s, n, observed_home_win: +(xs.filter(r => r.y === 0).length / n).toFixed(4), predicted_home_win: Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, mean(r => r[k][0])])),
    observed_away_win: +(xs.filter(r => r.y === 2).length / n).toFixed(4), predicted_away_win: Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, mean(r => r[k][2])])),
    observed_home_goals: mean(r => r.hs), predicted_home_goals: { A: mean(r => r.lam[540].lh), C: mean(r => r.lamC.lh) },
    observed_away_goals: mean(r => r.as), predicted_away_goals: { A: mean(r => r.lam[540].la), C: mean(r => r.lamC.la) },
    home_ece: Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, +eceClass(xs, k, 0).toFixed(4)])), away_ece: Object.fromEntries(['A', 'B', 'C', 'D'].map(k => [k, +eceClass(xs, k, 2).toFixed(4)])) }; });
// home advantage through time (all evaluated seasons 2006/07+): model league home/away goal ratio at prediction time vs realised
const allSeasons = [...new Set(rows.map(r => r.season))].sort();
const realised = Object.fromEntries(allSeasons.map(s => { const xs = rows.filter(r => r.season === s); return [s, xs.reduce((a, r) => a + r.hs, 0) / xs.reduce((a, r) => a + r.as, 0)]; }));
const hC = sel.C.selected_home_half_life;
const traceH = [...new Set([540, hC, 90])];
const haSeries = Object.fromEntries(traceH.map(h => [h, allSeasons.map(s => { const xs = rows.filter(r => r.season === s); return +(xs.reduce((a, r) => a + r.lam[h].parts.muH / r.lam[h].parts.muA, 0) / xs.length).toFixed(4); })]));
const monthly = Object.fromEntries(traceH.map(h => { const m = new Map(); for (const r of rows) { if (!m.has(r.month)) m.set(r.month, []); m.get(r.month).push(r.lam[h].parts.muH / r.lam[h].parts.muA); } return [h, [...m].map(([k, v]) => [k, +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)])]; }));
const corr = (a, b) => { const ma = a.reduce((x, y) => x + y, 0) / a.length; const mb = b.reduce((x, y) => x + y, 0) / b.length; let n = 0; let da = 0; let db = 0; a.forEach((v, i) => { n += (v - ma) * (b[i] - mb); da += (v - ma) ** 2; db += (b[i] - mb) ** 2; }); return n / Math.sqrt(da * db); };
const lag = Object.fromEntries(traceH.map(h => { const idx = allSeasons.map((s, i) => i).slice(1); const M = idx.map(i => haSeries[h][i]);
  return [h, { corr_with_same_season_realised: +corr(M, idx.map(i => realised[allSeasons[i]])).toFixed(3), corr_with_previous_season_realised: +corr(M, idx.map(i => realised[allSeasons[i - 1]])).toFixed(3) }]; }));
const homeAdvantage = { note: 'league home/away goal ratio muH/muA used at prediction time, season means; realised = season home goals / away goals', seasons: allSeasons, realised: allSeasons.map(s => +realised[s].toFixed(4)), model_by_home_half_life: haSeries, lag_analysis: lag, monthly_model_ratio: monthly };
// SVG plot
function svg() {
  const W = 960; const Hh = 360; const L = 50; const R = 20; const T = 20; const B = 40; const y0 = 0.9; const y1 = 1.7;
  const t0s = Date.parse(`${rows[0].month}-01`); const t1s = Date.parse(`${rows.at(-1).month}-28`);
  const X = t => L + (t - t0s) / (t1s - t0s) * (W - L - R); const Y = v => T + (1 - (v - y0) / (y1 - y0)) * (Hh - T - B);
  const colors = { 540: '#1f6feb', 90: '#d29922' }; colors[hC] = colors[hC] || '#2da44e';
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${Hh}" font-family="system-ui,sans-serif" font-size="11"><rect width="100%" height="100%" fill="#fff"/>`;
  for (let v = 1.0; v <= 1.61; v += 0.1) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" stroke="#ddd"/><text x="${L - 6}" y="${Y(v) + 4}" text-anchor="end">${v.toFixed(1)}</text>`;
  for (const se of allSeasons) { const xs = rows.filter(r => r.season === se); const a = X(xs[0].t); const b = X(xs.at(-1).t);
    s += `<line x1="${a}" x2="${b}" y1="${Y(realised[se])}" y2="${Y(realised[se])}" stroke="#000" stroke-width="2"/>`;
    if (se.endsWith('0') || se.endsWith('5')) s += `<text x="${a}" y="${Hh - B + 16}">${se}</text>`; }
  for (const h of traceH) s += `<polyline fill="none" stroke="${colors[h]}" stroke-width="1.5" ${h === 90 && h !== hC ? 'stroke-dasharray="4 3"' : ''} points="${monthly[h].map(([mo, v]) => `${X(Date.parse(`${mo}-15`)).toFixed(1)},${Y(v).toFixed(1)}`).join(' ')}"/>`;
  const legend = [['#000', 'realised season home/away goal ratio'], ...traceH.map(h => [colors[h], `model muH/muA, home half-life ${h} d${h === 540 ? ' (A)' : h === hC ? ' (C selected)' : ' (diagnostic)'}`])];
  legend.forEach(([c, t], k) => { s += `<rect x="${L + 10}" y="${T + 6 + k * 15}" width="14" height="3" fill="${c}"/><text x="${L + 30}" y="${T + 10 + k * 15}">${t}</text>`; });
  s += `<line x1="${X(Date.parse('2020-03-15'))}" x2="${X(Date.parse('2020-03-15'))}" y1="${T}" y2="${Hh - B}" stroke="#cf222e" stroke-dasharray="2 2"/><text x="${X(Date.parse('2020-03-15')) + 4}" y="${Hh - B - 6}" fill="#cf222e">COVID (empty stadiums)</text>`;
  return s + '</svg>\n';
}
// diagnostic only: every home half-life on the evaluation set (NOT used for any decision)
const gridDiag = Object.fromEntries(HLS.flatMap(h => [`C_${h}`, `D_${h}`]).map(k => { const m = metrics(ev, k); const sdh = sd(seasons.map(s => homeBias(ev.filter(r => r.season === s), k))); return [k, { log_loss: m.log_loss, brier: m.brier, ece: m.ece, draw_bias_pts: m.bias_pts[1], home_bias_pts: m.bias_pts[0], sd_season_home_bias_pts: +(sdh * 100).toFixed(3) }]; }));

const strip = m => { const { log_loss_exact, brier_exact, ...rest } = m; void log_loss_exact; void brier_exact; return rest; };
const report = { stage: DRY ? 'dry-run-on-dev (NOT the holdout)' : 'holdout', evaluated_split: EVAL, generated_at: new Date().toISOString(), protocol_id: PROTOCOL.id, protocol_sha256: PROTOCOL_SHA,
  dev_selection_sha256: fileSha(`${OUT}/dev-selection.json`), data_sha256: sha(raw), script_sha256: Object.fromEntries(SCRIPTS.map(p => [p, fileSha(p)])),
  selection: sel, prediction_hashes: frozen.prediction_hashes,
  reference_check: DRY ? null : (() => { const p2 = JSON.parse(readFileSync('docs/evidence/research/calibration-research-2026-09-28.json', 'utf8')).calibrated.holdout_pooled.poisson; return { phase2_strict_poisson: { log_loss: p2.log_loss, brier: p2.brier, ece: p2.ece }, A: { log_loss: pooled.A.log_loss, brier: pooled.A.brier, ece: pooled.A.ece }, match: p2.log_loss === pooled.A.log_loss && p2.brier === pooled.A.brier && p2.ece === pooled.A.ece }; })(),
  pooled: Object.fromEntries(KEYS.map(k => [k, strip(pooled[k])])),
  by_season: bySeason.map(s => ({ season: s.season, n: s.n, ...Object.fromEntries(KEYS.map(k => [k, { log_loss: s[k].log_loss, brier: s[k].brier, ece: s[k].ece, ece_class: s[k].ece_class, bias_pts: s[k].bias_pts, mean_pred: s[k].mean_pred, observed: s[k].observed }])) })),
  comparisons: cmp, verdicts, final_candidate: final, final_beats_baseline_every_season: final ? baselineEvery(final) : null, leakage_all_pass: leakOk, overall,
  draw_diagnostics: drawDiag, exact_score_distribution: scoreDist, home_away_by_season: homeDiag, home_advantage: homeAdvantage,
  diagnostic_only_all_home_half_lives_not_used_for_decisions: gridDiag,
  runtime_s: +((Date.now() - t0) / 1000).toFixed(1) };
const outFile = arg('--out') || (DRY ? null : `${OUT}/holdout-results.json`);
if (!outFile) throw new Error('--dry-run-on-dev needs --out <scratch file>');
writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n');
if (!DRY) writeFileSync(`${OUT}/home-advantage.svg`, svg());
console.log(JSON.stringify({ stage: report.stage, reference_check: report.reference_check, pooled: Object.fromEntries(KEYS.map(k => [k, { ll: pooled[k].log_loss, brier: pooled[k].brier, ece: pooled[k].ece, ece_class: pooled[k].ece_class, bias: pooled[k].bias_pts }])),
  comparisons: Object.fromEntries(Object.entries(cmp).map(([k, v]) => [k, { dLL: v.d_log_loss, dBr: v.d_brier, checks: v.checks, verdict: v.verdict, k3: v.K3_detail, worse: v.seasons_worse_by_more_than_0_002, improved: v.seasons_improved }])),
  verdicts, final, overall, runtime_s: report.runtime_s }, null, 1));
