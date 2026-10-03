#!/usr/bin/env node
// Generic competition canary (World Coverage sprint): any registry competition (club or national, men or women) on
// REAL ESPN Core data in a LOCAL PGlite store running every migration. Nothing is written to production; the registry
// lane is enabled IN MEMORY only (data/registry/competitions.json is untouched).
//
// Production team identities are SEEDED read-only first (every active canonical team + its ESPN crosswalk + gender), so
// identity behaves exactly as it would in production: a club the Champions League already holds (same stable ESPN team
// id) is REUSED, never founded twice; a women's side is never mapped onto the men's club of the same name.
//
//   ingest       ESPN lane until the season's fixture graph + every finished match's detail is done (budgeted)
//   identity     team kind per competition contract, gender == competition gender, stable ESPN ids, no duplicate vs
//                production, no name-only merge, cross-gender namesakes stay distinct teams
//   table        league: overall table from canonical results; groups / league phase: every group verified
//   enrichment   lineups / team stats / plays / located events per finished match; gaps listed
//   match proof  deepest finished match: detail + cast (PBEcast replay payload); one scheduled match payload
//
//   node scripts/canary/competition.mjs --slug la-liga [--budget 2500] [--resume]
// Output: docs/evidence/world/canary-<slug>-<date>.json

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

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SLUG = arg('--slug', null);
if (!SLUG) throw new Error('--slug required');
const BUDGET = Number(arg('--budget', '2500'));
let budgetLeft = BUDGET;
mkdirSync('.proof', { recursive: true });
const snapshot = arg('--data', `.proof/canary-${SLUG}.tar.gz`); // PGlite cannot use a data dir on exFAT: in-memory + dump
const resume = argv.includes('--resume') && existsSync(snapshot);
const day = new Date().toISOString().slice(0, 10);
const out = arg('--out', `docs/evidence/world/canary-${SLUG}-${day}.json`);
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

const envFile = 'D:/Workers/secrets/soccer-supabase.env';
const prod = existsSync(envFile) ? (() => { const text = readFileSync(envFile, 'utf8').replace(/^\uFEFF/, ''); return storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]))); })() : null;
if (!prod) throw new Error('production env file missing: the identity gate needs read-only production crosswalks');

const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const comp = registry.competitions.find(c => c.slug === SLUG);
if (!comp?.espn) throw new Error(`${SLUG}: no ESPN registry entry`);
comp.espn.enabled = true; // in memory only
const GENDER = comp.gender || 'men';
const NATIONAL = comp.espn.team_type === 'national';

let store;
if (resume) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite({ loadDataDir: new Blob([readFileSync(snapshot)]) });
  await db.waitReady;
  store = pgliteStore(db);
} else {
  store = await openPglite(); await applyMigrations(store);
  const teams = await prod.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name', 'official_name', 'team_type', 'gender', 'country_code', 'city', 'status', 'founding_provider', 'founding_external_id'], eq: { status: 'active' } });
  const xw = await prod.select('soccer_team_external_ids', { columns: ['provider', 'external_id', 'team_id', 'method', 'evidence'], eq: { provider: 'espn' } });
  for (const p of chunkArr(teams, 200)) await store.insert('soccer_teams', p);
  const active = new Set(teams.map(t => t.id));
  for (const p of chunkArr(xw.filter(x => active.has(x.team_id)), 200)) await store.insert('soccer_team_external_ids', p.map(x => ({ ...x, capture_id: null })));
  log('seeded production identities', teams.length, 'teams', xw.length, 'espn team crosswalks');
}
const bounded = (p, ms = 30000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`production read timed out after ${ms} ms`)), ms))]);
let prodUnreachable = null;
async function prodSelect(table, opts) { if (prodUnreachable) return null; try { return await bounded(prod.select(table, opts)); } catch (e) { prodUnreachable = String(e.message || e); return null; } }
const saveSnapshot = async () => writeFileSync(snapshot, Buffer.from(await (await store.db.dumpDataDir('gzip')).arrayBuffer()));
const areas = JSON.parse(readFileSync('data/registry/areas.json', 'utf8'));
const storage = await fsStorage('.raw');
const lane = ESPN_LANES.find(l => l.competition === SLUG);
if (!lane) throw new Error(`${SLUG}: not in ESPN_COMPETITIONS (workers/soccer-ingest/src/espn-jobs.js)`);
const statePath = `${snapshot}.state.json`;
let state = resume && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : emptyLaneState(lane.name);
const preTeams = new Set((await store.select('soccer_team_external_ids', { columns: ['team_id', 'capture_id'], eq: { provider: 'espn' } })).filter(x => !x.capture_id).map(x => x.team_id));

