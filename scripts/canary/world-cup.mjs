#!/usr/bin/env node
// FIFA World Cup (ESPN fifa.world) LOCAL canary v2, on REAL ESPN Core data in a LOCAL PGlite store running
// every migration. Nothing is written to production. The registry lane is enabled IN MEMORY only;
// data/registry/competitions.json is untouched by this script.
//
// Production identities are SEEDED read-only into the local store first (every active canonical team + its
// ESPN crosswalk), so national-team reconciliation behaves exactly as it would in production: a nation the
// Nations League already founded (same stable ESPN team id) is REUSED, never founded twice.
//
//   ingest       ESPN lane until the fixture graph + every finished match's detail is done
//   identity     all teams national, stable ESPN ids, no duplicate nation vs production, no name-only merge
//   stages       group stage + one canonical stage per ESPN knockout type, bracket edges proven or withheld
//   groups       standings lane (forced) + every group verified against canonical results AND fixtures
//   match proof  deepest finished match: detail + cast (PBEcast replay payload)
//
//   node scripts/canary/world-cup.mjs [--budget 4500] [--data .proof/wc-pglite.tar.gz] [--resume]
// Output: docs/evidence/v4/espn-world-cup-canary-v2.json

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fsStorage } from '../../workers/shared/archive.js';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { provenBracket } from '../../workers/shared/bracket.js';
import { applyMigrations, openPglite, pgliteStore } from '../../workers/soccer-ingest/src/store-pglite.js';
import { ESPN_LANES, runEspnLane } from '../../workers/soccer-ingest/src/espn-jobs.js';
import { runEspnStandings } from '../../workers/soccer-ingest/src/espn-standings.js';
import { emptyLaneState } from '../../workers/soccer-ingest/src/state.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import * as R from '../../workers/soccer-api/src/routes.js';
import * as C from '../../workers/soccer-api/src/cast.js';

const SLUG = 'fifa-world-cup';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const BUDGET = Number(arg('--budget', '4500'));
let budgetLeft = BUDGET;
const snapshot = arg('--data', '.proof/wc-pglite.tar.gz');
const resume = argv.includes('--resume') && existsSync(snapshot);
const out = arg('--out', 'docs/evidence/v4/espn-world-cup-canary-v2.json');
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const envFile = 'D:/Workers/secrets/soccer-supabase.env';
const prod = existsSync(envFile) ? (() => { const text = readFileSync(envFile, 'utf8').replace(/^\uFEFF/, ''); return storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))); })() : null;
if (!prod) throw new Error('production env file missing: the identity gate needs read-only production crosswalks');

