// FORWARD-LOOKING and STRUCTURE stories from the canonical graph (no provider calls):
//   match_preview (fixture)   one meaningful fixture, 1-24 h before kick-off
//   match_preview (matchday)  one compact brief for a competition day with 3+ fixtures
//   competition_intelligence (group_watch)  verified group tables after a settled round
//                             (Nations League groups, UCL league phase: ONLY groups whose published
//                             standings verify against our canonical results)
// Facts: kick-off, venue, current table or VERIFIED group position, the last five results, active
// scoring runs from sourced lineups + goals, earlier meetings THIS season. Never: lineups that are not
// sourced, injuries, suspensions, quotes, odds, predictions or probabilities.
import { computeTable } from './packet.js';
import { appearanceGoals, groupContext, scoringStreak } from './engine.js';
import { verifyGroupStandings } from '../../shared/standings.js';
import { profileFor } from './profiles.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { loadPreviewDepth, PACKET_V4_PREVIEW } from './preview-depth.js';

export const PREVIEW_VERSION = 'soccer-packet-preview/1.0.0';
export const PREVIEW_WINDOW = { minMs: 3600e3, maxMs: 24 * 3600e3 }; // eligible 24 h .. 1 h before kick-off
export const MATCHDAY_MIN_FIXTURES = 3;
export const MAX_PREVIEWS_PER_RUN = 3;

