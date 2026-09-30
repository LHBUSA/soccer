#!/usr/bin/env node
// SOCCER ALGO V2 research (national teams). Rules: scripts/research/algo-v2-protocol.mjs (committed c4f3520 first).
//   node scripts/research/algo-v2-research.mjs --stage select
//       walk-forward predictions, hyper-parameter + rho selection, SELECT market validation and threshold
//       eligibility. Computes NO holdout number. Writes docs/evidence/research/algo-v2/select-freeze.json.
//   node scripts/research/algo-v2-research.mjs --stage holdout
//       refuses unless the protocol and dataset hashes are unchanged and SELECT reproduces the committed freeze
//       exactly, and refuses if holdout-results.json exists; evaluates the holdout ONCE.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fitRho, dcGrid } from './structural-core.mjs';
import { ntPredict, marketsFrom } from './national-core.mjs';
import { PROTOCOL } from './algo-v2-protocol.mjs';

const arg = k => { const i = process.argv.indexOf(k); return i < 0 ? null : process.argv[i + 1] ?? true; };
const STAGE = arg('--stage');
if (!['select', 'holdout'].includes(STAGE)) throw new Error('--stage select|holdout');
const OUT = 'docs/evidence/research/algo-v2';
const sha = s => createHash('sha256').update(s).digest('hex');
const PROTOCOL_SHA = sha(readFileSync('scripts/research/algo-v2-protocol.mjs'));
const DATA = `${OUT}/national-dataset.json`;
const dataRaw = readFileSync(DATA, 'utf8');
const { manifest, rows: dataRows } = JSON.parse(dataRaw);
if (sha(JSON.stringify(dataRows)) !== manifest.rows_sha256) throw new Error('dataset rows do not match their manifest hash');
const r4 = x => (x === null || x === undefined ? null : +x.toFixed(4));
const WARM_END = Date.parse('2020-09-01T00:00:00Z'); const SELECT_END = Date.parse('2024-09-01T00:00:00Z');
const splitOf = t => (t < WARM_END ? 'warmup' : t < SELECT_END ? 'select' : 'holdout');
// neutral_site unknown (null) is treated as NOT neutral (ESPN's default); counted in the freeze.
const list = dataRows.map(r => ({ ...r, t: Date.parse(r.kickoff_at), neutral: r.neutral_site === true, split: splitOf(Date.parse(r.kickoff_at)), primary: r.competition_id === 'uefa-nations-league' && r.stage_type === 'group', hs: r.home_score, as: r.away_score, y: r.home_score > r.away_score ? 0 : r.home_score === r.away_score ? 1 : 2 }));
const P = PROTOCOL;

