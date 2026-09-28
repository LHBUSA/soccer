// Frozen research model core (extracted verbatim in logic from scripts/research/model-research.mjs
// @ 6fdf692, sha256 9d369da1a695a6dea75227a4a471480d435d39c6f4a130ba96964614e5b51d5e).
// Pure functions over a chronologically sorted match list. The ONLY option is `strict`:
//   strict=false  reproduces the frozen v1 exactly (same-kickoff matches earlier in the list
//                 enter the Poisson league averages: a small leakage found in this phase)
//   strict=true   v1.1: every feature uses only matches that kicked off strictly before
// No feature changes.

export const SPLIT = s => (s <= '2013/14' ? 'train' : s <= '2018/19' ? 'dev' : s <= '2025/26' ? 'holdout' : 'live');
export const FROZEN = { elo: { K: 10, home_edge: 60, carry: 2 / 3 }, poisson: { half_life_days: 540, shrink: 10, window_half_lives: 5, min_weight: 50 } };
const eps = 1e-12;
export const sig = x => 1 / (1 + Math.exp(-x));

export function eloSeries(matches, K, homeEdge, carry = 2 / 3) {
  const R = new Map(); let season = null; const out = [];
  for (const m of matches) {
    if (m.season !== season) { for (const [k, v] of R) R.set(k, 1500 + (v - 1500) * carry); season = m.season; }
    const rh = R.get(m.home_team_id) ?? 1500; const ra = R.get(m.away_team_id) ?? 1500;
    out.push({ d: rh + homeEdge - ra, rh, ra });
    const e = 1 / (1 + 10 ** (-(rh + homeEdge - ra) / 400));
    const s = m.r === 0 ? 1 : m.r === 1 ? 0.5 : 0;
    const gd = Math.abs(m.home_score - m.away_score); const mult = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
    R.set(m.home_team_id, rh + K * mult * (s - e)); R.set(m.away_team_id, ra - K * mult * (s - e));
  }
  return out;
}
export const ologit = (d, [a, c1, c2]) => { const pA = sig(c1 - a * d); const pAD = sig(c2 - a * d); return [1 - pAD, Math.max(eps, pAD - pA), pA]; };
export const ll3 = (p, r) => -Math.log(Math.max(eps, p[r]));
export function fitOlogit(ds, ys) {
  let best = null;
  for (let a = 0.002; a <= 0.012; a += 0.0005) for (let c1 = -2; c1 <= 0; c1 += 0.05) for (let gap = 0.6; gap <= 1.6; gap += 0.05) {
    const th = [a, c1, c1 + gap]; let l = 0;
    for (let i = 0; i < ds.length; i++) l += ll3(ologit(ds[i], th), ys[i]);
    if (!best || l < best.l) best = { l, th };
  }
  return best.th;
}

// Returns per match null (warm-up) or { lh, la, parts } where parts is the model's own
// multiplicative decomposition (used for attribution; nothing is invented).
export function poissonSeries(matches, halfLifeDays, shrink, { strict = false } = {}) {
  const hist = []; const out = [];
  for (const m of matches) {
    const w = x => 0.5 ** ((m.t - x.t) / (halfLifeDays * 86400e3));
    let hg = 0; let ag = 0; let W = 0;
    const team = new Map();
    const T = id => { if (!team.has(id)) team.set(id, { gf: 0, ga: 0, w: 0 }); return team.get(id); };
    for (const x of hist) {
      if (strict && x.t >= m.t) continue; // v1.1: nothing at or after this kickoff
      if (m.t - x.t > 5 * halfLifeDays * 86400e3) continue;
      const wx = w(x); hg += wx * x.home_score; ag += wx * x.away_score; W += wx;
      const h = T(x.home_team_id); h.gf += wx * x.home_score; h.ga += wx * x.away_score; h.w += wx;
      const a = T(x.away_team_id); a.gf += wx * x.away_score; a.ga += wx * x.home_score; a.w += wx;
    }
    if (W < 50) { out.push(null); hist.push(m); continue; }
    const muH = hg / W; const muA = ag / W; const mu = (muH + muA) / 2;
    const rate = (t, k) => { const x = team.get(t); if (!x) return 1; return ((x[k] + shrink * mu) / (x.w + shrink)) / mu; };
    const attH = rate(m.home_team_id, 'gf'); const defA = rate(m.away_team_id, 'ga');
    const attA = rate(m.away_team_id, 'gf'); const defH = rate(m.home_team_id, 'ga');
    out.push({ lh: muH * attH * defA, la: muA * attA * defH, parts: { mu, muH, muA, attH, defA, attA, defH } });
    hist.push(m);
  }
  return out;
}
const pois = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * l ** k / f; };
export function poisson1x2(lh, la) { let h = 0; let d = 0; let a = 0; for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = pois(lh, i) * pois(la, j); if (i > j) h += p; else if (i === j) d += p; else a += p; } const s = h + d + a; return [h / s, d / s, a / s]; }
export const pOver25 = (lh, la) => { const l = lh + la; return 1 - (pois(l, 0) + pois(l, 1) + pois(l, 2)); };

// The frozen pipeline: returns per-match predictions for both models + baseline.
export function runFrozen(matches, { strict = false } = {}) {
  const train = matches.filter(m => SPLIT(m.season) === 'train');
  const freq = [0, 1, 2].map(r => train.filter(m => m.r === r).length / train.length);
  const elo = eloSeries(matches, FROZEN.elo.K, FROZEN.elo.home_edge, FROZEN.elo.carry);
  const idx = matches.map((m, i) => i).filter(i => SPLIT(matches[i].season) === 'train' && matches[i].season > '2005/06');
  const th = fitOlogit(idx.map(i => elo[i].d), idx.map(i => matches[i].r));
  const po = poissonSeries(matches, FROZEN.poisson.half_life_days, FROZEN.poisson.shrink, { strict });
  const rows = [];
  matches.forEach((m, i) => {
    if (!po[i] || m.season <= '2005/06') return;
    rows.push({ id: m.id, season: m.season, split: SPLIT(m.season), t: m.t, y: m.r, home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_score: m.home_score, away_score: m.away_score,
      base: freq, elo: ologit(elo[i].d, th), elo_d: elo[i].d, elo_home: elo[i].rh, elo_away: elo[i].ra, poisson: poisson1x2(po[i].lh, po[i].la), lh: po[i].lh, la: po[i].la, parts: po[i].parts });
  });
  return { rows, freq, ologit_theta: th };
}
