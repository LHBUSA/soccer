// ARTICLE VISUAL CONTRACT (soccer-visuals). Every chart in a soccer article is a VISUAL SPEC built here,
// deterministically, from the story's FROZEN evidence packet (plus, for shot maps, the match's canonical
// located shot events: the same events, source family and frame transform PBEcast uses). The editorial desk
// may only choose which visual to emphasise (by id); it never supplies a value, a coordinate, an axis, a
// score, a percentage, a rank or a name.
//
//   packet -> buildVisuals() -> validateVisuals() -> article.body.visuals[] (frozen) -> renderer (src/components/visuals.js)
//
// A visual: { id, type, title, subtitle, data, units, entities, source, observed_at, provenance, values_hash }.
// values_hash = sha256 of { type, data, units }: the article stores it at publication and soccer-api refuses to
// serve a visual whose values no longer match (a published chart never silently changes).
import { payloadHash } from '../../shared/ids.js';
import { toMatchFrame } from '../../shared/coords.js';

export const VISUALS_VERSION = 'soccer-visuals/1.0.0';
export const SHOT_MAP_MIN_LOCATED = 6; // fewer located shots than this is not a map worth drawing
const FAMILY = ['wyscout_figshare', 'espn', 'openligadb'];

const ref = t => (t ? { id: t.id ?? null, name: t.name ?? null, slug: t.slug ?? null } : null);
const ent = (type, t) => (t?.id ? { type, id: t.id, name: t.name, slug: t.slug ?? null } : null);
const fin = v => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);
const pct1 = (a, b) => (b ? Math.round((1000 * a) / b) / 10 : null);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const longDate = iso => { const d = new Date(`${String(iso).slice(0, 10)}T12:00:00Z`); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const hashOf = v => payloadHash({ type: v.type, data: v.data, units: v.units || null });

function make(packet, observedAt, v) {
  const out = {
    id: v.id, type: v.type, title: v.title, subtitle: v.subtitle || null, data: v.data, units: v.units || null,
    entities: (v.entities || []).filter(Boolean), source: v.source,
    observed_at: observedAt,
    provenance: { builder: VISUALS_VERSION, packet_hash: packet.hash || null, packet_version: packet.version, fields: v.fields || [] },
  };
  out.values_hash = hashOf(out);
  return out;
}

// ---------------- shot points (publication-time freeze of canonical located shot events) ----------------
// The match's shot events of ONE source family (richest first, same rule as PBEcast and the depth packet),
// in the MATCH frame: home attacks toward x = 105, away toward x = 0 (the PBEcast / match-page orientation).
export async function loadShotPoints(store, packet) {
  const m = packet.match; if (!m?.id) return null;
  const home = packet.teams?.home?.id; const away = packet.teams?.away?.id;
  const evs = await store.select('soccer_match_events', { columns: ['sequence', 'period', 'minute', 'team_id', 'player_id', 'outcome', 'is_goal', 'x_m', 'y_m', 'source_family'], eq: { match_id: m.id, event_type: 'shot' }, order: 'sequence.asc' });
  const fam = FAMILY.find(f => evs.some(e => e.source_family === f));
  if (!fam) return null;
  const shots = evs.filter(e => e.source_family === fam);
  const ids = [...new Set(shots.map(s => s.player_id).filter(Boolean))];
  const people = new Map();
  if (ids.length) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: ids } })) people.set(p.id, { id: p.id, name: p.display_name, slug: p.slug });
  const points = [];
  for (const s of shots) {
    if (s.x_m === null || s.x_m === undefined || s.y_m === null || s.y_m === undefined) continue;
    const team = s.team_id === home ? 'home' : s.team_id === away ? 'away' : null; if (!team) continue;
    const f = toMatchFrame({ x_m: Number(s.x_m), y_m: Number(s.y_m) }, { isHomeTeam: team === 'home' });
    points.push({ x: Math.round(f.x * 10) / 10, y: Math.round(f.y * 10) / 10, team, minute: fin(s.minute), period: s.period || null,
      outcome: s.is_goal || s.outcome === 'goal' ? 'goal' : ['on_target', 'off_target', 'blocked', 'post'].includes(s.outcome) ? s.outcome : 'other',
      player: people.get(s.player_id) || null });
  }
  return { source_family: fam, recorded: shots.length, points };
}

