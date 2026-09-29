#!/usr/bin/env node
// UEFA Nations League canary (steps 2-8 of the enable sequence), on REAL ESPN Core data in a
// LOCAL PGlite store running every migration (nothing is written to production). The registry
// lane is enabled IN MEMORY only; data/registry/competitions.json is untouched.
//
//   2 dry ingest      ESPN lane until the season's fixture graph + finished details are done
//   3 identity        teams founded / national / duplicates; athletes vs PRODUCTION ESPN crosswalks
//                     (read-only: which national-team players are already canonical club players)
//   4 fixtures        counts by status and season type vs the source index
//   5 group tree      standings lane (forced): groups, tiers, members
//   6 standings       every group verified against canonical results (API table)
//   7 finished match  deep enrichment proof (lineups, stats, plays, coordinates, players) + cast
//   8 scheduled match match + cast payload shape
//
//   node scripts/canary/nations-league.mjs [--budget 3000] [--data .proof/unl-pglite.tar.gz] [--resume]
// Output: docs/evidence/espn/uefa-nations-canary-<date>.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fsStorage } from '../../workers/shared/archive.js';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { applyMigrations, openPglite, pgliteStore } from '../../workers/soccer-ingest/src/store-pglite.js';
import { ESPN_LANES, runEspnLane } from '../../workers/soccer-ingest/src/espn-jobs.js';
import { runEspnStandings } from '../../workers/soccer-ingest/src/espn-standings.js';
import { emptyLaneState } from '../../workers/soccer-ingest/src/state.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import * as R from '../../workers/soccer-api/src/routes.js';
import * as C from '../../workers/soccer-api/src/cast.js';

const SLUG = 'uefa-nations-league';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
let budgetLeft = Number(arg('--budget', '3000'));
const snapshot = arg('--data', '.proof/unl-pglite.tar.gz'); // PGlite cannot use a data dir on exFAT: in-memory + dump
const resume = argv.includes('--resume') && existsSync(snapshot);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

let store;
if (resume) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite({ loadDataDir: new Blob([readFileSync(snapshot)]) });
  await db.waitReady;
  store = pgliteStore(db);
} else { store = await openPglite(); await applyMigrations(store); }
const saveSnapshot = async () => writeFileSync(snapshot, Buffer.from(await (await store.db.dumpDataDir('gzip')).arrayBuffer()));
const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const comp = registry.competitions.find(c => c.slug === SLUG);
comp.espn.enabled = true; // in memory only
const areas = JSON.parse(readFileSync('data/registry/areas.json', 'utf8'));
const storage = await fsStorage('.raw');
const lane = ESPN_LANES.find(l => l.competition === SLUG);
const statePath = `${snapshot}.state.json`;
let state = resume && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : emptyLaneState(lane.name);

// ---- 2. dry ingest
const runs = [];
for (let i = 0; i < 100 && budgetLeft >= 10; i++) {
  const out = await runEspnLane(lane, { store, storage, registry, areas, state, budget: Math.min(200, budgetLeft), force: i === 0 });
  budgetLeft -= out.requests;
  state = { ...state, cursor: out.cursor };
  writeFileSync(statePath, JSON.stringify(state));
  if (i % 3 === 2) await saveSnapshot();
  const r = out.results[0];
  runs.push({ requests: out.requests, fixtures_new: r.fixtures_new, detailed: r.matches_detailed, team_identity: r.team_identity, fixtures: r.fixtures, exhausted: r.budget_exhausted_at || null });
  log(`run ${i + 1}`, `req ${out.requests}`, `fixtures+${r.fixtures_new}`, `detailed ${r.matches_detailed}`, `done ${Object.keys(out.cursor.done).length}/${Object.keys(out.cursor.fixtures).length}`, r.budget_exhausted_at || '');
  if (!r.budget_exhausted_at && r.fixtures_new === 0 && r.matches_detailed === 0) break;
}

// ---- 5. group tree (standings lane, forced, this competition only)
const standingsRegistry = { ...registry, competitions: [comp] };
const st = await runEspnStandings({ store, storage, registry: standingsRegistry, state: {}, force: true, budget: 80 });
log('standings', JSON.stringify(st.results));
await saveSnapshot();

