#!/usr/bin/env node
// Provider crests + portraits under the owner identification policy (workers/soccer-ingest/src/media-provider.js).
// Identity: exact ESPN team / athlete id from our canonical crosswalk, matched against ESPN's own API payload.
// Priority: an already-governed free-licensed primary (rights_status approved) is kept; otherwise the provider
// asset becomes the primary. Bytes are cached write-once, content-addressed in R2 (same route as the Commons
// backfill); the API serves only cached copies. Nothing is hotlinked.
//   node scripts/media/provider-media.mjs [--dry] [--crests-only]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { syncRows, chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { ESPN_LEAGUE, espnCrestCandidate, espnHeadshotCandidate, providerMediaRow, PROVIDER_MEDIA_VERSION } from '../../workers/soccer-ingest/src/media-provider.js';

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry'); const CRESTS_ONLY = argv.includes('--crests-only');
const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
if (!policy.owner_identification) throw new Error('policy.owner_identification missing');
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const INGEST = process.env.SOCCER_INGEST_URL || 'https://soccer-ingest.sales-fd3.workers.dev';
const TOKEN = DRY ? null : readFileSync('D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const t0 = Date.now(); const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
// ESPN's edge refuses our crawler user-agent string from this host; plain fetch (runtime default UA), rate-limited.
let lastAt = 0;
async function espnFetch(url, headers = {}) { const wait = lastAt + 300 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); lastAt = Date.now(); const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }); return { status: res.status, contentType: res.headers.get('content-type'), bytes: new Uint8Array(await res.arrayBuffer()) }; }
const json = async url => { const r = await espnFetch(url); if (r.status !== 200) throw new Error(`${url} HTTP ${r.status}`); return JSON.parse(new TextDecoder().decode(r.bytes)); };
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }
const report = { version: PROVIDER_MEDIA_VERSION, policy_version: policy.policy_version, owner_policy: policy.owner_identification.policy_version, started_at: new Date().toISOString(), dry: DRY, crests: { by_competition: {}, teams: [] }, portraits: { reasons: {} } };

// ---- active teams per competition (latest season), in customer priority order
const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'] });
const order = ['mls', 'premier-league', 'bundesliga', 'uefa-champions-league', 'uefa-nations-league'];
const teamComp = new Map(); // team -> first (highest-priority) competition
const memberships = new Map(); // team -> every active competition
for (const slug of order) {
  const c = comps.find(x => x.slug === slug); if (!c) continue;
  const season = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1))[0];
  const ms = await store.select('soccer_matches', { columns: ['home_team_id', 'away_team_id'], eq: { season_id: season.id } });
  for (const m of ms) for (const t of [m.home_team_id, m.away_team_id]) { if (!t) continue; if (!teamComp.has(t)) teamComp.set(t, slug); memberships.set(t, new Set([...(memberships.get(t) || []), slug])); }
}
const teams = new Map((await selectIn('soccer_teams', 'id', [...teamComp.keys()], { columns: ['id', 'slug', 'name', 'team_type'] })).map(t => [t.id, t]));
const ext = await selectIn('soccer_team_external_ids', 'team_id', [...teamComp.keys()], { columns: ['team_id', 'provider', 'external_id'] });
const espnOfTeam = new Map(ext.filter(x => x.provider === 'espn').map(x => [x.team_id, String(x.external_id)]));
const primaries = await selectIn('soccer_entity_media', 'entity_id', [...teamComp.keys()], { columns: ['entity_id', 'rights_status', 'is_primary', 'media_type'], eq: { entity_type: 'team', media_type: 'crest', is_primary: true } });
const freeCrest = new Set(primaries.filter(r => r.rights_status === 'approved').map(r => r.entity_id));
log('active teams', teamComp.size, 'with espn id', espnOfTeam.size, 'free-licensed crest kept', freeCrest.size);

// ---- ESPN league listings (one call per league)
const listing = {};
for (const [slug, lg] of Object.entries(ESPN_LEAGUE)) listing[slug] = (await json(`https://site.api.espn.com/apis/site/v2/sports/soccer/${lg}/teams`)).sports[0].leagues[0].teams.map(x => x.team);

