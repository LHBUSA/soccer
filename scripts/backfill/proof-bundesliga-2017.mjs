#!/usr/bin/env node
// End-to-end proof for the first competition: Bundesliga 2017/18.
//
//   raw archive (.raw, R2 layout)  ->  parsers  ->  identity  ->  canonical graph
//   (PGlite running the repo's real migrations)  ->  second run (idempotency)
//   ->  cross-source check vs OpenLigaDB  ->  reconciliation report
//
// Writes docs/evidence/proof/bundesliga-2017-18.json (committed) and leaves a
// database snapshot in .proof/ (ignored) for the match page / news steps.
//
// Usage: node scripts/backfill/proof-bundesliga-2017.mjs [--skip-openligadb]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { fsStorage } from '../../workers/shared/archive.js';
import * as wy from '../../workers/providers/wyscout-figshare.js';
import { syncRows } from '../../workers/soccer-ingest/src/store.js';
import { applyMigrations, openPglite } from '../../workers/soccer-ingest/src/store-pglite.js';
import { ingestWyscoutSeason } from '../../workers/soccer-ingest/src/wyscout-lane.js';
import { ingestOpenLigaSeason } from '../../workers/soccer-ingest/src/openligadb-lane.js';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const skipOld = process.argv.includes('--skip-openligadb');

const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const manifest = JSON.parse(readFileSync('docs/evidence/captures/wyscout_figshare.json', 'utf8')).records;
const storage = await fsStorage('.raw');
const cap = key => {
  const r = manifest.find(x => x.source_key === `wyscout_figshare.${key}`);
  if (!r) throw new Error(`no capture for ${key}; run scripts/backfill/fetch-wyscout.mjs`);
  return r;
};
const raw = async key => {
  const b = await storage.get(cap(key).raw_key);
  if (!b) throw new Error(`raw payload missing for ${key} (${cap(key).raw_key})`);
  return b;
};
const json = async key => JSON.parse(strFromU8(await raw(key)));

log('opening PGlite + applying migrations');
const store = await openPglite();
const migrations = await applyMigrations(store);
log('migrations:', migrations.join(', '));

// Capture records first: every canonical row references one.
await syncRows(store, {
  table: 'soccer_source_captures', key: ['capture_id'],
  rows: manifest.map(r => ({ capture_id: r.capture_id, source_key: r.source_key, family: r.family, request_method: r.request_method, request_url: r.request_url, captured_at: r.captured_at, http_status: r.http_status, content_type: r.content_type, content_sha256: r.content_sha256, bytes: r.bytes, raw_key: r.raw_key, parser_version: r.parser_version, notes: r.notes })),
});

log('parsing wyscout');
const matchesZip = unzipSync(await raw('matches'), { filter: f => f.name === 'matches_Germany.json' });
const eventsZip = unzipSync(await raw('events'), { filter: f => f.name === 'events_Germany.json' });
const parsedEvents = wy.parseEvents(JSON.parse(strFromU8(eventsZip['events_Germany.json'])));
const parsed = {
  teams: wy.parseTeams(await json('teams')),
  players: wy.parsePlayers(await json('players')),
  coaches: wy.parseCoaches(await json('coaches')),
  matches: wy.parseMatches(JSON.parse(strFromU8(matchesZip['matches_Germany.json']))),
  events: parsedEvents.events,
  unmapped: parsedEvents.unmapped,
};
log(`parsed: ${parsed.matches.length} matches, ${parsed.events.length} events, unmapped types: ${JSON.stringify(parsed.unmapped)}`);

const captures = {
  competitions: cap('competitions').capture_id, teams: cap('teams').capture_id, players: cap('players').capture_id,
  coaches: cap('coaches').capture_id, matches: cap('matches').capture_id, matches_at: cap('matches').captured_at,
  events: cap('events').capture_id, events_at: cap('events').captured_at,
};

log('ingest run 1');
const run1 = await ingestWyscoutSeason(store, { registry, competitionExternalId: 426, parsed, captures, log });
log('run 1 counts', JSON.stringify(run1.counts));
log('ingest run 2 (idempotency)');
const run2 = await ingestWyscoutSeason(store, { registry, competitionExternalId: 426, parsed, captures, log });
const nonIdempotent = [];
const walk = (o, path = '') => {
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object' && !('inserted' in v)) walk(v, `${path}${k}.`);
    else if (v && (v.inserted || v.updated)) nonIdempotent.push(`${path}${k}: +${v.inserted} ~${v.updated}`);
  }
};
walk(run2.counts);
log('run 2 non-idempotent writes:', nonIdempotent.length ? nonIdempotent : 'none');

// ---- reconciliation: event ledger vs recorded score, per match
const { rows: recon } = await store.query(`
  with g as (
    select e.match_id,
           count(*) filter (where e.is_goal and e.team_id = m.home_team_id) + count(*) filter (where e.is_own_goal and e.team_id = m.away_team_id) as home_ev,
           count(*) filter (where e.is_goal and e.team_id = m.away_team_id) + count(*) filter (where e.is_own_goal and e.team_id = m.home_team_id) as away_ev
      from public.soccer_match_events e join public.soccer_matches m on m.id = e.match_id group by e.match_id)
  select m.id, m.home_score, m.away_score, g.home_ev::int, g.away_ev::int, ht.name as home, at.name as away, m.kickoff_at
    from public.soccer_matches m join g on g.match_id = m.id
    join public.soccer_teams ht on ht.id = m.home_team_id join public.soccer_teams at on at.id = m.away_team_id`);
