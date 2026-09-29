#!/usr/bin/env node
// SOCCER ALGO V1 research: market validation + Official Pick policy for the frozen v1.2-dc model.
// Rules: scripts/research/algo-v1-protocol.mjs (declared and committed first, 05ff308).
//   node scripts/research/algo-v1-research.mjs --stage select
//       reproduces the frozen v1.2-dc predictions (hash 19b72fed...), computes SELECT-window (2006/07-2018/19)
//       market validation and every threshold's eligibility, selects the thresholds. Computes NO holdout
//       number. Writes docs/evidence/research/algo-v1/select-freeze.json.
//   node scripts/research/algo-v1-research.mjs --stage holdout
//       refuses to run unless the protocol hash is unchanged and the SELECT stage reproduces the committed
//       freeze exactly; then evaluates the holdout ONCE. Writes docs/evidence/research/algo-v1/holdout-results.json.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { SPLIT } from './model-core.mjs';
import { structuralSeries, dc1x2, dcGrid } from './structural-core.mjs';
import { brier as brier3 } from './metrics.mjs';
import { PROTOCOL } from './algo-v1-protocol.mjs';

const arg = k => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] ?? true; };
const STAGE = arg('--stage');
if (!['select', 'holdout'].includes(STAGE)) throw new Error('--stage select|holdout');
const OUT = 'docs/evidence/research/algo-v1';
const sha = s => createHash('sha256').update(s).digest('hex');
const PROTOCOL_SHA = sha(readFileSync('scripts/research/algo-v1-protocol.mjs'));
const SNAP = 'docs/evidence/research/frozen/bundesliga-results-snapshot.json';
const raw = readFileSync(SNAP, 'utf8');
const card = JSON.parse(readFileSync(PROTOCOL.frozen_model.card, 'utf8'));
if (sha(raw) !== card.data_sha256) throw new Error('snapshot differs from the frozen card');
if (card.rho !== PROTOCOL.frozen_model.rho || card.prediction_hash !== PROTOCOL.frozen_model.prediction_hash) throw new Error('card differs from the protocol');
const RHO = card.rho;
const r4 = x => (x === null || x === undefined ? null : +x.toFixed(4));
const matches = JSON.parse(raw).map(m => ({ ...m, t: Date.parse(m.kickoff_at), r: m.home_score > m.away_score ? 0 : m.home_score === m.away_score ? 1 : 2 }));

// ---------------------------------------------------------------- frozen predictions (Phase 4 row set)
const lam = structuralSeries(matches, { homeHl: 540 });
const rows = [];
matches.forEach((m, i) => {
  if (!lam[i] || m.season <= '2005/06') return;
  const { g, S } = dcGrid(lam[i].lh, lam[i].la, RHO);
  let over = 0; let h0 = 0; let a0 = 0; let both = 0;
  for (let a = 0; a <= 10; a++) for (let b = 0; b <= 10; b++) { const p = g[a * 11 + b] / S; if (a + b >= 3) over += p; if (a === 0) h0 += p; if (b === 0) a0 += p; if (a >= 1 && b >= 1) both += p; }
  rows.push({ id: m.id, season: m.season, split: SPLIT(m.season), hs: m.home_score, as: m.away_score, y: m.r, lh: lam[i].lh, la: lam[i].la,
    p1x2: dc1x2(lam[i].lh, lam[i].la, RHO), over_2_5: over, home_to_score: 1 - h0, away_to_score: 1 - a0, btts: both });
});
const reproduced = sha(JSON.stringify(rows.map(r => [r.id, ...r.p1x2.map(x => +x.toFixed(10))])));
if (reproduced !== PROTOCOL.frozen_model.prediction_hash) throw new Error(`frozen prediction hash not reproduced: ${reproduced}`);
const inScope = rows.filter(r => r.split !== 'live');