const rows = []; const disc = [];
const ledger = (entity_type, entity_id, media_type, outcome, reason, extra = {}) => disc.push({ entity_type, entity_id, media_type, outcome, method: extra.method || 'espn_exact_provider_id', reason, external_id: extra.external_id || null, source_url: extra.source_url || null, evidence: extra.evidence || {}, checked_at: new Date().toISOString() });
for (const [teamId, slug] of teamComp) {
  const t = teams.get(teamId); const espnId = espnOfTeam.get(teamId);
  const line = { competition: slug, competitions: [...memberships.get(teamId)], team: t.name, slug: t.slug, canonical_id: teamId, espn_team_id: espnId || null };
  if (freeCrest.has(teamId)) { Object.assign(line, { source: 'wikimedia_commons (free-licensed, already governed)', identity: 'governed', status: 'live' }); report.crests.teams.push(line); continue; }
  if (!espnId) { Object.assign(line, { status: 'identity_unresolved', reason: 'no_espn_team_id' }); ledger('team', teamId, 'crest', 'not_found', 'no_espn_team_id'); report.crests.teams.push(line); continue; }
  // the team must be listed by ESPN in THIS competition's league (exact id), else any league we cover
  let c = espnCrestCandidate(espnId, listing[slug]); let listedIn = slug;
  if (!c.ok) for (const s of order) { const x = espnCrestCandidate(espnId, listing[s]); if (x.ok) { c = x; listedIn = s; break; } }
  if (!c.ok) { Object.assign(line, { status: c.reason === 'current_crest_not_found' ? 'asset_unavailable' : 'identity_unresolved', reason: c.reason }); ledger('team', teamId, 'crest', 'not_found', c.reason, { external_id: espnId }); report.crests.teams.push(line); continue; }
  const sourceUrl = `https://www.espn.com/soccer/team/_/id/${espnId}`;
  const evidence = { method: 'espn_exact_team_id', external_id: espnId, provider: 'espn', crosswalk: 'soccer_team_external_ids', espn_league: ESPN_LEAGUE[listedIn], espn_display_name: c.espn_name, logo_rel: 'default', logo_last_updated: c.last_updated, api: `https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN_LEAGUE[listedIn]}/teams` };
  rows.push({ ...providerMediaRow({ entityType: 'team', entityId: teamId, mediaType: 'crest', url: c.url, sourceUrl, subjectName: t.name, evidence, policy, national: t.team_type === 'national' }), width: c.width, height: c.height });
  Object.assign(line, { source: `ESPN team artwork (exact ESPN team id ${espnId}, listed in ${ESPN_LEAGUE[listedIn]} as "${c.espn_name}")`, identity: 'exact_espn_team_id', url: c.url, status: 'pending_cache' });
  report.crests.teams.push(line);
}
log('crest candidates', rows.length);

// ---- portraits: exact ESPN athlete id on the team roster payload
if (!CRESTS_ONLY) {
  const px = await store.select('soccer_player_external_ids', { columns: ['player_id', 'external_id'], eq: { provider: 'espn' }, order: 'external_id.asc' });
  const playerOfEspn = new Map(); for (const x of px) playerOfEspn.set(String(x.external_id), [...(playerOfEspn.get(String(x.external_id)) || []), x.player_id]);
  const seen = new Map(); // espn athlete id -> roster payload entries
  for (const [teamId, slug] of teamComp) {
    const espnId = espnOfTeam.get(teamId); if (!espnId) continue;
    let roster = [];
    try { roster = (await json(`https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN_LEAGUE[slug]}/teams/${espnId}/roster`)).athletes || []; } catch (e) { report.portraits.reasons.roster_fetch_failed = (report.portraits.reasons.roster_fetch_failed || 0) + 1; continue; }
    for (const a of roster) if (a.headshot?.href) seen.set(String(a.id), [...(seen.get(String(a.id)) || []), a]);
  }
  const ids = [...seen.keys()].filter(id => playerOfEspn.get(id)?.length === 1);
  const players = new Map((await selectIn('soccer_players', 'id', ids.map(id => playerOfEspn.get(id)[0]), { columns: ['id', 'display_name', 'birth_date', 'status'] })).map(p => [p.id, p]));
  const pPrim = await selectIn('soccer_entity_media', 'entity_id', [...players.keys()], { columns: ['entity_id', 'rights_status'], eq: { entity_type: 'player', media_type: 'portrait', is_primary: true } });
  const freePortrait = new Set(pPrim.filter(r => r.rights_status === 'approved').map(r => r.entity_id));
  const tally = k => { report.portraits.reasons[k] = (report.portraits.reasons[k] || 0) + 1; };
  report.portraits.espn_headshots_in_payloads = seen.size;
  for (const [espnAthlete, entries] of seen) {
    const pids = playerOfEspn.get(espnAthlete) || [];
    if (pids.length !== 1) { tally(pids.length ? 'espn_id_on_several_players' : 'athlete_not_in_crosswalk'); continue; }
    const p = players.get(pids[0]); if (!p) { tally('player_missing'); continue; }
    if (freePortrait.has(p.id)) { tally('free_licensed_portrait_kept'); continue; }
    const urls = new Set(entries.map(e => e.headshot.href));
    if (urls.size !== 1) { tally('conflicting_headshots'); continue; }
    const c = espnHeadshotCandidate(espnAthlete, [entries[0]], p.birth_date);
    if (!c.ok) { tally(c.reason); ledger('player', p.id, 'portrait', c.reason === 'birth_date_contradiction' ? 'rejected' : 'not_found', c.reason, { external_id: espnAthlete }); continue; }
    tally('candidate');
    rows.push(providerMediaRow({ entityType: 'player', entityId: p.id, mediaType: 'portrait', url: c.url, sourceUrl: `https://www.espn.com/soccer/player/_/id/${espnAthlete}`, subjectName: p.display_name, evidence: { method: 'espn_exact_athlete_id', external_id: espnAthlete, provider: 'espn', crosswalk: 'soccer_player_external_ids', espn_display_name: c.espn_name, birth_date_checked: c.dob_checked }, policy }));
  }
  log('portrait candidates', rows.filter(r => r.entity_type === 'player').length, JSON.stringify(report.portraits.reasons));
}

