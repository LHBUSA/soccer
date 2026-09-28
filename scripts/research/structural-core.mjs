// Phase 3 structural candidates on top of the frozen Poisson v1.1 (model-core.mjs is not modified).
//  - structuralSeries: the strict Poisson team-strength model with an optional separate half-life
//    for the league HOME SHARE of goals (homeHl). homeHl === hl reproduces model-core strict
//    bit-for-bit (same terms, same summation order).
//  - Dixon-Coles low-score dependence (Dixon & Coles 1997) applied to the same lambdas.
const DAY = 86400e3;

// Prediction for match m from list[from..to) (only entries that kicked off strictly before m count).
export function predictFrom(list, from, to, m, { hl = 540, shrink = 10, homeHl = 540, minWeight = 50, forceShare = false } = {}) {
  const H = hl * DAY; const HH = homeHl * DAY; const same = homeHl === hl && !forceShare; // forceShare: test the general formula at h = 540
  let hg = 0; let ag = 0; let W = 0; let sh = 0; let sa = 0;
  const team = new Map();
  const T = id => { if (!team.has(id)) team.set(id, { gf: 0, ga: 0, w: 0 }); return team.get(id); };
  for (let k = from; k < to; k++) {
    const x = list[k];
    if (x.t >= m.t) continue; // strict: nothing at or after this kickoff
    const dt = m.t - x.t;
    if (!(dt > 5 * H)) {
      const wx = 0.5 ** (dt / H); hg += wx * x.home_score; ag += wx * x.away_score; W += wx;
      const h = T(x.home_team_id); h.gf += wx * x.home_score; h.ga += wx * x.away_score; h.w += wx;
      const a = T(x.away_team_id); a.gf += wx * x.away_score; a.ga += wx * x.home_score; a.w += wx;
    }
    if (!same && !(dt > 5 * HH)) { const wh = 0.5 ** (dt / HH); sh += wh * x.home_score; sa += wh * x.away_score; }
  }
  if (W < minWeight) return null;
  const mu = (hg / W + ag / W) / 2;
  let muH; let muA;
  if (same) { muH = hg / W; muA = ag / W; } else { const s = sh + sa > 0 ? sh / (sh + sa) : 0.5; muH = 2 * mu * s; muA = 2 * mu * (1 - s); }
  const rate = (t, k) => { const x = team.get(t); if (!x) return 1; return ((x[k] + shrink * mu) / (x.w + shrink)) / mu; };
  const attH = rate(m.home_team_id, 'gf'); const defA = rate(m.away_team_id, 'ga');
  const attA = rate(m.away_team_id, 'gf'); const defH = rate(m.home_team_id, 'ga');
  return { lh: muH * attH * defA, la: muA * attA * defH, parts: { mu, muH, muA, attH, defA, attA, defH } };
}

export function structuralSeries(matches, opts = {}) {
  const hl = opts.hl ?? 540; const homeHl = opts.homeHl ?? 540;
  const maxWin = 5 * Math.max(hl, homeHl) * DAY;
  const out = new Array(matches.length); let start = 0;
  for (let i = 0; i < matches.length; i++) {
    while (start < i && matches[i].t - matches[start].t > maxWin) start++;
    out[i] = predictFrom(matches, start, i, matches[i], opts);
  }
  return out;
}

const pois = (l, k) => { let f = 1; for (let i = 2; i <= k; i++) f *= i; return Math.exp(-l) * l ** k / f; };
export const tau = (i, j, lh, la, rho) => (i === 0 && j === 0 ? 1 - lh * la * rho : i === 0 && j === 1 ? 1 + lh * rho : i === 1 && j === 0 ? 1 + la * rho : i === 1 && j === 1 ? 1 - rho : 1);
// Full 0..10 x 0..10 scoreline grid (renormalised). rho = 0 gives exactly poisson1x2's numbers.
export function dcGrid(lh, la, rho) {
  const g = []; let S = 0; let clamped = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    let t = tau(i, j, lh, la, rho); if (t < 0) { t = 0; clamped += 1; }
    const p = rho === 0 ? pois(lh, i) * pois(la, j) : pois(lh, i) * pois(la, j) * t;
    g.push(p); S += p;
  }
  return { g, S, clamped };
}
export function dc1x2(lh, la, rho) {
  const { g, S } = dcGrid(lh, la, rho); let h = 0; let d = 0; let a = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) { const p = g[i * 11 + j]; if (i > j) h += p; else if (i === j) d += p; else a += p; }
  const s = h + d + a; void S; return [h / s, d / s, a / s];
}
export function scoreLogLik(rows, rho) {
  let l = 0;
  for (const r of rows) { const { g, S } = dcGrid(r.lh, r.la, rho); const i = Math.min(10, r.hs); const j = Math.min(10, r.as); l += Math.log(Math.max(1e-300, g[i * 11 + j] / S)); }
  return l;
}
// Dixon-Coles rho by maximum scoreline likelihood: coarse grid then refinement.
export function fitRho(rows, lo = -0.30, hi = 0.15) {
  let best = { rho: 0, ll: -Infinity };
  for (let k = 0; lo + k * 0.0025 <= hi + 1e-9; k++) { const rho = +(lo + k * 0.0025).toFixed(4); const ll = scoreLogLik(rows, rho); if (ll > best.ll) best = { rho, ll }; }
  const c = best.rho;
  for (let k = -25; k <= 25; k++) { const rho = +(c + k * 0.0001).toFixed(4); const ll = scoreLogLik(rows, rho); if (ll > best.ll) best = { rho, ll }; }
  return best;
}
