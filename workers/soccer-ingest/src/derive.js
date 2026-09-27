// Descriptive stats DERIVED from the event ledger. These are counts, not models.
// basis = 'derived', derivation_version names the rules below. Anything that
// needs a model (xG, xT, possession value, field tilt...) is NOT computed here —
// see docs/METHODOLOGY.md and soccer_metric_definitions.
//
// Pure JS over the rows a lane has just written (no SQL), so the same code runs
// against PGlite and PostgREST.

import { syncRows } from './store.js';

export const DERIVATION_VERSION = 'pbe-counts/1.0.0';

const isPass = e => e.event_type === 'pass';
const TEAM_STATS = {
  shots: e => e.event_type === 'shot',
  shots_on_target: e => e.event_type === 'shot' && (e.outcome === 'goal' || e.outcome === 'on_target'),
  goals_scored_by_players: e => e.is_goal,
  own_goals_conceded_for_opponent: e => e.is_own_goal,
  passes: isPass,
  passes_completed: e => isPass(e) && e.outcome === 'success',
  final_third_passes_completed: e => isPass(e) && e.outcome === 'success' && e.end_x_m !== null && Number(e.end_x_m) >= 70,
  crosses: e => isPass(e) && e.subtype === 'cross',
  duels: e => e.event_type === 'duel',
  duels_won: e => e.event_type === 'duel' && e.outcome === 'won',
  fouls_committed: e => e.event_type === 'foul',
  corners: e => e.set_piece === 'corner',
  offsides: e => e.event_type === 'offside',
  yellow_cards: e => e.card === 'yellow',
  red_cards: e => e.card === 'red' || e.card === 'second_yellow',
  events_in_final_third: e => e.x_m !== null && Number(e.x_m) >= 70,
};

const PLAYER_STATS = {
  shots: TEAM_STATS.shots,
  shots_on_target: TEAM_STATS.shots_on_target,
  goals: e => e.is_goal,
  own_goals: e => e.is_own_goal,
  assists: e => !!e.qualifiers?.assist,
  key_passes: e => !!e.qualifiers?.key_pass,
  passes: TEAM_STATS.passes,
  passes_completed: TEAM_STATS.passes_completed,
  final_third_passes_completed: TEAM_STATS.final_third_passes_completed,
  duels: TEAM_STATS.duels,
  duels_won: TEAM_STATS.duels_won,
  fouls_committed: TEAM_STATS.fouls_committed,
  yellow_cards: TEAM_STATS.yellow_cards,
  red_cards: TEAM_STATS.red_cards,
  touches_in_final_third: TEAM_STATS.events_in_final_third,
};

// matches: [{id, duration}], events: canonical event rows,
// lineupPlayers: [{match_id, team_id, player_id, is_starter}], subs: substitution rows.
export function computeMatchStats({ matches, events, lineupPlayers, subs }) {
  const team = new Map(); const player = new Map();
  const bump = (m, k, key, stat) => { const o = m.get(k) || { key, stats: {} }; o.stats[stat] = (o.stats[stat] || 0) + 1; m.set(k, o); };
  for (const e of events) {
    if (e.team_id) {
      const k = `${e.match_id}|${e.team_id}`;
      if (!team.has(k)) team.set(k, { key: { match_id: e.match_id, team_id: e.team_id }, stats: Object.fromEntries(Object.keys(TEAM_STATS).map(s => [s, 0])) });
      for (const [s, f] of Object.entries(TEAM_STATS)) if (f(e)) team.get(k).stats[s] += 1;
    }
    if (e.player_id) {
      const k = `${e.match_id}|${e.player_id}`;
      for (const [s, f] of Object.entries(PLAYER_STATS)) if (f(e)) bump(player, k, { match_id: e.match_id, player_id: e.player_id, team_id: e.team_id }, s);
      if (!player.has(k)) player.set(k, { key: { match_id: e.match_id, player_id: e.player_id, team_id: e.team_id }, stats: {} });
    }
  }
  const teamRows = [];
  for (const { key, stats } of team.values()) for (const [s, v] of Object.entries(stats)) teamRows.push({ ...key, stat_key: s, value: v, basis: 'derived', provider: null, derivation_version: DERIVATION_VERSION });
  const playerRows = [];
  for (const { key, stats } of player.values()) for (const [s, v] of Object.entries(stats)) if (v) playerRows.push({ ...key, stat_key: s, value: v, basis: 'derived', provider: null, derivation_version: DERIVATION_VERSION });

  // Minutes: nominal 90/120 (the dataset has no stoppage-time clock end), cut at
  // substitution or dismissal. Labelled 'minutes_nominal'.
  const duration = new Map(matches.map(m => [m.id, m.duration]));
  const subIn = new Map(subs.map(s => [`${s.match_id}|${s.player_in_id}`, s.minute]));
  const subOut = new Map(subs.map(s => [`${s.match_id}|${s.player_out_id}`, s.minute]));
  const red = new Map();
  for (const e of events) if (e.player_id && (e.card === 'red' || e.card === 'second_yellow')) {
    const k = `${e.match_id}|${e.player_id}`;
    red.set(k, Math.min(red.get(k) ?? Infinity, Number(e.minute)));
  }
  for (const lp of lineupPlayers) {
    const k = `${lp.match_id}|${lp.player_id}`;
    const d = duration.get(lp.match_id);
    const full = d === 'regular' || !d ? 90 : 120;
    let start = null;
    if (lp.is_starter) start = 0; else if (subIn.has(k)) start = Math.min(subIn.get(k) ?? full, full);
    if (start === null) continue;
    let end = full;
    if (subOut.has(k) && subOut.get(k) !== null) end = Math.min(end, subOut.get(k));
    if (red.has(k)) end = Math.min(end, red.get(k));
    playerRows.push({ match_id: lp.match_id, player_id: lp.player_id, team_id: lp.team_id, stat_key: 'minutes_nominal', value: Math.max(0, end - start), basis: 'derived', provider: null, derivation_version: DERIVATION_VERSION });
  }
  return { teamRows, playerRows };
}

export async function deriveMatchStats(store, input) {
  const { teamRows, playerRows } = computeMatchStats(input);
  const team = await syncRows(store, { table: 'soccer_team_match_stats', key: ['match_id', 'team_id', 'stat_key', 'basis'], compare: ['value', 'derivation_version'], rows: teamRows, chunk: 2000 });
  const player = await syncRows(store, { table: 'soccer_player_match_stats', key: ['match_id', 'player_id', 'stat_key', 'basis'], compare: ['value', 'derivation_version'], rows: playerRows, chunk: 2000 });
  return { team, player };
}
