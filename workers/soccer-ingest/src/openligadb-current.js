// Production lane: OpenLigaDB Bundesliga, current season.
//
// Efficient polling (OpenLigaDB asks consumers not to pull full datasets
// repeatedly): each run asks /getcurrentgroup and /getlastchangedate for the
// current matchday and its neighbours, and downloads /getmatchdata only for
// matchdays whose change date moved. A full-season refresh runs once a day
// (reschedulings) and on first run.
//
// Cadence (decided here, cron fires every 5 min):
//   live window (a kickoff within -3 h .. +20 min)  -> every tick
//   otherwise                                       -> at most hourly
//   full season refresh                             -> once per UTC day

import { politeFetch } from '../../shared/http.js';
import { OPENLIGA_PARSER_VERSION } from '../../providers/openligadb.js';
import { fetchAndArchive, ingestOpenLigaSeason } from './openligadb-lane.js';

export const LANE = 'openligadb_bl1_current';
const API = 'https://api.openligadb.de';

export function currentSeason(now = new Date()) {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // season label starts in July
}

async function getJson(fetcher, url) {
  const r = await fetcher(url);
  return JSON.parse(new TextDecoder().decode(r.bytes));
}

export function decideCadence(state, { now = Date.now(), inLiveWindow }) {
  const last = state.last_attempt_at ? Date.parse(state.last_attempt_at) : 0;
  if (inLiveWindow) return true;
  return now - last >= 55 * 60e3;
}

export async function runOpenLigaCurrent({ store, storage, registry, reviewed = { entries: [] }, state, now = Date.now(), fetcher = politeFetch, league = 'bl1', force = false }) {
  const season = currentSeason(new Date(now));
  const cursor = { season, group_changes: {}, ...(state.cursor || {}) };
  if (cursor.season !== season) { cursor.season = season; cursor.group_changes = {}; cursor.full_refresh_day = null; }

  // Live window from what we already store: any kickoff in [-3h, +20min].
  const upcoming = await store.select('soccer_matches', {
    columns: ['kickoff_at'], gte: { kickoff_at: new Date(now - 3 * 3600e3).toISOString() }, lte: { kickoff_at: new Date(now + 20 * 60e3).toISOString() }, limit: 1,
  }).catch(() => []);
  const inLiveWindow = upcoming.length > 0;
  if (!force && !decideCadence(state, { now, inLiveWindow })) return { skipped: 'cadence', inLiveWindow };

  const today = new Date(now).toISOString().slice(0, 10);
  const results = [];
  let observed = 0; let changed = 0; let lastCapture = null;
  const add = s => {
    observed += s.summary.matches;
    changed += ['matches_written', 'source_results', 'goal_events', 'team_crosswalk', 'match_crosswalk'].reduce((n, k) => n + (s.summary[k]?.inserted || 0) + (s.summary[k]?.updated || 0), 0);
    lastCapture = s.summary.capture_id;
    results.push(s.summary);
  };

  if (cursor.full_refresh_day !== today || force) {
    const cap = await fetchAndArchive(storage, league, season, null, fetcher);
    add(await ingestOpenLigaSeason(store, { registry, reviewed, league, season, storage, capture: cap, now }));
    cursor.full_refresh_day = today;
    // Seed change dates so the next tick does not re-download everything.
    const cur = await getJson(fetcher, `${API}/getcurrentgroup/${league}`);
    for (const g of [cur.groupOrderID - 1, cur.groupOrderID, cur.groupOrderID + 1].filter(g => g >= 1 && g <= 34)) {
      cursor.group_changes[g] = await getJson(fetcher, `${API}/getlastchangedate/${league}/${season}/${g}`);
    }
  } else {
    const cur = await getJson(fetcher, `${API}/getcurrentgroup/${league}`);
    for (const g of [cur.groupOrderID - 1, cur.groupOrderID, cur.groupOrderID + 1].filter(g => g >= 1 && g <= 34)) {
      const lastChange = await getJson(fetcher, `${API}/getlastchangedate/${league}/${season}/${g}`);
      if (lastChange === cursor.group_changes[g]) continue;
      const cap = await fetchAndArchive(storage, league, season, g, fetcher);
      add(await ingestOpenLigaSeason(store, { registry, reviewed, league, season, storage, capture: cap, now }));
      cursor.group_changes[g] = lastChange; // only after a successful ingest
    }
  }
  return { inLiveWindow, observed, changed, captureId: lastCapture, cursor, parserVersion: OPENLIGA_PARSER_VERSION, results };
}