// ---- ingest
const runs = []; let aborted = null;
for (let i = 0; i < 300 && budgetLeft >= 10; i++) {
  let o;
  try { o = await runEspnLane(lane, { store, storage, registry, areas, state, budget: Math.min(200, budgetLeft), force: i === 0 }); } catch (e) { aborted = { run: i + 1, error: String(e.message || e).slice(0, 400), name: e.name }; log('ABORT', aborted); break; }
  budgetLeft -= o.requests;
  state = { ...state, cursor: o.cursor };
  writeFileSync(statePath, JSON.stringify(state));
  if (i % 3 === 2) await saveSnapshot();
  const r = o.results[0];
  runs.push({ requests: o.requests, fixtures_new: r.fixtures_new, detailed: r.matches_detailed, team_identity: r.team_identity, fixtures: r.fixtures, exhausted: r.budget_exhausted_at || null });
  log(`run ${i + 1}`, `req ${o.requests}`, `fixtures+${r.fixtures_new}`, `detailed ${r.matches_detailed}`, `done ${Object.keys(o.cursor.done || {}).length}/${Object.keys(o.cursor.fixtures || {}).length}`, r.budget_exhausted_at || '');
  if (!r.budget_exhausted_at && r.fixtures_new === 0 && r.matches_detailed === 0) break;
}
const budgetOut = budgetLeft < 10;

// ---- standings (forced, this competition only) where the registry declares ESPN groups
let st = null;
if (!aborted && comp.espn.standings) {
  try { st = await runEspnStandings({ store, storage, registry: { ...registry, competitions: [comp] }, state: {}, force: true, budget: 80 }); log('standings', JSON.stringify(st.results)); } catch (e) { st = { error: String(e.message || e) }; }
}
await saveSnapshot();

// ---- report
const sel = (t, o) => store.select(t, o);
async function selectIn(t, col, vals, o = {}) { let res = []; for (const p of chunkArr([...new Set(vals)], 400)) res = res.concat(await sel(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return res; }
const [c] = await sel('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type', 'gender'], eq: { slug: SLUG } });
const report = { generated_at: new Date().toISOString(), mode: 'local-pglite (production untouched; production team identities seeded read-only)', competition: SLUG, gender: GENDER, team_kind: NATIONAL ? 'national' : 'club', source: 'ESPN Core (owner-approved collection lane)', budget: BUDGET, requests_used: BUDGET - budgetLeft, budget_exhausted: budgetOut, aborted, runs };
const cursor = state.cursor || {};
report.espn = { league: comp.espn.league, id: comp.espn.id, season_year: cursor.season_year, types: cursor.types, fixtures_seen: Object.keys(cursor.fixtures || {}).length, detailed: Object.keys(cursor.done || {}).length,
  by_type: Object.values(cursor.fixtures || {}).reduce((o, f) => { const k = cursor.types?.[f.stype]?.name || f.stype; return { ...o, [k]: (o[k] || 0) + 1 }; }, {}), excluded_teams: cursor.excluded_teams || null };
