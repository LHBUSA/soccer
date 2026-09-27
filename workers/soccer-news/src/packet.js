// Evidence packet builder. A packet is the ONLY input a composer may use.
// Every number an article prints must exist in the packet (numeric_grounding
// gate). Packets are frozen: hashed, stored once, never updated.

import { payloadHash, uuidv5 } from '../../shared/ids.js';
import { PITCH_LENGTH_M, PITCH_WIDTH_M, toMatchFrame } from '../../shared/coords.js';
import { displayMinute } from '../../shared/clock.js';

export const PACKET_VERSION = 'soccer-packet/1.0.0';

const pct = (a, b) => (b > 0 ? Math.round((1000 * a) / b) / 10 : null);
const r1 = v => Math.round(v * 10) / 10;

// Distance from the shot location to the centre of the goal the actor attacks
// (attacking frame: goal centre at x = 105, y = 34). Pure geometry, not a model.
export function distanceToGoal(x_m, y_m) {
  if (x_m === null || y_m === null) return null;
  return r1(Math.hypot(PITCH_LENGTH_M - Number(x_m), PITCH_WIDTH_M / 2 - Number(y_m)));
}

export async function buildMatchRecapPacket(store, matchId, { asOf = null, attributions = [] } = {}) {
  const q = async (sql, p = []) => (await store.query(sql, p)).rows;
  const [m] = await q(`
    select m.*, c.name comp_name, c.slug comp_slug, s.label season_label, v.name venue_name,
           ht.name home_name, ht.slug home_slug, at.name away_name, at.slug away_slug
      from public.soccer_matches m join public.soccer_competitions c on c.id = m.competition_id
      join public.soccer_seasons s on s.id = m.season_id left join public.soccer_venues v on v.id = m.venue_id
      join public.soccer_teams ht on ht.id = m.home_team_id join public.soccer_teams at on at.id = m.away_team_id
     where m.id = $1`, [matchId]);
  if (!m) throw new Error(`match ${matchId} not found`);
  const kickoff = new Date(m.kickoff_at).toISOString();

  const managers = await q(`select l.team_id, mg.display_name, mg.slug from public.soccer_lineups l join public.soccer_managers mg on mg.id = l.manager_id where l.match_id = $1`, [matchId]);
  const mgr = Object.fromEntries(managers.map(x => [x.team_id, { name: x.display_name, slug: x.slug }]));

  // Goals from the ledger, with the assisting pass where the source tags one.
  const evs = await q(`
    select e.id, e.sequence, e.period, e.minute, e.team_id, e.player_id, e.event_type, e.subtype, e.set_piece, e.body_part,
           e.is_goal, e.is_own_goal, e.outcome, e.x_m, e.y_m, e.qualifiers, p.display_name, p.slug
      from public.soccer_match_events e left join public.soccer_players p on p.id = e.player_id
     where e.match_id = $1 and (e.event_type = 'shot' or e.is_own_goal or (e.qualifiers->>'assist')::boolean or e.card is not null)
     order by e.sequence`, [matchId]);
  const goals = [];
  for (const e of evs.filter(x => x.is_goal || x.is_own_goal)) {
    const benefiting = e.is_own_goal ? (e.team_id === m.home_team_id ? m.away_team_id : m.home_team_id) : e.team_id;
    const assist = e.is_goal ? evs.filter(a => a.sequence < e.sequence && a.team_id === e.team_id && a.qualifiers?.assist).pop() : null;
    const assistNear = assist && e.sequence - assist.sequence <= 6 ? assist : null;
    goals.push({
      minute: e.minute, display_minute: displayMinute(e.period, e.minute), period: e.period, team: benefiting === m.home_team_id ? 'home' : 'away',
      scorer: e.player_id ? { id: e.player_id, name: e.display_name, slug: e.slug } : null,
      own_goal: e.is_own_goal, penalty: e.set_piece === 'penalty', free_kick: e.set_piece === 'free_kick',
      body_part: e.body_part, distance_m: e.is_goal ? distanceToGoal(e.x_m, e.y_m) : null,
      assist: assistNear ? { id: assistNear.player_id, name: assistNear.display_name, slug: assistNear.slug } : null,
    });
  }
  let h = 0; let a = 0;
  for (const g of goals) { if (g.team === 'home') h += 1; else a += 1; g.running_score = `${h}-${a}`; }

  // Shots for the map (match frame: home attacks toward x = 105).
  const shots = evs.filter(e => e.event_type === 'shot').map(e => {
    const isHome = e.team_id === m.home_team_id;
    const mf = toMatchFrame({ x_m: e.x_m === null ? null : Number(e.x_m), y_m: e.y_m === null ? null : Number(e.y_m) }, { isHomeTeam: isHome });
    return { minute: e.minute, team: isHome ? 'home' : 'away', player: e.display_name, outcome: e.outcome, set_piece: e.set_piece, x: mf.x, y: mf.y, distance_m: distanceToGoal(e.x_m, e.y_m) };
  });

  // Team counts (derived from the ledger by pbe-counts).
  const ts = await q(`select team_id, stat_key, value, derivation_version from public.soccer_team_match_stats where match_id = $1 and basis = 'derived'`, [matchId]);
  const side = tid => (tid === m.home_team_id ? 'home' : 'away');
  const stats = { home: {}, away: {} };
  let derivation = null;
  for (const s of ts) { stats[side(s.team_id)][s.stat_key] = Number(s.value); derivation = s.derivation_version; }
  for (const k of ['home', 'away']) {
    const t = stats[k];
    t.pass_completion_pct = pct(t.passes_completed, t.passes);
    t.duel_win_pct = pct(t.duels_won, t.duels);
  }
  const passShareHome = pct(stats.home.passes_completed, stats.home.passes_completed + stats.away.passes_completed);
  const f3 = pct(stats.home.events_in_final_third, stats.home.events_in_final_third + stats.away.events_in_final_third);
  const shares = {
    completed_pass_share: { home: passShareHome, away: passShareHome === null ? null : r1(100 - passShareHome) },
    attacking_third_event_share: { home: f3, away: f3 === null ? null : r1(100 - f3) },
  };
  const avgShotDist = k => {
    const d = shots.filter(s => s.team === k && s.distance_m !== null).map(s => s.distance_m);
    return d.length ? r1(d.reduce((x, y) => x + y, 0) / d.length) : null;
  };
  const shotProfile = {
    home: { avg_shot_distance_m: avgShotDist('home'), shots_inside_box: shots.filter(s => s.team === 'home' && s.x !== null && s.x >= 88.5 && s.y >= 13.84 && s.y <= 54.16).length },
    away: { avg_shot_distance_m: avgShotDist('away'), shots_inside_box: shots.filter(s => s.team === 'away' && s.x !== null && s.x <= 16.5 && s.y >= 13.84 && s.y <= 54.16).length },
  };

  // Key performers: goals + assists, then shots on target, then key passes. A
  // documented ordering rule, not a rating.
  const perf = await q(`
    select s.player_id, p.display_name, p.slug, s.team_id,
           coalesce(sum(s.value) filter (where s.stat_key = 'goals'),0)::int goals,
           coalesce(sum(s.value) filter (where s.stat_key = 'assists'),0)::int assists,
           coalesce(sum(s.value) filter (where s.stat_key = 'shots_on_target'),0)::int shots_on_target,
           coalesce(sum(s.value) filter (where s.stat_key = 'key_passes'),0)::int key_passes,
           coalesce(sum(s.value) filter (where s.stat_key = 'passes_completed'),0)::int passes_completed
      from public.soccer_player_match_stats s join public.soccer_players p on p.id = s.player_id
     where s.match_id = $1 and s.basis = 'derived' group by 1,2,3,4`, [matchId]);
  perf.sort((x, y) => (y.goals + y.assists) - (x.goals + x.assists) || y.shots_on_target - x.shots_on_target || y.key_passes - x.key_passes || y.passes_completed - x.passes_completed || (x.display_name < y.display_name ? -1 : 1));
  const keyPerformers = perf.slice(0, 4).map(p => ({ id: p.player_id, name: p.display_name, slug: p.slug, team: side(p.team_id), goals: p.goals, assists: p.assists, shots_on_target: p.shots_on_target, key_passes: p.key_passes }));

  // Table impact: standings computed from canonical results up to and including this match.
  const played = await q(`select id, home_team_id, away_team_id, home_score, away_score, kickoff_at from public.soccer_matches
     where season_id = $1 and status = 'finished' and kickoff_at <= $2 order by kickoff_at`, [m.season_id, m.kickoff_at]);
  const table = computeTable(played);
  const tableBefore = computeTable(played.filter(x => x.id !== matchId));
  const pos = (t, id) => { const i = t.findIndex(r => r.team_id === id); return i < 0 ? null : { position: i + 1, points: t[i].points, played: t[i].played, goal_difference: t[i].gd }; };
  const form = async tid => (await q(`select home_team_id, away_team_id, home_score, away_score from public.soccer_matches
     where season_id = $1 and status = 'finished' and kickoff_at < $2 and (home_team_id = $3 or away_team_id = $3) order by kickoff_at desc limit 5`, [m.season_id, m.kickoff_at, tid]))
    .map(x => { const gf = x.home_team_id === tid ? x.home_score : x.away_score; const ga = x.home_team_id === tid ? x.away_score : x.home_score; return gf > ga ? 'W' : gf < ga ? 'L' : 'D'; });

  const packet = {
    version: PACKET_VERSION,
    event: { kind: 'match_recap', as_of: asOf || kickoff, archive: Date.now() - Date.parse(kickoff) > 30 * 86400000 },
    match: {
      id: m.id, competition: { name: m.comp_name, slug: m.comp_slug }, season: m.season_label, matchday: m.matchday,
      kickoff_utc: kickoff, venue: m.venue_name, status: m.status,
      score: { home: m.home_score, away: m.away_score, home_ht: m.home_score_ht, away_ht: m.away_score_ht, final: `${m.home_score}-${m.away_score}`, half_time: `${m.home_score_ht}-${m.away_score_ht}` },
      winner: m.winner_team_id === m.home_team_id ? 'home' : m.winner_team_id === m.away_team_id ? 'away' : 'draw',
      margin: Math.abs(m.home_score - m.away_score),
    },
    teams: {
      home: { id: m.home_team_id, name: m.home_name, slug: m.home_slug, manager: mgr[m.home_team_id] || null, form_before: await form(m.home_team_id), table_before: pos(tableBefore, m.home_team_id), table_after: pos(table, m.home_team_id) },
      away: { id: m.away_team_id, name: m.away_name, slug: m.away_slug, manager: mgr[m.away_team_id] || null, form_before: await form(m.away_team_id), table_before: pos(tableBefore, m.away_team_id), table_after: pos(table, m.away_team_id) },
    },
    goals, shots, stats, shares, shot_profile: shotProfile, key_performers: keyPerformers,
    derivation: { counts: derivation, shares: 'ratio of derived counts', distance: 'euclidean distance to goal centre on the 105x68 canonical pitch' },
    unavailable: ['possession_pct (no possession clock in source)', 'xg (PBE xG not validated)', 'formation (not stated by source)', 'injuries (no legitimate source ingested)', 'quotes (none sourced)'],
    provenance: { attributions, source_results: await q(`select provider, home_score, away_score, home_score_ht, away_score_ht, capture_id from public.soccer_match_source_results where match_id = $1 order by provider`, [matchId]) },
  };
  packet.event.event_id = uuidv5(`news_event:match_recap:${m.id}:${packet.event.as_of}`);
  packet.hash = payloadHash(packet);
  return packet;
}

export function computeTable(matches) {
  const t = new Map();
  const row = id => { if (!t.has(id)) t.set(id, { team_id: id, played: 0, points: 0, gf: 0, ga: 0, gd: 0 }); return t.get(id); };
  for (const x of matches) {
    const h = row(x.home_team_id); const a = row(x.away_team_id);
    h.played += 1; a.played += 1; h.gf += x.home_score; h.ga += x.away_score; a.gf += x.away_score; a.ga += x.home_score;
    if (x.home_score > x.away_score) h.points += 3; else if (x.home_score < x.away_score) a.points += 3; else { h.points += 1; a.points += 1; }
  }
  for (const r of t.values()) r.gd = r.gf - r.ga;
  return [...t.values()].sort((x, y) => y.points - x.points || y.gd - x.gd || y.gf - x.gf || (x.team_id < y.team_id ? -1 : 1));
}