// ---------------- builders per story class ----------------
export function buildVisuals(packet, { shots = null, observedAt = new Date().toISOString() } = {}) {
  const k = packet?.event?.kind;
  const specs = k === 'match_recap' ? recapVisuals(packet, shots)
    : k === 'player_form' ? formVisuals(packet)
    : k === 'team_trend' ? trendVisuals(packet)
    : k === 'match_preview' ? (packet.preview_kind === 'matchday' ? matchdayVisuals(packet) : previewVisuals(packet))
    : k === 'competition_intelligence' ? (packet.brief === 'group_watch' ? groupVisuals(packet) : raceVisuals(packet))
    : [];
  return specs.filter(Boolean).map(v => make(packet, observedAt, v));
}

function sides(p) { return { home: ref(p.teams.home), away: ref(p.teams.away) }; }
const teamEnts = p => [ent('SportsTeam', p.teams?.home), ent('SportsTeam', p.teams?.away)];

function recapVisuals(p, shots) {
  const out = [];
  const d = p.depth || {};
  const S = sides(p);
  // A. MATCH FLOW: first half vs second half (sourced shot events + the packet's goals)
  if (d.phases && (d.phases.shot_events_source || (p.goals || []).length)) {
    const half = h => ({ home: { ...d.phases[h].home }, away: { ...d.phases[h].away } });
    out.push({ id: 'match_flow', type: 'match_flow', title: 'Match flow', subtitle: 'First half v second half',
      data: { teams: S, halves: [{ key: '1H', label: 'First half', ...half('first_half') }, { key: '2H', label: 'Second half', ...half('second_half') }], metrics: ['shots', 'shots_on_target', 'goals'], shot_events_source: d.phases.shot_events_source || null },
      units: { shots: 'count', shots_on_target: 'count', goals: 'count' }, entities: teamEnts(p),
      source: 'Sourced shot events of one provider family per match; goals from the canonical goal sequence.', fields: ['depth.phases', 'goals'] });
  }
  // B. GOAL TIMELINE
  const goals = p.goals || [];
  if (goals.length) {
    const s1 = Math.max(0, ...goals.filter(g => /^45\+/.test(String(g.display_minute || ''))).map(g => parseInt(String(g.display_minute).split('+')[1], 10) || 0));
    const s2 = Math.max(0, ...goals.filter(g => /^90\+/.test(String(g.display_minute || ''))).map(g => parseInt(String(g.display_minute).split('+')[1], 10) || 0));
    const pos = g => { const dm = String(g.display_minute || ''); if (/^45\+/.test(dm)) return 45 + (parseInt(dm.split('+')[1], 10) || 0); if (/^90\+/.test(dm)) return 90 + s1 + (parseInt(dm.split('+')[1], 10) || 0); return g.minute > 45 ? g.minute + s1 : g.minute; };
    out.push({ id: 'goal_timeline', type: 'goal_timeline', title: 'Goal timeline', subtitle: p.match?.score?.home_ht !== null && p.match?.score?.home_ht !== undefined ? `Half-time ${p.match.score.home_ht}-${p.match.score.away_ht} · full time ${p.match.score.final}` : `Full time ${p.match.score.final}`,
      data: { teams: S, axis: { halftime: 45 + s1, end: 90 + s1 + s2, first_half_stoppage: s1, second_half_stoppage: s2 }, final: p.match.score.final, halftime: p.match.score.home_ht !== null && p.match.score.home_ht !== undefined ? `${p.match.score.home_ht}-${p.match.score.away_ht}` : null,
        goals: goals.map(g => ({ minute: g.minute, display_minute: g.display_minute || `${g.minute}'`, at: pos(g), team: g.team, scorer: ref(g.scorer), ...(g.assist ? { assist: ref(g.assist) } : {}), own_goal: !!g.own_goal, penalty: !!g.penalty, running_score: g.running_score })) },
      units: { at: 'match minute (stoppage appended)' }, entities: [...teamEnts(p), ...goals.flatMap(g => [ent('Person', g.scorer)])],
      source: 'Canonical goal sequence (one event family per match); assists only where the source links one.', fields: ['goals', 'match.score'] });
  }
  // C. SHOT PROFILE
  const sp = d.shot_profile;
  const st = p.stats;
  if (st && fin(st.home?.shots) !== null && fin(st.away?.shots) !== null) {
    const g = side => goals.filter(x => x.team === side).length;
    const row = (key, label, h, a, unit = 'count') => ({ key, label, home: h, away: a, unit });
    const rows = [row('shots', 'Shots', fin(st.home.shots), fin(st.away.shots)), row('shots_on_target', 'On target', fin(st.home.shots_on_target), fin(st.away.shots_on_target)),
      row('on_target_pct', 'On-target %', pct1(fin(st.home.shots_on_target) || 0, fin(st.home.shots)), pct1(fin(st.away.shots_on_target) || 0, fin(st.away.shots)), 'percent'),
      row('goals', 'Goals', g('home'), g('away')), row('goals_per_shot_pct', 'Goals per shot', pct1(g('home'), fin(st.home.shots)), pct1(g('away'), fin(st.away.shots)), 'percent')];
    if (sp?.home?.located_inside_box !== undefined && (sp.located_total || 0) > 0) rows.push(row('located_inside_box', 'Located shots in the box', sp.home.located_inside_box, sp.away.located_inside_box));
    if (fin(sp?.home?.avg_located_distance_m) !== null && fin(sp?.away?.avg_located_distance_m) !== null) rows.push(row('avg_located_distance_m', 'Avg located shot distance', sp.home.avg_located_distance_m, sp.away.avg_located_distance_m, 'm'));
    if (fin(st.home.corners) !== null && fin(st.away.corners) !== null) rows.push(row('corners', 'Corners', fin(st.home.corners), fin(st.away.corners)));
    out.push({ id: 'shot_profile', type: 'shot_profile', title: 'Shot profile', subtitle: st.basis === 'source' ? 'Source match statistics' : 'PropBetEdge counts from the event ledger',
      data: { teams: S, rows: rows.filter(r => r.home !== null && r.away !== null), basis: st.basis, provider: st.provider || null },
      units: { count: 'count', percent: '%', m: 'metres' }, entities: teamEnts(p),
      source: st.basis === 'source' ? `Team statistics as published by ${st.provider || 'the source'} (not PropBetEdge metrics); goals from the canonical sequence.` : 'PropBetEdge counts from the event ledger.', fields: ['stats', 'goals', 'depth.shot_profile'] });
  }
  // D. SHOT MAP (+ the primary player's own shots)
  if (shots && shots.points.length >= SHOT_MAP_MIN_LOCATED) {
    const recorded = shots.recorded;
    out.push({ id: 'shot_map', type: 'shot_map', title: 'Shot map', subtitle: `${shots.points.length} of ${recorded} recorded shots have location data`,
      data: { teams: S, orientation: 'home attacks right (x = 105), away attacks left', pitch: { length_m: 105, width_m: 68 }, recorded_shots: recorded, located_shots: shots.points.length, full_coverage: shots.points.length === recorded, source_family: shots.source_family, points: shots.points },
      units: { x: 'metres from the home team\'s own goal line', y: 'metres from the top touchline' }, entities: teamEnts(p),
      source: 'Located shot events from the same canonical event record PBEcast uses (one provider family per match). Event locations, not player tracking.', fields: ['soccer_match_events(shot)'] });
  }
  // E. PLAYER FOCUS: the story's primary person (hat-trick / brace scorer), sourced counts only
  const top = (() => { const m = new Map(); for (const g of goals) if (!g.own_goal && g.scorer?.id) m.set(g.scorer.id, (m.get(g.scorer.id) || 0) + 1); return [...m.entries()].sort((a, b) => b[1] - a[1])[0]; })();
  let line = top && top[1] >= 2 ? (d.player_lines || []).find(r => r.player?.id === top[0]) : null;
  // A packet without player lines (v2) still names the scorer's goals: a goals-only focus (+ located shots).
  if (!line && top && top[1] >= 2 && !d.player_lines) { const g = goals.find(x => x.scorer?.id === top[0]); line = { player: g.scorer, team: g.team, goals: top[1], goals_only: true }; }
  if (line?.goals_only) {
    const mine = shots ? shots.points.filter(x => x.player?.id === line.player.id && x.team === line.team) : [];
    out.push({ id: 'player_focus', type: 'player_focus', title: line.player.name, subtitle: `${p.teams[line.team]?.name || ''} · this match`,
      data: { player: ref(line.player), team: line.team, team_ref: ref(p.teams[line.team]), stats: [{ key: 'goals', label: 'Goals', value: line.goals }], points: mine.length ? mine : null, located_shots: mine.length, basis: 'goals' },
      units: { value: 'count' }, entities: [ent('Person', line.player), ent('SportsTeam', p.teams[line.team])],
      source: 'Goals from the canonical goal sequence; located shots from the match event record (shot and on-target counts are not in this story\'s evidence).', fields: ['goals', ...(mine.length ? ['soccer_match_events(shot)'] : [])] });
  } else if (line) {
    const mine = shots ? shots.points.filter(x => x.player?.id === line.player.id && x.team === line.team) : [];
    out.push({ id: 'player_focus', type: 'player_focus', title: line.player.name, subtitle: `${p.teams[line.team]?.name || ''} · this match`,
      data: { player: ref(line.player), team: line.team, team_ref: ref(p.teams[line.team]),
        stats: [['goals', 'Goals', line.goals], ['assists', 'Assists', line.assists], ['shots', 'Shots', line.shots], ['shots_on_target', 'On target', line.shots_on_target], ...(line.shots_inside_box !== null && line.shots_inside_box !== undefined ? [['shots_inside_box', 'Shots in the box', line.shots_inside_box]] : [])].map(([key, label, value]) => ({ key, label, value })),
        points: mine.length ? mine : null, located_shots: mine.length },
      units: { value: 'count' }, entities: [ent('Person', line.player), ent('SportsTeam', p.teams[line.team])],
      source: 'Player match line from the sourced shot and goal events (minutes are not stated per match by the source).', fields: ['depth.player_lines', ...(mine.length ? ['soccer_match_events(shot)'] : [])] });
  }
  // F. STANDING / FORM CONTEXT
  const tm = d.table_move;
  if (tm?.home && tm?.away) {
    out.push({ id: 'table_move', type: 'table_move', title: 'Where it leaves them', subtitle: `${p.competition.name} table before and after`,
      data: { teams: S, teams_in_table: tm.teams_in_table, home: tm.home, away: tm.away }, units: { position: 'rank', points: 'points' }, entities: teamEnts(p),
      source: 'Table computed from canonical results up to this match.', fields: ['depth.table_move'] });
  } else if (p.teams?.home?.group?.verified || p.teams?.away?.group?.verified) {
    out.push({ id: 'group_position', type: 'group_position', title: 'Group position', subtitle: 'Published standings, verified against canonical results',
      data: { teams: S, home: groupRow(p.teams.home.group), away: groupRow(p.teams.away.group) }, units: { position: 'rank', points: 'points' }, entities: teamEnts(p),
      source: 'ESPN published standings, shown only where every figure matches PropBetEdge canonical results.', fields: ['teams.*.group'] });
  }
  const rr = d.recent_league_results;
  if (rr && ((rr.home || []).length || (rr.away || []).length)) {
    out.push({ id: 'form_before', type: 'form_strip', title: 'Form coming in', subtitle: 'Previous league results, most recent first',
      data: { teams: S, home: (rr.home || []).map(formCell), away: (rr.away || []).map(formCell) }, units: null, entities: teamEnts(p),
      source: 'Canonical league results dated before this match.', fields: ['depth.recent_league_results'] });
  }
  return out;
}
const groupRow = g => (g?.verified ? { group: g.group, tier: g.tier || null, position: g.position, teams_in_group: g.teams_in_group, points: g.points, played: g.played, zone: g.zone || null } : null);
const formCell = r => ({ date: r.date, result: r.result, score: r.score, venue: r.venue, opponent: r.opponent ? { name: r.opponent.name, slug: r.opponent.slug || null } : null });