// ---- cache bytes write-once (skipped in --dry), mark primary
const prior = new Map((await selectIn('soccer_entity_media', 'id', rows.map(r => r.id), { columns: ['id', 'url', 'object_key', 'content_sha256', 'cached_url', 'verified_at', 'mime'] })).map(x => [x.id, x]));
let cached = 0, reused = 0, failed = 0;
for (const r of rows) {
  r.retrieved_at = new Date().toISOString();
  if (DRY) continue;
  const was = prior.get(r.id);
  if (was?.object_key && was.url === r.url) { Object.assign(r, { object_key: was.object_key, content_sha256: was.content_sha256, cached_url: was.cached_url, verified_at: new Date(was.verified_at).toISOString(), mime: was.mime, is_primary: true }); reused++; continue; }
  try {
    const res = await espnFetch(r.url, { accept: 'image/*' });
    if (res.status !== 200 || !/^image\//.test(res.contentType || '')) throw new Error(`HTTP ${res.status} ${res.contentType}`);
    const sha = createHash('sha256').update(res.bytes).digest('hex');
    const key = `soccer-source/media/sha256/${sha.slice(0, 2)}/${sha}`;
    const put = await fetch(`${INGEST}/v1/admin/raw?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': res.contentType }, body: res.bytes });
    const pj = await put.json();
    if (!(put.status === 201 || put.status === 200) || (pj.sha256 && pj.sha256 !== sha)) throw new Error(`R2 put ${put.status}`);
    Object.assign(r, { object_key: key, content_sha256: sha, cached_url: `/api/soccer/media/${sha}`, verified_at: new Date().toISOString(), is_primary: true, mime: res.contentType.split(';')[0] });
    cached++; if (cached % 50 === 0) log('cached', cached);
  } catch (e) {
    Object.assign(r, { rights_status: 'review_required', is_primary: false, rights_notes: `${r.rights_notes} Cache failed: ${String(e.message).slice(0, 120)}`, rejection_reason: `cache failed: ${String(e.message).slice(0, 120)}` });
    failed++;
  }
}
for (const r of rows) ledger(r.entity_type, r.entity_id, r.media_type, r.rights_status === 'owner_approved_identification' ? 'owner_approved_identification' : 'held_review', r.rights_status === 'owner_approved_identification' ? 'owner_approved_identification' : r.rejection_reason, { method: r.match_evidence.method, external_id: r.source_entity, source_url: r.source_url, evidence: { provider: r.provider, owner_policy_version: r.owner_policy_version } });
for (const line of report.crests.teams) if (line.status === 'pending_cache') { const r = rows.find(x => x.entity_type === 'team' && x.entity_id === line.canonical_id); line.status = DRY ? 'candidate (dry run)' : r.rights_status === 'owner_approved_identification' ? 'live' : `cache_failed: ${r.rejection_reason}`; }
for (const slug of order) { const ls = report.crests.teams.filter(l => memberships.get(l.canonical_id)?.has(slug)); report.crests.by_competition[slug] = { teams: ls.length, live_or_candidate: ls.filter(l => l.status === 'live' || l.status.startsWith('candidate')).length, identity_unresolved: ls.filter(l => l.status === 'identity_unresolved').length, asset_unavailable: ls.filter(l => l.status === 'asset_unavailable').length }; }
report.cached = cached; report.reused = reused; report.cache_failed = failed;
if (!DRY) {
  // Only primaries for entities without a free-licensed primary are written; never demote an approved row.
  report.sync = await syncRows(store, { table: 'soccer_entity_media', key: ['id'], rows: rows.map(r => ({ is_primary: false, cached_url: null, object_key: null, content_sha256: null, verified_at: null, mime: null, width: null, height: null, ...r })), touch: true });
  const last = new Map(disc.map(d => [`${d.entity_type}:${d.entity_id}:${d.media_type}`, d])); // one ledger row per entity
  for (const part of chunkArr([...last.values()], 500)) await store.upsert('soccer_media_discovery', part, ['entity_type', 'entity_id', 'media_type']);
}
report.finished_at = new Date().toISOString();
mkdirSync('docs/evidence/media', { recursive: true });
const file = `docs/evidence/media/provider-media-${report.started_at.slice(0, 10)}${DRY ? '-dry' : ''}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
log('crests', JSON.stringify(report.crests.by_competition), 'cached', cached, 'reused', reused, 'failed', failed, 'wrote', file);
