#!/usr/bin/env node
// PRODUCTION backfill + certification of the Bundesliga graph on the SPORTS project.
// Same lane code as the local proof, through the PostgREST store.
//
// Order (owner brief 2026-09-27):
//   1. capture records for everything we ingest
//   2. Wyscout Bundesliga 2017/18 (event-rich season; founding lane)
//   3. OpenLigaDB 2017 (fixture-graph proof vs Wyscout; scorer event alignment)
//   4. OpenLigaDB results/goals 2004/05 -> current (from the archived captures in .raw)
//   5. second full pass: must write 0 rows (idempotency)
//   6. certification report -> docs/evidence/proof/production-certification-<date>.json
//
// Env file: D:\Workers\secrets\soccer-supabase.env with SOCCER_MODEL_SUPABASE_URL and
// SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY (values never printed).
//   node scripts/backfill/prod-bundesliga.mjs [--skip-wyscout] [--certify-only]

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { fsStorage } from '../../workers/shared/archive.js';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import * as wy from '../../workers/providers/wyscout-figshare.js';
import { syncRows } from '../../workers/soccer-ingest/src/store.js';
import { applyMigrations, openPglite } from '../../workers/soccer-ingest/src/store-pglite.js';
import { ingestWyscoutSeason } from '../../workers/soccer-ingest/src/wyscout-lane.js';
import { captureRow, ingestOpenLigaSeason } from '../../workers/soccer-ingest/src/openligadb-lane.js';
import { certify } from './certify.mjs';

const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const args = new Set(process.argv.slice(2));
// --local: rehearse the exact production run on PGlite running the real migrations.
let store; let target;
if (args.has('--local')) {
  store = await openPglite();
  await applyMigrations(store);
  target = 'pglite (local rehearsal)';
} else {
  const envText = readFileSync(process.env.SOCCER_ENV_FILE || 'D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
  const env = Object.fromEntries(envText.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; }));
  store = storeFromEnv(env);
  if (!store) throw new Error('soccer-supabase.env incomplete');
  target = new URL(env.SOCCER_MODEL_SUPABASE_URL).host;
}
const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const reviewed = JSON.parse(readFileSync('data/registry/team-crosswalk-reviewed.json', 'utf8'));
const storage = await fsStorage('.raw');

// Latest archived OpenLigaDB capture per full-season URL (from the depth scan / proof).
function openligaCaptures() {
  const dir = '.raw/soccer-source/openligadb/captures';
  const recs = readdirSync(dir).flatMap(d => readdirSync(join(dir, d)).map(f => JSON.parse(readFileSync(join(dir, d, f), 'utf8'))));
  const bySeason = new Map();
  for (const r of recs) {
    const m = r.request_url.match(/getmatchdata\/bl1\/(\d{4})$/);
    if (!m) continue;
    const s = Number(m[1]);
    if (!bySeason.has(s) || bySeason.get(s).captured_at < r.captured_at) bySeason.set(s, r);
  }
  return bySeason;
}
async function oldbCapture(rec) {
  const bytes = await storage.get(rec.raw_key);
  if (!bytes) throw new Error(`raw payload missing ${rec.raw_key}`);
  return { rec, bytes }; // the capture record keeps the parser version it was captured under; rows carry their own
}

async function wyscoutParsed() {
  const manifest = JSON.parse(readFileSync('docs/evidence/captures/wyscout_figshare.json', 'utf8')).records;
  const cap = k => manifest.find(x => x.source_key === `wyscout_figshare.${k}`);
  const raw = async k => storage.get(cap(k).raw_key);
  const json = async k => JSON.parse(strFromU8(await raw(k)));
  const mz = unzipSync(await raw('matches'), { filter: f => f.name === 'matches_Germany.json' });
  const ez = unzipSync(await raw('events'), { filter: f => f.name === 'events_Germany.json' });
  const pe = wy.parseEvents(JSON.parse(strFromU8(ez['events_Germany.json'])));
  return {
    manifest,
    captures: { competitions: cap('competitions').capture_id, teams: cap('teams').capture_id, players: cap('players').capture_id, coaches: cap('coaches').capture_id, matches: cap('matches').capture_id, matches_at: cap('matches').captured_at, events: cap('events').capture_id, events_at: cap('events').captured_at },
    parsed: { teams: wy.parseTeams(await json('teams')), players: wy.parsePlayers(await json('players')), coaches: wy.parseCoaches(await json('coaches')), matches: wy.parseMatches(JSON.parse(strFromU8(mz['matches_Germany.json']))), events: pe.events, unmapped: pe.unmapped },
  };
}

const writesOf = counts => JSON.stringify(counts).match(/"(inserted|updated)":[1-9]\d*/g) || [];

async function pass(label) {
  const report = { label, seasons: {} };
  const oldb = openligaCaptures();
  await syncRows(store, { table: 'soccer_source_captures', key: ['capture_id'], rows: [...oldb.values()].map(captureRow) });
  if (!args.has('--skip-wyscout')) {
    const w = await wyscoutParsed();
    await syncRows(store, { table: 'soccer_source_captures', key: ['capture_id'], rows: w.manifest.map(captureRow) });
    log(label, 'wyscout 2017/18');
    const r = await ingestWyscoutSeason(store, { registry, competitionExternalId: 426, parsed: w.parsed, captures: w.captures, log });
    report.wyscout = { counts: r.counts, queued: r.queued.length, writes: writesOf(r.counts) };
    log(label, 'wyscout writes', report.wyscout.writes.length);
  }
  const seasons = [2017, ...[...oldb.keys()].filter(s => s !== 2017 && s >= 2004).sort((a, b) => a - b)];
  for (const s of seasons) {
    if (!oldb.has(s)) { report.seasons[s] = { missing_capture: true }; continue; }
    const r = await ingestOpenLigaSeason(store, { registry, reviewed, league: 'bl1', season: s, storage, capture: await oldbCapture(oldb.get(s)) });
    report.seasons[s] = { ...r.summary, writes: writesOf(r.summary) };
    log(label, 'openligadb', s, `matches ${r.summary.matches}`, `writes ${report.seasons[s].writes.length}`, r.summary.halted || '');
  }
  return report;
}

let run1 = null; let run2 = null;
if (!args.has('--certify-only')) {
  run1 = await pass('run1');
  run2 = await pass('run2');
}
const cert = await certify(store, { run1, run2 });
mkdirSync('docs/evidence/proof', { recursive: true });
const file = `docs/evidence/proof/${args.has('--local') ? 'rehearsal' : 'production'}-certification-${new Date().toISOString().slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), target, store_requests: store.requests, elapsed_s: Math.round((Date.now() - t0) / 1000), run1, run2_writes: run2 && { wyscout: run2.wyscout?.writes, seasons: Object.fromEntries(Object.entries(run2.seasons).map(([k, v]) => [k, v.writes])) }, certification: cert }, null, 2) + '\n');
log('certification written', file, JSON.stringify(cert.verdict));
if (args.has('--local') && args.has('--dump')) {
  const dump = await store.db.dumpDataDir('gzip');
  writeFileSync('.proof/rehearsal.pgdata.tar.gz', Buffer.from(await dump.arrayBuffer()));
  log('snapshot .proof/rehearsal.pgdata.tar.gz');
}
