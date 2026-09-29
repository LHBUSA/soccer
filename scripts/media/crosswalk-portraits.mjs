#!/usr/bin/env node
// Portraits through the exact ESPN -> TheSportsDB (id crosswalk only) -> Wikidata chain
// (workers/soccer-ingest/src/media-crosswalk.js), for players WITHOUT a displayable portrait, in the
// order people see them: the PBEcast audit list first (docs/evidence/media/pbecast-portraits-*.json),
// or every active player with --active. The P18 file goes through the unchanged Commons rights
// classifier; only 'approved' (free-licensed) files are cached (write-once R2) and made primary.
//   node scripts/media/crosswalk-portraits.mjs [--audit <file>] [--scope <label for the evidence file>] [--active] [--limit N] [--dry]
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { politeFetch } from '../../workers/shared/http.js';
import { syncRows, chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { commonsInfo, mediaRow } from '../../workers/soccer-ingest/src/media-wikimedia.js';
import { tsdbExactEspn, wikidataAgrees, CROSSWALK_VERSION } from '../../workers/soccer-ingest/src/media-crosswalk.js';

const argv = process.argv.slice(2); const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const DRY = argv.includes('--dry'); const ACTIVE = argv.includes('--active'); const LIMIT = Number(arg('--limit', '0')) || Infinity;
const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const INGEST = process.env.SOCCER_INGEST_URL || 'https://soccer-ingest.sales-fd3.workers.dev';
const TOKEN = DRY ? null : readFileSync('D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const t0 = Date.now(); const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }
let lastTsdb = 0;
async function tsdb(path) { const wait = lastTsdb + 2100 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); lastTsdb = Date.now(); const r = await fetch(`https://www.thesportsdb.com/api/v1/json/123/${path}`, { signal: AbortSignal.timeout(30000) }); if (r.status === 429) { await new Promise(res => setTimeout(res, 60000)); return tsdb(path); } if (r.status !== 200) throw new Error(`tsdb ${r.status}`); return r.json(); }

// ---- who: players without a displayable portrait, visible-first
let playerIds;
if (ACTIVE) {
  const act = await store.select('soccer_players', { columns: ['id'], eq: { status: 'active' } });
  playerIds = act.map(p => p.id);
} else {
  const f = arg('--audit', `docs/evidence/media/${readdirSync('docs/evidence/media').filter(x => x.startsWith('pbecast-portraits-')).sort().pop()}`);
  const audit = JSON.parse(readFileSync(f, 'utf8'));
  const slugs = audit.no_photo.map(x => x.slug);
  playerIds = (await selectIn('soccer_players', 'slug', slugs, { columns: ['id'] })).map(p => p.id);
}
const prim = await selectIn('soccer_entity_media', 'entity_id', playerIds, { columns: ['entity_id'], eq: { entity_type: 'player', media_type: 'portrait', is_primary: true } });
const hasPic = new Set(prim.map(r => r.entity_id));
const todo = playerIds.filter(id => !hasPic.has(id)).slice(0, LIMIT);
const players = new Map((await selectIn('soccer_players', 'id', todo, { columns: ['id', 'slug', 'display_name', 'first_name', 'last_name', 'birth_date'] })).map(p => [p.id, p]));
const espn = new Map((await selectIn('soccer_player_external_ids', 'player_id', todo, { columns: ['player_id', 'external_id'], eq: { provider: 'espn' } })).map(x => [x.player_id, String(x.external_id)]));
log('players without a portrait', todo.length, 'with ESPN id', espn.size);

const report = { version: CROSSWALK_VERSION, started_at: new Date().toISOString(), dry: DRY, scope: ACTIVE ? 'active' : arg('--scope', 'pbecast'), reasons: {}, matched: [] };
const tally = k => { report.reasons[k] = (report.reasons[k] || 0) + 1; };
const disc = [];
const ledger = (pid, outcome, reason, extra = {}) => disc.push({ entity_type: 'player', entity_id: pid, media_type: 'portrait', outcome, method: 'espn_tsdb_wikidata_crosswalk', reason, external_id: extra.qid || null, source_url: extra.source_url || null, evidence: extra.evidence || {}, checked_at: new Date().toISOString() });
const cands = [];
for (const pid of todo) {
  const p = players.get(pid); const e = espn.get(pid);
  if (!p || !e) { tally('no_espn_id'); continue; }
  const names = [...new Set([p.display_name, [p.first_name, p.last_name].filter(Boolean).join(' ')].filter(Boolean))];
  const records = []; const seenIds = new Set();
  try {
    for (const n of names) {
      const s = await tsdb(`searchplayers.php?p=${encodeURIComponent(n)}`);
      for (const r of (s.player || []).slice(0, 6)) if (!seenIds.has(r.idPlayer)) { seenIds.add(r.idPlayer); const full = await tsdb(`lookupplayer.php?id=${encodeURIComponent(r.idPlayer)}`); records.push(...(full.players || full.player || [])); }
      if (records.some(r => String(r.idESPN || '') === e)) break;
    }
  } catch (err) { tally('tsdb_error'); continue; }
  const x = tsdbExactEspn(e, records);
  if (!x.ok) { tally(x.reason); ledger(pid, 'not_found', x.reason, { evidence: { espn_id: e } }); continue; }
  cands.push({ p, espn: e, ...x });
}
log('exact crosswalk hits', cands.length, JSON.stringify(report.reasons));

// ---- Wikidata agreement
const items = new Map();
for (const part of chunkArr(cands.map(c => c.qid), 50)) {
  const r = await politeFetch(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=claims&ids=${part.join('|')}`, { minIntervalMs: 1000 });
  const j = JSON.parse(new TextDecoder().decode(r.bytes)); for (const [q, it] of Object.entries(j.entities || {})) items.set(q, it);
}
const jobs = [];
for (const c of cands) {
  const a = wikidataAgrees(items.get(c.qid), { birthDate: c.p.birth_date, espnId: c.espn });
  if (!a.ok) { tally(`wikidata:${a.reason}`); ledger(c.p.id, a.reason === 'birth_date_contradiction' || a.reason === 'wikidata_has_different_espn_id' ? 'rejected' : 'not_found', a.reason, { qid: c.qid, evidence: { espn_id: c.espn, tsdb_id: c.tsdb_id } }); continue; }
  jobs.push({ ...c, file: a.image });
}
log('identity proven (exact chain + DOB)', jobs.length);

// ---- Commons rights (unchanged classifier)
const info = await commonsInfo(politeFetch, [...new Set(jobs.map(j => j.file))], { width: policy.thumb_width });
const rows = [];
for (const j of jobs) {
  const i = info.get(j.file); if (!i) { tally('commons_file_missing'); continue; }
  const r = mediaRow({ entityType: 'player', entityId: j.p.id, mediaType: 'portrait', info: i, sourceEntity: j.qid, policy, evidence: { method: 'espn_tsdb_wikidata_crosswalk', rule: 'ESPN athlete id == TheSportsDB idESPN (exactly one) -> idWikidata -> Wikidata birth date equals ours, no different P3681', espn_id: j.espn, tsdb_id: j.tsdb_id, qid: j.qid, crosswalk_version: CROSSWALK_VERSION } });
  r.trademark_status = (i.meta?.Restrictions?.value || '').split('|').includes('trademarked') ? 'trademark_notice' : 'none';
  r.retrieved_at = new Date().toISOString(); r.provider = 'wikimedia_commons';
  r.rejection_reason = r.rights_status === 'approved' ? null : (r.rights_notes || '').replace(/^media-rights\/[\d.]+ ?/, '') || r.rights_status;
  rows.push(r); tally(`rights:${r.rights_status}`);
}
// ---- cache approved bytes, primary
let cached = 0;
for (const r of rows.filter(x => x.rights_status === 'approved')) {
  if (DRY) break;
  try {
    const res = await politeFetch(r.url, { minIntervalMs: 700, headers: { accept: 'image/*' } });
    if (res.status !== 200 || !/^image\//.test(res.contentType || '')) throw new Error(`HTTP ${res.status} ${res.contentType}`);
    const sha = createHash('sha256').update(res.bytes).digest('hex'); const key = `soccer-source/media/sha256/${sha.slice(0, 2)}/${sha}`;
    const put = await fetch(`${INGEST}/v1/admin/raw?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': res.contentType }, body: res.bytes });
    const pj = await put.json(); if (!(put.status === 201 || put.status === 200) || (pj.sha256 && pj.sha256 !== sha)) throw new Error(`R2 put ${put.status}`);
    Object.assign(r, { object_key: key, content_sha256: sha, cached_url: `/api/soccer/media/${sha}`, verified_at: new Date().toISOString(), is_primary: true, mime: res.contentType.split(';')[0] });
    cached++;
  } catch (e) { Object.assign(r, { rights_status: 'review_required', rejection_reason: `cache failed: ${String(e.message).slice(0, 120)}` }); tally('cache_failed'); }
}
for (const r of rows) ledger(r.entity_id, r.rights_status === 'approved' ? 'approved' : r.rights_status === 'review_required' ? 'held_review' : 'rejected', r.rights_status === 'approved' ? 'approved' : r.rejection_reason, { qid: r.source_entity, source_url: r.source_url, evidence: { license: r.license } });
for (const r of rows.filter(x => x.rights_status === 'approved')) report.matched.push({ player: players.get(r.entity_id)?.display_name, slug: players.get(r.entity_id)?.slug, qid: r.source_entity, license: r.license });
if (!DRY) {
  report.sync = await syncRows(store, { table: 'soccer_entity_media', key: ['id'], rows: rows.map(r => ({ is_primary: false, cached_url: null, object_key: null, content_sha256: null, verified_at: null, ...r })), touch: true });
  const last = new Map(disc.map(d => [d.entity_id, d]));
  for (const part of chunkArr([...last.values()], 500)) await store.upsert('soccer_media_discovery', part, ['entity_type', 'entity_id', 'media_type']);
}
report.cached = cached; report.finished_at = new Date().toISOString();
writeFileSync(`docs/evidence/media/crosswalk-portraits-${report.started_at.slice(0, 10)}-${report.scope}${DRY ? '-dry' : ''}.json`, JSON.stringify(report, null, 2) + '\n');
log('done', JSON.stringify(report.reasons), 'cached', cached);
