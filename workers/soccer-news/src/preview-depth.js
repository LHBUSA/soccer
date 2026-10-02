// PACKET V4 (previews): deterministic football texture for a fixture that has NOT been played, as
// STRUCTURED EVIDENCE (never prose). Everything is built from canonical rows dated strictly before
// kick-off (as-of safe), across every competition in the canonical graph (each match labelled with its
// competition), so a national team's World Cup and Nations League matches both count.
//   per team: last five results, record, goals for/against, clean sheets, scoring by half and 15-minute
//             period (ONLY matches whose goal events reconcile to the final score), shots / on target
//             (source team statistics), located-shot profile (PBE derived from event coordinates),
//             scorers, player contribution lines, sourced formations + starting XI continuity, cards,
//             home/away split, rest days
//   fixture : head-to-head in the canonical record (with its coverage start), previous same-season
//             meeting, each side's following fixture, mathematically provable group consequences
//   angles  : deterministic evidence labels ranked by weight; the desk builds the story around the first
// Never: injuries, suspensions, predicted lineups, tactics or intent, odds, probabilities, quotes.
import { distanceToGoal } from './packet.js';
import { bucketOf, BUCKETS } from './depth.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const PREVIEW_DEPTH_VERSION = 'soccer-preview-depth/1.0.0';
export const PACKET_V4_PREVIEW = 'soccer-packet-preview/2.0.0';
const FAMILY = ['wyscout_figshare', 'espn', 'openligadb'];
const RECENT_N = 5;
export const RECENT_MAX_AGE_DAYS = 400; // older results are not 'recent' (a two-year-old friendly is history, not form)
const DAY = 86400e3;
const BOX = { x: 105 - 16.5, halfWidth: 20.16, mid: 34 };
const inBox = s => s.x_m !== null && s.x_m !== undefined && Number(s.x_m) >= BOX.x && Math.abs(Number(s.y_m) - BOX.mid) <= BOX.halfWidth;
const valid = m => m.status === 'finished' && Number.isInteger(m.home_score) && Number.isInteger(m.away_score);
const r1 = x => Math.round(x * 10) / 10;
const byKickDesc = (a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at) || (a.id < b.id ? 1 : -1);
const halfOf = b => (['0-15', '16-30', '31-45+'].includes(b) ? 'first_half' : b === 'extra_time' ? 'extra_time' : 'second_half');

// ---------------------------------------------------------------- pure builders

// One recent match from the team's point of view, with its sourced detail where the record has it.
// rows: { goals: [{minute, period, display, side, scorer_id, assist_id, own_goal}], shots: [...], cards, subs,
//         lineup: { formation, starters: [ids] } | null, stats: { shots, shots_on_target } | null }
export function teamMatchView(m, tid, rows = {}, { teams = new Map(), comps = new Map() } = {}) {
  const home = m.home_team_id === tid; const me = home ? 'home' : 'away'; const opp = home ? 'away' : 'home';
  const gf = home ? m.home_score : m.away_score; const ga = home ? m.away_score : m.home_score;
  const goals = rows.goals || [];
  const reconciles = goals.length === gf + ga && goals.filter(g => g.side === me).length === gf;
  const o = teams.get(home ? m.away_team_id : m.home_team_id);
  return {
    match_id: m.id, date: new Date(m.kickoff_at).toISOString().slice(0, 10), kickoff_at: new Date(m.kickoff_at).toISOString(),
    competition: comps.get(m.competition_id) || null, venue: home ? 'home' : 'away',
    opponent: o ? { id: o.id, name: o.name, slug: o.slug } : { id: home ? m.away_team_id : m.home_team_id, name: null, slug: null },
    goals_for: gf, goals_against: ga, result: gf > ga ? 'W' : gf < ga ? 'L' : 'D',
    goal_events_reconcile: reconciles,
    goals: reconciles ? goals.map(g => ({ ...g, for: g.side === me })) : [],
    shots: rows.shots?.length ? rows.shots.map(s => ({ ...s, for: s.side === me })) : [],
    stats: rows.stats ? { for: rows.stats[me] || null, against: rows.stats[opp] || null, basis: rows.stats.basis || null } : null,
    lineup: rows.lineups?.[me] || null,
    cards: (rows.cards || []).filter(c => c.side === me),
  };
}