// ---------------------------------------------------------------- targets, baselines
const EVENT = { over_2_5: r => r.hs + r.as >= 3, home_to_score: r => r.hs >= 1, away_to_score: r => r.as >= 1, btts: r => r.hs >= 1 && r.as >= 1 };
const trainAll = matches.filter(m => SPLIT(m.season) === 'train');
const FREQ = [0, 1, 2].map(c => trainAll.filter(m => m.r === c).length / trainAll.length);
const RATE = Object.fromEntries(Object.entries(EVENT).map(([k, f]) => [k, trainAll.filter(m => f({ hs: m.home_score, as: m.away_score })).length / trainAll.length]));
const SEL3 = ['home', 'draw', 'away'];
// the market selection for a row: { sel, prob, hit, base } (base = train frequency of the selected outcome)
function pick(market, r) {
  if (market === '1x2') { const k = r.p1x2.indexOf(Math.max(...r.p1x2)); return { sel: SEL3[k], prob: r.p1x2[k], hit: r.y === k, base: FREQ[k] }; }
  const p = r[market]; const yes = p >= 0.5; const ev = EVENT[market](r);
  const sel = market === 'over_2_5' ? (yes ? 'over' : 'under') : yes ? 'yes' : 'no';
  return { sel, prob: yes ? p : 1 - p, hit: yes ? ev : !ev, base: yes ? RATE[market] : 1 - RATE[market] };
}
const eps = 1e-12;
const llBin = (p, y) => -Math.log(Math.max(eps, y ? p : 1 - p));
function scores(market, xs) {
  if (market === '1x2') return { ll: xs.reduce((a, r) => a - Math.log(Math.max(eps, r.p1x2[r.y])), 0) / xs.length, br: xs.reduce((a, r) => a + brier3(r.p1x2, r.y), 0) / xs.length, bll: xs.reduce((a, r) => a - Math.log(FREQ[r.y]), 0) / xs.length, bbr: xs.reduce((a, r) => a + brier3(FREQ, r.y), 0) / xs.length };
  const f = EVENT[market]; const b = RATE[market];
  return { ll: xs.reduce((a, r) => a + llBin(r[market], f(r)), 0) / xs.length, br: xs.reduce((a, r) => a + (r[market] - (f(r) ? 1 : 0)) ** 2, 0) / xs.length, bll: xs.reduce((a, r) => a + llBin(b, f(r)), 0) / xs.length, bbr: xs.reduce((a, r) => a + (b - (f(r) ? 1 : 0)) ** 2, 0) / xs.length };
}
const seasons = xs => [...new Set(xs.map(r => r.season))].sort();
function validate(market, xs) {
  const pooled = scores(market, xs);
  const per = seasons(xs).map(s => { const q = scores(market, xs.filter(r => r.season === s)); return { season: s, n: xs.filter(r => r.season === s).length, log_loss: r4(q.ll), baseline_log_loss: r4(q.bll), brier: r4(q.br), baseline_brier: r4(q.bbr), beats_log_loss: q.ll < q.bll }; });
  const rel = []; for (let b = 0; b < 10; b++) { const ys = xs.filter(r => { const p = market === '1x2' ? r.p1x2[0] : r[market]; return Math.min(9, Math.floor(p * 10)) === b; }); if (ys.length) rel.push({ band: `${b / 10}-${(b + 1) / 10}`, n: ys.length, predicted: r4(ys.reduce((a, r) => a + (market === '1x2' ? r.p1x2[0] : r[market]), 0) / ys.length), observed: r4(ys.filter(r => (market === '1x2' ? r.y === 0 : EVENT[market](r))).length / ys.length) }); }
  return { n: xs.length, log_loss: r4(pooled.ll), baseline_log_loss: r4(pooled.bll), brier: r4(pooled.br), baseline_brier: r4(pooled.bbr), seasons_beating_baseline_log_loss: per.filter(s => s.beats_log_loss).length, seasons: per.length, per_season: per, reliability: market === '1x2' ? { class: 'home', bands: rel } : { bands: rel }, _pass: pooled.ll < pooled.bll && pooled.br < pooled.bbr };
}
const wilsonLo = (k, n, z = 1.96) => { if (!n) return null; const p = k / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n); };
function pickStats(market, xs, t) {
  const ps = xs.map(r => ({ r, ...pick(market, r) })).filter(x => x.prob >= t);
  const n = ps.length; const k = ps.filter(x => x.hit).length;
  const per = seasons(xs).map(s => { const q = ps.filter(x => x.r.season === s); return { season: s, picks: q.length, hit_rate: q.length ? r4(q.filter(x => x.hit).length / q.length) : null, mean_prob: q.length ? r4(q.reduce((a, x) => a + x.prob, 0) / q.length) : null }; });
  return { threshold: t, picks: n, coverage: r4(n / xs.length), hits: k, hit_rate: n ? r4(k / n) : null, mean_prob: n ? r4(ps.reduce((a, x) => a + x.prob, 0) / n) : null, wilson_lo: r4(wilsonLo(k, n)), baseline_rate: n ? r4(ps.reduce((a, x) => a + x.base, 0) / n) : null,
    brier: n ? r4(ps.reduce((a, x) => a + (x.prob - (x.hit ? 1 : 0)) ** 2, 0) / n) : null, log_loss: n ? r4(ps.reduce((a, x) => a + llBin(x.prob, x.hit), 0) / n) : null,
    selections: Object.fromEntries([...new Set(ps.map(x => x.sel))].map(s => [s, ps.filter(x => x.sel === s).length])), per_season: per };
}
const grid = market => { const [lo, hi] = market === '1x2' ? [0.5, 0.8] : [0.6, 0.9]; const out = []; for (let k = 0; lo + k * 0.025 <= hi + 1e-9; k++) out.push(+(lo + k * 0.025).toFixed(3)); return out; };
function eligibility(s, nRows) {
  const valid = s.per_season.filter(x => x.picks >= 10);
  const e = {
    E1_coverage: s.picks >= 0.05 * nRows,
    E2_calibration: s.picks > 0 && Math.abs(s.hit_rate - s.mean_prob) <= 0.025,
    E3_durability: valid.every(x => x.hit_rate >= x.mean_prob - 0.10) && valid.filter(x => x.hit_rate < x.mean_prob - 0.05).length <= 2,
    E4_floor: s.wilson_lo !== null && s.wilson_lo >= 0.5,
    E5_lift: s.picks > 0 && s.hit_rate - s.baseline_rate >= 0.05,
  };
  return { ...e, eligible: Object.values(e).every(Boolean) };
}