function formVisuals(p) {
  const f = p.form; if (!f?.appearances?.length) return [];
  return [{ id: 'scoring_run', type: 'scoring_run', title: `${p.player.name}: match by match`, subtitle: `${f.consecutive_scoring_appearances} consecutive scoring appearances`,
    data: { player: ref(p.player), team: ref(p.team), run: f.consecutive_scoring_appearances, goals_in_run: f.goals_in_run,
      appearances: f.appearances.map(a => ({ date: a.date, opponent: ref(a.opponent), score: a.score, goals: a.goals, started: !!a.started, in_run: true })) },
    units: { goals: 'count' }, entities: [ent('Person', p.player), ent('SportsTeam', p.team)],
    source: 'Appearances from sourced lineups (started or came on); goals from the match event record.', fields: ['form.appearances'] }];
}

function trendVisuals(p) {
  const tr = p.trend; if (!tr?.games?.length) return [];
  const out = [{ id: 'run_results', type: 'run_results', title: `${p.team.name}: the run`, subtitle: `${tr.wins} W · ${tr.draws} D · ${tr.losses} L · goals ${tr.goals_for}-${tr.goals_against}`,
    data: { team: ref(p.team), kind: tr.kind, games: tr.games.map(g => ({ date: g.date, opponent: ref(g.opponent), venue: g.venue, goals_for: g.goals_for, goals_against: g.goals_against, result: g.result })), totals: { wins: tr.wins, draws: tr.draws, losses: tr.losses, goals_for: tr.goals_for, goals_against: tr.goals_against } },
    units: { goals: 'count' }, entities: [ent('SportsTeam', p.team)], source: 'Canonical league results.', fields: ['trend'] }];
  if (p.team.table_now) out.push({ id: 'team_standing', type: 'team_standing', title: 'League position', subtitle: `${p.competition.name}`, data: { team: ref(p.team), teams_in_table: p.teams_in_table, row: p.team.table_now }, units: { position: 'rank' }, entities: [ent('SportsTeam', p.team)], source: 'Table computed from canonical results.', fields: ['team.table_now'] });
  return out;
}