if (c) {
  report.competition_row = c;
  const seasons = await sel('soccer_seasons', { columns: ['id', 'label', 'publication_state'], eq: { competition_id: c.id } });
  const season = seasons.sort((a, b) => String(b.label).localeCompare(String(a.label)))[0];
  report.season = season ? { label: season.label, publication_state_after_lane: season.publication_state ?? null } : null;
  // A new season is HELD by the lane (migration 1400). The public API reads only published seasons, so the canary
  // promotes it LOCALLY (this PGlite only) to prove the product payloads; production promotion is accept-season --promote.
  if (season) { await store.db.query(`update soccer_seasons set publication_state = 'published', published_at = now(), publication_note = 'local canary promotion' where id = $1`, [season.id]); report.season.local_promotion = 'published in the local canary store only'; }
  const matches = await sel('soccer_matches', { columns: ['id', 'status', 'stage_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'home_pens', 'away_pens', 'duration', 'winner_team_id'], eq: { season_id: season.id } });
  const stages = (await sel('soccer_stages', { columns: ['id', 'name', 'stage_type', 'stage_order'], eq: { season_id: season.id } })).sort((a, b) => a.stage_order - b.stage_order);
  const ids = matches.map(m => m.id);
  const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teams = await selectIn('soccer_teams', 'id', teamIds, { columns: ['id', 'slug', 'name', 'team_type', 'gender', 'country_code', 'founding_provider'] });
  const teamX = await selectIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'external_id', 'method'], eq: { provider: 'espn' } });
  const seeded = await sel('soccer_team_external_ids', { columns: ['external_id', 'team_id', 'capture_id'], eq: { provider: 'espn' } });
  const prodX = seeded.filter(x => !x.capture_id && preTeams.has(x.team_id) && teamX.some(t => t.external_id === x.external_id));
  const byNameLower = teams.reduce((o, t) => ({ ...o, [t.name.toLowerCase()]: (o[t.name.toLowerCase()] || 0) + 1 }), {});
  const teamQueue = await sel('soccer_identity_queue', { columns: ['external_id', 'reason', 'payload'], eq: { entity_type: 'team', provider: 'espn', status: 'open' } });
  // namesakes of the other gender already in production: they must stay distinct canonical teams
  const allTeams = await sel('soccer_teams', { columns: ['id', 'name', 'gender'] });
  const fold = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\b(women|womens|w|fc|cf|ac|sc|afc|ladies|femenino|feminine|feminines)\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const namesakes = teams.map(t => ({ t, other: allTeams.filter(o => o.id !== t.id && (o.gender || 'men') !== t.gender && fold(o.name) === fold(t.name)) })).filter(x => x.other.length);
  const kindOk = t => (NATIONAL ? t.team_type === 'national' : t.team_type === 'club');
  report.identity_gate = {
    teams: teams.length, expected_teams: comp.expected_teams ?? null,
    wrong_team_kind: teams.filter(t => !kindOk(t)).map(t => t.name),
    wrong_gender: teams.filter(t => t.gender !== GENDER).map(t => `${t.name} (${t.gender})`),
    reused_existing_canonical: teams.filter(t => preTeams.has(t.id)).map(t => t.name), founded_new: teams.filter(t => !preTeams.has(t.id)).length,
    espn_ids_already_crosswalked_in_production: prodX.length, espn_id_maps_to_same_canonical_as_production: prodX.every(p => teamX.find(x => x.external_id === p.external_id)?.team_id === p.team_id),
    duplicate_espn_team_ids: teamX.length - new Set(teamX.map(x => x.external_id)).size, teams_with_more_than_one_espn_id: teamIds.filter(id => teamX.filter(x => x.team_id === id).length > 1).length,
    duplicate_names: Object.entries(byNameLower).filter(([, n]) => n > 1).map(([k]) => k), crosswalk_methods: teamX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}),
    cross_gender_namesakes_kept_distinct: namesakes.map(x => ({ team: x.t.name, gender: x.t.gender, distinct_from: x.other.map(o => `${o.name} (${o.gender})`) })),
    teams_queued: teamQueue.length, teams_queued_detail: teamQueue.map(q => ({ id: q.external_id, reason: q.reason, name: q.payload?.name || null })),
  };
  const ig = report.identity_gate;
  ig.pass = !ig.wrong_team_kind.length && !ig.wrong_gender.length && ig.duplicate_espn_team_ids === 0 && ig.teams_with_more_than_one_espn_id === 0 && !ig.duplicate_names.length && ig.espn_id_maps_to_same_canonical_as_production && ig.teams_queued === 0 && (!comp.expected_teams || ig.teams === comp.expected_teams);
  const byStatus = matches.reduce((o, m) => ({ ...o, [m.status]: (o[m.status] || 0) + 1 }), {});
  report.matches = { total: matches.length, by_status: byStatus, by_stage: stages.map(s => ({ name: s.name, type: s.stage_type, matches: matches.filter(m => m.stage_id === s.id).length, finished: matches.filter(m => m.stage_id === s.id && m.status === 'finished').length })),
    finished_without_score: matches.filter(m => m.status === 'finished' && (m.home_score === null || m.away_score === null)).length,
    knockout_without_winner: matches.filter(m => ['knockout', 'playoff'].includes(stages.find(s => s.id === m.stage_id)?.stage_type) && m.status === 'finished' && !m.winner_team_id).length };
  const ko = stages.filter(s => s.stage_type === 'knockout');
  if (ko.length) { const br = provenBracket(ko, matches); report.knockouts = { stages: ko.map(s => s.name), bracket_proven: br.proven, edges: br.edges.length, unproven: br.unproven.length }; }
  const enrich = await selectIn('soccer_match_enrichment', 'match_id', ids, { columns: ['match_id', 'component', 'status', 'detail'] });
  const finished = matches.filter(m => m.status === 'finished');
  const has = (m, k) => enrich.some(e => e.match_id === m.id && e.component === k && e.status === 'complete');
  const events = await selectIn('soccer_match_events', 'match_id', finished.map(m => m.id), { columns: ['match_id', 'x_m', 'source_coordinate_system'], eq: { source_family: 'espn' } });
  const stats = await selectIn('soccer_team_match_stats', 'match_id', finished.map(m => m.id), { columns: ['match_id', 'team_id'], eq: { basis: 'source' } });
  const lineups = await selectIn('soccer_lineups', 'match_id', ids, { columns: ['id', 'match_id', 'formation'] });
  const lps = await selectIn('soccer_lineup_players', 'lineup_id', lineups.map(l => l.id), { columns: ['player_id'] });
  const pq = await sel('soccer_identity_queue', { columns: ['external_id', 'reason'], eq: { entity_type: 'player', provider: 'espn', status: 'open' } });
  const px = await selectIn('soccer_player_external_ids', 'player_id', lps.map(x => x.player_id), { columns: ['external_id', 'method'], eq: { provider: 'espn' } });
  const known = []; for (const p of chunkArr(px.map(x => x.external_id), 150)) { const r = await prodSelect('soccer_player_external_ids', { columns: ['external_id', 'player_id'], eq: { provider: 'espn' }, in: { external_id: p } }); if (!r) break; known.push(...r); }
  report.enrichment = {
    finished: finished.length, detailed: finished.filter(m => enrich.some(e => e.match_id === m.id)).length,
    lineups_both: finished.filter(m => has(m, 'lineup_home') && has(m, 'lineup_away')).length, lineup_rows: lineups.length, formations: lineups.filter(l => l.formation).length,
    team_stats_both: finished.filter(m => has(m, 'stats_home') && has(m, 'stats_away')).length, team_stat_rows: stats.length,
    plays: finished.filter(m => has(m, 'plays')).length, events: events.length, located_events: events.filter(e => e.x_m !== null).length,
    coord_systems: events.reduce((o, e) => ({ ...o, [e.source_coordinate_system || 'none']: (o[e.source_coordinate_system || 'none'] || 0) + 1 }), {}),
    gaps: enrich.filter(e => e.status !== 'complete' && e.status !== 'not_applicable').map(e => ({ match_id: e.match_id, component: e.component, status: e.status })),
  };
  report.players = { in_lineups: new Set(lps.map(x => x.player_id)).size, founded_locally: px.filter(x => x.method === 'founding').length, corroborated: px.filter(x => x.method === 'attribute_corroborated').length,
    queued: pq.length, queued_by_reason: pq.reduce((o, q) => ({ ...o, [q.reason]: (o[q.reason] || 0) + 1 }), {}),
    already_canonical_in_production_by_espn_id: prodUnreachable ? null : known.length, production_lookup: prodUnreachable ? `unavailable: ${prodUnreachable}` : 'ok' };
  // table
  let table = null;
  try {
    const idx = await R.table(store, { competition: SLUG });
    const d = idx.data;
    if (d.groups?.length) {
      const per = [];
      for (const g of d.groups) { const t = await R.table(store, { competition: SLUG, group: g.key }); per.push({ key: g.key, name: g.name, verified: t.data.verification?.verified ?? null, rows: t.data.rows?.length ?? 0, mismatches: (t.data.verification?.mismatches || []).slice(0, 4) }); }
      table = { view: d.view, verified_groups: d.verified_groups, withheld_groups: d.withheld_groups, groups: per };
    } else table = { view: d.view, rows: d.rows?.length ?? 0, top: (d.rows || []).slice(0, 3).map(r => ({ team: r.team?.name, pld: r.played ?? r.p, pts: r.points ?? r.pts })) };
  } catch (e) { table = { error: String(e.message || e) }; }
  report.table = table;
  const deep = finished.map(m => ({ m, n: events.filter(e => e.match_id === m.id).length })).sort((a, b) => b.n - a.n)[0]?.m;
  if (deep) {
    try { const md = await R.match(store, deep.id); const cast = await C.cast(store, deep.id, {}); const d = md.data;
      report.finished_match_proof = { match_id: deep.id, fixture: `${d.home?.name} ${d.score?.home}-${d.score?.away} ${d.away?.name}`, kickoff: d.kickoff_at, venue: d.venue?.name || null, lineups: d.lineups ? Object.keys(d.lineups) : null, timeline: d.timeline?.length ?? null, shots: d.shots?.length ?? null, events: events.filter(e => e.match_id === deep.id).length, coverage: md.meta?.coverage, cast: { mode: cast.data.live?.mode ?? null, sequence: cast.data.sequence?.length ?? null } };
    } catch (e) { report.finished_match_proof = { match_id: deep.id, error: String(e.message || e) }; }
  }
  const next = matches.filter(m => m.status === 'scheduled').sort((a, b) => String(a.kickoff_at).localeCompare(String(b.kickoff_at)))[0];
  if (next) { try { const md = await R.match(store, next.id); const cast = await C.cast(store, next.id, {}); report.scheduled_match_proof = { match_id: next.id, fixture: `${md.data.home?.name} v ${md.data.away?.name}`, kickoff: next.kickoff_at, cast_mode: cast.data.live?.mode ?? null }; } catch (e) { report.scheduled_match_proof = { match_id: next.id, error: String(e.message || e) }; } }
  try { const cp = await R.competition(store, SLUG); report.competition_api = { team_kind: cp.data.current?.team_kind || null, teams: cp.data.current?.teams?.length, finished: cp.data.current?.finished, scheduled: cp.data.current?.scheduled }; } catch (e) { report.competition_api = { error: String(e.message || e) }; }
}
const e = report.enrichment || {}; const m = report.matches || {}; const t = report.table || {};
report.gate = {
  lane_completed_without_abort: !aborted && !budgetOut,
  fixtures_complete: report.espn.fixtures_seen > 0 && report.espn.fixtures_seen === (m.total || 0) + Object.keys(report.espn.excluded_teams || {}).length * 0,
  every_finished_match_scored: (m.finished_without_score ?? 1) === 0,
  every_finished_match_detailed: (e.finished ?? 0) === (e.detailed ?? -1),
  no_enrichment_gaps: (e.gaps?.length ?? 1) === 0,
  identity: !!report.identity_gate?.pass,
  table: !t.error && (t.groups ? t.withheld_groups === 0 && t.verified_groups > 0 : (t.rows || 0) > 0),
  knockout_winners_known: (m.knockout_without_winner ?? 1) === 0,
};
report.gate.pass = Object.values(report.gate).every(Boolean);
report.elapsed_s = Math.round((Date.now() - t0) / 1000);
mkdirSync('docs/evidence/world', { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
log('written', out, 'gate', JSON.stringify(report.gate));
