// MATCHUP LAB v1 (Soccer Pro) — DESCRIPTIVE matchup intelligence from canonical facts only.
// Pure functions. The PBE MATCHUP RATING is a descriptive lean built from named components
// (each shipped with both sides' inputs); it is NOT a win probability and is never labelled one.
export const MATCHUP_VERSION = 'soccer-matchup/1.0.0';

const r2 = x => (x === null || x === undefined || !Number.isFinite(x) ? null : Math.round(x * 100) / 100);
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const avg = xs => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

// Canonical pitch 105 x 68, team-relative (the shooting team attacks toward x = 105; y = 0 is its
// right touchline). Penalty area: x >= 88.5 and |y - 34| <= 20.16.
export const inBox = s => Number(s.x_m) >= 88.5 && Math.abs(Number(s.y_m) - 34) <= 20.16;
export const channelOf = s => (Number(s.y_m) < 68 / 3 ? 'right' : Number(s.y_m) > (2 * 68) / 3 ? 'left' : 'centre');

// One team's recent profile. games: newest first, each { id, kickoff_at, home (bool), gf, ga,
// stats: { shots, shots_on_target } | null (own), opp_stats: same | null, shots: [{x_m,y_m,set_piece}]
// (own located shots), goals: [{ minute, set_piece }] (own), conceded: [{ minute }] }.
export function teamProfile(games) {
  const n = games.length;
  const withStats = games.filter(g => g.stats && Number.isFinite(g.stats.shots));
  const withOpp = games.filter(g => g.opp_stats && Number.isFinite(g.opp_stats.shots));
  const located = games.flatMap(g => g.shots || []).filter(s => s.x_m !== null && s.y_m !== null && s.x_m !== undefined);
  const ch = { left: 0, centre: 0, right: 0 };
  for (const s of located) ch[channelOf(s)] += 1;
  const goals = games.flatMap(g => g.goals || []);
  const conceded = games.flatMap(g => g.conceded || []);
  const pts = g => (g.gf > g.ga ? 3 : g.gf === g.ga ? 1 : 0);
  const split = pred => { const xs = games.filter(pred); return xs.length ? { played: xs.length, ppg: r2(avg(xs.map(pts))), gf_pg: r2(avg(xs.map(g => g.gf))), ga_pg: r2(avg(xs.map(g => g.ga))) } : null; };
  return {
    matches: n,
    matches_with_stats: withStats.length, matches_with_located_shots: games.filter(g => (g.shots || []).length).length,
    goals_for_pg: n ? r2(avg(games.map(g => g.gf))) : null, goals_against_pg: n ? r2(avg(games.map(g => g.ga))) : null,
    shots_for_pg: withStats.length ? r2(avg(withStats.map(g => g.stats.shots))) : null,
    shots_on_target_for_pg: r2(avg(games.filter(g => Number.isFinite(g.stats?.shots_on_target)).map(g => g.stats.shots_on_target))),
    shots_against_pg: withOpp.length ? r2(avg(withOpp.map(g => g.opp_stats.shots))) : null,
    shots_on_target_against_pg: r2(avg(games.filter(g => Number.isFinite(g.opp_stats?.shots_on_target)).map(g => g.opp_stats.shots_on_target))),
    located_shots: located.length,
    inside_box_share: located.length ? r2(located.filter(inBox).length / located.length) : null,
    channels: located.length ? { left: r2(ch.left / located.length), centre: r2(ch.centre / located.length), right: r2(ch.right / located.length) } : null,
    set_piece_shots_pg: located.length ? r2(located.filter(s => s.set_piece && s.set_piece !== 'kick_off').length / Math.max(1, games.filter(g => (g.shots || []).length).length)) : null,
    set_piece_goals: goals.filter(g => g.set_piece && g.set_piece !== 'kick_off').length,
    goal_timing: { first_half: goals.filter(g => g.minute !== null && g.minute <= 45).length, second_half: goals.filter(g => g.minute !== null && g.minute > 45).length },
    conceded_timing: { first_half: conceded.filter(g => g.minute !== null && g.minute <= 45).length, second_half: conceded.filter(g => g.minute !== null && g.minute > 45).length },
    form_last5: games.slice(0, 5).map(g => (g.gf > g.ga ? 'W' : g.gf === g.ga ? 'D' : 'L')),
    ppg_last5: games.length ? r2(avg(games.slice(0, 5).map(pts))) : null,
    home: split(g => g.home), away: split(g => !g.home),
  };
}

// edge in [-1, 1]: positive favours home. a / b are the two sides' inputs, scale = the difference
// that counts as a full edge. Missing inputs -> null (component skipped, never zero-filled).
const edge = (a, b, scale) => (a === null || b === null || a === undefined || b === undefined ? null : clamp((a - b) / scale, -1, 1));

export function matchup(home, away, { homeFatigue = null, awayFatigue = null, homeSquad = null, awaySquad = null } = {}) {
  const H = home; const A = away;
  const exp = (att, def) => (att === null || def === null ? null : (att + def) / 2); // shots a side can expect: its output vs the other's concession
  const comps = [
    { key: 'attack_edge', label: 'Attack edge', weight: 0.2, home: exp(H.shots_for_pg, A.shots_against_pg), away: exp(A.shots_for_pg, H.shots_against_pg), scale: 6, basis: 'shots per match vs the opponent\'s shots conceded per match' },
    { key: 'defensive_edge', label: 'Defensive edge', weight: 0.2, home: H.goals_against_pg === null ? null : -H.goals_against_pg, away: A.goals_against_pg === null ? null : -A.goals_against_pg, scale: 1.2, basis: 'goals conceded per match (fewer is better)' },
    { key: 'shot_profile_edge', label: 'Shot profile edge', weight: 0.15, home: H.inside_box_share, away: A.inside_box_share, scale: 0.25, basis: 'share of located shots taken inside the penalty area' },
    { key: 'set_piece_edge', label: 'Set-piece edge', weight: 0.05, home: H.set_piece_shots_pg, away: A.set_piece_shots_pg, scale: 3, basis: 'set-piece shots per located match (where the source marks the set piece)' },
    { key: 'form_edge', label: 'Form edge', weight: 0.15, home: H.ppg_last5, away: A.ppg_last5, scale: 1.5, basis: 'points per match, last five' },
    { key: 'rest_edge', label: 'Rest edge', weight: 0.15, home: homeFatigue ? -homeFatigue.score : null, away: awayFatigue ? -awayFatigue.score : null, scale: 40, basis: 'team fatigue index (lower load is better)' },
    { key: 'xi_stability', label: 'XI stability', weight: 0.1, home: homeSquad?.xi_continuity ?? null, away: awaySquad?.xi_continuity ?? null, scale: 0.3, basis: 'share of starters kept between consecutive sourced XIs' },
  ].map(c => ({ ...c, home: r2(c.home), away: r2(c.away), edge: r2(edge(c.home, c.away, c.scale)) }));
  const used = comps.filter(c => c.edge !== null);
  const wsum = used.reduce((s, c) => s + c.weight, 0);
  const lean = wsum ? used.reduce((s, c) => s + c.weight * c.edge, 0) / wsum : null;
  return {
    version: MATCHUP_VERSION,
    rating: lean === null ? null : { home: Math.round(50 + 50 * lean), away: Math.round(50 - 50 * lean), components_used: used.length, components_total: comps.length },
    rating_label: 'PBE MATCHUP RATING: a descriptive lean from the components below. Not a win probability.',
    components: comps.map(({ scale, ...c }) => ({ ...c, contribution: c.edge === null ? null : r2((c.weight * c.edge) / (wsum || 1) * 50) })),
  };
}
