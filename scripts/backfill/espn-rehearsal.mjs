#!/usr/bin/env node
// ESPN secondary-lane rehearsal on real data (local PGlite running the real
// migrations, or production with --prod). Runs OpenLigaDB current season first
// (so the Bundesliga fixture graph is owned by OpenLigaDB, as in production), then
// the ESPN lanes for the requested competitions until each stops making progress
// or the total request budget is spent. Writes docs/evidence/espn/<mode>-<date>.json
// with the coverage/identity metrics the owner asked for.
//
//   node scripts/backfill/espn-rehearsal.mjs --competitions bundesliga,premier-league --budget 1500

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fsStorage } from '../../workers/shared/archive.js';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { applyMigrations, openPglite, pgliteStore } from '../../workers/soccer-ingest/src/store.js';
import { normalizeUrl } from '../../workers/shared/archive.js';
import { politeFetch } from '../../workers/shared/http.js';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { runOpenLigaCurrent } from '../../workers/soccer-ingest/src/openligadb-current.js';
import { ESPN_LANES, runEspnLane } from '../../workers/soccer-ingest/src/espn-jobs.js';
import { emptyLaneState } from '../../workers/soccer-ingest/src/state.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { espnStoreCanary } from '../../workers/soccer-ingest/src/canary.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const comps = arg('--competitions', 'bundesliga').split(',');
let budgetLeft = Number(arg('--budget', '1200'));
const prod = argv.includes('--prod');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

let store;
if (prod) {
  const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
  store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
} else if (arg('--snapshot')) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite({ loadDataDir: new Blob([readFileSync(arg('--snapshot'))]) });
  await db.waitReady;
  store = pgliteStore(db);
} else { store = await openPglite(); await applyMigrations(store); }

// --replay: serve ESPN Core URLs from the local raw archive when a capture exists
// (latest capture per normalized URL); fall back to a live polite fetch otherwise.
let fetcher = politeFetch; let replayHits = 0; let liveFetches = 0;
if (argv.includes('--replay')) {
  const dir = '.raw/soccer-source/espn/captures';
  const idx = new Map();
  for (const d of readdirSync(dir)) for (const f of readdirSync(join(dir, d))) {
    const r = JSON.parse(readFileSync(join(dir, d, f), 'utf8'));
    const k = r.request_url; if (!idx.has(k) || idx.get(k).captured_at < r.captured_at) idx.set(k, r);
  }
  fetcher = async (url, opts) => {
    const hit = idx.get(normalizeUrl(url));
    if (hit) { replayHits += 1; return { status: hit.http_status, contentType: hit.content_type, bytes: new Uint8Array(readFileSync(join('.raw', ...hit.raw_key.split('/')))) }; }
    liveFetches += 1; return politeFetch(url, opts);
  };
}
const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const reviewed = JSON.parse(readFileSync('data/registry/team-crosswalk-reviewed.json', 'utf8'));
const areas = JSON.parse(readFileSync('data/registry/areas.json', 'utf8'));
const storage = await fsStorage('.raw');

log('openligadb current season');
const ol = argv.includes('--skip-openligadb') ? { observed: 0 } : await runOpenLigaCurrent({ store, storage, registry, reviewed, state: emptyLaneState('x'), force: true });
log('openligadb', ol.observed, 'observed');

const lanes = {};
for (const c of comps) {
  const lane = ESPN_LANES.find(l => l.competition === c);
  if (!lane) throw new Error(`no ESPN lane for ${c}`);
  let state = emptyLaneState(lane.name);
  const runs = [];
  for (let i = 0; i < 200 && budgetLeft > 0; i++) {
    const budget = Math.min(150, budgetLeft);
    const out = await runEspnLane(lane, { store, storage, registry, areas, state, budget, fetcher });
    budgetLeft -= out.requests;
    state = { ...state, cursor: out.cursor };
    const r = out.results[0];
    runs.push({ requests: out.requests, fixtures_new: r.fixtures_new, detailed: r.matches_detailed, team_identity: r.team_identity, fixtures: r.fixtures && { attached: r.fixtures.attached_to_existing, founded: r.fixtures.founded }, bridge: r.openligadb_scorer_bridge, exhausted: r.budget_exhausted_at || null });
    log(c, `run ${i + 1}`, `req ${out.requests}`, `fixtures+${r.fixtures_new}`, `detailed ${r.matches_detailed}`, `done ${Object.keys(out.cursor.done).length}/${Object.keys(out.cursor.fixtures).length}`, r.budget_exhausted_at || '');
    if (!r.budget_exhausted_at && r.fixtures_new === 0 && r.matches_detailed === 0) break;
  }
  lanes[c] = { runs, cursor_summary: { season_year: state.cursor.season_year, index: state.cursor.index?.length, fixtures: Object.keys(state.cursor.fixtures || {}).length, detailed: Object.keys(state.cursor.done || {}).length } };
}