let store;
if (resume) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite({ loadDataDir: new Blob([readFileSync(snapshot)]) });
  await db.waitReady;
  store = pgliteStore(db);
} else {
  store = await openPglite(); await applyMigrations(store);
  // ---- seed production team identities (read-only GETs), or -- when production is unreachable -- the identical
  // production identities an earlier run of this script seeded (its crosswalk rows with capture_id null).
  const seedSnap = arg('--seed-snapshot', null);
  let teams; let xw;
  if (seedSnap) {
    const { PGlite } = await import('@electric-sql/pglite');
    const old = new PGlite({ loadDataDir: new Blob([readFileSync(seedSnap)]) }); await old.waitReady;
    xw = (await old.query("select provider, external_id, team_id, method, evidence from soccer_team_external_ids where provider = 'espn' and capture_id is null")).rows;
    teams = (await old.query("select id, slug, name, short_name, official_name, team_type, gender, country_code, city, status, founding_provider, founding_external_id from soccer_teams where status = 'active' and (founding_provider <> 'espn' or id in (select team_id from soccer_team_external_ids where provider = 'espn' and capture_id is null) or id not in (select team_id from soccer_team_external_ids where provider = 'espn'))")).rows;
    await old.close();
    log('seed source', seedSnap, '(production identities read at that run start)');
  } else {
    teams = (await prod.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name', 'official_name', 'team_type', 'gender', 'country_code', 'city', 'status', 'founding_provider', 'founding_external_id'], eq: { status: 'active' } }));
    xw = await prod.select('soccer_team_external_ids', { columns: ['provider', 'external_id', 'team_id', 'method', 'evidence'], eq: { provider: 'espn' } });
  }
  for (const p of chunkArr(teams, 200)) await store.insert('soccer_teams', p);
  const active = new Set(teams.map(t => t.id));
  for (const p of chunkArr(xw.filter(x => active.has(x.team_id)), 200)) await store.insert('soccer_team_external_ids', p.map(x => ({ ...x, capture_id: null })));
  log('seeded production identities', teams.length, 'teams', xw.length, 'espn team crosswalks');
}
// Production reads during the REPORT are bounded: an unreachable production database is recorded, never waited on.
const bounded = (p, ms = 30000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`production read timed out after ${ms} ms`)), ms))]);
let prodUnreachable = null;
async function prodSelect(table, opts) { if (prodUnreachable) return null; try { return await bounded(prod.select(table, opts)); } catch (e) { prodUnreachable = String(e.message || e); return null; } }
const saveSnapshot = async () => writeFileSync(snapshot, Buffer.from(await (await store.db.dumpDataDir('gzip')).arrayBuffer()));
const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const comp = registry.competitions.find(c => c.slug === SLUG);
comp.espn.enabled = true; // in memory only
const areas = JSON.parse(readFileSync('data/registry/areas.json', 'utf8'));
const storage = await fsStorage('.raw');
const lane = ESPN_LANES.find(l => l.competition === SLUG);
const statePath = `${snapshot}.state.json`;
let state = resume && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : emptyLaneState(lane.name);
// Production identities = ESPN team crosswalks SEEDED at the start (capture_id null); a lane founding carries its capture.
const preTeams = new Set((await store.select('soccer_team_external_ids', { columns: ['team_id', 'capture_id'], eq: { provider: 'espn' } })).filter(x => !x.capture_id).map(x => x.team_id));

// ---- ingest
const runs = []; let aborted = null;
for (let i = 0; i < 200 && budgetLeft >= 10; i++) {
  let o;
  try { o = await runEspnLane(lane, { store, storage, registry, areas, state, budget: Math.min(200, budgetLeft), force: i === 0 }); } catch (e) { aborted = { run: i + 1, error: String(e.message || e).slice(0, 400), name: e.name }; log('ABORT', aborted); break; }
  budgetLeft -= o.requests;
  state = { ...state, cursor: o.cursor };
  writeFileSync(statePath, JSON.stringify(state));
  if (i % 3 === 2) await saveSnapshot();
  const r = o.results[0];
  runs.push({ requests: o.requests, fixtures_new: r.fixtures_new, detailed: r.matches_detailed, team_identity: r.team_identity, fixtures: r.fixtures, exhausted: r.budget_exhausted_at || null });
  log(`run ${i + 1}`, `req ${o.requests}`, `fixtures+${r.fixtures_new}`, `detailed ${r.matches_detailed}`, `done ${Object.keys(o.cursor.done).length}/${Object.keys(o.cursor.fixtures).length}`, r.budget_exhausted_at || '');
  if (!r.budget_exhausted_at && r.fixtures_new === 0 && r.matches_detailed === 0) break;
}

// ---- groups (standings lane, forced, this competition only)
let st = null;
if (!aborted) {
  try { st = await runEspnStandings({ store, storage, registry: { ...registry, competitions: [comp] }, state: {}, force: true, budget: 80 }); log('standings', JSON.stringify(st.results)); } catch (e) { st = { error: String(e.message || e) }; }
}
await saveSnapshot();

// ---- reports
const sel = (t, o) => store.select(t, o);
async function selectIn(t, col, vals, o = {}) { let res = []; for (const p of chunkArr([...new Set(vals)], 400)) res = res.concat(await sel(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return res; }
const [c] = await sel('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type'], eq: { slug: SLUG } });
const report = { generated_at: new Date().toISOString(), mode: 'local-pglite (production untouched; production team identities seeded read-only)', competition: SLUG, source: 'ESPN Core (owner-approved secondary source); no FIFA endpoint used', budget: BUDGET, requests_used: BUDGET - budgetLeft, aborted, runs };
const cursor = state.cursor || {};
report.espn = { league: comp.espn.league, id: comp.espn.id, season_year: cursor.season_year, types: cursor.types, fixtures_seen: Object.keys(cursor.fixtures || {}).length, detailed: Object.keys(cursor.done || {}).length,
  by_type: Object.values(cursor.fixtures || {}).reduce((o, f) => { const k = cursor.types?.[f.stype]?.name || f.stype; return { ...o, [k]: (o[k] || 0) + 1 }; }, {}) };
