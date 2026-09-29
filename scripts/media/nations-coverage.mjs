#!/usr/bin/env node
// READ-ONLY Nations League media coverage + guard checks after provider-media.mjs.
//   node scripts/media/nations-coverage.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const selIn = async (t, col, vals, o = {}) => { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return out; };
const DISPLAYABLE = ['approved', 'owner_approved_identification'];

const [c] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: 'uefa-nations-league' } });
const [s] = await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } });
const ms = await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id'], eq: { season_id: s.id } });
const teamIds = [...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))];
const crests = await selIn('soccer_entity_media', 'entity_id', teamIds, { columns: ['entity_id', 'rights_status', 'cached_url', 'is_primary'], eq: { entity_type: 'team', media_type: 'crest', is_primary: true } });
const lus = await selIn('soccer_lineups', 'match_id', ms.map(m => m.id), { columns: ['id', 'team_id'] });
const lps = await selIn('soccer_lineup_players', 'lineup_id', lus.map(l => l.id), { columns: ['player_id'] });
const players = [...new Set(lps.map(x => x.player_id))];
const xw = await selIn('soccer_player_external_ids', 'player_id', players, { columns: ['player_id', 'provider', 'external_id', 'method'] });
const espn = new Map(xw.filter(x => x.provider === 'espn').map(x => [x.player_id, x.external_id]));
const media = await selIn('soccer_entity_media', 'entity_id', players, { columns: ['entity_id', 'rights_status', 'source', 'cached_url', 'url', 'is_primary'], eq: { entity_type: 'player', media_type: 'portrait', is_primary: true } });
const usable = media.filter(m => DISPLAYABLE.includes(m.rights_status) && m.cached_url);
const free = new Set(usable.filter(m => m.rights_status === 'approved').map(m => m.entity_id));
const prov = new Set(usable.filter(m => m.rights_status === 'owner_approved_identification').map(m => m.entity_id));
const both = new Set([...free, ...prov]);
// guard checks
const dobHeld = ['1119052b-51c2-552e-b836-644b531dcc68', '3c5660e7-39d2-57a8-b6e8-cc3cd80c7774'];
const heldRows = await selIn('soccer_entity_media', 'entity_id', dobHeld, { columns: ['entity_id', 'rights_status', 'source'], eq: { entity_type: 'player', media_type: 'portrait', source: 'provider_artwork' } });
const allPortraits = await store.select('soccer_entity_media', { columns: ['entity_id', 'rights_status', 'is_primary', 'cached_url', 'source'], eq: { entity_type: 'player', media_type: 'portrait', is_primary: true } });
const freeAll = allPortraits.filter(m => m.rights_status === 'approved').length;
const providerAll = allPortraits.filter(m => m.rights_status === 'owner_approved_identification').length;
const nonCached = allPortraits.filter(m => DISPLAYABLE.includes(m.rights_status) && !(m.cached_url || '').startsWith('/api/soccer/media/')).length;
const dupPrimary = allPortraits.length - new Set(allPortraits.map(m => m.entity_id)).size;
const queue = await store.select('soccer_identity_queue', { columns: ['external_id', 'reason'], eq: { entity_type: 'player', provider: 'espn', status: 'open' } });
const dupEspn = xw.filter(x => x.provider === 'espn').length - new Set(xw.filter(x => x.provider === 'espn').map(x => x.external_id)).size;
const out = {
  at: new Date().toISOString(), season: s.label,
  national_teams: teamIds.length, badges_primary_cached: crests.filter(x => DISPLAYABLE.includes(x.rights_status) && x.cached_url).length,
  players_observed_in_nations_league_lineups: players.length,
  players_with_exact_espn_id: espn.size,
  free_portrait: free.size, provider_portrait: [...prov].filter(p => !free.has(p)).length, total_usable_portrait: both.size,
  silhouette_fallback: players.length - both.size,
  espn_players_open_in_identity_queue: queue.length,
  guards: { dob_contradiction_provider_rows_written: heldRows.length, free_portraits_primary_network_wide: freeAll, provider_portraits_primary_network_wide: providerAll,
    displayable_primary_not_served_from_media_cache: nonCached, players_with_two_primary_portraits: dupPrimary, duplicate_espn_player_ids_in_nations_league: dupEspn },
};
writeFileSync(`docs/evidence/media/nations-coverage-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 1));
