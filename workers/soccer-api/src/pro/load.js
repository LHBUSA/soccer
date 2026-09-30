// Soccer Pro loaders: canonical rows -> the plain inputs of fatigue.js / matchup.js. Read-only.
import { chunkArr } from '../../../soccer-ingest/src/store.js';
import { ownGoalBeneficiary } from '../../../shared/own-goals.js';

const DAY = 864e5;
async function selectIn(store, table, col, vals, opts = {}) {
  const out = [];
  for (const part of chunkArr([...new Set(vals.filter(Boolean))], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: part } }));
  return out;
}

export async function compSlugs(store) {
  return new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'] })).map(c => [c.id, c.slug]));
}

const MCOLS = ['id', 'competition_id', 'season_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'duration'];
// Every canonical match of the team in [asOf - backDays, asOf + aheadDays], any competition.
export async function teamWindow(store, teamId, asOf, { backDays = 35, aheadDays = 21 } = {}) {
  const from = new Date(Date.parse(asOf) - backDays * DAY).toISOString(); const to = new Date(Date.parse(asOf) + aheadDays * DAY).toISOString();
  const [h, a] = await Promise.all(['home_team_id', 'away_team_id'].map(k => store.select('soccer_matches', { columns: MCOLS, eq: { [k]: teamId }, gte: { kickoff_at: from }, lte: { kickoff_at: to }, order: 'kickoff_at.desc' })));
  return [...h, ...a].sort((x, y) => Date.parse(y.kickoff_at) - Date.parse(x.kickoff_at));
}

// Starting XIs + minutes for the team's finished matches (newest first).
export async function teamXis(store, teamId, matches) {
  const done = matches.filter(m => m.status === 'finished');
  const lineups = await selectIn(store, 'soccer_lineups', 'match_id', done.map(m => m.id), { columns: ['id', 'match_id'], eq: { team_id: teamId } });
  const lps = await selectIn(store, 'soccer_lineup_players', 'lineup_id', lineups.map(l => l.id), { columns: ['lineup_id', 'player_id', 'is_starter'] });
  const mins = await selectIn(store, 'soccer_player_match_stats', 'match_id', done.map(m => m.id), { columns: ['match_id', 'player_id', 'value'], eq: { team_id: teamId, stat_key: 'minutes_nominal', basis: 'derived' } });
  const byLineup = new Map(lineups.map(l => [l.id, l.match_id]));
  return done.filter(m => lineups.some(l => l.match_id === m.id)).map(m => {
    const lid = lineups.find(l => l.match_id === m.id).id;
    return { match_id: m.id, kickoff_at: m.kickoff_at, starters: lps.filter(x => x.lineup_id === lid && x.is_starter).map(x => x.player_id),
      named: lps.filter(x => byLineup.get(x.lineup_id) === m.id).map(x => x.player_id),
      minutes: Object.fromEntries(mins.filter(x => x.match_id === m.id).map(x => [x.player_id, Number(x.value)])) };
  });
}

// Every appearance row (named in a sourced lineup) of these players since fromIso, across clubs AND
// national teams: the same canonical person in both (no duplicate identities exist to merge).
export async function playerApps(store, playerIds, fromIso, comps) {
  const lps = await selectIn(store, 'soccer_lineup_players', 'player_id', playerIds, { columns: ['lineup_id', 'player_id', 'is_starter'] });
  const lineups = await selectIn(store, 'soccer_lineups', 'id', lps.map(x => x.lineup_id), { columns: ['id', 'match_id', 'team_id'] });
  const matches = (await selectIn(store, 'soccer_matches', 'id', lineups.map(l => l.match_id), { columns: ['id', 'kickoff_at', 'competition_id', 'status'] }))
    .filter(m => m.status === 'finished' && Date.parse(m.kickoff_at) >= Date.parse(fromIso));
  const mIds = matches.map(m => m.id);
  const teams = new Map((await selectIn(store, 'soccer_teams', 'id', lineups.map(l => l.team_id), { columns: ['id', 'team_type'] })).map(t => [t.id, t.team_type]));
  const mins = await selectIn(store, 'soccer_player_match_stats', 'match_id', mIds, { columns: ['match_id', 'player_id', 'value'], eq: { stat_key: 'minutes_nominal', basis: 'derived' }, in: { player_id: playerIds.slice(0, 150) } });
  const subs = await selectIn(store, 'soccer_substitutions', 'match_id', mIds, { columns: ['match_id', 'player_in_id', 'player_out_id', 'minute'] });
  const lineupOf = new Map(lineups.map(l => [l.id, l]));
  const matchOf = new Map(matches.map(m => [m.id, m]));
  const out = new Map(playerIds.map(p => [p, []]));
  for (const x of lps) {
    const l = lineupOf.get(x.lineup_id); const m = l && matchOf.get(l.match_id); if (!m) continue;
    const on = subs.find(s => s.match_id === m.id && s.player_in_id === x.player_id);
    const off = subs.find(s => s.match_id === m.id && s.player_out_id === x.player_id);
    const minutes = mins.find(r => r.match_id === m.id && r.player_id === x.player_id);
    out.get(x.player_id)?.push({ match_id: m.id, kickoff_at: m.kickoff_at, minutes: minutes ? Number(minutes.value) : null, started: !!x.is_starter, came_on: !!on,
      sub_on_minute: on?.minute ?? null, sub_off_minute: off?.minute ?? null, team_kind: teams.get(l.team_id) === 'national' ? 'national' : 'club', competition_slug: comps.get(m.competition_id) || null });
  }
  return out;
}

// Matchup inputs for the team's last `n` finished matches (any competition), newest first.
export async function matchupGames(store, teamId, matches, n = 8) {
  const done = matches.filter(m => m.status === 'finished' && m.home_score !== null && m.away_score !== null).slice(0, n);
  const ids = done.map(m => m.id);
  const stats = await selectIn(store, 'soccer_team_match_stats', 'match_id', ids, { columns: ['match_id', 'team_id', 'stat_key', 'value', 'basis'], in: { stat_key: ['shots', 'shots_on_target'] } });
  const events = await selectIn(store, 'soccer_match_events', 'match_id', ids, { columns: ['match_id', 'team_id', 'event_type', 'x_m', 'y_m', 'set_piece', 'is_goal', 'is_own_goal', 'minute', 'source_family'], in: { event_type: ['shot', 'touch'] } });
  const statOf = (mid, tid) => {
    const rows = stats.filter(s => s.match_id === mid && s.team_id === tid);
    const pick = k => { const r = rows.find(x => x.stat_key === k && x.basis === 'source') || rows.find(x => x.stat_key === k); return r ? Number(r.value) : null; };
    const shotRow = rows.find(x => x.stat_key === 'shots' && x.basis === 'source') || rows.find(x => x.stat_key === 'shots');
    return pick('shots') === null ? null : { shots: pick('shots'), shots_on_target: pick('shots_on_target'), basis: shotRow?.basis || null };
  };
  return done.map(m => {
    const home = m.home_team_id === teamId; const opp = home ? m.away_team_id : m.home_team_id;
    // one event family per match (the richest present), so nothing is double counted
    const ev = events.filter(e => e.match_id === m.id);
    const fams = [...new Set(ev.map(e => e.source_family))];
    const fam = ['wyscout_figshare', 'espn', 'openligadb'].find(f => fams.includes(f)) || fams[0];
    const mine = ev.filter(e => e.source_family === fam);
    const scorer = e => (e.is_own_goal ? ownGoalBeneficiary(e, m.home_team_id, m.away_team_id) : e.team_id);
    return {
      id: m.id, kickoff_at: m.kickoff_at, home, gf: home ? m.home_score : m.away_score, ga: home ? m.away_score : m.home_score,
      stats: statOf(m.id, teamId), opp_stats: statOf(m.id, opp),
      stat_signature: statOf(m.id, teamId)?.basis && statOf(m.id, teamId)?.basis === statOf(m.id, opp)?.basis && fam ? `${fam}:${statOf(m.id, teamId).basis}` : null,
      event_family: fam || null,
      shots: mine.filter(e => e.event_type === 'shot' && e.team_id === teamId && e.x_m !== null).map(e => ({ x_m: Number(e.x_m), y_m: Number(e.y_m), set_piece: e.set_piece })),
      goals: mine.filter(e => (e.is_goal || e.is_own_goal) && scorer(e) === teamId).map(e => ({ minute: e.minute, set_piece: e.is_own_goal ? null : e.set_piece })),
      conceded: mine.filter(e => (e.is_goal || e.is_own_goal) && scorer(e) === opp).map(e => ({ minute: e.minute })),
    };
  });
}