function raceVisuals(p) {
  const t = p.table; if (!t?.top?.length) return [];
  const row = r => ({ position: r.position, team: ref(r.team), played: r.played, won: r.won ?? null, points: r.points, goal_difference: r.goal_difference });
  return [{ id: 'standings', type: 'standings', title: `${p.competition.name}: the table`, subtitle: `Top ${t.top.length}${t.bottom?.length ? ` and bottom ${t.bottom.length}` : ''} of ${t.teams}`,
    data: { columns: ['played', 'won', 'goal_difference', 'points'], top: t.top.map(row), bottom: (t.bottom || []).map(row), teams: t.teams, tiebreak: t.tiebreak, leader_gap: t.leader_gap },
    units: { points: 'points' }, entities: t.top.map(r => ent('SportsTeam', r.team)), source: `Table computed from canonical results (order: ${t.tiebreak === 'mls' ? 'points, wins, goal difference, goals for' : 'points, goal difference, goals for'}).`, fields: ['table'] }];
}

function groupVisuals(p) {
  return (p.groups || []).map((g, i) => ({ id: `group_table_${i + 1}`, type: 'group_table', title: `${g.name}${g.tier ? ` · ${g.tier}` : ''}`, subtitle: 'Published standings, verified against canonical results',
    data: { columns: ['played', 'won', 'drawn', 'lost', 'goal_difference', 'points'], rows: g.rows.map(r => ({ position: r.position, team: ref(r.team), played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, goal_difference: r.goal_difference, points: r.points, zone: r.zone || null })) },
    units: { points: 'points' }, entities: g.rows.map(r => ent('SportsTeam', r.team)), source: 'ESPN published standings, included only because every figure matches PropBetEdge canonical results.', fields: [`groups[${i}]`] }));
}

