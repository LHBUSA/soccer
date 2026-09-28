// PACKET v3 depth: deterministic match texture from data we already own, as STRUCTURED EVIDENCE (never
// prose). Built from the match's own sourced events and results dated before the story (as-of safe):
//   phases (halves + 15-minute buckets), goal sequence, player match lines, shot profile, table move,
//   recent league results (up to five), cards and substitutions.
// Nothing here is a judgement: no momentum, dominance, pressure, chance quality or xG.
import { distanceToGoal } from './packet.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const PACKET_V3 = 'soccer-packet/3.0.0';
export const DEPTH_VERSION = 'soccer-depth/1.0.0';
const FAMILY = ['wyscout_figshare', 'espn', 'openligadb'];
const BOX = { x: 105 - 16.5, halfWidth: 20.16, mid: 34 }; // normalised: every team attacks toward x = 105
export const BUCKETS = ['0-15', '16-30', '31-45+', '46-60', '61-75', '76-90+', 'extra_time'];

// Bucket of a sourced minute; a first-half stoppage minute ("45+2'") stays in the first half.
export function bucketOf(minute, period) {
  if (minute === null || minute === undefined || minute === '') return null;
  const m = Number(minute);
  if (!Number.isFinite(m)) return null;
  if (period === 'E1' || period === 'E2' || (period !== '1H' && period !== '2H' && m > 105)) return 'extra_time';
  if (period === '1H' || (!period && m <= 45)) return m <= 15 ? '0-15' : m <= 30 ? '16-30' : '31-45+';
  return m <= 60 ? '46-60' : m <= 75 ? '61-75' : '76-90+';
}
const halfOf = b => (['0-15', '16-30', '31-45+'].includes(b) ? 'first_half' : b === 'extra_time' ? 'extra_time' : 'second_half');
const pct = (a, b) => (b ? Math.round((100 * a) / b) : null);
const ratio = (a, b) => (b ? Math.round((100 * a) / b) / 100 : null);
const inBox = s => s.x_m !== null && s.x_m !== undefined && Number(s.x_m) >= BOX.x && Math.abs(Number(s.y_m) - BOX.mid) <= BOX.halfWidth;

