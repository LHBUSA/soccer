#!/usr/bin/env node
// Competition logos under the owner identification policy. Identity: our canonical competition's ESPN
// external id (soccer_competition_external_ids) must EXACTLY equal the league slug in ESPN's own scoreboard
// payload. Both published variants are cached write-once in R2: `default` (primary; for light surfaces) and
// `dark` (non-primary; ESPN's own variant for dark surfaces; no recolouring of ours). Writes the frontend
// manifest src/lib/competition-media.js (same-origin URLs only).
//   node scripts/media/competition-logos.mjs [--dry]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { syncRows } from '../../workers/soccer-ingest/src/store.js';
import { espnLeagueLogos, providerMediaRow } from '../../workers/soccer-ingest/src/media-provider.js';

const DRY = process.argv.includes('--dry');
const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const INGEST = process.env.SOCCER_INGEST_URL || 'https://soccer-ingest.sales-fd3.workers.dev';
const TOKEN = DRY ? null : readFileSync('D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const get = async (url, headers = {}) => { const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) }); return { status: r.status, contentType: r.headers.get('content-type'), bytes: new Uint8Array(await r.arrayBuffer()) }; };

const comps = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'] });
const ext = await store.select('soccer_competition_external_ids', { columns: ['competition_id', 'external_id'], eq: { provider: 'espn' } });
const rows = []; const report = { at: new Date().toISOString(), dry: DRY, competitions: [] };
for (const c of comps) {
  const e = ext.filter(x => x.competition_id === c.id);
  if (e.length !== 1) { report.competitions.push({ slug: c.slug, status: 'identity_unresolved', reason: `espn ids: ${e.length}` }); continue; }
  const espnId = e[0].external_id;
  const sb = await get(`https://site.api.espn.com/apis/site/v2/sports/soccer/${encodeURIComponent(espnId)}/scoreboard`);
  const league = sb.status === 200 ? JSON.parse(new TextDecoder().decode(sb.bytes)).leagues?.[0] : null;
  const l = espnLeagueLogos(espnId, league);
  if (!l.ok) { report.competitions.push({ slug: c.slug, espn_id: espnId, status: 'asset_unavailable', reason: l.reason }); continue; }
  for (const [variant, url] of [['default', l.default], ['dark', l.dark]]) {
    if (!url) continue;
    const sourceUrl = `https://www.espn.com/soccer/league/_/name/${espnId}${variant === 'dark' ? '?variant=dark' : ''}`;
    const r = providerMediaRow({ entityType: 'competition', entityId: c.id, mediaType: 'crest', url, sourceUrl, subjectName: c.name, evidence: { method: 'espn_exact_league_id', external_id: espnId, provider: 'espn', crosswalk: 'soccer_competition_external_ids', espn_league_id: l.espn_league_id, espn_display_name: l.espn_name, logo_rel: variant, variant }, policy });
    r.retrieved_at = new Date().toISOString(); r.width = 500; r.height = 500; r.is_primary = variant === 'default';
    rows.push(r);
  }
  report.competitions.push({ slug: c.slug, canonical_id: c.id, espn_id: espnId, espn_league_id: l.espn_league_id, espn_name: l.espn_name, default: l.default, dark: l.dark, status: 'candidate' });
}
if (!DRY) for (const r of rows) {
  const res = await get(r.url, { accept: 'image/*' });
  if (res.status !== 200 || !/^image\//.test(res.contentType || '')) throw new Error(`${r.url} HTTP ${res.status}`);
  const sha = createHash('sha256').update(res.bytes).digest('hex');
  const key = `soccer-source/media/sha256/${sha.slice(0, 2)}/${sha}`;
  const put = await fetch(`${INGEST}/v1/admin/raw?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': res.contentType }, body: res.bytes });
  const pj = await put.json();
  if (!(put.status === 201 || put.status === 200) || (pj.sha256 && pj.sha256 !== sha)) throw new Error(`R2 put ${put.status}`);
  Object.assign(r, { object_key: key, content_sha256: sha, cached_url: `/api/soccer/media/${sha}`, verified_at: new Date().toISOString(), mime: res.contentType.split(';')[0] });
}
if (!DRY) {
  report.sync = await syncRows(store, { table: 'soccer_entity_media', key: ['id'], rows, touch: true });
  const manifest = {};
  for (const c of report.competitions.filter(x => x.status === 'candidate')) {
    const d = rows.find(r => r.entity_id === c.canonical_id && r.is_primary); const k = rows.find(r => r.entity_id === c.canonical_id && !r.is_primary);
    manifest[c.slug] = { url: d.cached_url, url_dark: k?.cached_url || null, attribution: d.attribution, basis: 'owner_approved_identification' };
    c.status = 'live';
  }
  writeFileSync('src/lib/competition-media.js', `// GENERATED by scripts/media/competition-logos.mjs: approved competition logos (same-origin cached copies).\n// Identity: exact ESPN league id from soccer_competition_external_ids; provenance in soccer_entity_media\n// (rights_status owner_approved_identification: NOT free-licensed). Do not edit by hand.\nexport const COMPETITION_MEDIA = ${JSON.stringify(manifest, null, 2)};\n`);
}
writeFileSync(`docs/evidence/media/competition-logos-${report.at.slice(0, 10)}${DRY ? '-dry' : ''}.json`, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report.competitions.map(c => [c.slug, c.espn_id, c.status, c.reason || '']), null, 0));