// ---- reports
const sel = (t, o) => store.select(t, o);
async function selectIn(t, col, vals, o = {}) { const out = []; for (const p of chunkArr([...new Set(vals)], 500)) out.push(...await sel(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return out; }
const [c] = await sel('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type'], eq: { slug: SLUG } });
const seasons = await sel('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } });
const season = seasons[0];
const matches = await sel('soccer_matches', { columns: ['id', 'status', 'stage_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], eq: { season_id: season.id } });
const stages = await sel('soccer_stages', { columns: ['id', 'name', 'stage_type'], eq: { season_id: season.id } });
const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
const teams = await selectIn('soccer_teams', 'id', teamIds, { columns: ['id', 'slug', 'name', 'team_type', 'country_code'] });
const teamX = await selectIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'external_id', 'method'], eq: { provider: 'espn' } });
const cursor = state.cursor;
const byStatus = matches.reduce((o, m) => ({ ...o, [m.status]: (o[m.status] || 0) + 1 }), {});
const typeCounts = Object.values(cursor.fixtures).reduce((o, f) => ({ ...o, [cursor.types?.[f.stype]?.name || f.stype]: (o[cursor.types?.[f.stype]?.name || f.stype] || 0) + 1 }), {});
const ids = matches.map(m => m.id);
const enrich = await selectIn('soccer_match_enrichment', 'match_id', ids, { columns: ['match_id', 'component', 'status'] });
const finished = matches.filter(m => m.status === 'finished');
const comp4 = k => finished.filter(m => enrich.some(e => e.match_id === m.id && e.component.startsWith(k) && e.status === 'complete')).length;
const events = await selectIn('soccer_match_events', 'match_id', finished.map(m => m.id), { columns: ['match_id', 'x_m'], eq: { source_family: 'espn' } });

// athletes: canonical players named in UNL lineups; which ESPN athlete ids are ALREADY crosswalked in production
const lineups = await selectIn('soccer_lineups', 'match_id', ids, { columns: ['id'] });
const lps = await selectIn('soccer_lineup_players', 'lineup_id', lineups.map(l => l.id), { columns: ['player_id'] });
const px = await selectIn('soccer_player_external_ids', 'player_id', lps.map(x => x.player_id), { columns: ['player_id', 'external_id', 'method'], eq: { provider: 'espn' } });
let prodIdentity = { skipped: 'no production env file' };
const envFile = 'D:/Workers/secrets/soccer-supabase.env';
if (existsSync(envFile)) {
  const text = readFileSync(envFile, 'utf8').replace(/^\uFEFF/, '');
  const prod = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
  const espnIds = [...new Set(px.map(x => x.external_id))];
  const known = []; for (const p of chunkArr(espnIds, 150)) known.push(...await prod.select('soccer_player_external_ids', { columns: ['external_id', 'player_id', 'method'], eq: { provider: 'espn' }, in: { external_id: p } }));
  const prodTeams = []; for (const p of chunkArr(teamX.map(x => x.external_id), 150)) prodTeams.push(...await prod.select('soccer_team_external_ids', { columns: ['external_id', 'team_id', 'method'], eq: { provider: 'espn' }, in: { external_id: p } }));
  const queued = []; for (const p of chunkArr(espnIds, 150)) queued.push(...await prod.select('soccer_identity_queue', { columns: ['external_id', 'reason'], eq: { provider: 'espn', entity_type: 'player', status: 'open' }, in: { external_id: p } }));
  prodIdentity = {
    unl_athletes_seen_locally: espnIds.length,
    already_canonical_in_production_by_espn_id: known.length, // reused: SAME canonical player as their club Player DNA
    by_method: known.reduce((o, k) => ({ ...o, [k.method]: (o[k.method] || 0) + 1 }), {}),
    already_queued_in_production: queued.length,
    would_be_new: espnIds.length - known.length - queued.length,
    national_teams_already_in_production: prodTeams.length,
  };
}

// ---- 6. API: grouped table + every group
const idx = await R.table(store, { competition: SLUG });
const groupsOut = [];
for (const g of idx.data.groups) {
  const t = await R.table(store, { competition: SLUG, group: g.key });
  groupsOut.push({ key: g.key, name: g.name, tier: g.parent?.name || null, teams: g.teams, verified: t.data.verification.verified, rows: t.data.rows.length, mismatches: t.data.verification.mismatches.slice(0, 4), zones: [...new Set(t.data.rows.map(r => r.zone?.label).filter(Boolean))] });
}
let overallProbe = null;
try { const o = await R.table(store, { competition: SLUG, group: 'overall' }); overallProbe = { view: o.data.view, rows: o.data.rows.length }; } catch (e) { overallProbe = { error: e.message }; }

// ---- 7. finished-match deep proof, 8. scheduled-match proof
const deep = finished.map(m => ({ m, n: events.filter(e => e.match_id === m.id).length })).sort((a, b) => b.n - a.n)[0]?.m;
let deepProof = null;
if (deep) {
  const md = await R.match(store, deep.id);
  const cast = await C.cast(store, deep.id, {});
  const d = md.data;
  deepProof = {
    match_id: deep.id, fixture: `${d.home?.name} ${d.score?.home}-${d.score?.away} ${d.away?.name}`, kickoff: d.kickoff_at, venue: d.venue?.name || null,
    lineups: d.lineups ? Object.keys(d.lineups) : null, substitutions: d.substitutions?.length ?? null, stats: d.stats ? 'present' : null, shots: d.shots?.length ?? null,
    timeline: d.timeline?.length ?? null, events: events.filter(e => e.match_id === deep.id).length,
    located_events: events.filter(e => e.match_id === deep.id && e.x_m !== null).length, coverage: md.meta.coverage,
    cast: { mode: cast.data.live?.mode ?? null, sequence: cast.data.sequence?.length ?? null, located: cast.data.sequence?.filter(x => x.x !== undefined).length ?? null },
  };
}
const sched = matches.filter(m => m.status === 'scheduled').sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at))[0];
let schedProof = null;
if (sched) {
  const md = await R.match(store, sched.id);
  const cast = await C.cast(store, sched.id, {});
  schedProof = { match_id: sched.id, fixture: `${md.data.home?.name} v ${md.data.away?.name}`, kickoff: md.data.kickoff_at, status: md.data.status, score: md.data.score, cast_mode: cast.data.live?.mode ?? null, cast_sequence: cast.data.sequence?.length ?? null };
}
const nat = teams.find(t => t.team_type === 'national');
const teamPage = nat ? await R.team(store, nat.slug) : null;
const compPage = await R.competition(store, SLUG);