if (c) {
  const [season] = await sel('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } });
  const matches = await sel('soccer_matches', { columns: ['id', 'status', 'stage_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'home_pens', 'away_pens', 'duration', 'winner_team_id'], eq: { season_id: season.id } });
  const stages = (await sel('soccer_stages', { columns: ['id', 'name', 'stage_type', 'stage_order'], eq: { season_id: season.id } })).sort((a, b) => a.stage_order - b.stage_order);
  const ids = matches.map(m => m.id);
  const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teams = await selectIn('soccer_teams', 'id', teamIds, { columns: ['id', 'slug', 'name', 'team_type', 'country_code', 'founding_provider'] });
  const teamX = await selectIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'external_id', 'method'], eq: { provider: 'espn' } });
  // Production team crosswalks: the identities SEEDED from production at the start of this run (pre-ingest state).
  const seeded = await sel('soccer_team_external_ids', { columns: ['external_id', 'team_id'], eq: { provider: 'espn' } });
  const prodX = seeded.filter(x => preTeams.has(x.team_id) && teamX.some(t => t.external_id === x.external_id));
  const byNameLower = teams.reduce((o, t) => ({ ...o, [t.name.toLowerCase()]: (o[t.name.toLowerCase()] || 0) + 1 }), {});
  const teamQueue = await sel('soccer_identity_queue', { columns: ['external_id', 'reason'], eq: { entity_type: 'team', provider: 'espn', status: 'open' } });
  report.identity_gate = {
    teams: teams.length, national: teams.filter(t => t.team_type === 'national').length, club: teams.filter(t => t.team_type !== 'national').map(t => t.name),
    reused_existing_canonical_nation: teams.filter(t => preTeams.has(t.id)).length, founded_new_nation: teams.filter(t => !preTeams.has(t.id)).length,
    espn_ids_already_crosswalked_in_production: prodX.length, production_identity_basis: 'production teams + ESPN crosswalks seeded read-only at the start of this run', espn_id_maps_to_same_canonical_as_production: prodX.every(p => teamX.find(x => x.external_id === p.external_id)?.team_id === p.team_id),
    duplicate_espn_team_ids: teamX.length - new Set(teamX.map(x => x.external_id)).size, teams_with_more_than_one_espn_id: teamIds.filter(id => teamX.filter(x => x.team_id === id).length > 1).length,
    duplicate_names: Object.entries(byNameLower).filter(([, n]) => n > 1).map(([k]) => k), crosswalk_methods: teamX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}),
    teams_queued: teamQueue.length, teams_queued_by_reason: teamQueue.reduce((o, q) => ({ ...o, [q.reason]: (o[q.reason] || 0) + 1 }), {}),
    flags_or_country_codes_assigned: teams.filter(t => t.country_code).length,
  };
  report.identity_gate.pass = report.identity_gate.club.length === 0 && report.identity_gate.duplicate_espn_team_ids === 0 && report.identity_gate.teams_with_more_than_one_espn_id === 0 && report.identity_gate.duplicate_names.length === 0 && report.identity_gate.espn_id_maps_to_same_canonical_as_production && report.identity_gate.teams_queued === 0;
  const byStatus = matches.reduce((o, m) => ({ ...o, [m.status]: (o[m.status] || 0) + 1 }), {});
  report.matches = { total: matches.length, by_status: byStatus, by_stage: stages.map(s => ({ name: s.name, type: s.stage_type, order: s.stage_order, matches: matches.filter(m => m.stage_id === s.id).length, finished: matches.filter(m => m.stage_id === s.id && m.status === 'finished').length })),
    finished_without_score: matches.filter(m => m.status === 'finished' && (m.home_score === null || m.away_score === null)).length,
    by_duration: matches.reduce((o, m) => ({ ...o, [m.duration || 'null']: (o[m.duration || 'null'] || 0) + 1 }), {}),
    knockout_without_winner: matches.filter(m => stages.find(s => s.id === m.stage_id)?.stage_type === 'knockout' && m.status === 'finished' && !m.winner_team_id).length,
    shootouts: matches.filter(m => m.duration === 'penalties').map(m => ({ id: m.id, score: `${m.home_score}-${m.away_score}`, pens: `${m.home_pens}-${m.away_pens}`, winner_set: !!m.winner_team_id })) };
  const ko = stages.filter(s => s.stage_type === 'knockout');
  const br = provenBracket(ko, matches);
  report.knockouts = { stages: ko.map(s => s.name), bracket_proven: br.proven, edges: br.edges.length, later_stage_matches: br.later_matches, unproven: br.unproven.length, contradictory_feeders: br.contradictory_feeders.length };
  const enrich = await selectIn('soccer_match_enrichment', 'match_id', ids, { columns: ['match_id', 'component', 'status', 'detail'] });
  const finished = matches.filter(m => m.status === 'finished');
  const has = (m, k) => enrich.some(e => e.match_id === m.id && e.component === k && e.status === 'complete');
  const events = await selectIn('soccer_match_events', 'match_id', finished.map(m => m.id), { columns: ['match_id', 'x_m'], eq: { source_family: 'espn' } });
  const stats = await selectIn('soccer_team_match_stats', 'match_id', finished.map(m => m.id), { columns: ['match_id', 'team_id'], eq: { basis: 'source' } });
  const lineups = await selectIn('soccer_lineups', 'match_id', ids, { columns: ['id', 'match_id'] });
  const lps = await selectIn('soccer_lineup_players', 'lineup_id', lineups.map(l => l.id), { columns: ['player_id'] });
  const pq = await sel('soccer_identity_queue', { columns: ['external_id', 'reason'], eq: { entity_type: 'player', provider: 'espn', status: 'open' } });
  const px = await selectIn('soccer_player_external_ids', 'player_id', lps.map(x => x.player_id), { columns: ['external_id', 'method'], eq: { provider: 'espn' } });
  const known = []; for (const p of chunkArr(px.map(x => x.external_id), 150)) { const r = await prodSelect('soccer_player_external_ids', { columns: ['external_id', 'player_id'], eq: { provider: 'espn' }, in: { external_id: p } }); if (!r) break; known.push(...r); }
  const unresolvedInLineups = enrich.filter(e => e.component.startsWith('lineup') && e.status === 'complete').reduce((n, e) => n + (e.detail?.players_unresolved || 0), 0);
  report.enrichment = {
    finished: finished.length, detailed: finished.filter(m => enrich.some(e => e.match_id === m.id)).length,
    lineups_both: finished.filter(m => has(m, 'lineup_home') && has(m, 'lineup_away')).length, lineups_rows: lineups.length,
    team_stats_both: finished.filter(m => has(m, 'stats_home') && has(m, 'stats_away')).length, team_stat_rows: stats.length,
    plays: finished.filter(m => has(m, 'plays')).length, events: events.length, located_events: events.filter(e => e.x_m !== null).length,
    gaps: enrich.filter(e => e.status !== 'complete' && e.status !== 'not_applicable').map(e => ({ match_id: e.match_id, component: e.component, status: e.status })),
  };
  report.players = {
    in_lineups: new Set(lps.map(x => x.player_id)).size, founded_locally: px.filter(x => x.method === 'founding').length, corroborated: px.filter(x => x.method === 'attribute_corroborated').length,
    queued: pq.length, queued_by_reason: pq.reduce((o, q) => ({ ...o, [q.reason]: (o[q.reason] || 0) + 1 }), {}), unresolved_lineup_slots: unresolvedInLineups,
    already_canonical_in_production_by_espn_id: prodUnreachable ? null : known.length, production_lookup: prodUnreachable ? `unavailable: ${prodUnreachable}` : 'ok',
    note: 'Players seen here that production already holds by the same ESPN athlete id are reused there (same canonical player as their club Player DNA); a local founding row is a production reuse.',
  };
  // groups: verified tables + fixture membership reconciliation
  const groups = await sel('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'group_type'], eq: { season_id: season.id } });
  const members = await selectIn('soccer_season_group_members', 'group_id', groups.map(g => g.id), { columns: ['group_id', 'team_id'] });
  const groupOf = new Map(members.map(m => [m.team_id, m.group_id]));
  const gs = stages.find(s => s.stage_type === 'league');
  const gsMatches = matches.filter(m => m.stage_id === gs?.id);
  const cross = gsMatches.filter(m => !groupOf.has(m.home_team_id) || groupOf.get(m.home_team_id) !== groupOf.get(m.away_team_id));
  let table = null;
  try {
    const idx = await R.table(store, { competition: SLUG });
    const per = [];
    for (const g of idx.data.groups) {
      const t = await R.table(store, { competition: SLUG, group: g.key });
      const gm = gsMatches.filter(m => groupOf.get(m.home_team_id) === groups.find(x => x.group_key === g.key)?.id);
      per.push({ key: g.key, name: g.name, teams: g.teams, verified: t.data.verification.verified, rows: t.data.rows.length, group_stage_matches: gm.length, mismatches: t.data.verification.mismatches.slice(0, 4) });
    }
    let overall = null; try { const o = await R.table(store, { competition: SLUG, group: 'overall' }); overall = { view: o.data.view, rows: o.data.rows.length }; } catch (e) { overall = { refused: e.message }; }
    table = { view: idx.data.view, verified_groups: idx.data.verified_groups, withheld_groups: idx.data.withheld_groups, overall_probe: overall, groups: per };
  } catch (e) { table = { error: String(e.message || e) }; }
  report.groups = { standings_lane: st?.results || st, groups: groups.length, members: members.length, standings_rows: (await selectIn('soccer_source_standings', 'group_id', groups.map(g => g.id), { columns: ['team_id'] })).length,
    group_stage_matches: gsMatches.length, group_stage_matches_across_groups_or_unassigned: cross.length, table };
  // match proofs
  const deep = finished.map(m => ({ m, n: events.filter(e => e.match_id === m.id).length })).sort((a, b) => b.n - a.n)[0]?.m;
  if (deep) {
    const md = await R.match(store, deep.id); const cast = await C.cast(store, deep.id, {}); const d = md.data;
    report.finished_match_proof = { match_id: deep.id, fixture: `${d.home?.name} ${d.score?.home}-${d.score?.away} ${d.away?.name}`, kickoff: d.kickoff_at, venue: d.venue?.name || null, lineups: d.lineups ? Object.keys(d.lineups) : null, timeline: d.timeline?.length ?? null, shots: d.shots?.length ?? null, events: events.filter(e => e.match_id === deep.id).length, coverage: md.meta.coverage, cast: { mode: cast.data.live?.mode ?? null, sequence: cast.data.sequence?.length ?? null } };
  }
  const final = matches.find(m => stages.find(s => s.id === m.stage_id)?.name === 'Final');
  if (final) { const md = await R.match(store, final.id); report.final_proof = { match_id: final.id, fixture: `${md.data.home?.name} ${md.data.score?.home}-${md.data.score?.away} ${md.data.away?.name}`, duration: final.duration, pens: final.home_pens !== null ? `${final.home_pens}-${final.away_pens}` : null, winner_set: !!final.winner_team_id }; }
  const cp = await R.competition(store, SLUG);
  report.competition_api = { team_kind: cp.data.current?.team_kind || null, teams: cp.data.current?.teams?.length, finished: cp.data.current?.finished, scheduled: cp.data.current?.scheduled };
}
const g = report.groups || {}; const e = report.enrichment || {}; const m = report.matches || {};
report.gate = {
  lane_completed_without_abort: !aborted,
  fixtures_complete: report.espn.fixtures_seen > 0 && report.espn.fixtures_seen === (m.total || 0),
  every_finished_match_scored: (m.finished_without_score ?? 1) === 0,
  identity: !!report.identity_gate?.pass,
  groups_all_verified: !!g.table && g.table.withheld_groups === 0 && g.table.verified_groups > 0,
  group_fixtures_reconcile: g.group_stage_matches_across_groups_or_unassigned === 0,
  knockout_winners_known: (m.knockout_without_winner ?? 1) === 0,
};
report.gate.pass = Object.values(report.gate).every(Boolean);
report.elapsed_s = Math.round((Date.now() - t0) / 1000);
mkdirSync('docs/evidence/v4', { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
log('written', out, 'gate', JSON.stringify(report.gate));