// Team block over its recent matches (newest first). Every aggregate states how many matches it counts.
export function teamDepth(views, { people = new Map(), restFrom = null, kickoff = null } = {}) {
  const n = views.length;
  const sum = f => views.reduce((a, v) => a + f(v), 0);
  const record = { played: n, won: views.filter(v => v.result === 'W').length, drawn: views.filter(v => v.result === 'D').length, lost: views.filter(v => v.result === 'L').length,
    goals_for: sum(v => v.goals_for), goals_against: sum(v => v.goals_against), clean_sheets: views.filter(v => v.goals_against === 0).length, failed_to_score: views.filter(v => v.goals_for === 0).length };
  const venue = k => { const vs = views.filter(v => v.venue === k); return { played: vs.length, won: vs.filter(v => v.result === 'W').length, drawn: vs.filter(v => v.result === 'D').length, lost: vs.filter(v => v.result === 'L').length, goals_for: vs.reduce((a, v) => a + v.goals_for, 0), goals_against: vs.reduce((a, v) => a + v.goals_against, 0) }; };
  // scoring by period: reconciled matches only
  const rec = views.filter(v => v.goal_events_reconcile && v.goals_for + v.goals_against > 0 || (v.goal_events_reconcile && v.goals_for + v.goals_against === 0));
  const periods = {}; for (const b of BUCKETS) periods[b] = { for: 0, against: 0 };
  const halves = { first_half: { for: 0, against: 0 }, second_half: { for: 0, against: 0 }, extra_time: { for: 0, against: 0 } };
  for (const v of rec) for (const g of v.goals) {
    const b = /^45\+/.test(String(g.display || '')) ? '31-45+' : bucketOf(g.minute, g.period); if (!b) continue;
    periods[b][g.for ? 'for' : 'against'] += 1; halves[halfOf(b)][g.for ? 'for' : 'against'] += 1;
  }
  for (const b of BUCKETS) if (!periods[b].for && !periods[b].against) delete periods[b];
  if (!halves.extra_time.for && !halves.extra_time.against) delete halves.extra_time;
  // shots: source team statistics where both sides are published
  const withStats = views.filter(v => v.stats?.for && Number.isFinite(Number(v.stats.for.shots)));
  const shots = withStats.length ? { matches_counted: withStats.length, basis: withStats[0].stats.basis,
    for: sum(v => (withStats.includes(v) ? Number(v.stats.for.shots) || 0 : 0)), on_target_for: sum(v => (withStats.includes(v) ? Number(v.stats.for.shots_on_target) || 0 : 0)),
    against: sum(v => (withStats.includes(v) && v.stats.against ? Number(v.stats.against.shots) || 0 : 0)), on_target_against: sum(v => (withStats.includes(v) && v.stats.against ? Number(v.stats.against.shots_on_target) || 0 : 0)) } : null;
  // located shots (PBE derived from the source event coordinates, attacking frame)
  const loc = views.flatMap(v => v.shots.filter(s => s.for && s.x_m !== null && s.x_m !== undefined));
  const located = loc.length ? { matches_counted: views.filter(v => v.shots.some(s => s.for && s.x_m !== null && s.x_m !== undefined)).length, shots: loc.length, inside_box: loc.filter(inBox).length, outside_box: loc.filter(s => !inBox(s)).length,
    avg_distance_m: r1(loc.reduce((a, s) => a + distanceToGoal(s.x_m, s.y_m), 0) / loc.length), basis: 'PBE derived from source event coordinates (penalty area x >= 88.5 m, |y - 34| <= 20.16 m)' } : null;
  // scorers + contribution lines
  const lines = new Map();
  const line = pid => { const p = people.get(pid); if (!p) return null; if (!lines.has(pid)) lines.set(pid, { player: p, goals: 0, assists: 0, shots: 0, shots_on_target: 0, starts: 0, scoring_matches: 0 }); return lines.get(pid); };
  for (const v of views) {
    const scored = new Set();
    for (const g of v.goals.filter(x => x.for && !x.own_goal)) { const l = g.scorer_id && line(g.scorer_id); if (l) { l.goals += 1; scored.add(g.scorer_id); } const a = g.assist_id && line(g.assist_id); if (a) a.assists += 1; }
    for (const pid of scored) lines.get(pid).scoring_matches += 1;
    for (const s of v.shots.filter(x => x.for && x.player_id)) { const l = line(s.player_id); if (l) { l.shots += 1; if (s.outcome === 'goal' || s.outcome === 'on_target' || s.is_goal) l.shots_on_target += 1; } }
    for (const pid of v.lineup?.starters || []) { const l = line(pid); if (l) l.starts += 1; }
  }
  const contributors = [...lines.values()].filter(l => l.goals || l.assists || l.shots)
    .sort((a, b) => (b.goals + b.assists) - (a.goals + a.assists) || b.shots_on_target - a.shots_on_target || b.shots - a.shots || (a.player.name < b.player.name ? -1 : 1)).slice(0, 5);
  const scorers = [...lines.values()].filter(l => l.goals).sort((a, b) => b.goals - a.goals || (a.player.name < b.player.name ? -1 : 1)).map(l => ({ player: l.player, goals: l.goals, scoring_matches: l.scoring_matches }));
  const goalsByPlayers = scorers.reduce((a, s) => a + s.goals, 0);
  // lineups: sourced formations + starting XI continuity between the two most recent sourced lineups
  const lu = views.filter(v => v.lineup?.starters?.length >= 11);
  const formations = lu.filter(v => v.lineup.formation).map(v => ({ match_id: v.match_id, date: v.date, formation: v.lineup.formation }));
  const continuity = lu.length >= 2 ? { latest: lu[0].date, previous: lu[1].date, same_starters: lu[0].lineup.starters.filter(p => lu[1].lineup.starters.includes(p)).length, of: lu[0].lineup.starters.length } : null;
  const cards = { yellow: sum(v => v.cards.filter(c => c.card === 'yellow').length), red: sum(v => v.cards.filter(c => c.card === 'red').length), matches_counted: views.filter(v => v.cards !== undefined).length };
  const last = views[0];
  return {
    record, home: venue('home'), away: venue('away'),
    results: views.map(v => ({ match_id: v.match_id, date: v.date, competition: v.competition, venue: v.venue, opponent: v.opponent, score: `${v.goals_for}-${v.goals_against}`, result: v.result })),
    scoring_by_period: rec.length ? { matches_counted: rec.length, of: n, halves, buckets: periods } : null,
    shots, located_shots: located,
    scorers, goals_by_identified_scorers: goalsByPlayers,
    contributors,
    formations, starting_xi_continuity: continuity,
    cards,
    rest_days: last && kickoff ? Math.floor((Date.parse(kickoff) - Date.parse(restFrom || last.kickoff_at)) / DAY) : null,
  };
}