function previewVisuals(p) {
  const H = p.teams.home; const A = p.teams.away; const S = sides(p);
  const out = [];
  const rows = [];
  const add = (key, label, h, a, unit = 'count', better = null) => { if (h !== null && h !== undefined && a !== null && a !== undefined) rows.push({ key, label, home: h, away: a, unit, ...(better ? { better } : {}) }); };
  if (H.group?.verified && A.group?.verified) { add('group_position', `${H.group.group === A.group.group ? H.group.group : 'Group'} position`, H.group.position, A.group.position, 'rank', 'lower'); add('points', 'Points', H.group.points, A.group.points, 'count', 'higher'); add('played', 'Played', H.group.played, A.group.played, 'plain'); }
  else if (H.table_now && A.table_now) { add('position', 'League position', H.table_now.position, A.table_now.position, 'rank', 'lower'); add('points', 'Points', H.table_now.points, A.table_now.points, 'count', 'higher'); add('played', 'Played', H.table_now.played, A.table_now.played, 'plain'); add('goal_difference', 'Goal difference', H.table_now.goal_difference, A.table_now.goal_difference, 'count', 'higher'); }
  const f = t => t.recent_form;
  if (f(H)?.played && f(A)?.played) {
    add('recent_record', f(H).played === f(A).played ? `Last ${f(H).played === 1 ? 'match' : `${f(H).played} matches`} (W-D-L)` : 'Recent record (W-D-L)', `${f(H).won}-${f(H).drawn}-${f(H).lost}`, `${f(A).won}-${f(A).drawn}-${f(A).lost}`, 'record');
    add('recent_goals_for', 'Goals scored (recent)', f(H).goals_for, f(A).goals_for, 'count', 'higher');
    add('recent_goals_against', 'Goals conceded (recent)', f(H).goals_against, f(A).goals_against, 'count', 'lower');
  }
  if (rows.length) out.push({ id: 'matchup', type: 'matchup', title: `${H.name} v ${A.name}`, subtitle: `Kick-off ${longDate(p.fixture.kickoff_date)}, ${p.fixture.kickoff_time_utc} UTC${p.fixture.venue ? ` · ${p.fixture.venue}` : ''}`,
    data: { teams: S, rows, recent_matches: { home: f(H)?.played || 0, away: f(A)?.played || 0 } }, units: { count: 'count', rank: 'rank', record: 'W-D-L' }, entities: teamEnts(p),
    source: 'Descriptive only: current table or verified group position and recent canonical results. No prediction.', fields: ['teams.*.table_now|group', 'teams.*.recent_form'] });
  if (f(H)?.results?.length || f(A)?.results?.length) out.push({ id: 'recent_form', type: 'form_strip', title: 'Recent form', subtitle: 'Most recent first',
    data: { teams: S, home: (f(H)?.results || []).map(formCell), away: (f(A)?.results || []).map(formCell) }, units: null, entities: teamEnts(p), source: 'Canonical results in this competition before kick-off.', fields: ['teams.*.recent_form.results'] });
  if (p.players_in_form?.length) out.push({ id: 'players_in_form', type: 'players_in_form', title: 'Players in form', subtitle: 'Consecutive scoring appearances (sourced lineups + goals)',
    data: { players: p.players_in_form.map(x => ({ player: ref(x.player), team: x.team, run: x.consecutive_scoring_appearances, goals_in_run: x.goals_in_run })) }, units: { run: 'appearances' }, entities: p.players_in_form.map(x => ent('Person', x.player)), source: 'Sourced lineups (started or came on) and match goal events.', fields: ['players_in_form'] });
  return out;
}

