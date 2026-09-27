// Materiality gate: which finished matches deserve a NEWS article.
// Every finished match gets a MATCH page; only a match with a real intelligence
// angle becomes a news candidate. "Team A beat Team B 2-1" is not an angle.
// Pure function over canonical results of one season (owner brief 2026-09-27).

import { computeTable } from './packet.js';

export const MATERIALITY_VERSION = 'soccer-materiality/1.0.0';
export const PUBLISH_THRESHOLD = 1.0;

// weights: an angle >= 1.0 is sufficient on its own; weaker angles must combine.
export const ANGLES = {
  leader_change: 1.2,          // new team top of the table
  title_race_swing: 1.0,       // gap between 1st and 2nd changed by 3 with both in contention (after matchday 10)
  top4_entry_exit: 0.8,        // European places (1-4) entered or left
  relegation_zone_move: 0.8,   // relegation zone (16-18) entered or left
  upset: 1.0,                  // winner started the day >= 8 places below the loser (after matchday 5)
  comeback_from_ht: 1.0,       // winner trailed at half-time
  multi_goal_scorer: 0.6,      // resolved player scored >= 2 (1.2 for >= 3)
  winning_streak: 1.0,         // winner extended a league winning run to >= 5
  unbeaten_run_ended: 1.0,     // loser's unbeaten run of >= 8 ended
  high_scoring: 0.6,           // >= 6 total goals
  heavy_margin: 0.6,           // margin >= 4
};

const res = (m, tid) => {
  const gf = m.home_team_id === tid ? m.home_score : m.away_score;
  const ga = m.home_team_id === tid ? m.away_score : m.home_score;
  return gf > ga ? 'W' : gf < ga ? 'L' : 'D';
};
const pos = (t, id) => { const i = t.findIndex(r => r.team_id === id); return i < 0 ? null : i + 1; };

// seasonMatches: finished canonical matches of the season (any order), each
//   {id, kickoff_at, matchday, home_team_id, away_team_id, home_score, away_score, home_score_ht, away_score_ht}
// goals: [{match_id, player_id (resolved canonical or null), is_goal}] for the target match
export function assessMateriality(target, seasonMatches, { goals = [], teamsInLeague = 18 } = {}) {
  if (target.home_score === null || target.away_score === null) return { material: false, score: 0, angles: [], reason: 'not_final' };
  const before = seasonMatches.filter(m => m.id !== target.id && Date.parse(m.kickoff_at) < Date.parse(target.kickoff_at));
  const after = [...before, target];
  const tb = computeTable(before); const ta = computeTable(after);
  const H = target.home_team_id; const A = target.away_team_id;
  const winner = target.home_score > target.away_score ? H : target.away_score > target.home_score ? A : null;
  const loser = winner === H ? A : winner === A ? H : null;
  const md = target.matchday || 0;
  const angles = [];
  const add = (key, detail, weight = ANGLES[key]) => angles.push({ key, weight, detail });

  if (tb.length && ta.length && tb[0].team_id !== ta[0].team_id && [H, A].includes(ta[0].team_id) && md >= 3) add('leader_change', { new_leader: ta[0].team_id, previous: tb[0].team_id });
  if (md >= 10 && tb.length > 1 && ta.length > 1) {
    const gapB = tb[0].points - tb[1].points; const gapA = ta[0].points - ta[1].points;
    const involved = [tb[0].team_id, tb[1].team_id, ta[0].team_id, ta[1].team_id].some(t => t === H || t === A);
    if (involved && Math.abs(gapA - gapB) >= 3) add('title_race_swing', { gap_before: gapB, gap_after: gapA });
  }
  const zoneMoves = (lo, hi, key) => {
    for (const t of [H, A]) {
      const pb = pos(tb, t); const pa = pos(ta, t);
      if (pb === null || pa === null || md < 5) continue;
      const inB = pb >= lo && pb <= hi; const inA = pa >= lo && pa <= hi;
      if (inB !== inA) add(key, { team_id: t, from: pb, to: pa });
    }
  };
  zoneMoves(1, 4, 'top4_entry_exit');
  zoneMoves(teamsInLeague - 2, teamsInLeague, 'relegation_zone_move');
  if (winner && md > 5) {
    const pw = pos(tb, winner); const pl = pos(tb, loser);
    if (pw !== null && pl !== null && pw - pl >= 8) add('upset', { winner_position_before: pw, loser_position_before: pl });
  }
  if (winner && target.home_score_ht !== null && target.away_score_ht !== null) {
    const wHt = winner === H ? target.home_score_ht - target.away_score_ht : target.away_score_ht - target.home_score_ht;
    if (wHt < 0) add('comeback_from_ht', { half_time: `${target.home_score_ht}-${target.away_score_ht}` });
  }
  const byPlayer = new Map();
  for (const g of goals) if (g.is_goal && g.player_id) byPlayer.set(g.player_id, (byPlayer.get(g.player_id) || 0) + 1);
  for (const [pid, n] of byPlayer) if (n >= 2) add('multi_goal_scorer', { player_id: pid, goals: n }, n >= 3 ? 1.2 : ANGLES.multi_goal_scorer);
  const runOf = (tid, pred) => {
    let n = 0;
    for (const m of before.filter(x => x.home_team_id === tid || x.away_team_id === tid).sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at))) { if (pred(res(m, tid))) n += 1; else break; }
    return n;
  };
  if (winner) {
    const w = runOf(winner, r => r === 'W') + 1;
    if (w >= 5) add('winning_streak', { team_id: winner, run: w });
    const u = runOf(loser, r => r !== 'L');
    if (u >= 8) add('unbeaten_run_ended', { team_id: loser, run: u });
  }
  if (target.home_score + target.away_score >= 6) add('high_scoring', { goals: target.home_score + target.away_score });
  if (Math.abs(target.home_score - target.away_score) >= 4) add('heavy_margin', { margin: Math.abs(target.home_score - target.away_score) });

  const score = Math.round(angles.reduce((n, a) => n + a.weight, 0) * 100) / 100;
  return { version: MATERIALITY_VERSION, material: score >= PUBLISH_THRESHOLD, score, angles, reason: score >= PUBLISH_THRESHOLD ? 'angle' : angles.length ? 'angles_below_threshold' : 'ordinary_result_match_page_only' };
}