// ---- metrics
const count = (t, o) => store.count(t, o);
const sel = (t, o) => store.select(t, o);
async function selectIn(t, col, vals, o) { const out = []; for (const p of chunkArr(vals, store.inChunk || 150)) out.push(...await sel(t, { ...o, in: { ...(o?.in || {}), [col]: p } })); return out; }
const metrics = {};
for (const c of comps) {
  const [comp] = await sel('soccer_competitions', { columns: ['id'], eq: { slug: c }, limit: 1 });
  if (!comp) { metrics[c] = { missing: true }; continue; }
  const seasons = await sel('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: comp.id } });
  const season = seasons.sort((a, b) => (a.label < b.label ? 1 : -1))[0];
  const matches = await sel('soccer_matches', { columns: ['id', 'status', 'result_provider', 'home_team_id', 'away_team_id'], eq: { season_id: season.id } });
  const ids = matches.map(m => m.id);
  const espnX = await selectIn('soccer_match_external_ids', 'match_id', ids, { columns: ['match_id', 'method'], eq: { provider: 'espn' } });
  const lineups = await selectIn('soccer_lineups', 'match_id', ids, { columns: ['match_id', 'provider', 'formation'] });
  const stats = await selectIn('soccer_team_match_stats', 'match_id', ids, { columns: ['match_id'], eq: { provider: 'espn', basis: 'source' } });
  const sr = await selectIn('soccer_match_source_results', 'match_id', ids, { columns: ['match_id', 'provider', 'home_score', 'away_score', 'status'] });
  const by = new Map(); for (const r of sr) by.set(r.match_id, { ...(by.get(r.match_id) || {}), [r.provider]: r });
  const both = [...by.values()].filter(v => v.espn && v.openligadb && v.espn.status === 'finished' && v.openligadb.status === 'finished');
  const eventCounts = {};
  for (const id of ids.filter(i => espnX.some(x => x.match_id === i))) {
    const n = await count('soccer_match_events', { eq: { match_id: id, source_family: 'espn' } });
    if (n) eventCounts[id] = n;
  }
  const withCoords = Object.keys(eventCounts).length ? await count('soccer_match_events', { eq: { source_family: 'espn', source_coordinate_system: 'espn_pct_v1' }, in: { match_id: Object.keys(eventCounts) } }) : 0;
  const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teamX = await selectIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'method'], eq: { provider: 'espn' } });
  metrics[c] = {
    season: season.label, canonical_matches: matches.length, finished: matches.filter(m => m.status === 'finished').length,
    espn_linked_matches: espnX.length, espn_linked_by_method: espnX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}),
    duplicate_matches_prevented: espnX.filter(x => x.method === 'fixture_graph').length,
    teams: teamIds.length, espn_team_links_by_method: teamX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}),
    matches_with_espn_lineups: new Set(lineups.filter(l => l.provider === 'espn').map(l => l.match_id)).size, lineups_with_formation: lineups.filter(l => l.formation).length,
    matches_with_espn_team_stats: new Set(stats.map(s => s.match_id)).size,
    matches_with_espn_plays: Object.keys(eventCounts).length, espn_events: Object.values(eventCounts).reduce((a, b) => a + b, 0), espn_events_with_coordinates: withCoords,
    cross_source_finished_compared: both.length, cross_source_score_disagreements: both.filter(v => v.espn.home_score !== v.openligadb.home_score || v.espn.away_score !== v.openligadb.away_score).map(v => ({ match_id: v.espn.match_id, espn: `${v.espn.home_score}-${v.espn.away_score}`, openligadb: `${v.openligadb.home_score}-${v.openligadb.away_score}` })),
  };
}
const queue = await sel('soccer_identity_queue', { columns: ['entity_type', 'provider', 'reason'], eq: { status: 'open' } });
const report = {
  generated_at: new Date().toISOString(), mode: prod ? 'production' : 'local-rehearsal', competitions: comps, requests_used: Number(arg('--budget', '1200')) - budgetLeft,
  lanes, metrics,
  identity: {
    espn_players_founded: await count('soccer_player_external_ids', { eq: { provider: 'espn', method: 'founding' } }),
    espn_teams_founded: await count('soccer_team_external_ids', { eq: { provider: 'espn', method: 'founding' } }),
    espn_teams_proven_fixture_graph: await count('soccer_team_external_ids', { eq: { provider: 'espn', method: 'fixture_graph' } }),
    openligadb_scorers_bridged_via_espn: (await sel('soccer_player_external_ids', { columns: ['evidence'], eq: { provider: 'openligadb', method: 'event_alignment' } })).filter(r => /via ESPN/.test(r.evidence || '')).length,
    queue_open_by_reason: queue.reduce((o, q) => { const k = `${q.entity_type}/${q.provider}/${q.reason}`; o[k] = (o[k] || 0) + 1; return o; }, {}),
  },
  store_canary: await espnStoreCanary(store),
  corroboration: await (async () => {
    const merged = (await sel('soccer_player_external_ids', { columns: ['external_id', 'player_id', 'evidence'], eq: { provider: 'espn', method: 'attribute_corroborated' } })).map(r => ({ ...r, ev: JSON.parse(r.evidence) }));
    const espnQ = await sel('soccer_identity_queue', { columns: ['external_id', 'reason', 'payload', 'candidate_ids'], eq: { provider: 'espn', entity_type: 'player', status: 'open' } });
    const nameDob = espnQ.filter(q => q.reason !== 'athlete_without_dob_or_name');
    const conflicting = nameDob.filter(q => q.reason.startsWith('contradiction_'));
    const whyUnverifiable = {};
    for (const q of nameDob) for (const w of q.payload?.evidence?.unverifiable_windows || []) whyUnverifiable[w.why] = (whyUnverifiable[w.why] || 0) + 1;
    const movers = merged.filter(m => m.ev.current_club && m.ev.corroborating_windows.some(w => w.canonical_team !== m.ev.current_club));
    return {
      name_dob_candidates_total: merged.length + nameDob.length,
      auto_resolved: merged.length,
      still_queued: nameDob.length - conflicting.length,
      conflicting: conflicting.length,
      queued_by_reason: nameDob.reduce((o, q) => ({ ...o, [q.reason]: (o[q.reason] || 0) + 1 }), {}),
      contradiction_kinds: conflicting.flatMap(q => (q.payload?.evidence?.contradictions || []).map(c => c.kind)).reduce((o, k) => ({ ...o, [k]: (o[k] || 0) + 1 }), {}),
      unverifiable_window_reasons: whyUnverifiable,
      merged_evidence: {
        corroborating_windows_by_season: merged.flatMap(m => m.ev.corroborating_windows.map(w => w.season)).reduce((o, s) => ({ ...o, [s]: (o[s] || 0) + 1 }), {}),
        nationality_compared: merged.filter(m => m.ev.nationality?.compared).length,
        movers_2017_club_differs_from_current_club: movers.length,
      },
      samples: {
        merged: merged.slice(0, 5).map(m => ({ name: m.ev.name, dob: m.ev.birth_date, windows: m.ev.corroborating_windows })),
        conflicting: conflicting.slice(0, 5).map(q => ({ name: q.payload?.name, reason: q.reason, contradictions: q.payload?.evidence?.contradictions })),
      },
    };
  })(),
  replay: { hits: replayHits, live_fetches: liveFetches },
  elapsed_s: Math.round((Date.now() - t0) / 1000),
};
mkdirSync('docs/evidence/espn', { recursive: true });
const file = `docs/evidence/espn/${prod ? 'production' : 'rehearsal'}-${report.generated_at.slice(0, 10)}-${comps.join('+')}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
log('written', file);
console.log(JSON.stringify({ metrics, identity: report.identity }, null, 1).slice(0, 4000));