// Pure: everything derived from the loaded rows + the frozen v2 packet (goals, stats, tables, next).
export function depthFromRows(packet, { shots = [], cards = [], subs = [], people = new Map(), teamSide, recent = { home: [], away: [] } }) {
  const side = teamSide;
  const zero = () => ({ shots: 0, shots_on_target: 0, goals: 0 });
  // phases from sourced shot events (one source family) and the packet's goal list
  const phases = { first_half: { home: zero(), away: zero() }, second_half: { home: zero(), away: zero() }, buckets: {} };
  for (const b of BUCKETS) phases.buckets[b] = { home: zero(), away: zero() };
  for (const s of shots) {
    const b = bucketOf(s.minute, s.period); const k = side(s.team_id); if (!b || !k) continue;
    const on = s.outcome === 'goal' || s.outcome === 'on_target' || s.is_goal;
    phases.buckets[b][k].shots += 1; if (on) phases.buckets[b][k].shots_on_target += 1;
    const h = halfOf(b); if (phases[h]) { phases[h][k].shots += 1; if (on) phases[h][k].shots_on_target += 1; }
  }
  const goals = packet.goals || [];
  for (const g of goals) {
    const stoppage1 = /^45\+/.test(String(g.display_minute || ''));
    const b = stoppage1 ? '31-45+' : bucketOf(g.minute, null);
    if (!b) continue;
    phases.buckets[b][g.team].goals += 1; const h = halfOf(b); if (phases[h]) phases[h][g.team].goals += 1;
  }
  for (const b of BUCKETS) if (!['home', 'away'].some(k => phases.buckets[b][k].shots || phases.buckets[b][k].goals)) delete phases.buckets[b];
  phases.shot_events_source = shots.length ? shots[0].source_family : null;

  // goal sequence
  const secondHalf = goals.filter(g => !/^45\+/.test(String(g.display_minute || '')) && g.minute > 45);
  const after = n => ({ home: goals.filter(g => g.minute > n && !/^45\+/.test(String(g.display_minute || '')) && g.team === 'home').length, away: goals.filter(g => g.minute > n && !/^45\+/.test(String(g.display_minute || '')) && g.team === 'away').length });
  const sc = packet.match?.score || {};
  const goal_sequence = goals.length ? {
    goals_total: goals.length,
    opening_goal: { minute: goals[0].display_minute, team: goals[0].team, scorer: goals[0].scorer?.name || null },
    halftime_score: sc.home_ht !== null && sc.home_ht !== undefined ? `${sc.home_ht}-${sc.away_ht}` : null,
    first_second_half_goal: secondHalf[0] ? { minute: secondHalf[0].display_minute, team: secondHalf[0].team, scorer: secondHalf[0].scorer?.name || null } : null,
    goal_intervals_minutes: goals.slice(1).map((g, i) => g.minute - goals[i].minute),
    goals_after_60: after(60), goals_after_70: after(70),
    second_half_goals: { home: secondHalf.filter(g => g.team === 'home').length, away: secondHalf.filter(g => g.team === 'away').length },
  } : null;

  // player match lines (sourced counts only; nothing when the source has no events)
  const lines = new Map();
  const L = (pid, team) => { const p = people.get(pid); if (!p) return null; if (!lines.has(pid)) lines.set(pid, { player: p, team, goals: 0, assists: 0, shots: 0, shots_on_target: 0, shots_inside_box: 0 }); return lines.get(pid); };
  for (const s of shots) { if (!s.player_id) continue; const r = L(s.player_id, side(s.team_id)); if (!r) continue; r.shots += 1; if (s.outcome === 'goal' || s.outcome === 'on_target' || s.is_goal) r.shots_on_target += 1; if (inBox(s)) r.shots_inside_box += 1; }
  const lineOf = (pl, team) => { if (!lines.has(pl.id)) lines.set(pl.id, { player: pl, team, goals: 0, assists: 0, shots: 0, shots_on_target: 0, shots_inside_box: 0 }); return lines.get(pl.id); };
  for (const g of goals) {
    if (g.scorer?.id && !g.own_goal) lineOf(g.scorer, g.team).goals += 1;
    if (g.assist?.id) lineOf(g.assist, g.team).assists += 1;
  }
  const player_lines = [...lines.values()].filter(r => r.goals || r.assists || r.shots)
    .sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists) || b.shots_on_target - a.shots_on_target || b.shots - a.shots || (a.player.name < b.player.name ? -1 : 1)).slice(0, 10)
    .map(r => ({ ...r, shots_inside_box: shots.some(s => s.x_m !== null && s.x_m !== undefined) ? r.shots_inside_box : null }));

  // shot profile: team totals from the stats basis, locations from the shot events
  const st = packet.stats || null; const tot = st ? (Number(st.home?.shots) || 0) + (Number(st.away?.shots) || 0) : 0;
  const located = shots.filter(s => s.x_m !== null && s.x_m !== undefined);
  const teamProfile = k => {
    const my = located.filter(s => side(s.team_id) === k);
    const d = my.map(s => distanceToGoal(s.x_m, s.y_m)).filter(v => v !== null);
    const g = goals.filter(x => x.team === k).length;
    return {
      shots: st?.[k]?.shots ?? null, shots_on_target: st?.[k]?.shots_on_target ?? null,
      on_target_pct: st ? pct(st[k]?.shots_on_target ?? 0, st[k]?.shots) : null,
      share_of_total_shots_pct: st && tot ? pct(Number(st[k]?.shots) || 0, tot) : null,
      goals: g, goals_per_shot: st ? ratio(g, st[k]?.shots) : null, goals_per_shot_on_target: st ? ratio(g, st[k]?.shots_on_target) : null,
      located_shots: my.length, located_inside_box: my.filter(inBox).length, located_outside_box: my.filter(s => !inBox(s)).length,
      avg_located_distance_m: d.length ? Math.round((d.reduce((p, q) => p + q, 0) / d.length) * 10) / 10 : null,
      first_half_shot_events: phases.first_half[k].shots, second_half_shot_events: phases.second_half[k].shots,
    };
  };
  const shot_profile = st || located.length ? { basis: st?.basis || null, total_shots: st ? tot : null, located_total: located.length, home: teamProfile('home'), away: teamProfile('away'), box_rule: 'penalty area from event coordinates (x >= 88.5 m, |y - 34| <= 20.16 m)' } : null;

  // table move (from the frozen as-of tables)
  const move = k => { const t = packet.teams?.[k]; if (!t?.table_after) return null; const b = t.table_before?.position ?? null; const a = t.table_after.position; return { position_before: b, position_after: a, position_change: b === null ? null : b - a, points_after: t.table_after.points, played_after: t.table_after.played, goal_difference_after: t.table_after.goal_difference }; };
  const table_move = packet.teams?.home?.table_after ? { teams_in_table: packet.teams_in_table, home: move('home'), away: move('away') } : null;

  // discipline + substitutions (context the editor MAY use; never required)
  const discipline = cards.map(c => ({ minute: c.minute, team: side(c.team_id), player: people.get(c.player_id) || null, card: c.card })).filter(c => c.team);
  const substitutions = subs.map(s => ({ minute: s.minute, team: side(s.team_id), player_in: people.get(s.player_in_id) || null, player_out: people.get(s.player_out_id) || null })).filter(s => s.team).sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));

  return { version: DEPTH_VERSION, phases, goal_sequence, player_lines, shot_profile, table_move, recent_league_results: recent, discipline, substitutions };
}