function matchdayVisuals(p) {
  const pos = t => (t.group?.verified ? { kind: 'group', group: t.group.group, position: t.group.position, points: t.group.points } : t.table_now ? { kind: 'table', position: t.table_now.position, points: t.table_now.points } : null);
  const out = [{ id: 'fixtures_board', type: 'fixtures_board', title: 'The fixtures', subtitle: `${p.fixtures.length} kick-offs · times UTC`,
    data: { day: p.day, fixtures: p.fixtures.map(x => ({ match_id: x.match_id, kickoff_time_utc: x.kickoff_time_utc, venue: x.venue, home: { ...ref(x.home), standing: pos(x.home) }, away: { ...ref(x.away), standing: pos(x.away) } })) },
    units: null, entities: p.fixtures.flatMap(x => [ent('SportsTeam', x.home), ent('SportsTeam', x.away)]), source: 'Canonical fixtures; positions from the canonical table or verified published group standings.', fields: ['fixtures'] }];
  if (p.table_top?.length) out.push({ id: 'standings', type: 'standings', title: 'Top of the table', subtitle: `${p.competition.name}`, data: { columns: ['played', 'points'], top: p.table_top.map(r => ({ position: r.position, team: ref(r.team), played: r.played, points: r.points })), bottom: [], teams: p.teams_in_table }, units: { points: 'points' }, entities: p.table_top.map(r => ent('SportsTeam', r.team)), source: 'Table computed from canonical results.', fields: ['table_top'] });
  return out;
}