// This competition-season only (the campaign the fixture belongs to).
export function campaignRecord(matches, tid) {
  const ms = matches.filter(valid);
  const r = ms.map(m => { const h = m.home_team_id === tid; const gf = h ? m.home_score : m.away_score; const ga = h ? m.away_score : m.home_score; return { gf, ga, res: gf > ga ? 'W' : gf < ga ? 'L' : 'D' }; });
  return { played: r.length, won: r.filter(x => x.res === 'W').length, drawn: r.filter(x => x.res === 'D').length, lost: r.filter(x => x.res === 'L').length, goals_for: r.reduce((a, x) => a + x.gf, 0), goals_against: r.reduce((a, x) => a + x.ga, 0), clean_sheets: r.filter(x => x.ga === 0).length };
}

// Head-to-head in the canonical record: every stored meeting before kick-off (any competition).
export function headToHead(meetings, homeId, awayId, { coverageStart = null } = {}) {
  const ms = meetings.filter(valid).sort(byKickDesc);
  const winsOf = tid => ms.filter(m => (m.home_team_id === tid && m.home_score > m.away_score) || (m.away_team_id === tid && m.away_score > m.home_score)).length;
  const goalsOf = tid => ms.reduce((a, m) => a + (m.home_team_id === tid ? m.home_score : m.away_score), 0);
  return { meetings: ms.length, home_wins: winsOf(homeId), away_wins: winsOf(awayId), draws: ms.filter(m => m.home_score === m.away_score).length,
    home_goals: goalsOf(homeId), away_goals: goalsOf(awayId), coverage_start: coverageStart,
    wording: coverageStart ? `in the PropBetEdge record since ${coverageStart}` : 'in the PropBetEdge record',
    latest: ms.slice(0, 3).map(m => ({ match_id: m.id, date: new Date(m.kickoff_at).toISOString().slice(0, 10), home_team_id: m.home_team_id, away_team_id: m.away_team_id, score: `${m.home_score}-${m.away_score}` })) };
}