// Loader: the match's own rows + league results dated before kickoff (as-of safe). Never reads standings
// or anything dated after the match.
export async function loadDepthRows(store, S, packet) {
  const m = S.matches.find(x => x.id === packet.match.id) || null;
  if (!m) throw new Error('match not in season');
  const side = tid => (tid === m.home_team_id ? 'home' : tid === m.away_team_id ? 'away' : null);
  const cols = ['sequence', 'period', 'minute', 'team_id', 'player_id', 'outcome', 'is_goal', 'x_m', 'y_m', 'source_family', 'card', 'event_type'];
  const evs = await store.select('soccer_match_events', { columns: cols, eq: { match_id: m.id }, in: { event_type: ['shot', 'card'] }, order: 'sequence.asc' });
  const shotFam = FAMILY.find(f => evs.some(e => e.event_type === 'shot' && e.source_family === f));
  const cardFam = FAMILY.find(f => evs.some(e => e.event_type === 'card' && e.source_family === f));
  const shots = evs.filter(e => e.event_type === 'shot' && e.source_family === shotFam);
  const cards = evs.filter(e => e.event_type === 'card' && e.source_family === cardFam && e.card);
  const subs = await store.select('soccer_substitutions', { columns: ['team_id', 'player_in_id', 'player_out_id', 'minute'], eq: { match_id: m.id } });
  const ids = [...new Set([...shots, ...cards].map(e => e.player_id).concat(subs.flatMap(s => [s.player_in_id, s.player_out_id])).filter(Boolean))];
  const people = new Map();
  for (const part of chunkArr(ids, 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: part } })) people.set(p.id, { id: p.id, name: p.display_name, slug: p.slug });
  const recentFor = tid => S.finished.filter(x => x.id !== m.id && S.leagueStages.has(x.stage_id) && Date.parse(x.kickoff_at) < Date.parse(m.kickoff_at) && (x.home_team_id === tid || x.away_team_id === tid))
    .sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at)).slice(0, 5)
    .map(x => { const home = x.home_team_id === tid; const gf = home ? x.home_score : x.away_score; const ga = home ? x.away_score : x.home_score; const o = S.teams.get(home ? x.away_team_id : x.home_team_id); return { date: new Date(x.kickoff_at).toISOString().slice(0, 10), opponent: o ? { name: o.name, slug: o.slug } : null, venue: home ? 'home' : 'away', score: `${gf}-${ga}`, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D' }; });
  return { shots, cards, subs, people, teamSide: side, recent: { home: recentFor(m.home_team_id), away: recentFor(m.away_team_id) } };
}

// v3 packet for a recap: the v2 evidence + depth. For a legacy article the ORIGINAL frozen packet is the
// base (never mutated; derived_from records its hash); the depth block only adds as-of-safe texture, and a
// next fixture that had already kicked off when the rebuild ran is dropped (never stale "next" copy).
export function packetV3(base, depth, { derivedFrom = null, rebuiltAt = null } = {}) {
  const { hash, ...rest } = base;
  const p = { ...rest, version: PACKET_V3, depth };
  if (p.teams) p.teams = { ...p.teams }; // never write into the original packet's objects
  if (derivedFrom) p.derived_from = { packet_hash: derivedFrom, version: base.version, rebuilt_at: rebuiltAt, method: 'as-of-safe rebuild: original packet + depth from the match\'s own events and results before kickoff' };
  if (rebuiltAt && p.teams) for (const k of ['home', 'away']) if (p.teams[k]?.next && Date.parse(`${p.teams[k].next.date}T23:59:59Z`) < Date.parse(rebuiltAt)) { p.teams[k] = { ...p.teams[k], next: null, next_omitted: 'kicked off before this rebuild' }; }
  if (p.teams) for (const k of ['home', 'away']) if (p.teams[k]?.next) p.teams[k] = { ...p.teams[k], next: { ...p.teams[k].next, competition: p.competition?.name || null } };
  return p;
}