// ---------------- validation ----------------
// Structural + evidence checks. A visual that fails is DROPPED (recorded in body.visuals_rejected); it never
// holds the story, and nothing is repaired or estimated.
const TYPES = new Set(['match_flow', 'goal_timeline', 'shot_profile', 'shot_map', 'player_focus', 'table_move', 'group_position', 'form_strip', 'scoring_run', 'run_results', 'team_standing', 'standings', 'group_table', 'matchup', 'players_in_form', 'fixtures_board']);
export function validateVisual(v, packet) {
  const errs = [];
  const need = (c, m) => { if (!c) errs.push(m); };
  need(TYPES.has(v.type), `unknown type ${v.type}`);
  need(typeof v.id === 'string' && /^[a-z0-9_]{2,40}$/.test(v.id), 'bad id');
  need(typeof v.title === 'string' && v.title.length > 0 && v.title.length <= 120, 'bad title');
  need(v.data && typeof v.data === 'object', 'no data');
  need(typeof v.source === 'string' && v.source.length > 10, 'no source');
  need(!Number.isNaN(Date.parse(v.observed_at)), 'bad observed_at');
  need(v.provenance?.builder === VISUALS_VERSION, 'bad builder');
  need(v.values_hash === hashOf(v), 'values_hash mismatch');
  const nums = [];
  const walk = (x, k) => { if (typeof x === 'number') nums.push([k, x]); else if (Array.isArray(x)) x.forEach(y => walk(y, k)); else if (x && typeof x === 'object') for (const [kk, y] of Object.entries(x)) walk(y, kk); };
  walk(v.data, null);
  need(nums.every(([, n]) => Number.isFinite(n)), 'non-finite number');
  const goals = packet?.goals || [];
  if (v.type === 'goal_timeline') {
    need(v.data.goals.length === goals.length, 'goal count differs from packet');
    if (v.data.goals.length === goals.length) need(v.data.goals.every((g, i) => g.running_score === goals[i].running_score && g.team === goals[i].team && !!g.own_goal === !!goals[i].own_goal), 'goal order/side differs from packet');
    need(v.data.goals.every(g => g.at >= 0 && g.at <= v.data.axis.end), 'goal off the axis');
    need((v.data.goals.at(-1)?.running_score || '0-0') === packet.match.score.final, 'timeline does not reach the final score');
  }
  if (v.type === 'match_flow') for (const h of v.data.halves) for (const s of ['home', 'away']) need(JSON.stringify(h[s]) === JSON.stringify(packet.depth.phases[h.key === '1H' ? 'first_half' : 'second_half'][s]), `match_flow ${h.key} ${s} differs from packet`);
  if (v.type === 'shot_profile') for (const r of v.data.rows) {
    if (['shots', 'shots_on_target', 'corners'].includes(r.key)) need(r.home === fin(packet.stats.home[r.key]) && r.away === fin(packet.stats.away[r.key]), `${r.key} differs from packet`);
    if (r.key === 'goals') need(r.home === goals.filter(g => g.team === 'home').length && r.away === goals.filter(g => g.team === 'away').length, 'goals differ from packet');
    if (r.unit === 'percent') need(r.home >= 0 && r.home <= 100 && r.away >= 0 && r.away <= 100, `${r.key} out of range`);
  }
  if (v.type === 'shot_map' || (v.type === 'player_focus' && v.data.points)) {
    const pts = v.data.points || [];
    need(pts.every(p => p.x >= 0 && p.x <= 105 && p.y >= 0 && p.y <= 68 && ['home', 'away'].includes(p.team)), 'point off the pitch');
    if (v.type === 'shot_map') {
      need(v.data.located_shots === pts.length && pts.length <= v.data.recorded_shots, 'coverage counts inconsistent');
      need(v.subtitle === `${pts.length} of ${v.data.recorded_shots} recorded shots have location data`, 'coverage label must state located / recorded');
      need(pts.filter(p => p.outcome === 'goal').length <= goals.filter(g => !g.own_goal).length, 'more located goals than goals');
    }
  }
  if (v.type === 'player_focus') {
    if (v.data.basis === 'goals') {
      need(v.data.stats.length === 1 && v.data.stats[0].value === goals.filter(g => !g.own_goal && g.scorer?.id === v.data.player.id).length, 'goal count differs from packet');
    } else {
      const line = (packet.depth?.player_lines || []).find(r => r.player?.id === v.data.player.id);
      need(!!line, 'player not in packet player_lines');
      if (line) for (const s of v.data.stats) need(s.value === line[s.key], `${s.key} differs from packet`);
    }
    if (v.data.points) need(v.data.points.every(p => p.player?.id === v.data.player.id), 'player map carries another player');
  }
  if (v.type === 'group_table') {
    const g = (packet.groups || []).find(x => v.title.startsWith(x.name));
    need(!!g && g.verified, 'group not verified in packet');
    if (g) need(JSON.stringify(v.data.rows.map(r => [r.team.id, r.points, r.played])) === JSON.stringify(g.rows.map(r => [r.team.id, r.points, r.played])), 'group rows differ from packet');
  }
  if (v.type === 'matchup') need(!JSON.stringify({ t: v.title, s: v.subtitle, d: v.data }).match(/\b(predict\w*|favou?rites?|probabilit\w*|odds|chances?|betting edge)\b/i), 'matchup carries prediction language');
  return errs;
}

export function validateVisuals(visuals, packet) {
  const ok = []; const rejected = [];
  const ids = new Set();
  for (const v of visuals) {
    let errs; try { errs = validateVisual(v, packet); } catch (e) { errs = [`validator error: ${String(e?.message || e).slice(0, 120)}`]; }
    if (ids.has(v.id)) errs.push('duplicate id');
    if (errs.length) rejected.push({ id: v.id, type: v.type, errors: errs }); else { ok.push(v); ids.add(v.id); }
  }
  return { visuals: ok, rejected };
}

// Verify a STORED visual on read (soccer-api): the values must still hash to what was published.
export const visualIntact = v => !!v && typeof v === 'object' && v.provenance?.builder === VISUALS_VERSION && v.values_hash === hashOf(v);