const mismatches = recon.filter(r => r.home_score !== r.home_ev || r.away_score !== r.away_ev)
  .map(r => ({ match: `${r.home} v ${r.away}`, kickoff: r.kickoff_at, recorded: `${r.home_score}-${r.away_score}`, from_events: `${r.home_ev}-${r.away_ev}` }));
log(`score reconciliation: ${recon.length - mismatches.length}/${recon.length} matches agree`);

const one = async sql => (await store.query(sql)).rows[0];
const integrity = {
  events_out_of_pitch: (await one(`select count(*)::int n from public.soccer_match_events where x_m is null and source_x is not null`)).n,
  events_without_coords: (await one(`select count(*)::int n from public.soccer_match_events where source_x is null`)).n,
  duplicate_sequences: (await one(`select count(*)::int n from (select match_id, sequence from public.soccer_match_events group by 1,2 having count(*) > 1) x`)).n,
  events_player_null: (await one(`select count(*)::int n from public.soccer_match_events where player_id is null`)).n,
  identity_queue_open: (await one(`select count(*)::int n from public.soccer_identity_queue where status = 'open'`)).n,
  source_changes_logged: (await one(`select count(*)::int n from public.soccer_source_changes`)).n,
};
log('integrity', JSON.stringify(integrity));

// ---- cross-source: OpenLigaDB bl1 2017 (independent, ODbL)
let openliga = null;
if (!skipOld) {
  log('openligadb bl1/2017 cross-source');
  openliga = await ingestOpenLigaSeason(store, { registry, league: 'bl1', season: 2017, storage, log, mode: 'prove_against_existing' });
  log('openligadb', JSON.stringify(openliga.summary));
}

// ---- live lane on the same graph: current season 2026/27
let current = null;
if (!skipOld) {
  log('openligadb bl1/2026 current season');
  current = await ingestOpenLigaSeason(store, { registry, league: 'bl1', season: 2026, storage, log });
  const again = await ingestOpenLigaSeason(store, { registry, league: 'bl1', season: 2026, storage, log });
  current.rerun_writes = ['matches_written', 'team_crosswalk', 'match_crosswalk', 'goal_events'].map(k => [k, again.summary[k]]).filter(([, v]) => v && (v.inserted || v.updated));
  const { rows } = await store.query(`select t.name, x.method from public.soccer_team_external_ids x join public.soccer_teams t on t.id = x.team_id
     where x.provider = 'openligadb' and x.team_id in (select home_team_id from public.soccer_matches m join public.soccer_seasons s on s.id = m.season_id where s.label = '2026/27') order by 2, 1`);
  current.team_identity = rows;
  log('current', JSON.stringify(current.summary));
}

const counts = {};
for (const t of ['soccer_competitions', 'soccer_seasons', 'soccer_teams', 'soccer_players', 'soccer_managers', 'soccer_venues', 'soccer_matches', 'soccer_lineups', 'soccer_lineup_players', 'soccer_substitutions', 'soccer_match_events', 'soccer_team_match_stats', 'soccer_player_match_stats', 'soccer_team_external_ids', 'soccer_player_external_ids', 'soccer_match_external_ids', 'soccer_match_source_results', 'soccer_source_captures', 'soccer_identity_queue', 'soccer_source_changes']) {
  counts[t] = (await one(`select count(*)::int n from public.${t}`)).n;
}

mkdirSync('docs/evidence/proof', { recursive: true });
const report = {
  proof: 'bundesliga-2017-18', generated_at: new Date().toISOString(), engine: 'PGlite (Postgres 17, WASM) running supabase/migrations/*',
  migrations, attribution: wy.ATTRIBUTION, captures: manifest.map(r => ({ source_key: r.source_key, capture_id: r.capture_id, sha256: r.content_sha256, bytes: r.bytes })),
  run1: run1.counts, run2_non_idempotent_writes: nonIdempotent, unmapped_event_types: parsed.unmapped,
  season: run1.season, queued: run1.queued, lineup_refs_unresolved: run1.lineup_refs_unresolved, event_players_unresolved: run1.event_players_unresolved,
  score_reconciliation: { matches: recon.length, agree: recon.length - mismatches.length, mismatches },
  integrity, openligadb: openliga, current_season: current, row_counts: counts, elapsed_s: Math.round((Date.now() - t0) / 1000),
};
writeFileSync('docs/evidence/proof/bundesliga-2017-18.json', JSON.stringify(report, null, 2) + '\n');
log('report written');

mkdirSync('.proof', { recursive: true });
const dump = await store.db.dumpDataDir('gzip');
writeFileSync(join('.proof', 'bundesliga-2017-18.pgdata.tar.gz'), Buffer.from(await dump.arrayBuffer()));
log('snapshot .proof/bundesliga-2017-18.pgdata.tar.gz');
await store.close();
