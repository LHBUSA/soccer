#!/usr/bin/env node
// Soccer prediction RESEARCH (never shipped from here). Chronological, leakage-free.
//   node scripts/research/model-research.mjs
// Data: Bundesliga canonical results, all stored seasons (read-only, production store).
// Splits (declared before looking at results):
//   train   2004/05 .. 2013/14   fit mapping parameters
//   dev     2014/15 .. 2018/19   choose hyperparameters (Elo K / home edge, Poisson half-life / shrink)
//   holdout 2019/20 .. 2025/26   reported once, season by season (2026/27 partial reported separately)
// Every feature for match m uses ONLY matches that kicked off before m.
// Declared baseline: training-set outcome frequencies (1X2) / event rates (binary).
// A model "passes" only if it beats the baseline on the holdout (log loss AND Brier).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: 'bundesliga' }, limit: 1 });
const seasons = new Map((await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: comp.id } })).map(s => [s.id, s.label]));
const league = new Set((await store.select('soccer_stages', { columns: ['id', 'season_id', 'stage_type'], in: { season_id: [...seasons.keys()] } })).filter(s => s.stage_type === 'league').map(s => s.id));
const matches = (await store.select('soccer_matches', { columns: ['id', 'season_id', 'stage_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'status'], eq: { competition_id: comp.id, status: 'finished' }, order: 'kickoff_at.asc' }))
  .filter(m => m.home_score !== null && m.away_score !== null && league.has(m.stage_id))
  .map(m => ({ ...m, season: seasons.get(m.season_id), t: Date.parse(m.kickoff_at), r: m.home_score > m.away_score ? 0 : m.home_score === m.away_score ? 1 : 2 }))
  .sort((a, b) => a.t - b.t);
console.log('matches', matches.length, 'seasons', new Set(matches.map(m => m.season)).size);
const split = s => (s <= '2013/14' ? 'train' : s <= '2018/19' ? 'dev' : s <= '2025/26' ? 'holdout' : 'live');

// ---------- metrics ----------
const eps = 1e-12;
const ll3 = (p, r) => -Math.log(Math.max(eps, p[r]));
const brier3 = (p, r) => p.reduce((a, x, i) => a + (x - (i === r ? 1 : 0)) ** 2, 0);
const llb = (p, y) => -Math.log(Math.max(eps, y ? p : 1 - p));
const brb = (p, y) => (p - (y ? 1 : 0)) ** 2;
function summarize(rows, key) {
  const n = rows.length; if (!n) return null;
  const out = { n };
  if (key === '1x2') {
    out.log_loss = rows.reduce((a, x) => a + ll3(x.p, x.y), 0) / n;
    out.brier = rows.reduce((a, x) => a + brier3(x.p, x.y), 0) / n;
    out.accuracy = rows.filter(x => x.p.indexOf(Math.max(...x.p)) === x.y).length / n;
    // calibration of P(home win) in 10 bins
    out.calibration_home = Array.from({ length: 10 }, (_, b) => { const xs = rows.filter(x => Math.min(9, Math.floor(x.p[0] * 10)) === b); return xs.length ? { bin: `${b / 10}-${(b + 1) / 10}`, n: xs.length, predicted: +(xs.reduce((a, x) => a + x.p[0], 0) / xs.length).toFixed(3), observed: +(xs.filter(x => x.y === 0).length / xs.length).toFixed(3) } : null; }).filter(Boolean);
  } else {
    out.log_loss = rows.reduce((a, x) => a + llb(x.p, x.y), 0) / n;
    out.brier = rows.reduce((a, x) => a + brb(x.p, x.y), 0) / n;
    out.accuracy = rows.filter(x => (x.p >= 0.5) === !!x.y).length / n;
  }
  for (const k of ['log_loss', 'brier', 'accuracy']) out[k] = +out[k].toFixed(4);
  return out;
}

// ---------- Elo (pre-match rating, updated after the result) ----------
function eloSeries(K, homeEdge, carry = 2 / 3) {
  const R = new Map(); let season = null; const out = [];
  for (const m of matches) {
    if (m.season !== season) { for (const [k, v] of R) R.set(k, 1500 + (v - 1500) * carry); season = m.season; }
    const rh = R.get(m.home_team_id) ?? 1500; const ra = R.get(m.away_team_id) ?? 1500;
    out.push(rh + homeEdge - ra); // feature BEFORE the result
    const e = 1 / (1 + 10 ** (-(rh + homeEdge - ra) / 400));
    const s = m.r === 0 ? 1 : m.r === 1 ? 0.5 : 0;
    const gd = Math.abs(m.home_score - m.away_score); const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    R.set(m.home_team_id, rh + K * mult * (s - e)); R.set(m.away_team_id, ra - K * mult * (s - e));
  }
  return out;
}
// Ordered logit on the Elo difference: P(away)=σ(c1 - a·d), P(away or draw)=σ(c2 - a·d)
const sig = x => 1 / (1 + Math.exp(-x));
const ologit = (d, [a, c1, c2]) => { const pA = sig(c1 - a * d); const pAD = sig(c2 - a * d); return [1 - pAD, Math.max(eps, pAD - pA), pA]; };
function fitOlogit(ds, ys) {
  let best = null;
  for (let a = 0.002; a <= 0.012; a += 0.0005) for (let c1 = -2; c1 <= 0; c1 += 0.05) for (let gap = 0.6; gap <= 1.6; gap += 0.05) {
    const th = [a, c1, c1 + gap]; let l = 0;
    for (let i = 0; i < ds.length; i++) l += ll3(ologit(ds[i], th), ys[i]);
    if (!best || l < best.l) best = { l, th };
  }
  return best.th;
}

// ---------- time-decayed Poisson team strengths ----------
function poissonSeries(halfLifeDays, shrink) {
  const hist = []; const out = [];
  for (const m of matches) {
    const w = x => 0.5 ** ((m.t - x.t) / (halfLifeDays * 86400e3));
    let hg = 0; let ag = 0; let W = 0;
    const team = new Map();
    const T = id => { if (!team.has(id)) team.set(id, { gf: 0, ga: 0, w: 0 }); return team.get(id); };
    for (const x of hist) {
      if (m.t - x.t > 5 * halfLifeDays * 86400e3) continue;
      const wx = w(x); hg += wx * x.home_score; ag += wx * x.away_score; W += wx;
      const h = T(x.home_team_id); h.gf += wx * x.home_score; h.ga += wx * x.away_score; h.w += wx;
      const a = T(x.away_team_id); a.gf += wx * x.away_score; a.ga += wx * x.home_score; a.w += wx;
    }
    if (W < 50) { out.push(null); hist.push(m); continue; }
    const muH = hg / W; const muA = ag / W; const mu = (muH + muA) / 2;
    const rate = (t, k) => { const x = team.get(t); if (!x) return 1; return ((x[k] + shrink * mu) / (x.w + shrink)) / mu; };
    const lh = muH * rate(m.home_team_id, 'gf') * rate(m.away_team_id, 'ga');
    const la = muA * rate(m.away_team_id, 'gf') * rate(m.home_team_id, 'ga');
    out.push([lh, la]);
    hist.push(m);
  }
  return out;
}
const pois = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * l ** k / f; };
function poisson1x2([lh, la]) { let h = 0; let d = 0; let a = 0; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = pois(lh, i) * pois(la, j); if (i > j) h += p; else if (i === j) d += p; else a += p; } const s = h + d + a; return [h / s, d / s, a / s]; }
const pOver25 = ([lh, la]) => { const l = lh + la; return 1 - (pois(l, 0) + pois(l, 1) + pois(l, 2)); };

// ---------- baseline ----------
const trainRows = matches.filter(m => split(m.season) === 'train');
const freq = [0, 1, 2].map(r => trainRows.filter(m => m.r === r).length / trainRows.length);
const rateOf = f => trainRows.filter(f).length / trainRows.length;
const base = { home_scores: rateOf(m => m.home_score > 0), away_scores: rateOf(m => m.away_score > 0), over25: rateOf(m => m.home_score + m.away_score > 2) };

// ---------- choose hyperparameters on DEV (train-fitted mapping) ----------
let bestElo = null;
for (const K of [10, 15, 20, 25, 30]) for (const H of [40, 60, 80, 100]) {
  const d = eloSeries(K, H);
  const idx = matches.map((m, i) => i).filter(i => split(matches[i].season) === 'train' && matches[i].season > '2005/06'); // skip the warm-up season
  const th = fitOlogit(idx.map(i => d[i]), idx.map(i => matches[i].r));
  const dev = matches.map((m, i) => i).filter(i => split(matches[i].season) === 'dev');
  const l = dev.reduce((a, i) => a + ll3(ologit(d[i], th), matches[i].r), 0) / dev.length;
  if (!bestElo || l < bestElo.dev_log_loss) bestElo = { K, H, th, dev_log_loss: +l.toFixed(4) };
}
console.log('elo chosen', JSON.stringify({ K: bestElo.K, H: bestElo.H, dev: bestElo.dev_log_loss }));
let bestPo = null;
for (const hl of [120, 240, 365, 540]) for (const sh of [2, 5, 10, 20]) {
  const s = poissonSeries(hl, sh);
  const dev = matches.map((m, i) => i).filter(i => split(matches[i].season) === 'dev' && s[i]);
  const l = dev.reduce((a, i) => a + ll3(poisson1x2(s[i]), matches[i].r), 0) / dev.length;
  if (!bestPo || l < bestPo.dev_log_loss) bestPo = { half_life_days: hl, shrink: sh, dev_log_loss: +l.toFixed(4) };
}
console.log('poisson chosen', JSON.stringify(bestPo));

// ---------- evaluate on every split with the chosen settings ----------
const eloD = eloSeries(bestElo.K, bestElo.H);
const po = poissonSeries(bestPo.half_life_days, bestPo.shrink);
const byModel = { baseline: [], elo_ologit: [], poisson: [] }; const bin = { baseline: { home_scores: [], away_scores: [], over25: [] }, poisson: { home_scores: [], away_scores: [], over25: [] } };
matches.forEach((m, i) => {
  if (!po[i] || m.season <= '2005/06') return; // identical evaluation set for every model
  const tag = { season: m.season, split: split(m.season) };
  byModel.baseline.push({ ...tag, p: freq, y: m.r });
  byModel.elo_ologit.push({ ...tag, p: ologit(eloD[i], bestElo.th), y: m.r });
  byModel.poisson.push({ ...tag, p: poisson1x2(po[i]), y: m.r });
  bin.baseline.home_scores.push({ ...tag, p: base.home_scores, y: m.home_score > 0 }); bin.baseline.away_scores.push({ ...tag, p: base.away_scores, y: m.away_score > 0 }); bin.baseline.over25.push({ ...tag, p: base.over25, y: m.home_score + m.away_score > 2 });
  bin.poisson.home_scores.push({ ...tag, p: 1 - Math.exp(-po[i][0]), y: m.home_score > 0 }); bin.poisson.away_scores.push({ ...tag, p: 1 - Math.exp(-po[i][1]), y: m.away_score > 0 }); bin.poisson.over25.push({ ...tag, p: pOver25(po[i]), y: m.home_score + m.away_score > 2 });
});
const report = { generated_at: new Date().toISOString(), data: { competition: 'bundesliga', matches: matches.length, first: matches[0].kickoff_at, last: matches[matches.length - 1].kickoff_at }, splits: { train: '2004/05-2013/14', dev: '2014/15-2018/19', holdout: '2019/20-2025/26', live: '2026/27 (partial)' },
  baseline: { '1x2_train_frequencies': freq.map(x => +x.toFixed(4)), binary_train_rates: base }, chosen: { elo: { K: bestElo.K, home_edge: bestElo.H, ologit: bestElo.th.map(x => +x.toFixed(4)) }, poisson: bestPo }, results: {} };
for (const sp of ['dev', 'holdout', 'live']) {
  report.results[sp] = { '1x2': Object.fromEntries(Object.entries(byModel).map(([k, rows]) => [k, summarize(rows.filter(r => r.split === sp), '1x2')])) };
  for (const t of ['home_scores', 'away_scores', 'over25']) report.results[sp][t] = { baseline: summarize(bin.baseline[t].filter(r => r.split === sp)), poisson: summarize(bin.poisson[t].filter(r => r.split === sp)) };
}
report.holdout_by_season = [...new Set(byModel.baseline.filter(r => r.split === 'holdout').map(r => r.season))].map(s => ({ season: s, ...Object.fromEntries(Object.entries(byModel).map(([k, rows]) => { const x = summarize(rows.filter(r => r.season === s), '1x2'); return [k, { log_loss: x.log_loss, brier: x.brier, accuracy: x.accuracy }]; })) }));
const H = report.results.holdout['1x2'];
const pass = k => H[k].log_loss < H.baseline.log_loss && H[k].brier < H.baseline.brier;
report.gate = { rule: 'beats the training-frequency baseline on the holdout in BOTH log loss and Brier', elo_ologit: pass('elo_ologit'), poisson: pass('poisson'),
  seasons_beating_baseline: { elo_ologit: report.holdout_by_season.filter(s => s.elo_ologit.log_loss < s.baseline.log_loss).length, poisson: report.holdout_by_season.filter(s => s.poisson.log_loss < s.baseline.log_loss).length, of: report.holdout_by_season.length } };
mkdirSync('docs/evidence/research', { recursive: true });
writeFileSync(`docs/evidence/research/model-research-${report.generated_at.slice(0, 10)}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ holdout: H, gate: report.gate, binary_holdout: Object.fromEntries(['home_scores', 'away_scores', 'over25'].map(t => [t, report.results.holdout[t]])) }, null, 1));
