// ESPN Core secondary lanes — one per competition, rotated by the cron.
//
// Each run is budgeted (requests) and checkpointed in the lane cursor:
//   1. season year (league object, refreshed daily)
//   2. event index for the season (refs, refreshed daily)
//   3. fixtures: fetch events not yet seen -> compact fixture list in the cursor
//   4. team identity: crosswalk; else fixture-subset proof against canonical
//      fixtures owned by another provider (Bundesliga: OpenLigaDB); else found
//      (competitions without another source)
//   5. match detail for finished fixtures: status, scores, rosters, team stats,
//      plays -> canonical (secondary precedence, never overwrites)
// A match is only marked done after every write for it succeeded; a failed page
// never advances the cursor. Every response is archived (R2 family 'espn') and its
// capture row stored BEFORE any canonical row references it.

import { archiveCapture } from '../../shared/archive.js';
import { politeFetch } from '../../shared/http.js';
import * as espn from '../../providers/espn.js';
import { captureRow } from './openligadb-lane.js';
import { alignOpenLigaScorersToEspn, ensureCompetitionSeason, ingestEspnMatch, resolveEspnTeams, upsertEspnFixtures } from './espn-lane.js';

export const ESPN_COMPETITIONS = ['bundesliga', 'premier-league', 'uefa-champions-league', 'uefa-europa-league', 'la-liga', 'serie-a', 'ligue-1', 'mls'];
export const ESPN_LANES = ESPN_COMPETITIONS.map(slug => ({ name: `espn_${slug.replace(/-/g, '_')}`, competition: slug }));
export const DEFAULT_BUDGET = 30;

export class BudgetExhausted extends Error { constructor() { super('request budget exhausted'); this.name = 'BudgetExhausted'; } }