// Provable group consequences after this round. `table` = current verified group points (team_id ->
// points), `fixtures` = this round's scheduled group fixtures (incl. this one). Every outcome combination
// is enumerated; a statement is emitted only when it holds in EVERY combination it quantifies over,
// and only on points (no tie-breaker is ever assumed: a tie on points is never called "top").
export function groupConsequences(table, fixtures, focus) {
  if (!table || !fixtures?.length || !fixtures.some(f => f.id === focus.id)) return null;
  const teams = Object.keys(table);
  const outcomes = ['H', 'D', 'A'];
  const combos = fixtures.reduce((acc) => acc.flatMap(c => outcomes.map(o => [...c, o])), [[]]);
  const apply = combo => { const pts = { ...table }; fixtures.forEach((f, i) => { const o = combo[i]; if (o === 'H') pts[f.home_team_id] += 3; else if (o === 'A') pts[f.away_team_id] += 3; else { pts[f.home_team_id] += 1; pts[f.away_team_id] += 1; } }); return pts; };
  const fi = fixtures.findIndex(f => f.id === focus.id);
  const soleTop = (pts, tid) => teams.every(t => t === tid || pts[tid] > pts[t]);
  const out = [];
  for (const [side, tid, win] of [['home', focus.home_team_id, 'H'], ['away', focus.away_team_id, 'A']]) {
    const withWin = combos.filter(c => c[fi] === win).map(apply);
    if (withWin.length && withWin.every(p => soleTop(p, tid))) out.push({ team_id: tid, side, statement: 'win_guarantees_sole_top_on_points_after_round', points_after_win: table[tid] + 3 });
    const anyTop = combos.map(apply).some(p => soleTop(p, tid));
    if (!anyTop) out.push({ team_id: tid, side, statement: 'cannot_be_sole_top_on_points_after_round' });
  }
  return { basis: 'All outcome combinations of this round’s scheduled group fixtures, points only; tie-breakers never assumed.', fixtures_counted: fixtures.length, statements: out, points_now: Object.fromEntries([focus.home_team_id, focus.away_team_id].map(t => [t, table[t] ?? null])) };
}

