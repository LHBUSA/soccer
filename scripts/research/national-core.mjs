// National-team strength model for Soccer Algo V2 (protocol scripts/research/algo-v2-protocol.mjs):
// time-decayed, opponent-adjusted Poisson strengths (Maher), a national-team home factor H fitted on non-neutral
// matches only (H = 1 on a neutral site), each team shrunk toward 1 with k pseudo-matches, then Dixon-Coles on
// the lambdas (structural-core dcGrid). Pure: used by the research script and by the live V2 lane.
import { dcGrid } from './structural-core.mjs';

const DAY = 864e5;
export const ITERATIONS = 30;
export const MIN_WEIGHT = 60;

// list: [{ t, home_team_id, away_team_id, home_score, away_score, neutral }] sorted by t.
// m: { t, home_team_id, away_team_id, neutral }. Only entries with x.t < m.t count.
export function ntPredict(list, m, { hl, k }) {
  const H = hl * DAY; const rows = []; let W = 0;
  const seen = new Set();
  for (const x of list) {
    if (x.t >= m.t) break;
    const dt = m.t - x.t; if (dt > 5 * H) continue;
    const w = 0.5 ** (dt / H); W += w;
    rows.push({ ...x, w }); seen.add(x.home_team_id); seen.add(x.away_team_id);
  }
  if (W < MIN_WEIGHT || !seen.has(m.home_team_id) || !seen.has(m.away_team_id)) return null;
  const att = new Map(); const def = new Map();
  for (const r of rows) for (const id of [r.home_team_id, r.away_team_id]) { att.set(id, 1); def.set(id, 1); }
  let goals = 0; for (const r of rows) goals += r.w * (r.home_score + r.away_score);
  let mu = goals / (2 * W); let home = 1;
  for (let it = 0; it < ITERATIONS; it++) {
    // attack: goals scored vs expected (given opponent defence and venue)
    const gA = new Map(); const eA = new Map(); const gD = new Map(); const eD = new Map();
    const add = (mp, id, v) => mp.set(id, (mp.get(id) || 0) + v);
    for (const r of rows) {
      const h = r.neutral ? 1 : home;
      add(gA, r.home_team_id, r.w * r.home_score); add(eA, r.home_team_id, r.w * mu * def.get(r.away_team_id) * h);
      add(gA, r.away_team_id, r.w * r.away_score); add(eA, r.away_team_id, r.w * mu * def.get(r.home_team_id) / h);
      add(gD, r.away_team_id, r.w * r.home_score); add(eD, r.away_team_id, r.w * mu * att.get(r.home_team_id) * h);
      add(gD, r.home_team_id, r.w * r.away_score); add(eD, r.home_team_id, r.w * mu * att.get(r.away_team_id) / h);
    }
    for (const id of att.keys()) { att.set(id, (gA.get(id) + k * mu) / (eA.get(id) + k * mu)); def.set(id, (gD.get(id) + k * mu) / (eD.get(id) + k * mu)); }
    // normalise (mean 1) so mu carries the scale
    const ma = [...att.values()].reduce((a, v) => a + v, 0) / att.size; const md = [...def.values()].reduce((a, v) => a + v, 0) / def.size;
    for (const id of att.keys()) { att.set(id, att.get(id) / ma); def.set(id, def.get(id) / md); }
    // home factor from non-neutral matches only
    let hg = 0; let he = 0; let ag = 0; let ae = 0; let e = 0;
    for (const r of rows) {
      const bh = mu * att.get(r.home_team_id) * def.get(r.away_team_id); const ba = mu * att.get(r.away_team_id) * def.get(r.home_team_id);
      if (!r.neutral) { hg += r.w * r.home_score; he += r.w * bh; ag += r.w * r.away_score; ae += r.w * ba; }
      const h = r.neutral ? 1 : home; e += r.w * (bh * h + ba / h);
    }
    if (he > 0 && ae > 0 && ag > 0) home = Math.sqrt((hg / he) / (ag / ae));
    mu *= goals / e;
  }
  const h = m.neutral ? 1 : home;
  return { lh: mu * att.get(m.home_team_id) * def.get(m.away_team_id) * h, la: mu * att.get(m.away_team_id) * def.get(m.home_team_id) / h, home_factor: home, mu, weight: W };
}

// Every market probability from the lambdas (same grid and markets as V1).
export function marketsFrom(lh, la, rho) {
  const { g, S } = dcGrid(lh, la, rho);
  let h = 0; let d = 0; let a = 0; let over = 0; let h0 = 0; let a0 = 0; let both = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const q = g[i * 11 + j] / S;
    if (i > j) h += q; else if (i === j) d += q; else a += q;
    if (i + j >= 3) over += q; if (i === 0) h0 += q; if (j === 0) a0 += q; if (i >= 1 && j >= 1) both += q;
  }
  const s = h + d + a;
  return { '1x2': { home: h / s, draw: d / s, away: a / s }, over_2_5: over, home_to_score: 1 - h0, away_to_score: 1 - a0, btts: both };
}