const byKick = (a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at) || (a.id < b.id ? -1 : 1);
const res = (m, tid) => { const gf = m.home_team_id === tid ? m.home_score : m.away_score; const ga = m.home_team_id === tid ? m.away_score : m.home_score; return gf > ga ? 'W' : gf < ga ? 'L' : 'D'; };
const teamRef = (S, id) => { const t = S.teams.get(id); return t ? { id: t.id, name: t.name, slug: t.slug } : { id, name: null, slug: null }; };
const hhmm = iso => new Date(iso).toISOString().slice(11, 16);
const isoWeek = d => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y) / 86400e3 + 1) / 7)).padStart(2, '0')}`;
};

// Last five results (every stage of this competition-season), newest first.
export function recentForm(S, tid, beforeIso) {
  const games = S.finished.filter(m => (m.home_team_id === tid || m.away_team_id === tid) && Date.parse(m.kickoff_at) < Date.parse(beforeIso)).sort((a, b) => byKick(b, a)).slice(0, 5);
  const list = games.map(m => { const home = m.home_team_id === tid; return { match_id: m.id, date: m.kickoff_at.slice(0, 10), opponent: teamRef(S, home ? m.away_team_id : m.home_team_id), venue: home ? 'home' : 'away', goals_for: home ? m.home_score : m.away_score, goals_against: home ? m.away_score : m.home_score, score: home ? `${m.home_score}-${m.away_score}` : `${m.away_score}-${m.home_score}`, result: res(m, tid) }; });
  return { results: list, played: list.length, won: list.filter(r => r.result === 'W').length, drawn: list.filter(r => r.result === 'D').length, lost: list.filter(r => r.result === 'L').length, goals_for: list.reduce((n, r) => n + r.goals_for, 0), goals_against: list.reduce((n, r) => n + r.goals_against, 0), goals: `${list.reduce((n, r) => n + r.goals_for, 0)}-${list.reduce((n, r) => n + r.goals_against, 0)}` };
}
// Current league run (league stages only, all-time within the season), for form angles.
function leagueRun(S, tid) {
  const games = S.finished.filter(m => (m.home_team_id === tid || m.away_team_id === tid) && S.leagueStages.has(m.stage_id)).sort(byKick);
  const count = pred => { let n = 0; for (let i = games.length - 1; i >= 0 && pred(res(games[i], tid)); i--) n += 1; return n; };
  return { winning_run: count(r => r === 'W'), unbeaten_run: count(r => r !== 'L'), losing_run: count(r => r === 'L'), winless_run: count(r => r !== 'W') };
}
const tableRow = (t, id) => { const i = t.findIndex(r => r.team_id === id); return i < 0 ? null : { position: i + 1, played: t[i].played, won: t[i].won, drawn: t[i].drawn, lost: t[i].lost, points: t[i].points, goal_difference: t[i].gd }; };

// Active scoring runs (>= 3 consecutive sourced appearances with a goal) for the given teams.
async function playersInForm(store, S, teamIds) {
  const apps = await appearanceGoals(store, S);
  const out = [];
  for (const [pid, seq] of apps) {
    const last = seq[seq.length - 1]; if (!last || !teamIds.includes(last.team_id)) continue;
    const n = scoringStreak(seq); if (n < 3) continue;
    out.push({ player_id: pid, team_id: last.team_id, consecutive_scoring_appearances: n, goals_in_run: seq.slice(-n).reduce((s, x) => s + x.goals, 0) });
  }
  if (!out.length) return [];
  const people = new Map();
  for (const part of chunkArr(out.map(x => x.player_id), 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: part } })) people.set(p.id, { id: p.id, name: p.display_name, slug: p.slug });
  return out.filter(x => people.has(x.player_id)).map(x => ({ player: people.get(x.player_id), team_id: x.team_id, consecutive_scoring_appearances: x.consecutive_scoring_appearances, goals_in_run: x.goals_in_run }))
    .sort((a, b) => b.consecutive_scoring_appearances - a.consecutive_scoring_appearances || (a.player.name < b.player.name ? -1 : 1));
}

// ---------- DETECTION ----------
export async function detectPreviews(store, S, { now = Date.now(), cfg = {}, stories = [], diag = {} } = {}) {
  const out = [];
  const upcoming = S.matches.filter(m => m.status === 'scheduled' && Date.parse(m.kickoff_at) - now >= PREVIEW_WINDOW.minMs && Date.parse(m.kickoff_at) - now <= PREVIEW_WINDOW.maxMs).sort(byKick);
  diag.preview_window_fixtures = upcoming.length; // kick-off 1-24 h from now
  if (!upcoming.length || !(stories.includes('match_preview') || stories.includes('matchday_brief'))) return out;
  const profileNow = profileFor(S.comp.slug, new Date(now).toISOString(), cfg);
  const table = profileNow?.table ? computeTable(S.finished.filter(m => S.leagueStages.has(m.stage_id)), { tiebreak: profileNow.tiebreak || 'standard' }) : null;
  const teamIds = [...new Set(upcoming.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const groups = await groupContext(store, S, teamIds);
  const form = await playersInForm(store, S, teamIds);
  const previews = [];
  for (const m of stories.includes('match_preview') ? upcoming : []) {
    const profile = profileFor(S.comp.slug, m.kickoff_at, cfg); if (!profile) continue;
    const angles = [];
    const add = (key, weight, detail) => angles.push({ key, weight, detail });
    const [H, A] = [m.home_team_id, m.away_team_id];
    const th = table && tableRow(table, H); const ta = table && tableRow(table, A);
    if (th && ta && th.played >= 3 && ta.played >= 3) {
      const top = profile.key === 'mls' ? 6 : 4;
      if (th.position <= top && ta.position <= top) add('top_table_meeting', 1.0, { home_position: th.position, away_position: ta.position });
      for (const [tid, r] of [[H, th], [A, ta]]) if (r.position === 1) add('leader_in_action', 0.6, { team_id: tid });
      if (profile.zones && th.position > table.length - profile.zones.bottom && ta.position > table.length - profile.zones.bottom) add('bottom_meeting', 0.8, { home_position: th.position, away_position: ta.position });
    }
    const gh = groups[H]; const ga = groups[A];
    if (gh?.verified && ga?.verified && gh.group === ga.group) {
      if (gh.position <= 2 && ga.position <= 2) add('group_top_meeting', 1.0, { group: gh.group });
      else for (const [tid, g] of [[H, gh], [A, ga]]) if (g.position === 1) add('group_leader_in_action', 0.6, { team_id: tid, group: g.group });
    }
    if (profile.table) for (const tid of [H, A]) {
      const run = leagueRun(S, tid);
      if (run.winning_run >= 3) add('winning_run', 0.5, { team_id: tid, run: run.winning_run });
      else if (run.unbeaten_run >= 6) add('unbeaten_run', 0.4, { team_id: tid, run: run.unbeaten_run });
      if (run.losing_run >= 3) add('losing_run', 0.4, { team_id: tid, run: run.losing_run });
    }
    const pf = form.filter(x => x.team_id === H || x.team_id === A).slice(0, 2);
    for (const x of pf) add('player_scoring_run', 0.5, { player_id: x.player.id, team_id: x.team_id, matches: x.consecutive_scoring_appearances });
    const score = Math.round(angles.reduce((n, a) => n + a.weight, 0) * 100) / 100;
    if (score >= 1.0) previews.push({ story_class: 'match_preview', preview_kind: 'fixture', key: `match_preview:${m.id}`, as_of: m.kickoff_at, match: m, profile, table, groups, form: pf, materiality: { score, angles } });
  }
  previews.sort((a, b) => b.materiality.score - a.materiality.score || byKick(a.match, b.match));
  out.push(...previews.slice(0, MAX_PREVIEWS_PER_RUN));
  diag.preview_eligible = previews.length;
  // Matchday brief: a competition day (UTC date) with 3+ fixtures and sourced context for 2+ of them.
  if (stories.includes('matchday_brief')) {
    const byDay = new Map();
    for (const m of upcoming) byDay.set(m.kickoff_at.slice(0, 10), [...(byDay.get(m.kickoff_at.slice(0, 10)) || []), m]);
    for (const [day, list] of byDay) {
      if (list.length < MATCHDAY_MIN_FIXTURES) continue;
      const withContext = list.filter(m => (table && tableRow(table, m.home_team_id) && tableRow(table, m.away_team_id)) || (groups[m.home_team_id]?.verified && groups[m.away_team_id]?.verified)).length;
      if (withContext < 2) continue;
      const profile = profileFor(S.comp.slug, list[0].kickoff_at, cfg); if (!profile) continue;
      out.push({ story_class: 'match_preview', preview_kind: 'matchday', key: `matchday:${S.comp.id}:${day}`, as_of: list[0].kickoff_at, day, fixtures: list, profile, table, groups, form, materiality: { score: Math.min(1.6, 1.0 + 0.1 * list.length), angles: [{ key: 'matchday', weight: 1, detail: { fixtures: list.length, day } }] } });
      diag.matchday_eligible = (diag.matchday_eligible || 0) + 1;
    }
  }
  return out;
}

// Group watch: verified group tables for a profile without a single league table (Nations League
// groups, UCL league phase), once per ISO week after a settled round (>= 6 results in the window,
// no match of the competition within 12 h).
export async function detectGroupWatch(store, S, { now = Date.now(), windowDays = 4, cfg = {}, stories = [] } = {}) {
  if (!stories.includes('table_watch')) return [];
  const profile = profileFor(S.comp.slug, new Date(now).toISOString(), cfg);
  if (!profile || profile.table) return []; // table profiles use the league table race
  const since = now - windowDays * 86400e3;
  const round = S.finished.filter(m => Date.parse(m.kickoff_at) >= since && Date.parse(m.kickoff_at) <= now);
  if (round.length < 6 || S.matches.some(m => m.status !== 'finished' && Math.abs(Date.parse(m.kickoff_at) - now) < 12 * 3600e3)) return [];
  const groups = await verifiedGroups(store, S);
  if (!groups.length) return [];
  const latest = round.sort(byKick)[round.length - 1];
  return [{ story_class: 'competition_intelligence', brief: 'group_watch', key: `group_watch:${S.comp.id}:${isoWeek(new Date(latest.kickoff_at))}`, as_of: latest.kickoff_at, profile, round, groups, materiality: { score: 1.0, angles: [{ key: 'group_watch', weight: 1, detail: { groups: groups.length } }] } }];
}

// Every group of the season whose ESPN standings verify against our canonical results (same rule as
// soccer-api and groupContext). Unverified groups are left out, never estimated.
export async function verifiedGroups(store, S) {
  const groups = await store.select('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'group_type', 'parent_name'], eq: { season_id: S.season.id } });
  const byId = new Map(computeTable(S.finished.filter(m => S.leagueStages.has(m.stage_id))).map(r => [r.team_id, r]));
  const out = [];
  for (const g of groups.filter(x => x.group_type === 'group' || x.group_type === 'league_phase').sort((a, b) => (a.group_key < b.group_key ? -1 : 1))) {
    const src = await store.select('soccer_source_standings', { columns: ['team_id', 'rank', 'played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against', 'points', 'deductions', 'note', 'observed_at'], eq: { group_id: g.id, provider: 'espn' } });
    if (!verifyGroupStandings(src, byId).verified) continue;
    const rows = src.sort((a, b) => a.rank - b.rank).map(r => ({ position: r.rank, team: teamRef(S, r.team_id), played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, points: r.points, goal_difference: r.goals_for - r.goals_against, zone: r.note || null }));
    out.push({ name: g.name, group_type: g.group_type, ...(g.parent_name ? { tier: g.parent_name } : {}), verified: true, teams: rows.length, rows, leader: rows[0], gap_top_two: rows.length > 1 ? rows[0].points - rows[1].points : null });
  }
  return out;
}

// ---------- PACKETS ----------
const ATTRIBUTION = { espn: 'Structured facts: ESPN (secondary source).', openligadb: 'Fixtures and results: OpenLigaDB (Open Database License).', wyscout_figshare: 'Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0.' };
const UNAVAILABLE = ['lineups (not sourced before kick-off)', 'injuries and suspensions (no legitimate source ingested)', 'odds, predictions and probabilities (not part of this product)', 'quotes (none sourced)'];

export async function previewBody(store, S, cand) {
  if (cand.preview_kind === 'matchday') return matchdayBody(store, S, cand);
  const m = cand.match;
  const [venue] = m.venue_id ? await store.select('soccer_venues', { columns: ['name'], eq: { id: m.venue_id }, limit: 1 }) : [];
  const side = tid => {
    const f = recentForm(S, tid, m.kickoff_at);
    return { ...teamRef(S, tid), table_now: cand.table ? tableRow(cand.table, tid) : null, group: cand.groups[tid] || null, recent_form: f, league_run: cand.profile.table ? leagueRun(S, tid) : null };
  };
  const meetings = S.finished.filter(x => (x.home_team_id === m.home_team_id && x.away_team_id === m.away_team_id) || (x.home_team_id === m.away_team_id && x.away_team_id === m.home_team_id)).sort(byKick)
    .map(x => ({ match_id: x.id, date: x.kickoff_at.slice(0, 10), home: teamRef(S, x.home_team_id), away: teamRef(S, x.away_team_id), score: `${x.home_score}-${x.away_score}` }));
  const people = new Map(cand.form.map(x => [x.player.id, x]));
  const angles = cand.materiality.angles.map(a => ({ ...a, detail: { ...a.detail, ...(a.detail.team_id ? { team: teamRef(S, a.detail.team_id) } : {}), ...(a.detail.player_id ? { player: people.get(a.detail.player_id)?.player || null } : {}) } }));
  // Subject: a player on a scoring run, else the leader / home side of the key angle, else the home side.
  const lead = angles.find(a => a.key === 'player_scoring_run' && a.detail.player) || null;
  const leaderTeam = angles.find(a => /leader_in_action/.test(a.key))?.detail?.team;
  const subject = lead ? { id: lead.detail.player.id, type: 'Person', reason: 'preview_scoring_run', team_id: lead.detail.team_id } : leaderTeam ? { id: leaderTeam.id, type: 'SportsTeam', reason: 'preview_leader' } : { id: m.home_team_id, type: 'SportsTeam', reason: 'preview_home' };
  const providers = [...new Set([...S.finished.filter(x => [m.home_team_id, m.away_team_id].some(t => x.home_team_id === t || x.away_team_id === t)).map(x => x.result_provider), Object.keys(cand.groups).length ? 'espn' : null, cand.form.length ? 'espn' : null].filter(Boolean))];
  // PACKET V4 depth (as-of safe, every canonical competition). Verified groups only: the whole group's
  // points from canonical results + this round's scheduled group fixtures for provable consequences.
  let groupTable = null; let roundFixtures = [];
  const gh = cand.groups[m.home_team_id]; const ga = cand.groups[m.away_team_id];
  if (gh?.verified && ga?.verified && gh.group === ga.group) {
    const [g] = await store.select('soccer_season_groups', { columns: ['id'], eq: { season_id: S.season.id, name: gh.group }, limit: 1 });
    const members = g ? (await store.select('soccer_season_group_members', { columns: ['team_id'], eq: { group_id: g.id } })).map(x => x.team_id) : [];
    if (members.length >= 2 && members.includes(m.home_team_id) && members.includes(m.away_team_id)) {
      const t = computeTable(S.finished.filter(x => S.leagueStages.has(x.stage_id) && members.includes(x.home_team_id) && members.includes(x.away_team_id)));
      groupTable = Object.fromEntries(members.map(id => [id, t.find(r => r.team_id === id)?.points ?? 0]));
      roundFixtures = S.matches.filter(x => x.status === 'scheduled' && S.leagueStages.has(x.stage_id) && members.includes(x.home_team_id) && members.includes(x.away_team_id) && Math.abs(Date.parse(x.kickoff_at) - Date.parse(m.kickoff_at)) <= 3 * 86400e3);
    }
  }
  const depth = await loadPreviewDepth(store, { match: m, groups: cand.groups, groupTable, roundFixtures, playersInForm: cand.form.map(x => ({ player: x.player, team: x.team_id === m.home_team_id ? 'home' : 'away', consecutive_scoring_appearances: x.consecutive_scoring_appearances })) });
  return {
    preview_version: PACKET_V4_PREVIEW, depth,
    preview_kind: 'fixture',
    fixture: { id: m.id, kickoff_utc: new Date(m.kickoff_at).toISOString(), kickoff_date: m.kickoff_at.slice(0, 10), kickoff_time_utc: hhmm(m.kickoff_at), timezone: 'UTC', venue: venue?.name || null, league_stage: S.leagueStages.has(m.stage_id), status: 'scheduled' },
    teams: { home: side(m.home_team_id), away: side(m.away_team_id) },
    teams_in_table: cand.table ? cand.table.length : null,
    players_in_form: cand.form.map(x => ({ player: x.player, team: x.team_id === m.home_team_id ? 'home' : 'away', consecutive_scoring_appearances: x.consecutive_scoring_appearances, goals_in_run: x.goals_in_run })),
    meetings_this_season: meetings, angles, subject,
    unavailable: UNAVAILABLE,
    provenance: { attributions: providers.map(p => ATTRIBUTION[p]).filter(Boolean) },
  };
}

async function matchdayBody(store, S, cand) {
  const venues = new Map();
  const vids = [...new Set(cand.fixtures.map(m => m.venue_id).filter(Boolean))];
  if (vids.length) for (const v of await store.select('soccer_venues', { columns: ['id', 'name'], in: { id: vids } })) venues.set(v.id, v.name);
  const fixtures = cand.fixtures.map(m => ({ match_id: m.id, kickoff_time_utc: hhmm(m.kickoff_at), venue: venues.get(m.venue_id) || null,
    home: { ...teamRef(S, m.home_team_id), table_now: cand.table ? tableRow(cand.table, m.home_team_id) : null, group: cand.groups[m.home_team_id] || null },
    away: { ...teamRef(S, m.away_team_id), table_now: cand.table ? tableRow(cand.table, m.away_team_id) : null, group: cand.groups[m.away_team_id] || null } }));
  const playing = new Set(cand.fixtures.flatMap(m => [m.home_team_id, m.away_team_id]));
  const runs = cand.profile.table ? [...playing].map(tid => ({ team: teamRef(S, tid), ...leagueRun(S, tid) })).filter(r => r.winning_run >= 3 || r.unbeaten_run >= 6 || r.losing_run >= 3).sort((a, b) => b.winning_run - a.winning_run || b.unbeaten_run - a.unbeaten_run || (a.team.name < b.team.name ? -1 : 1)).slice(0, 4) : [];
  const providers = [...new Set([...S.finished.map(x => x.result_provider), Object.keys(cand.groups).length ? 'espn' : null].filter(Boolean))];
  return {
    preview_kind: 'matchday', day: cand.day, timezone: 'UTC', fixtures,
    table_top: cand.table ? cand.table.slice(0, 5).map((r, i) => ({ position: i + 1, team: teamRef(S, r.team_id), played: r.played, points: r.points })) : null,
    teams_in_table: cand.table ? cand.table.length : null,
    teams_on_runs: runs,
    players_in_form: cand.form.filter(x => playing.has(x.team_id)).slice(0, 4).map(x => ({ player: x.player, team: teamRef(S, x.team_id), consecutive_scoring_appearances: x.consecutive_scoring_appearances, goals_in_run: x.goals_in_run })),
    unavailable: UNAVAILABLE,
    provenance: { attributions: providers.map(p => ATTRIBUTION[p]).filter(Boolean) },
  };
}

export function groupWatchBody(S, cand) {
  const results = cand.round.map(m => ({ match_id: m.id, date: m.kickoff_at.slice(0, 10), home: teamRef(S, m.home_team_id), away: teamRef(S, m.away_team_id), score: `${m.home_score}-${m.away_score}` }));
  return {
    brief: 'group_watch', groups: cand.groups,
    round: { results_counted: results.length, results },
    unavailable: ['head-to-head tie-breakers beyond the published ranking', 'groups whose published standings do not verify against canonical results (left out)'],
    provenance: { attributions: [...new Set([...cand.round.map(m => ATTRIBUTION[m.result_provider]), ATTRIBUTION.espn].filter(Boolean))] },
  };
}