// Deterministic angle labels from the depth evidence (never prose). Highest weight first.
export function selectAngles(d, { homeId, awayId, group = {}, h2h = null, consequences = null, playersInForm = [] } = {}) {
  const A = []; const add = (key, weight, detail) => A.push({ key, weight, detail });
  const T = { home: d.home, away: d.away };
  const g = { home: group[homeId], away: group[awayId] };
  if (g.home?.verified && g.away?.verified && g.home.group === g.away.group && g.home.position <= 2 && g.away.position <= 2) add('group_leaders_meet', 1.2, { group: g.home.group, home_position: g.home.position, away_position: g.away.position });
  for (const k of ['home', 'away']) {
    const t = T[k]; if (!t?.record?.played) continue;
    const tid = k === 'home' ? homeId : awayId;
    const r = t.campaign?.played >= 2 ? t.campaign : t.record; const scope = t.campaign?.played >= 2 ? 'campaign' : 'recent';
    if (r.played >= 2 && r.won === r.played) add(scope === 'campaign' ? 'perfect_start' : 'winning_run', 0.9, { side: k, team_id: tid, won: r.won, scope });
    if (r.played >= 2 && r.clean_sheets === r.played) add('defensive_run', 0.8, { side: k, team_id: tid, clean_sheets: r.clean_sheets, scope });
    if (r.played >= 2 && r.goals_for >= 2.5 * r.played) add('scoring_run', 0.7, { side: k, team_id: tid, goals_for: r.goals_for, played: r.played, scope });
    if (t.shots && t.shots.matches_counted >= 2 && t.shots.for >= 15 * t.shots.matches_counted) add('high_shot_volume', 0.5, { side: k, team_id: tid, shots: t.shots.for, matches: t.shots.matches_counted });
    const top = t.scorers[0];
    if (top && t.record.goals_for >= 3 && top.goals * 2 >= t.record.goals_for) add('finishing_concentration', 0.6, { side: k, team_id: tid, player: top.player, goals: top.goals, team_goals: t.record.goals_for, scope: 'recent' });
    const h = t.home; const a = t.away;
    if (h.played >= 2 && a.played >= 2 && ((h.won === h.played && a.won === 0) || (a.won === a.played && h.won === 0))) add('home_away_contrast', 0.4, { side: k, team_id: tid, home: h, away: a });
  }
  for (const p of playersInForm) add('player_scoring_run', 0.6, { player: p.player, side: p.team, matches: p.consecutive_scoring_appearances });
  if (h2h?.meetings) add('rematch', h2h.latest[0] && Date.parse(h2h.latest[0].date) > Date.now() - 400 * DAY ? 0.6 : 0.3, { meetings: h2h.meetings, latest: h2h.latest[0] });
  if (consequences?.statements?.some(s => s.statement === 'win_guarantees_sole_top_on_points_after_round')) add('qualification_stakes', 0.9, { statements: consequences.statements });
  return A.sort((x, y) => y.weight - x.weight || (x.key < y.key ? -1 : 1));
}

// How much evidence the packet carries (drives the desk's length allowance; never forces length).
export function evidenceDepth(d) {
  let n = 0;
  for (const k of ['home', 'away']) {
    const t = d[k]; if (!t) continue;
    if (t.record?.played >= 2) n += 1;
    if (t.scoring_by_period) n += 1;
    if (t.shots) n += 1;
    if (t.located_shots) n += 1;
    if (t.scorers?.length) n += 1;
    if (t.formations?.length) n += 1;
  }
  if (d.h2h?.meetings) n += 1;
  if (d.group_consequences?.statements?.length) n += 1;
  return { score: n, rich: n >= 9, word_range: n >= 9 ? [500, 850] : [250, 550], sections: n >= 9 ? [3, 5] : [3, 4] };
}

// ---------------------------------------------------------------- loader (as-of safe)