// ---------------------------------------------------------------- baselines (window strictly before the split)
const EVENT = { over_2_5: r => r.hs + r.as >= 3, home_to_score: r => r.hs >= 1, away_to_score: r => r.as >= 1, btts: r => r.hs >= 1 && r.as >= 1 };
function baseRates(win) {
  const f = xs => [0, 1, 2].map(c => xs.filter(r => r.y === c).length / xs.length);
  const nonN = win.filter(r => !r.neutral); const neu = win.filter(r => r.neutral);
  const fn = f(nonN); const sym = v => [(v[0] + v[2]) / 2, v[1], (v[0] + v[2]) / 2];
  const rate = (xs, e) => xs.filter(e).length / xs.length;
  const cond = xs => Object.fromEntries(Object.entries(EVENT).map(([k, e]) => [k, rate(xs, e)]));
  return {
    x12: { non_neutral: fn, neutral: neu.length >= 30 ? sym(f(neu)) : sym(fn), neutral_basis: neu.length >= 30 ? `${neu.length} neutral matches` : `fewer than 30 neutral matches (${neu.length}): symmetrised non-neutral` },
    binary: cond(win), binary_cond: { non_neutral: cond(nonN), neutral: neu.length >= 30 ? cond(neu) : cond(win) },
    window: { rows: win.length, non_neutral: nonN.length, neutral: neu.length },
  };
}
const SEL3 = ['home', 'draw', 'away'];
const eps = 1e-12;
const llBin = (p, y) => -Math.log(Math.max(eps, y ? p : 1 - p));
const brier3 = (p, y) => p.reduce((a, x, i) => a + (x - (i === y ? 1 : 0)) ** 2, 0);
function pickOf(market, r, B) {
  const bx = r.neutral ? B.x12.neutral : B.x12.non_neutral; const bc = r.neutral ? B.binary_cond.neutral : B.binary_cond.non_neutral;
  if (market === '1x2') { const p = r.p1x2; const k = p.indexOf(Math.max(...p)); return { sel: SEL3[k], prob: p[k], hit: r.y === k, base: bx[k] }; }
  const p = r[market]; const yes = p >= 0.5; const ev = EVENT[market](r);
  return { sel: market === 'over_2_5' ? (yes ? 'over' : 'under') : yes ? 'yes' : 'no', prob: yes ? p : 1 - p, hit: yes ? ev : !ev, base: yes ? bc[market] : 1 - bc[market] };
}
function scores(market, xs, B) {
  const bx = r => (r.neutral ? B.x12.neutral : B.x12.non_neutral);
  if (market === '1x2') return { ll: xs.reduce((a, r) => a - Math.log(Math.max(eps, r.p1x2[r.y])), 0) / xs.length, br: xs.reduce((a, r) => a + brier3(r.p1x2, r.y), 0) / xs.length, bll: xs.reduce((a, r) => a - Math.log(bx(r)[r.y]), 0) / xs.length, bbr: xs.reduce((a, r) => a + brier3(bx(r), r.y), 0) / xs.length };
  const e = EVENT[market]; const b = B.binary[market];
  return { ll: xs.reduce((a, r) => a + llBin(r[market], e(r)), 0) / xs.length, br: xs.reduce((a, r) => a + (r[market] - (e(r) ? 1 : 0)) ** 2, 0) / xs.length, bll: xs.reduce((a, r) => a + llBin(b, e(r)), 0) / xs.length, bbr: xs.reduce((a, r) => a + (b - (e(r) ? 1 : 0)) ** 2, 0) / xs.length };
}
const seasonsOf = xs => [...new Set(xs.map(r => r.season_id))].sort();
function reliability(market, xs) {
  const val = r => (market === '1x2' ? r.p1x2[0] : r[market]); const obs = r => (market === '1x2' ? r.y === 0 : EVENT[market](r));
  const s = [...xs].sort((a, b) => val(a) - val(b)); const bins = []; let ece = 0;
  for (let b = 0; b < 10; b++) { const ys = s.slice(Math.floor(b * s.length / 10), Math.floor((b + 1) * s.length / 10)); if (!ys.length) continue; const p = ys.reduce((a, r) => a + val(r), 0) / ys.length; const o = ys.filter(obs).length / ys.length; ece += ys.length / s.length * Math.abs(p - o); bins.push({ n: ys.length, predicted: r4(p), observed: r4(o) }); }
  return { class: market === '1x2' ? 'home' : 'event', bins, ece: r4(ece) };
}
function validate(market, xs, B) {
  const q = scores(market, xs, B);
  const per = seasonsOf(xs).map(s => { const ys = xs.filter(r => r.season_id === s); const z = scores(market, ys, B); return { season: s, n: ys.length, log_loss: r4(z.ll), baseline_log_loss: r4(z.bll), brier: r4(z.br), baseline_brier: r4(z.bbr), beats_log_loss: z.ll < z.bll }; });
  return { n: xs.length, log_loss: r4(q.ll), baseline_log_loss: r4(q.bll), brier: r4(q.br), baseline_brier: r4(q.bbr), beats_pooled: q.ll < q.bll && q.br < q.bbr, per_season: per, reliability: reliability(market, xs) };
}
const wilsonLo = (k, n, z = 1.96) => { if (!n) return null; const p = k / n; return (p + z * z / (2 * n) - z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))) / (1 + z * z / n); };
function pickStats(market, xs, t, B) {
  const ps = xs.map(r => ({ r, ...pickOf(market, r, B) })).filter(x => x.prob >= t);
  const n = ps.length; const k = ps.filter(x => x.hit).length;
  const per = seasonsOf(xs).map(s => { const q = ps.filter(x => x.r.season_id === s); return { season: s, picks: q.length, hit_rate: q.length ? r4(q.filter(x => x.hit).length / q.length) : null, mean_prob: q.length ? r4(q.reduce((a, x) => a + x.prob, 0) / q.length) : null }; });
  return { threshold: t, picks: n, coverage: r4(n / xs.length), hits: k, hit_rate: n ? r4(k / n) : null, mean_prob: n ? r4(ps.reduce((a, x) => a + x.prob, 0) / n) : null, wilson_lo: r4(wilsonLo(k, n)), baseline_rate: n ? r4(ps.reduce((a, x) => a + x.base, 0) / n) : null, selections: Object.fromEntries([...new Set(ps.map(x => x.sel))].map(s => [s, ps.filter(x => x.sel === s).length])), per_season: per };
}
const grid = market => { const [lo, hi] = market === '1x2' ? [0.5, 0.8] : [0.6, 0.9]; const out = []; for (let i = 0; lo + i * 0.025 <= hi + 1e-9; i++) out.push(+(lo + i * 0.025).toFixed(3)); return out; };
const TOP = market => (market === '1x2' ? 0.8 : 0.9);
function combined(xs, active, B) {
  const off = []; const gb = [];
  const all = Object.keys(P.markets).filter(k => P.markets[k].eligible);
  for (const r of xs) {
    const cands = all.map((k, order) => ({ k, order, t: active[k] ?? TOP(k), active: k in active, ...pickOf(k, r, B) })).map(c => ({ ...c, margin: c.prob - c.t })).sort((a, b) => b.margin - a.margin || a.order - b.order);
    gb.push(cands[0]);
    const q = cands.filter(c => c.active)[0];
    if (q && q.margin >= 0) off.push(q);
  }
  const n = off.length; const k = off.filter(x => x.hit).length;
  return { markets: Object.entries(active).map(([m, t]) => `${m}>=${t}`), matches: xs.length, game_best: gb.length, official_picks: n, coverage: r4(n / xs.length), hits: k, hit_rate: n ? r4(k / n) : null, mean_prob: n ? r4(off.reduce((a, x) => a + x.prob, 0) / n) : null, wilson_lo: r4(wilsonLo(k, n)), baseline_rate: n ? r4(off.reduce((a, x) => a + x.base, 0) / n) : null, by_market: Object.fromEntries(Object.keys(active).map(m => [m, off.filter(x => x.k === m).length])) };
}

