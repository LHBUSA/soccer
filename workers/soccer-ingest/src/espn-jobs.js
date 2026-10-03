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
import { alignOpenLigaScorersToEspn, ensureCompetitionSeason, ingestEspnMatch, resolveEspnTeams, retryEnrichment, upsertEspnFixtures } from './espn-lane.js';

export const ESPN_COMPETITIONS = ['bundesliga', 'premier-league', 'uefa-champions-league', 'uefa-europa-league', 'la-liga', 'serie-a', 'ligue-1', 'mls', 'uefa-nations-league', 'fifa-world-cup', 'nwsl', 'womens-super-league', 'uefa-womens-champions-league', 'liga-f', 'premiere-ligue'];
export const ESPN_LANES = ESPN_COMPETITIONS.map(slug => ({ name: `espn_${slug.replace(/-/g, '_')}`, competition: slug }));
export const DEFAULT_BUDGET = 30;

export class BudgetExhausted extends Error { constructor() { super('request budget exhausted'); this.name = 'BudgetExhausted'; } }

export function espnClient({ storage, store, fetcher = politeFetch, budget = DEFAULT_BUDGET, registry = null, areas = null }) {
  const client = { used: 0, budget, pending: [], registry, areas, storage };
  client.get = async (url) => {
    if (client.used >= client.budget) throw new BudgetExhausted();
    client.used += 1;
    const res = await fetcher(espn.https(url), { minIntervalMs: 700 });
    const ctype = res.contentType || '';
    const head = new TextDecoder().decode(res.bytes.subarray(0, 64));
    // Raw capture FIRST, also for a body we refuse: a non-JSON reply is archived (and its capture row stored) before
    // the shape error is raised, so every refused response stays inspectable.
    const rec = await archiveCapture(storage, { family: 'espn', sourceKey: 'espn.core', url: espn.https(url), status: res.status, contentType: ctype, bytes: res.bytes, parserVersion: espn.ESPN_PARSER_VERSION });
    client.pending.push(rec);
    if (!/json/.test(ctype) && !/^\s*[{[]/.test(head)) { await client.flush().catch(() => {}); throw new espn.EspnShapeError(`non-JSON response for ${url} (capture ${rec.capture_id}, HTTP ${res.status}, ${ctype || 'no content-type'})`); }
    return { json: JSON.parse(new TextDecoder().decode(res.bytes)), capture: rec };
  };
  // OPTIONAL enrichment resources only (athlete identity lookups). The response is ALWAYS archived
  // first (bytes, status, content type, capture row); a non-JSON body is returned as unavailable
  // instead of thrown, so one bad athlete page cannot abort a tournament. Core resources (league,
  // season types, event index, events, status, scores) keep using get() and still fail closed.
  client.getOptionalJson = async (url) => {
    if (client.used >= client.budget) throw new BudgetExhausted();
    client.used += 1;
    const res = await fetcher(espn.https(url), { minIntervalMs: 700 });
    const ctype = res.contentType || '';
    const rec = await archiveCapture(storage, { family: 'espn', sourceKey: 'espn.core', url: espn.https(url), status: res.status, contentType: ctype, bytes: res.bytes, parserVersion: espn.ESPN_PARSER_VERSION, notes: 'optional enrichment resource' });
    client.pending.push(rec);
    const text = new TextDecoder().decode(res.bytes);
    if (/json/.test(ctype) || /^\s*[{[]/.test(text.slice(0, 64))) {
      try { return { json: JSON.parse(text), capture: rec, unavailable: false }; } catch { /* malformed JSON: unavailable below */ }
    }
    return { json: null, capture: rec, unavailable: true, reason: 'non_json_response', http_status: res.status ?? null, content_type: ctype || null, endpoint: espn.https(url) };
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

export async function runEspnLane(lane, { store, storage, registry, areas = { areas: {}, aliases: {} }, state, now = Date.now(), fetcher = politeFetch, budget = DEFAULT_BUDGET, force = false, year: pinYear = null, depth = 'full' }) {
  const comp = registry.competitions.find(c => c.slug === lane.competition);
  if (!comp?.espn) throw new Error(`registry has no ESPN id for ${lane.competition}`);
  if (comp.espn.enabled === false) return { skipped: `espn lane for ${comp.slug} not enabled (registry espn.enabled=false)` };
  const league = comp.espn.league;
  const client = espnClient({ storage, store, fetcher, budget, registry, areas });
  const today = new Date(now).toISOString().slice(0, 10);
  const cursor = { fixtures: {}, done: {}, ...(state.cursor || {}) };
  const stats = { competition: comp.slug, observed: 0, changed: 0, matches_detailed: 0, fixtures_new: 0, match_results: [] };
  try {
    // 1. season (a history lane pins a past season: no league lookup; its index never changes)
    if (pinYear) {
      if (cursor.season_year && cursor.season_year !== pinYear) { cursor.fixtures = {}; cursor.done = {}; cursor.index = null; }
      cursor.season_year = pinYear; cursor.season_day = today; cursor.history = true;
    } else if (!cursor.season_year || cursor.season_day !== today || force) {
      const { json } = await client.get(espn.urls.league(league));
      const year = espn.seasonYearOf(json.season?.$ref);
      if (!year) throw new espn.EspnShapeError('league without season');
      if (cursor.season_year && cursor.season_year !== year) { cursor.fixtures = {}; cursor.done = {}; cursor.index = null; }
      cursor.season_year = year; cursor.season_day = today;
    }
    const year = cursor.season_year;
    // 2. event index (all season types: tournaments have several)
    // A cached type index whose roles no longer match the registry (a corrected type_roles entry) is rebuilt, also for a
    // pinned history lane (Premiere Ligue 2022/23 kept 'excluded' for its only type after the registry fix).
    const roleOf = n => comp.espn.type_roles?.[n] || espn.seasonTypeRole(n);
    const rolesDrifted = !!(comp.espn.stage_by_type && cursor.types && Object.values(cursor.types).some(t => roleOf(t.name) !== t.role));
    if (!cursor.index || rolesDrifted || (!pinYear && cursor.index_day !== today)) {
      const { json: types } = await client.get(espn.urls.seasonTypes(league, year));
      let typeIds = (types.items || []).map(i => espn.refId(i.$ref, 'types')).filter(Boolean);
      if (comp.espn.stage_by_type) {
        // Classify every type by its name; only league + playoff events are indexed.
        cursor.types = {};
        for (const t of typeIds) {
          const { json: tj } = await client.get(`${espn.CORE}/${league}/seasons/${year}/types/${t}`);
          // A registry may name a competition's own league-stage type exactly (World Cup: "Group Stage");
          // anything not named there keeps the generic classification.
          cursor.types[t] = { name: tj.name || null, role: roleOf(tj.name) };
        }
        typeIds = typeIds.filter(t => cursor.types[t].role !== 'excluded');
      }
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
    // History seasons can list one pairing several times (postponed / rescheduled / duplicate events). Before any
    // fixture is founded, every event of a repeated (stage, home, away) gets a status read so the FINISHED event is the
    // one that becomes canonical (upsertEspnFixtures prefers it); the others are recorded, never merged.
    if (pinYear) {
      const role = f => (cursor.types?.[f.stype]?.role === 'playoff' ? `t${f.stype}` : 'l');
      const groups = new Map();
      for (const [id, f] of Object.entries(cursor.fixtures)) { const k = `${role(f)}|${f.h}|${f.a}`; groups.set(k, [...(groups.get(k) || []), id]); }
      for (const ids of groups.values()) if (ids.length > 1) for (const id of ids) {
        const f = cursor.fixtures[id];
        if (!f.st) { const { json } = await client.get(`${espn.CORE}/${league}/events/${id}/competitions/${id}/status`); f.st = espn.parseStatus(json); }
        // a finished repeat also needs its score: two finished events of a pairing are two matches only when their
        // local dates AND results differ (upsertEspnFixtures); a duplicate listing repeats the same result
        if (f.st === 'finished' && !f.sc) {
          const sc = {};
          for (const side of ['h', 'a']) { const { json } = await client.get(`${espn.CORE}/${league}/events/${id}/competitions/${id}/competitors/${f[side]}/score`); sc[side] = Number.isFinite(Number(json.value)) ? Number(json.value) : null; }
          f.sc = sc;
        }
      }
      stats.repeated_pairings = [...groups.values()].filter(x => x.length > 1).length;
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) { await client.flush().catch(() => {}); throw err; }
    stats.budget_exhausted_at = 'discovery';
  }
  try {
    await client.flush();
    if (comp.espn.enabled === false) { stats.skipped = 'competition not enabled in registry'; return { observed: 0, changed: 0, captureId: null, cursor, parserVersion: espn.ESPN_PARSER_VERSION, results: [stats], requests: client.used }; }
    // A HISTORY season founds nothing until discovery is complete: every event fetched and every repeated pairing's
    // status and score read. Founding on a partial cursor made a postponed listing canonical before its finished replay
    // was known (Premier League 2002/03). The next run resumes discovery from the cursor.
    if (pinYear && stats.budget_exhausted_at === 'discovery') { stats.deferred = 'history discovery incomplete: no fixture is founded until every event and repeated pairing is read'; return { observed: 0, changed: 0, captureId: null, cursor, parserVersion: espn.ESPN_PARSER_VERSION, results: [stats], requests: client.used }; }
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
      const r = await ingestEspnMatch(store, { comp, league, year: cursor.season_year, eventId: id, fixture: f, teamMap: teamRes.teamMap, client, now, resultsOnly: depth === 'results' });
      stats.observed += 1; stats.changed += r.changed;
      stats.match_results.push(r.summary);
      if (r.final) { cursor.done[id] = 1; stats.matches_detailed += 1; }
    }
    // Spare budget retries optional components (lineups/stats/plays) that failed earlier.
    if (depth !== 'results' && client.budget - client.used >= 20) stats.enrichment_retry = await retryEnrichment(store, { comp, league, year: cursor.season_year, cursor, teamMap: teamRes.teamMap, client, now });
    // Where OpenLigaDB also covers the season, bridge its queued scorer ids.
    if (depth !== 'results' && stats.matches_detailed && comp.external_ids.some(x => x.provider === 'openligadb')) {
      const { seasonId } = await ensureCompetitionSeason(store, { comp, year: cursor.season_year, history: !!cursor.history });
      stats.openligadb_scorer_bridge = await alignOpenLigaScorersToEspn(store, { seasonId });
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) { await client.flush().catch(() => {}); throw err; }
    stats.budget_exhausted_at = stats.budget_exhausted_at || 'details';
  }
  await client.flush();
  return { observed: stats.observed, changed: stats.changed, captureId: null, cursor, parserVersion: espn.ESPN_PARSER_VERSION, results: [stats], requests: client.used };
}
