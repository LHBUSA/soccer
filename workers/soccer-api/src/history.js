// Stored history, never trophies or an overall tournament ranking. No schema changes.
import { envelope, COVERAGE, maxTs } from './envelope.js';
import { computeTable } from '../../soccer-news/src/packet.js';
import { verifyGroupStandings } from '../../shared/standings.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const HISTORY_VERSION = 'soccer-history/1.0.0';
const valid = m => m.status === 'finished' && Number.isInteger(m.home_score) && Number.isInteger(m.away_score);
const r2 = x => Math.round(x * 100) / 100;
const empty = () => ({ played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 });
export function aggregateResults(matches, teamId, pointsMeaningful = false) {
  const total = empty(); const home = empty(); const away = empty();
  for (const m of matches.filter(valid)) {
    const h = m.home_team_id === teamId; if (!h && m.away_team_id !== teamId) continue;
    const gf = h ? m.home_score : m.away_score; const ga = h ? m.away_score : m.home_score;
    for (const a of [total, h ? home : away]) { a.played++; a.won += gf > ga; a.drawn += gf === ga; a.lost += gf < ga; a.goals_for += gf; a.goals_against += ga; }
  }
  const rates = a => ({ ...a, goal_difference: a.goals_for - a.goals_against, points: pointsMeaningful ? a.won * 3 + a.drawn : null, points_per_game: pointsMeaningful && a.played ? r2((a.won * 3 + a.drawn) / a.played) : null, goals_per_match: a.played ? r2(a.goals_for / a.played) : null, goals_allowed_per_match: a.played ? r2(a.goals_against / a.played) : null });
  return { ...rates(total), home: rates(home), away: rates(away) };
}

async function selectIds(store, table, ids, columns) {
  const rows = []; for (const part of chunkArr([...new Set(ids)], 100)) rows.push(...await store.select(table, { columns, in: { id: part }, order: 'id.asc' })); return rows;
}