// ---------------------------------------------------------------- walk-forward predictions
function predictAll(hl, k) {
  const out = new Map();
  for (const m of list) { if (m.split === 'warmup') continue; const p = ntPredict(list, m, { hl, k }); if (p) out.set(m.match_key, p); }
  return out;
}
function withMarkets(xs, preds, rho) {
  return xs.filter(r => preds.has(r.match_key)).map(r => { const p = preds.get(r.match_key); const mk = marketsFrom(p.lh, p.la, rho); return { ...r, lh: p.lh, la: p.la, home_factor: p.home_factor, p1x2: [mk['1x2'].home, mk['1x2'].draw, mk['1x2'].away], over_2_5: mk.over_2_5, home_to_score: mk.home_to_score, away_to_score: mk.away_to_score, btts: mk.btts }; });
}

function selectStage() {
  const t0 = Date.now();
  const selPrimary = list.filter(r => r.split === 'select' && r.primary);
  const B = baseRates(list.filter(r => r.split === 'warmup'));
  // 1. hyper-parameters on the common predicted SELECT primary rows, rho = 0
  const G = P.model.grid; const cand = [];
  for (const hl of G.half_life_days) for (const k of G.shrink_k) cand.push({ hl, k, preds: predictAll(hl, k) });
  const common = selPrimary.filter(r => cand.every(c => c.preds.has(r.match_key)));
  const gridOut = cand.map(c => { const xs = withMarkets(common, c.preds, 0); const s = scores('1x2', xs, B); return { half_life_days: c.hl, shrink_k: c.k, log_loss_1x2: r4(s.ll), log_loss_exact: s.ll }; });
  const best = [...gridOut].sort((a, b) => a.log_loss_exact - b.log_loss_exact)[0];
  const chosen = cand.find(c => c.hl === best.half_life_days && c.k === best.shrink_k);
  // 2. rho on SELECT primary rows at the chosen parameters
  const selRows0 = withMarkets(selPrimary, chosen.preds, 0);
  const rho = fitRho(selRows0.map(r => ({ lh: r.lh, la: r.la, hs: r.hs, as: r.as }))).rho;
  const sel = withMarkets(selPrimary, chosen.preds, rho);
  // home effect report: log likelihood of the SELECT primary non-neutral scorelines with H vs H = 1
  const ll = (lh, la, hs, as) => { const { g, S } = dcGrid(lh, la, rho); return Math.log(Math.max(1e-300, g[Math.min(10, hs) * 11 + Math.min(10, as)] / S)); };
  const nn = sel.filter(r => !r.neutral);
  const homeReport = { rows_non_neutral: nn.length, mean_home_factor: r4(nn.reduce((a, r) => a + r.home_factor, 0) / (nn.length || 1)), loglik_with_H: r4(nn.reduce((a, r) => a + ll(r.lh, r.la, r.hs, r.as), 0)), loglik_H_equals_1: r4(nn.reduce((a, r) => a + ll(r.lh / r.home_factor, r.la * r.home_factor, r.hs, r.as), 0)) };
  const out = {
    protocol: P.id, protocol_sha256: PROTOCOL_SHA, dataset_sha256: manifest.rows_sha256, dataset_rows: list.length,
    neutral_unknown_treated_as_not_neutral: list.filter(r => r.neutral_site === null).length,
    rows: { warmup: list.filter(r => r.split === 'warmup').length, select_all: list.filter(r => r.split === 'select').length, select_primary: selPrimary.length, select_primary_predicted: sel.length, select_primary_common_grid_rows: common.length, seasons: seasonsOf(sel) },
    grid: gridOut.map(({ log_loss_exact, ...g }) => g), chosen: { half_life_days: chosen.hl, shrink_k: chosen.k, rho }, home_effect_select: homeReport,
    baselines: { '1x2': { non_neutral: B.x12.non_neutral.map(r4), neutral: B.x12.neutral.map(r4), neutral_basis: B.x12.neutral_basis }, binary: Object.fromEntries(Object.entries(B.binary).map(([k, v]) => [k, r4(v)])), window: B.window },
    markets: {},
  };
  const select_seasons = ['uefa.nations:2020', 'uefa.nations:2022'];
  const active = {};
  for (const market of Object.keys(P.markets)) {
    const v = validate(market, sel, B);
    const gate = v.beats_pooled && select_seasons.every(s => v.per_season.find(x => x.season === s)?.beats_log_loss);
    const table = grid(market).map(t => { const s = pickStats(market, sel, t, B); const e = { E0_market: gate && P.markets[market].eligible, E1_coverage: s.picks >= 0.05 * sel.length, E2_calibration: s.picks > 0 && s.hit_rate >= s.mean_prob - 0.025, E3_volume: s.picks >= 30, E4_floor: s.wilson_lo !== null && s.wilson_lo >= 0.5, E5_lift: s.picks > 0 && s.hit_rate - s.baseline_rate >= 0.10 }; return { ...s, eligibility: { ...e, eligible: Object.values(e).every(Boolean) } }; });
    const eligible = table.filter(x => x.eligibility.eligible);
    const capped = eligible.find(x => combined(sel, { ...active, [market]: x.threshold }, B).coverage <= 0.20);
    const chosenT = capped ? capped.threshold : null;
    if (chosenT !== null) active[market] = chosenT;
    out.markets[market] = { eligible: P.markets[market].eligible, validation_select: v, gate_select: gate, thresholds: table, selected_threshold: chosenT, reason: chosenT !== null ? 'lowest eligible threshold with combined coverage <= 0.20' : !P.markets[market].eligible ? 'research only (not eligible)' : !gate ? 'market fails the SELECT validation gate' : eligible.length ? 'no eligible threshold within the combined coverage cap' : 'no eligible threshold' };
  }
  out.active_select = active;
  out.combined_select = combined(sel, active, B);
  out.secondary_select = { all_national_rows: withMarkets(list.filter(r => r.split === 'select'), chosen.preds, rho).length, validation_1x2: validate('1x2', withMarkets(list.filter(r => r.split === 'select'), chosen.preds, rho), B) };
  out.prediction_hash = sha(JSON.stringify(sel.map(r => [r.match_key, ...r.p1x2.map(x => +x.toFixed(10))])));
  out.elapsed_ms = Date.now() - t0;
  out.freeze_sha256 = sha(JSON.stringify({ ...out, elapsed_ms: null }));
  return { out, chosen, rho, active };
}

