// Descriptive stats DERIVED from the event ledger. These are counts, not models.
// basis = 'derived', derivation_version names the rules below. Anything that
// needs a model (xG, xT, possession value, field tilt...) is NOT computed here —
// see docs/METHODOLOGY.md and soccer_metric_definitions.

import { syncRows } from './store.js';

export const DERIVATION_VERSION = 'pbe-counts/1.0.0';

// Team stat definitions, as SQL expressions over soccer_match_events e.
const TEAM_STATS = {
  shots: `count(*) filter (where e.event_type = 'shot')`,
  shots_on_target: `count(*) filter (where e.event_type = 'shot' and e.outcome in ('goal','on_target'))`,
  goals_scored_by_players: `count(*) filter (where e.is_goal)`,
  own_goals_conceded_for_opponent: `count(*) filter (where e.is_own_goal)`,
  passes: `count(*) filter (where e.event_type = 'pass')`,
  passes_completed: `count(*) filter (where e.event_type = 'pass' and e.outcome = 'success')`,
  final_third_passes_completed: `count(*) filter (where e.event_type = 'pass' and e.outcome = 'success' and e.end_x_m >= 70)`,
  crosses: `count(*) filter (where e.event_type = 'pass' and e.subtype = 'cross')`,
  duels: `count(*) filter (where e.event_type = 'duel')`,
  duels_won: `count(*) filter (where e.event_type = 'duel' and e.outcome = 'won')`,
  fouls_committed: `count(*) filter (where e.event_type = 'foul')`,
  corners: `count(*) filter (where e.set_piece = 'corner')`,
  offsides: `count(*) filter (where e.event_type = 'offside')`,
  yellow_cards: `count(*) filter (where e.card = 'yellow')`,
  red_cards: `count(*) filter (where e.card in ('red','second_yellow'))`,
  events_in_final_third: `count(*) filter (where e.x_m >= 70)`,
};

const PLAYER_STATS = {
  shots: TEAM_STATS.shots,
  shots_on_target: TEAM_STATS.shots_on_target,
  goals: `count(*) filter (where e.is_goal)`,
  own_goals: `count(*) filter (where e.is_own_goal)`,
  assists: `count(*) filter (where (e.qualifiers->>'assist')::boolean)`,
  key_passes: `count(*) filter (where (e.qualifiers->>'key_pass')::boolean)`,
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

export async function deriveMatchStats(store, matchIds) {
  if (!matchIds.length) return {};
  const tSel = Object.entries(TEAM_STATS).map(([k, v]) => `${v} as "${k}"`).join(', ');
  const { rows: tRows } = await store.query(
    `select e.match_id, e.team_id, ${tSel} from public.soccer_match_events e
      where e.match_id = any($1::uuid[]) and e.team_id is not null group by e.match_id, e.team_id`, [matchIds]);
  const teamStats = [];
  for (const r of tRows) for (const k of Object.keys(TEAM_STATS)) {
    teamStats.push({ match_id: r.match_id, team_id: r.team_id, stat_key: k, value: Number(r[k]), basis: 'derived', provider: null, derivation_version: DERIVATION_VERSION });
  }

  const pSel = Object.entries(PLAYER_STATS).map(([k, v]) => `${v} as "${k}"`).join(', ');
  const { rows: pRows } = await store.query(
    `select e.match_id, e.player_id, e.team_id, ${pSel} from public.soccer_match_events e
      where e.match_id = any($1::uuid[]) and e.player_id is not null group by e.match_id, e.player_id, e.team_id`, [matchIds]);
  const playerStats = [];
  for (const r of pRows) for (const k of Object.keys(PLAYER_STATS)) {
    const v = Number(r[k]);
    if (v === 0) continue; // absent = zero; keeps the table proportional to activity
    playerStats.push({ match_id: r.match_id, player_id: r.player_id, team_id: r.team_id, stat_key: k, value: v, basis: 'derived', provider: null, derivation_version: DERIVATION_VERSION });
  }

  // Minutes: nominal 90-minute regulation (the dataset has no stoppage-time
  // clock end), cut at substitution or dismissal. Labelled as such.
  const { rows: lp } = await store.query(
    `select l.match_id, l.team_id, lp.player_id, lp.is_starter, m.duration
       from public.soccer_lineup_players lp join public.soccer_lineups l on l.id = lp.lineup_id
       join public.soccer_matches m on m.id = l.match_id where l.match_id = any($1::uuid[])`, [matchIds]);
  const { rows: subs } = await store.query(`select match_id, player_in_id, player_out_id, minute from public.soccer_substitutions where match_id = any($1::uuid[])`, [matchIds]);
  const { rows: reds } = await store.query(`select match_id, player_id, min(minute) as minute from public.soccer_match_events where match_id = any($1::uuid[]) and card in ('red','second_yellow') and player_id is not null group by match_id, player_id`, [matchIds]);
  const subIn = new Map(subs.map(s => [`${s.match_id}|${s.player_in_id}`, s.minute]));
  const subOut = new Map(subs.map(s => [`${s.match_id}|${s.player_out_id}`, s.minute]));
  const red = new Map(reds.map(r => [`${r.match_id}|${r.player_id}`, Number(r.minute)]));
  for (const r of lp) {
    const k = `${r.match_id}|${r.player_id}`;
    const full = r.duration === 'regular' || !r.duration ? 90 : 120;
    let start = null;
    if (r.is_starter) start = 0; else if (subIn.has(k)) start = Math.min(subIn.get(k) ?? full, full);
    if (start === null) continue;
    let end = full;
    if (subOut.has(k) && subOut.get(k) !== null) end = Math.min(end, subOut.get(k));
    if (red.has(k)) end = Math.min(end, red.get(k));
    const minutes = Math.max(0, end - start);
    playerStats.push({ match_id: r.match_id, player_id: r.player_id, team_id: r.team_id, stat_key: 'minutes_nominal', value: minutes, basis: 'derived', provider: null, derivation_version: DERIVATION_VERSION });
  }

  const team = await syncRows(store, { table: 'soccer_team_match_stats', key: ['match_id', 'team_id', 'stat_key', 'basis'], compare: ['value', 'derivation_version'], rows: teamStats });
  const player = await syncRows(store, { table: 'soccer_player_match_stats', key: ['match_id', 'player_id', 'stat_key', 'basis'], compare: ['value', 'derivation_version'], rows: playerStats });
  return { team, player };
}