export async function loadPreviewDepth(store, { match, groups = {}, groupTable = null, roundFixtures = [], playersInForm = [] }) {
  const kick = new Date(match.kickoff_at).toISOString();
  const cols = ['id', 'competition_id', 'season_id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'];
  const teamMatches = async tid => (await Promise.all(['home_team_id', 'away_team_id'].map(k => store.select('soccer_matches', { columns: cols, eq: { [k]: tid }, lte: { kickoff_at: kick }, order: 'kickoff_at.desc', limit: 40 })))).flat()
    .map(m => ({ ...m, kickoff_at: new Date(m.kickoff_at).toISOString() })).filter(valid).sort(byKickDesc);
  const [H, A] = [match.home_team_id, match.away_team_id];
  const [hm, am] = await Promise.all([teamMatches(H), teamMatches(A)]);
  const fresh = list => list.filter(m => Date.parse(kick) - Date.parse(m.kickoff_at) <= RECENT_MAX_AGE_DAYS * DAY);
  const recent = { home: fresh(hm).slice(0, RECENT_N), away: fresh(am).slice(0, RECENT_N) };
  const campaign = { home: hm.filter(m => m.season_id === match.season_id && m.competition_id === match.competition_id), away: am.filter(m => m.season_id === match.season_id && m.competition_id === match.competition_id) };
  const ids = [...new Set([...recent.home, ...recent.away].map(m => m.id))];
  const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'] })).map(c => [c.id, { slug: c.slug, name: c.name }]));
  const teamIds = [...new Set([...recent.home, ...recent.away].flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teams = new Map();
  for (const part of chunkArr(teamIds, 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], in: { id: part } })) teams.set(t.id, t);
  // events (one source family per match), stats, lineups, cards
  const ev = [];
  for (const part of chunkArr(ids, 40)) ev.push(...await store.select('soccer_match_events', { columns: ['match_id', 'sequence', 'period', 'minute', 'team_id', 'player_id', 'event_type', 'subtype', 'outcome', 'is_goal', 'is_own_goal', 'card', 'x_m', 'y_m', 'source_family'], in: { match_id: part, event_type: ['shot', 'card', 'touch', 'pass', 'goal'] } }));
  const assists = ev.filter(e => e.subtype === 'espn_assist');
  const stats = []; for (const part of chunkArr(ids, 60)) stats.push(...await store.select('soccer_team_match_stats', { columns: ['match_id', 'team_id', 'stat_key', 'value', 'basis'], in: { match_id: part, stat_key: ['shots', 'shots_on_target'] } }));
  const lineups = []; for (const part of chunkArr(ids, 60)) lineups.push(...await store.select('soccer_lineups', { columns: ['id', 'match_id', 'team_id', 'formation'], in: { match_id: part } }));
  const lps = []; for (const part of chunkArr(lineups.map(l => l.id), 60)) lps.push(...await store.select('soccer_lineup_players', { columns: ['lineup_id', 'player_id', 'is_starter'], in: { lineup_id: part }, eq: { is_starter: true } }));
  const pids = new Set([...ev.map(e => e.player_id), ...lps.map(x => x.player_id)].filter(Boolean));
  const people = new Map();
  for (const part of chunkArr([...pids], 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: part } })) people.set(p.id, { id: p.id, name: p.display_name, slug: p.slug });
  const rowsFor = m => {
    const side = tid => (tid === m.home_team_id ? 'home' : tid === m.away_team_id ? 'away' : null);
    const mine = ev.filter(e => e.match_id === m.id);
    const fam = FAMILY.find(f => mine.some(e => (e.is_goal || e.is_own_goal) && e.source_family === f)) || FAMILY.find(f => mine.some(e => e.source_family === f));
    const fe = mine.filter(e => e.source_family === fam).sort((a, b) => a.sequence - b.sequence);
    const goals = fe.filter(e => e.is_goal || e.is_own_goal).map(e => {
      // own goals: ESPN tags the BENEFITING team, others the player's team (workers/shared/own-goals.js); the
      // scoring side is the side the goal counts for.
      const s = side(e.team_id); const counted = e.is_own_goal && fam !== 'espn' ? (s === 'home' ? 'away' : 'home') : s;
      const ast = !e.is_own_goal && fam === 'espn' ? assists.filter(a => a.match_id === m.id && a.team_id === e.team_id && Math.abs(a.sequence - e.sequence) <= 4).sort((x, y) => Math.abs(e.sequence - x.sequence) - Math.abs(e.sequence - y.sequence))[0] : null;
      return { minute: e.minute, period: e.period, side: counted, scorer_id: e.player_id, assist_id: ast?.player_id || null, own_goal: !!e.is_own_goal };
    });
    const shots = fe.filter(e => e.event_type === 'shot').map(e => ({ side: side(e.team_id), player_id: e.player_id, outcome: e.outcome, is_goal: e.is_goal, x_m: e.x_m === null ? null : Number(e.x_m), y_m: e.y_m === null ? null : Number(e.y_m) }));
    const cards = fe.filter(e => e.card).map(e => ({ side: side(e.team_id), card: e.card }));
    const st = stats.filter(s => s.match_id === m.id);
    const basis = st.some(s => s.basis === 'source') ? 'source' : st.length ? 'derived' : null;
    const sv = k => { const tid = k === 'home' ? m.home_team_id : m.away_team_id; const r = st.filter(s => s.team_id === tid && s.basis === basis); return r.length ? Object.fromEntries(r.map(s => [s.stat_key, Number(s.value)])) : null; };
    const lu = k => { const tid = k === 'home' ? m.home_team_id : m.away_team_id; const l = lineups.find(x => x.match_id === m.id && x.team_id === tid); return l ? { formation: l.formation || null, starters: lps.filter(x => x.lineup_id === l.id).map(x => x.player_id) } : null; };
    return { goals, shots, cards, stats: basis ? { home: sv('home'), away: sv('away'), basis } : null, lineups: { home: lu('home'), away: lu('away') } };
  };
  const view = (m, tid) => teamMatchView(m, tid, rowsFor(m), { teams, comps });
  const depthOf = (list, tid) => teamDepth(list.map(m => view(m, tid)), { people, kickoff: kick });
  // H2H across the canonical graph + its coverage start (earliest stored match of either side)
  const meetings = hm.filter(m => m.home_team_id === A || m.away_team_id === A);
  const earliest = [...hm, ...am].map(m => m.kickoff_at).sort()[0] || null;
  const h2h = headToHead(meetings, H, A, { coverageStart: earliest ? earliest.slice(0, 4) : null });
  const sameSeason = meetings.find(m => m.season_id === match.season_id) || null;
  const next = async tid => (await Promise.all(['home_team_id', 'away_team_id'].map(k => store.select('soccer_matches', { columns: cols, eq: { [k]: tid, status: 'scheduled' }, gte: { kickoff_at: kick }, order: 'kickoff_at.asc', limit: 2 })))).flat().filter(x => x.id !== match.id && Date.parse(x.kickoff_at) > Date.parse(kick)).sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at))[0] || null;
  const [nh, na] = await Promise.all([next(H), next(A)]);
  const nextRef = async (n, tid) => { if (!n) return null; const o = n.home_team_id === tid ? n.away_team_id : n.home_team_id; const [t] = await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], eq: { id: o }, limit: 1 }); return { match_id: n.id, date: new Date(n.kickoff_at).toISOString().slice(0, 10), venue: n.home_team_id === tid ? 'home' : 'away', opponent: t ? { id: t.id, name: t.name, slug: t.slug } : null, competition: comps.get(n.competition_id) || null }; };
  const withCampaign = (list, tid) => ({ ...depthOf(list, tid), campaign: campaignRecord(campaign[tid === H ? 'home' : 'away'], tid) });
  const d = { version: PREVIEW_DEPTH_VERSION, recent_window: { max_matches: RECENT_N, max_age_days: RECENT_MAX_AGE_DAYS }, home: withCampaign(recent.home, H), away: withCampaign(recent.away, A), h2h, previous_same_season_meeting: sameSeason ? { match_id: sameSeason.id, date: sameSeason.kickoff_at.slice(0, 10), score: `${sameSeason.home_score}-${sameSeason.away_score}`, home_team_id: sameSeason.home_team_id } : null,
    next: { home: await nextRef(nh, H), away: await nextRef(na, A) },
    group_consequences: groupTable ? groupConsequences(groupTable, roundFixtures, match) : null };
  d.angles = selectAngles(d, { homeId: H, awayId: A, group: groups, h2h: d.h2h, consequences: d.group_consequences, playersInForm });
  d.primary_angle = d.angles[0]?.key || null;
  d.evidence_depth = evidenceDepth(d);
  d.never = ['injuries or suspensions', 'predicted or probable lineups', 'tactics, intent or game plans', 'odds, predictions or probabilities', 'quotes'];
  return d;
}