export function espnClient({ storage, store, fetcher = politeFetch, budget = DEFAULT_BUDGET, registry = null, areas = null }) {
  const client = { used: 0, budget, pending: [], registry, areas };
  client.get = async (url) => {
    if (client.used >= client.budget) throw new BudgetExhausted();
    client.used += 1;
    const res = await fetcher(espn.https(url), { minIntervalMs: 700 });
    const ctype = res.contentType || '';
    const head = new TextDecoder().decode(res.bytes.subarray(0, 64));
    if (!/json/.test(ctype) && !/^\s*[{[]/.test(head)) throw new espn.EspnShapeError(`non-JSON response for ${url}`);
    const rec = await archiveCapture(storage, { family: 'espn', sourceKey: 'espn.core', url: espn.https(url), status: res.status, contentType: ctype, bytes: res.bytes, parserVersion: espn.ESPN_PARSER_VERSION });
    client.pending.push(rec);
    return { json: JSON.parse(new TextDecoder().decode(res.bytes)), capture: rec };
  };
  // Capture rows must exist before rows that reference them (FK).
  client.flush = async () => {
    if (!client.pending.length) return;
    const rows = client.pending.map(captureRow);
    client.pending = [];
    await store.insert('soccer_source_captures', rows);
  };
  return client;
}

export async function runEspnLane(lane, { store, storage, registry, areas = { areas: {}, aliases: {} }, state, now = Date.now(), fetcher = politeFetch, budget = DEFAULT_BUDGET, force = false }) {
  const comp = registry.competitions.find(c => c.slug === lane.competition);
  if (!comp?.espn) throw new Error(`registry has no ESPN id for ${lane.competition}`);
  if (comp.espn.enabled === false) return { skipped: `espn lane for ${comp.slug} not enabled (registry espn.enabled=false)` };
  const league = comp.espn.league;
  const client = espnClient({ storage, store, fetcher, budget, registry, areas });
  const today = new Date(now).toISOString().slice(0, 10);
  const cursor = { fixtures: {}, done: {}, ...(state.cursor || {}) };
  const stats = { competition: comp.slug, observed: 0, changed: 0, matches_detailed: 0, fixtures_new: 0, match_results: [] };
  try {
    // 1. season
    if (!cursor.season_year || cursor.season_day !== today || force) {
      const { json } = await client.get(espn.urls.league(league));
      const year = espn.seasonYearOf(json.season?.$ref);
      if (!year) throw new espn.EspnShapeError('league without season');
      if (cursor.season_year && cursor.season_year !== year) { cursor.fixtures = {}; cursor.done = {}; cursor.index = null; }
      cursor.season_year = year; cursor.season_day = today;
    }
    const year = cursor.season_year;
    // 2. event index (all season types: tournaments have several)
    if (!cursor.index || cursor.index_day !== today) {
      const { json: types } = await client.get(espn.urls.seasonTypes(league, year));
      const typeIds = (types.items || []).map(i => espn.refId(i.$ref, 'types')).filter(Boolean);
      const ids = [];
      for (const t of typeIds) {
        let page = 1; let pages = 1;
        do { const { json } = await client.get(espn.urls.seasonEvents(league, year, t, page)); const r = espn.refsOf(json); ids.push(...r.ids); pages = r.pageCount; page += 1; } while (page <= pages);
      }
      cursor.index = [...new Set(ids)]; cursor.index_day = today;
    }
    // 3. fixtures not yet seen (event objects)
    for (const id of cursor.index.filter(i => !cursor.fixtures[i])) {
      const { json, capture } = await client.get(espn.urls.event(league, id));
      const ev = espn.parseEvent(json, league);
      cursor.fixtures[id] = { d: ev.kickoff_utc, h: ev.home.team_id, a: ev.away.team_id, sy: ev.season_year, stype: ev.season_type, v: ev.venue, att: ev.attendance, cap: capture.capture_id };
      stats.fixtures_new += 1;
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) { await client.flush().catch(() => {}); throw err; }
    stats.budget_exhausted_at = 'discovery';
  }
  try {
    await client.flush();
    if (comp.espn.enabled === false) { stats.skipped = 'competition not enabled in registry'; return { observed: 0, changed: 0, captureId: null, cursor, parserVersion: espn.ESPN_PARSER_VERSION, results: [stats], requests: client.used }; }
    // 4. teams + fixtures -> canonical (only fixtures whose teams are resolved)
    const teamRes = await resolveEspnTeams(store, { comp, year: cursor.season_year, cursor, client });
    stats.team_identity = teamRes.summary;
    stats.fixtures = await upsertEspnFixtures(store, { comp, year: cursor.season_year, cursor, teamMap: teamRes.teamMap, now });
    // 5. details for finished fixtures not yet done, oldest first
    const due = Object.entries(cursor.fixtures)
      .filter(([, f]) => teamRes.teamMap.has(f.h) && teamRes.teamMap.has(f.a))
      .filter(([id, f]) => !cursor.done[id] && Date.parse(f.d) < now - 115 * 60e3)
      .sort((x, y) => Date.parse(x[1].d) - Date.parse(y[1].d));
    for (const [id, f] of due) {
      if (client.budget - client.used < 10) { stats.budget_exhausted_at = stats.budget_exhausted_at || 'details'; break; }
      const r = await ingestEspnMatch(store, { comp, league, year: cursor.season_year, eventId: id, fixture: f, teamMap: teamRes.teamMap, client, now });
      stats.observed += 1; stats.changed += r.changed;
      stats.match_results.push(r.summary);
      if (r.final) { cursor.done[id] = 1; stats.matches_detailed += 1; }
    }
    // Where OpenLigaDB also covers the season, bridge its queued scorer ids.
    if (stats.matches_detailed && comp.external_ids.some(x => x.provider === 'openligadb')) {
      const { seasonId } = await ensureCompetitionSeason(store, { comp, year: cursor.season_year });
      stats.openligadb_scorer_bridge = await alignOpenLigaScorersToEspn(store, { seasonId });
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) { await client.flush().catch(() => {}); throw err; }
    stats.budget_exhausted_at = stats.budget_exhausted_at || 'details';
  }
  await client.flush();
  return { observed: stats.observed, changed: stats.changed, captureId: null, cursor, parserVersion: espn.ESPN_PARSER_VERSION, results: [stats], requests: client.used };
}