export async function historyData(store, teamId, { asOf = new Date().toISOString(), env = null } = {}) {
  const cols = ['id', 'competition_id', 'season_id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'result_provider', 'updated_at'];
  const [h, a] = await Promise.all(['home_team_id', 'away_team_id'].map(k => store.select('soccer_public_matches', { columns: cols, eq: { [k]: teamId }, lte: { kickoff_at: asOf }, order: 'kickoff_at.asc,id.asc' })));
  const mine = [...new Map([...h, ...a].filter(m => Date.parse(m.kickoff_at) < Date.parse(asOf)).map(m => [m.id, m])).values()];
  const [seasons, comps] = await Promise.all([selectIds(store, 'soccer_public_seasons', mine.map(m => m.season_id), ['id', 'competition_id', 'label', 'start_date', 'end_date']), selectIds(store, 'soccer_competitions', mine.map(m => m.competition_id), ['id', 'slug', 'name', 'comp_type'])]);
  const byComp = new Map(comps.map(c => [c.id, c]));
  const rows = [];
  // Four independent seasons at a time, bounded rather than 23 sequential round trips.
  for (const batch of chunkArr(seasons, 4)) rows.push(...await Promise.all(batch.map(async s => {
    const c = byComp.get(s.competition_id); const ms = mine.filter(m => m.season_id === s.id && m.competition_id === s.competition_id).sort((x, y) => Date.parse(x.kickoff_at) - Date.parse(y.kickoff_at));
    const done = ms.filter(valid);
    const key = `history:${HISTORY_VERSION}:${teamId}:${s.id}:${maxTs(ms.map(m => m.updated_at))}:${asOf.slice(0, 10)}`;
    // Only closed seasons are materialized; current season reads remain five-minute edge cached.
    const closed = !!s.end_date && Date.parse(s.end_date) < Date.parse(asOf) && ms.length > 0 && ms.every(valid);
    const cached = closed && env?.SOCCER_STATE ? await env.SOCCER_STATE.get(key, 'json').catch(() => null) : null;
    if (cached) return cached;
    const [stages, groups] = await Promise.all([
      store.select('soccer_stages', { columns: ['id', 'stage_type'], eq: { season_id: s.id } }),
      store.select('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'group_type'], eq: { season_id: s.id } }),
    ]);
    const leagueIds = stages.filter(x => x.stage_type === 'league').map(x => x.id);
    const leagueDone = done.filter(m => leagueIds.includes(m.stage_id));
    const meaningful = done.length > 0 && leagueDone.length === done.length && (c?.comp_type === 'league' || groups.length > 0);
    const agg = aggregateResults(done, teamId, meaningful);
    let finish = null; let groupPosition = null;
    if (leagueIds.length && leagueDone.length) {
      const full = await store.select('soccer_public_matches', { columns: cols, eq: { season_id: s.id, competition_id: s.competition_id }, in: { stage_id: leagueIds }, lte: { kickoff_at: asOf }, order: 'id.asc' });
      const computed = computeTable(full.filter(valid)); const byId = new Map(computed.map(r => [r.team_id, r]));
      for (const g of groups) {
        const source = await store.select('soccer_source_standings', { columns: ['team_id', 'rank', 'played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against', 'points', 'deductions'], eq: { group_id: g.id, provider: 'espn' } });
        if (!source.some(r => r.team_id === teamId) || !verifyGroupStandings(source, byId).verified) continue;
        if (g.group_type === 'group') groupPosition = { position: source.find(r => r.team_id === teamId).rank, group: g.group_key, name: g.name, basis: 'Provider group rank reconciled to canonical league-stage results; not overall rank.' };
        // Conference / league-phase position is never called a league finish.
      }
      // Bundesliga complete balanced double round robin. Unresolved tied rows have no finish.
      const row = byId.get(teamId); const tied = row && computed.some(r => r.team_id !== teamId && r.points === row.points && r.gd === row.gd && r.gf === row.gf);
      if (c?.slug === 'bundesliga' && !groups.length && computed.length === 18 && full.length === 306 && full.every(valid) && computed.every(r => r.played === 34) && !tied) finish = { position: computed.findIndex(r => r.team_id === teamId) + 1, teams: 18, basis: 'Complete 306-match canonical Bundesliga league stage, 34 matches per team; points/GD/GF, no unresolved tie for this team.' };
    }
    const out = { competition: c ? { slug: c.slug, name: c.name } : null, season: s.label, season_id: s.id, ...agg, league_record: aggregateResults(leagueDone, teamId, c?.comp_type === 'league' || groups.length > 0), table_finish: finish, group_position: groupPosition, first_stored_match: ms[0]?.kickoff_at || null, last_stored_match: ms.at(-1)?.kickoff_at || null, completed: closed, stored_matches: ms.length, score_coverage: { counted: done.length, stored: ms.length }, basis: 'Canonical finished score pairs only; all stages included in W/D/L and goals. Points only for exclusively league/group-stage samples; league_record excludes knockouts/playoffs.' };
    if (closed && env?.SOCCER_STATE) await env.SOCCER_STATE.put(key, JSON.stringify(out), { expirationTtl: 86400 }).catch(() => {});
    return out;
  })));
  rows.sort((x, y) => Date.parse(x.first_stored_match) - Date.parse(y.first_stored_match) || x.competition.slug.localeCompare(y.competition.slug));
  const summary = selected => {
    const ms = mine.filter(m => selected.some(s => s.season_id === m.season_id));
    const agg = aggregateResults(ms, teamId);
    const finishes = selected.filter(r => r.table_finish).sort((a, b) => a.table_finish.position - b.table_finish.position);
    return { ...agg, seasons_stored: selected.length, win_rate: agg.played ? r2(agg.won / agg.played) : null, first_season: selected[0]?.season || null, latest_season: selected.at(-1)?.season || null, first_stored_match: selected[0]?.first_stored_match || null, last_stored_match: selected.at(-1)?.last_stored_match || null, best_verified_league_finish: finishes[0] ? { competition: finishes[0].competition, season: finishes[0].season, ...finishes[0].table_finish } : null, historical_window: selected.length ? `${selected[0].season}–${selected.at(-1).season}` : null };
  };
  return { version: HISTORY_VERSION, as_of: asOf, seasons: rows, summary: summary(rows), competitions: comps.map(c => ({ slug: c.slug, name: c.name, summary: summary(rows.filter(r => r.competition?.slug === c.slug)) })), attribution: [...new Set(mine.map(m => m.result_provider).filter(Boolean))] };
}

export async function teamHistory(store, slug, env) {
  const [t] = await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], eq: { slug, status: 'active' }, limit: 1 });
  if (!t) throw Object.assign(new Error('team not found'), { status: 404 });
  const d = await historyData(store, t.id, { env });
  return envelope({ team: t, ...d }, { version: HISTORY_VERSION, source: 'pbe', semantics: 'Every stored competition-season with canonical score aggregates. Missing scores remain missing. No inferred trophies. Group position is never overall ranking.', attribution: d.attribution, coverage: d.seasons.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE });
}