const dupTeamX = teamX.length - new Set(teamX.map(x => x.external_id)).size;
const allPx = await sel('soccer_player_external_ids', { columns: ['external_id'], eq: { provider: 'espn' } });
const report = {
  generated_at: new Date().toISOString(), mode: 'local-pglite (production untouched)', competition: SLUG,
  espn: { league: comp.espn.league, id: comp.espn.id, season_year: cursor.season_year, types: cursor.types, index: cursor.index?.length, fixtures_seen: Object.keys(cursor.fixtures).length, by_type: typeCounts },
  runs, requests_used: Number(arg('--budget', '3000')) - budgetLeft,
  teams: { total: teams.length, national: teams.filter(t => t.team_type === 'national').length, club: teams.filter(t => t.team_type !== 'national').length, with_country_code: teams.filter(t => t.country_code).length, espn_crosswalk_by_method: teamX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}), duplicate_espn_team_ids: dupTeamX },
  matches: { total: matches.length, by_status: byStatus, by_stage: stages.map(s => ({ name: s.name, type: s.stage_type, matches: matches.filter(m => m.stage_id === s.id).length })) },
  enrichment: { finished: finished.length, lineups_both: finished.filter(m => ['lineup_home', 'lineup_away'].every(k => enrich.some(e => e.match_id === m.id && e.component === k && e.status === 'complete'))).length, stats_any: comp4('stats'), plays: comp4('plays'), events: events.length, located_events: events.filter(e => e.x_m !== null).length, matches_with_coordinates: new Set(events.filter(e => e.x_m !== null).map(e => e.match_id)).size },
  identity: { players_in_lineups: new Set(lps.map(x => x.player_id)).size, duplicate_espn_player_ids: allPx.length - new Set(allPx.map(x => x.external_id)).size, production: prodIdentity, queue_open: (await sel('soccer_identity_queue', { columns: ['entity_type', 'reason'], eq: { status: 'open' } })).reduce((o, q) => ({ ...o, [`${q.entity_type}/${q.reason}`]: (o[`${q.entity_type}/${q.reason}`] || 0) + 1 }), {}) },
  standings_lane: st.results,
  table_api: { view: idx.data.view, rows_in_index: idx.data.rows.length, tiers: idx.data.tiers, verified_groups: idx.data.verified_groups, withheld_groups: idx.data.withheld_groups, overall_probe: overallProbe, groups: groupsOut, coverage: idx.meta.coverage },
  competition_api: { team_kind: compPage.data.current?.team_kind || null, teams: compPage.data.current?.teams?.length, finished: compPage.data.current?.finished, scheduled: compPage.data.current?.scheduled },
  team_page: teamPage ? { slug: teamPage.data.slug, type: teamPage.data.type, records: teamPage.data.records.map(r => ({ competition: r.competition?.slug, position: r.position, group: r.group?.key || null, teams_in_table: r.teams_in_table })) } : null,
  finished_match_proof: deepProof, scheduled_match_proof: schedProof,
  elapsed_s: Math.round((Date.now() - t0) / 1000),
};
mkdirSync('docs/evidence/espn', { recursive: true });
const file = `docs/evidence/espn/uefa-nations-canary-${report.generated_at.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
log('written', file);
console.log(JSON.stringify({ teams: report.teams, matches: report.matches, enrichment: report.enrichment, identity: report.identity, table: { verified: report.table_api.verified_groups, withheld: report.table_api.withheld_groups } }, null, 1));