const { out: sel, chosen, rho, active } = selectStage();
if (STAGE === 'select') {
  writeFileSync(`${OUT}/select-freeze.json`, `${JSON.stringify(sel, null, 2)}\n`);
  console.log('SELECT frozen', sel.freeze_sha256, JSON.stringify(sel.chosen), JSON.stringify(Object.fromEntries(Object.entries(sel.markets).map(([k, m]) => [k, { gate: m.gate_select, t: m.selected_threshold, reason: m.reason }]))));
} else {
  const frozen = JSON.parse(readFileSync(`${OUT}/select-freeze.json`, 'utf8'));
  if (frozen.protocol_sha256 !== PROTOCOL_SHA) throw new Error('protocol changed since the SELECT freeze');
  if (frozen.dataset_sha256 !== manifest.rows_sha256) throw new Error('dataset changed since the SELECT freeze');
  if (frozen.freeze_sha256 !== sel.freeze_sha256) throw new Error('SELECT stage does not reproduce the committed freeze');
  if (existsSync(`${OUT}/holdout-results.json`)) throw new Error('holdout already evaluated: evaluated ONCE (holdout-results.json exists)');
  const B = baseRates(list.filter(r => r.split !== 'holdout'));
  const hoAll = withMarkets(list.filter(r => r.split === 'holdout'), chosen.preds, rho);
  const ho = hoAll.filter(r => r.primary);
  const unlSeasons = seasonsOf(ho);
  const res = { protocol_sha256: PROTOCOL_SHA, select_freeze_sha256: frozen.freeze_sha256, dataset_sha256: manifest.rows_sha256, evaluated_at: new Date().toISOString(), rows: { holdout_primary: ho.length, holdout_primary_unpredicted: list.filter(r => r.split === 'holdout' && r.primary).length - ho.length, holdout_all: hoAll.length, seasons: unlSeasons },
    baselines: { '1x2': { non_neutral: B.x12.non_neutral.map(r4), neutral: B.x12.neutral.map(r4) }, binary: Object.fromEntries(Object.entries(B.binary).map(([k, v]) => [k, r4(v)])), window: B.window },
    home_effect_holdout: { mean_home_factor: r4(ho.filter(r => !r.neutral).reduce((a, r) => a + r.home_factor, 0) / (ho.filter(r => !r.neutral).length || 1)) }, markets: {}, v2_markets: [] };
  for (const market of Object.keys(P.markets)) {
    const v = validate(market, ho, B); const gate = v.beats_pooled;
    const entry = { validation_holdout: v, gate_holdout: gate };
    const t = frozen.markets[market].selected_threshold;
    if (t !== null) {
      const s = pickStats(market, ho, t, B);
      const H = { H0_market: gate, H1_calibration: s.picks > 0 && s.hit_rate >= s.mean_prob - 0.04, H2_floor: s.wilson_lo !== null && s.wilson_lo >= 0.5, H3_lift: s.picks > 0 && s.hit_rate - s.baseline_rate >= 0.08, H4_volume: s.picks >= 20, H5_durability: s.per_season.filter(x => x.picks >= 10).every(x => x.hit_rate >= x.mean_prob - 0.10) };
      entry.picks_holdout = s; entry.holdout_rule = H; entry.active_in_v2 = Object.values(H).every(Boolean);
      if (entry.active_in_v2) res.v2_markets.push({ market, threshold: t });
    }
    res.markets[market] = entry;
  }
  res.display_gate = { rule: P.market_validation.display_gate, select: frozen.markets['1x2'].gate_select, holdout: res.markets['1x2'].gate_holdout, pass: frozen.markets['1x2'].gate_select && res.markets['1x2'].gate_holdout };
  res.combined_holdout_v2_markets = combined(ho, Object.fromEntries(res.v2_markets.map(x => [x.market, x.threshold])), B);
  res.secondary_holdout = { rows: hoAll.length, validation_1x2: validate('1x2', hoAll, B), world_cup_2026_1x2: validate('1x2', hoAll.filter(r => r.season_id === 'fifa.world:2026'), B) };
  res.official_picks = res.v2_markets.length ? 'ACTIVE for the listed markets (UNL group matches)' : 'NONE: no market passed H0-H5; V2 has no Official Picks';
  writeFileSync(`${OUT}/holdout-results.json`, `${JSON.stringify(res, null, 2)}\n`);
  console.log('HOLDOUT', JSON.stringify(res.v2_markets), 'display', JSON.stringify(res.display_gate), JSON.stringify(res.combined_holdout_v2_markets));
}
