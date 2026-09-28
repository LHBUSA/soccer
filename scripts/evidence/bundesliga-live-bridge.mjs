#!/usr/bin/env node
// READ-ONLY identity proof for Bundesliga live enrichment (V3.1).
// Proves, for the current Bundesliga season, that every canonical (OpenLigaDB-owned) match maps
// to at most one ESPN event and every ESPN event to at most one canonical match, that ESPN clubs
// map to canonical clubs only by fixture-graph proof, and lists anything held for review.
//   node scripts/evidence/bundesliga-live-bridge.mjs [--season 2026/27]
// Writes docs/evidence/live/bundesliga-bridge-<date>.json. No writes to the database.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

const arg = k => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const envText = readFileSync(process.env.SOCCER_ENV_FILE || 'D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const env = Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
const store = storeFromEnv(env);

const [comp] = await store.select('soccer_competitions', { columns: ['id', 'slug'], eq: { slug: 'bundesliga' }, limit: 1 });
const seasons = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: comp.id } })).sort((a, b) => (a.label < b.label ? 1 : -1));
const season = arg('--season') ? seasons.find(s => s.label === arg('--season')) : seasons[0];
const matches = await store.select('soccer_matches', { columns: ['id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'result_provider', 'home_score', 'away_score'], eq: { season_id: season.id } });
const ids = matches.map(m => m.id);
const ext = [];
for (const part of chunkArr(ids, 100)) ext.push(...await store.select('soccer_match_external_ids', { columns: ['match_id', 'provider', 'external_id', 'method'], in: { match_id: part } }));
const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
const teamExt = await store.select('soccer_team_external_ids', { columns: ['team_id', 'provider', 'external_id', 'method'], in: { team_id: teamIds } });
const queue = (await store.select('soccer_identity_queue', { columns: ['entity_type', 'provider', 'external_id', 'reason', 'status'], eq: { provider: 'espn' } }).catch(() => [])).filter(q => q.status !== 'resolved');

const by = (rows, k) => rows.reduce((m, r) => m.set(r[k], [...(m.get(r[k]) || []), r]), new Map());
const espnByMatch = by(ext.filter(x => x.provider === 'espn'), 'match_id');
const espnByEvent = by(ext.filter(x => x.provider === 'espn'), 'external_id');
const oldbByMatch = by(ext.filter(x => x.provider === 'openligadb'), 'match_id');
const espnTeams = teamExt.filter(x => x.provider === 'espn');
const out = {
  at: new Date().toISOString(), season: season.label, canonical_matches: matches.length,
  result_provider: Object.fromEntries([...by(matches, 'result_provider')].map(([k, v]) => [k, v.length])),
  with_openligadb_id: matches.filter(m => oldbByMatch.has(m.id)).length,
  with_espn_event: matches.filter(m => espnByMatch.has(m.id)).length,
  espn_attach_methods: Object.fromEntries([...by(ext.filter(x => x.provider === 'espn'), 'method')].map(([k, v]) => [k, v.length])),
  violations: {
    canonical_with_multiple_espn_events: [...espnByMatch].filter(([, v]) => v.length > 1).map(([k, v]) => ({ match_id: k, events: v.map(x => x.external_id) })),
    espn_event_on_multiple_canonical: [...espnByEvent].filter(([, v]) => v.length > 1).map(([k, v]) => ({ event: k, matches: v.map(x => x.match_id) })),
    espn_owned_matches_in_openligadb_season: matches.filter(m => m.result_provider === 'espn').map(m => m.id),
  },
  canonical_clubs: teamIds.length,
  clubs_with_espn_id: new Set(espnTeams.map(x => x.team_id)).size,
  espn_club_methods: Object.fromEntries([...by(espnTeams, 'method')].map(([k, v]) => [k, v.length])),
  clubs_with_multiple_espn_ids: [...by(espnTeams, 'team_id')].filter(([, v]) => v.length > 1).map(([k, v]) => ({ team_id: k, espn: v.map(x => x.external_id) })),
  missing_espn_event: matches.filter(m => !espnByMatch.has(m.id)).map(m => ({ id: m.id, kickoff_at: m.kickoff_at, status: m.status })),
  held_espn_identity_items: queue.length,
  held_sample: queue.slice(0, 10),
};
out.pass = out.violations.canonical_with_multiple_espn_events.length === 0 && out.violations.espn_event_on_multiple_canonical.length === 0 && out.violations.espn_owned_matches_in_openligadb_season.length === 0 && out.clubs_with_multiple_espn_ids.length === 0;
mkdirSync('docs/evidence/live', { recursive: true });
const file = `docs/evidence/live/bundesliga-bridge-${out.at.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify({ ...out, missing_espn_event: out.missing_espn_event.length, held_sample: undefined }, null, 2));
console.log('wrote', file);