// ---------------------------------------------------------------- SELECT stage (no holdout number is computed)
function selectStage() {
  const sel = inScope.filter(r => r.split === 'train' || r.split === 'dev');
  const out = { protocol: PROTOCOL.id, protocol_sha256: PROTOCOL_SHA, snapshot_sha256: sha(raw), frozen_prediction_hash_reproduced: reproduced, rows: { select: sel.length, seasons: seasons(sel) }, baselines: { '1x2': FREQ.map(r4), binary_rates: Object.fromEntries(Object.entries(RATE).map(([k, v]) => [k, r4(v)])) }, markets: {} };
  for (const market of Object.keys(PROTOCOL.markets)) {
    const v = validate(market, sel);
    const gateSelect = v._pass && v.seasons_beating_baseline_log_loss >= 11; delete v._pass;
    const table = grid(market).map(t => { const s = pickStats(market, sel, t); return { ...s, eligibility: eligibility(s, sel.length) }; });
    const eligible = table.filter(x => x.eligibility.eligible);
    const chosen = PROTOCOL.markets[market].eligible_for_v1_picks && gateSelect && eligible.length ? eligible[0].threshold : null;
    out.markets[market] = { eligible_for_v1_picks: PROTOCOL.markets[market].eligible_for_v1_picks, validation_select: v, gate_select: gateSelect, thresholds: table, selected_threshold: chosen, reason: chosen !== null ? 'lowest eligible threshold' : !PROTOCOL.markets[market].eligible_for_v1_picks ? 'not eligible for V1 picks under the protocol' : !gateSelect ? 'market fails the SELECT validation gate' : 'no eligible threshold' };
  }
  out.combined_select = combined(sel, out);
  out.freeze_sha256 = sha(JSON.stringify(out));
  return out;
}
// one Official Pick per match + Game Best (per_match_policy)
function combined(xs, sel) {
  const mk = Object.entries(sel.markets).filter(([, m]) => m.selected_threshold !== null).map(([k, m]) => [k, m.selected_threshold]);
  const off = []; let gb = 0;
  for (const r of xs) {
    const cands = mk.map(([k, t], order) => ({ k, t, order, ...pick(k, r) })).map(c => ({ ...c, margin: c.prob - c.t })).sort((a, b) => b.margin - a.margin || a.order - b.order);
    if (!cands.length) continue; gb++;
    if (cands[0].margin >= 0) off.push(cands[0]);
  }
  const n = off.length; const k = off.filter(x => x.hit).length;
  return { markets: mk.map(([k2, t]) => `${k2}>=${t}`), matches: xs.length, game_best: gb, official_picks: n, coverage: r4(n / xs.length), hit_rate: n ? r4(k / n) : null, mean_prob: n ? r4(off.reduce((a, x) => a + x.prob, 0) / n) : null, wilson_lo: r4(wilsonLo(k, n)), baseline_rate: n ? r4(off.reduce((a, x) => a + x.base, 0) / n) : null, by_market: Object.fromEntries(mk.map(([m]) => [m, off.filter(x => x.k === m).length])) };
}

mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const sel = selectStage();
if (STAGE === 'select') {
  writeFileSync(`${OUT}/select-freeze.json`, `${JSON.stringify(sel, null, 2)}\n`);
  console.log('SELECT frozen', sel.freeze_sha256, JSON.stringify(Object.fromEntries(Object.entries(sel.markets).map(([k, m]) => [k, { gate: m.gate_select, t: m.selected_threshold, reason: m.reason }]))), `${Date.now() - t0} ms`);
} else {
  const frozen = JSON.parse(readFileSync(`${OUT}/select-freeze.json`, 'utf8'));
  if (frozen.protocol_sha256 !== PROTOCOL_SHA) throw new Error('protocol changed since the SELECT freeze');
  if (frozen.freeze_sha256 !== sel.freeze_sha256) throw new Error('SELECT stage does not reproduce the committed freeze');
  if (existsSync(`${OUT}/holdout-results.json`)) throw new Error('holdout already evaluated: the holdout is evaluated ONCE (holdout-results.json exists)');
  const ho = inScope.filter(r => r.split === 'holdout');
  const res = { protocol_sha256: PROTOCOL_SHA, select_freeze_sha256: frozen.freeze_sha256, evaluated_at: new Date().toISOString(), rows: { holdout: ho.length, seasons: seasons(ho) }, markets: {}, v1_markets: [] };
  for (const [market, m] of Object.entries(sel.markets)) {
    const v = validate(market, ho); const gateHoldout = v._pass && v.seasons_beating_baseline_log_loss >= 6; delete v._pass;
    const entry = { validation_holdout: v, gate_holdout: gateHoldout };
    if (m.selected_threshold !== null) {
      const s = pickStats(market, ho, m.selected_threshold);
      const valid = s.per_season.filter(x => x.picks >= 10);
      const H = { H1_calibration: s.picks > 0 && Math.abs(s.hit_rate - s.mean_prob) <= 0.04, H2_floor: s.wilson_lo !== null && s.wilson_lo >= 0.5, H3_lift: s.picks > 0 && s.hit_rate - s.baseline_rate >= 0.03, H4_durability: valid.filter(x => x.hit_rate >= x.mean_prob - 0.08).length >= 5 };
      entry.picks_holdout = s; entry.holdout_rule = H; entry.in_v1 = gateHoldout && Object.values(H).every(Boolean);
      if (entry.in_v1) res.v1_markets.push({ market, threshold: m.selected_threshold });
    }
    res.markets[market] = entry;
  }
  const v1 = { markets: Object.fromEntries(res.v1_markets.map(x => [x.market, { selected_threshold: x.threshold }])) };
  res.combined_holdout_v1_markets = combined(ho, v1);
  writeFileSync(`${OUT}/holdout-results.json`, `${JSON.stringify(res, null, 2)}\n`);
  console.log('HOLDOUT', JSON.stringify(res.v1_markets), JSON.stringify(res.combined_holdout_v1_markets), `${Date.now() - t0} ms`);
}
