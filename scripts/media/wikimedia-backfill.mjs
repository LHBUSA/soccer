#!/usr/bin/env node
// Governed media backfill: player portraits + club crests from Wikimedia Commons into
// soccer_entity_media (production). Identity and rights rules: workers/soccer-ingest/
// src/media-wikimedia.js + workers/shared/media-rights.js + data/media/policy.json.
// Approved files are downloaded once (Commons thumbnail), hashed, and stored
// write-once in R2 at soccer-source/media/sha256/<xx>/<sha> via the ingest admin route.
// Every non-approved verdict is stored too (audit), but the API never exposes it.
//   node scripts/media/wikimedia-backfill.mjs [--limit 50] [--dry] [--skip-teams] [--skip-players]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { politeFetch } from '../../workers/shared/http.js';
import { syncRows, chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { wikidataByEspnIds, playerMatchVerdict, proveClubByRoster, clubFacts, commonsInfo, fileNameOf, mediaRow, MEDIA_VERSION } from '../../workers/soccer-ingest/src/media-wikimedia.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const LIMIT = Number(arg('--limit', '0')) || Infinity;
const DRY = argv.includes('--dry');
const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const INGEST = process.env.SOCCER_INGEST_URL || 'https://soccer-ingest.sales-fd3.workers.dev';
const TOKEN = readFileSync('D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const t0 = Date.now();
const log = (...a) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s]`, ...a);
const report = { version: MEDIA_VERSION, policy_version: policy.policy_version, started_at: new Date().toISOString(), players: {}, teams: {}, files: {}, rows: {} };
const tally = (o, k) => { o[k] = (o[k] || 0) + 1; };

async function selectAll(table, opts) { return store.select(table, opts); }
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }

// ---- players: exact ESPN FC id -> Wikidata
const xw = (await selectAll('soccer_player_external_ids', { columns: ['external_id', 'player_id'], eq: { provider: 'espn' }, order: 'external_id.asc' })).slice(0, LIMIT);
const players = new Map((await selectIn('soccer_players', 'id', xw.map(x => x.player_id), { columns: ['id', 'display_name', 'birth_date', 'status'] })).map(p => [p.id, p]));
log('espn-linked players', xw.length);
const wd = await wikidataByEspnIds(politeFetch, xw.map(x => x.external_id));
log('wikidata items for', wd.size, 'espn ids');
report.players.espn_linked = xw.length; report.players.wikidata_items = wd.size; report.players.verdicts = {};
const portraitJobs = [];
const qidOfPlayer = new Map();
for (const x of xw) {
  const p = players.get(x.player_id); if (!p || p.status !== 'active') continue;
  const cands = wd.get(x.external_id);
  if (cands?.length === 1 && !(p.birth_date && cands[0].dobs.length && !cands[0].dobs.includes(String(p.birth_date).slice(0, 10)))) qidOfPlayer.set(p.id, cands[0]);
  const v = playerMatchVerdict(p, cands);
  tally(report.players.verdicts, v.reason || 'ok');
  if (!v.ok) continue;
  portraitJobs.push({ player: p, espn: x.external_id, qid: v.qid, file: fileNameOf(v.image), dob_checked: v.dob_checked });
}
log('portrait candidates', portraitJobs.length, JSON.stringify(report.players.verdicts));

// ---- teams: roster proof over sourced ESPN lineups
const crestJobs = [];
if (!argv.includes('--skip-teams')) {
  const lineups = await selectAll('soccer_lineups', { columns: ['id', 'team_id'], eq: { provider: 'espn' }, order: 'id.asc' });
  const lps = await selectIn('soccer_lineup_players', 'lineup_id', lineups.map(l => l.id), { columns: ['lineup_id', 'player_id'], order: 'lineup_id.asc,player_id.asc' });
  const teamOf = new Map(lineups.map(l => [l.id, l.team_id]));
  const roster = new Map();
  for (const r of lps) { const t = teamOf.get(r.lineup_id); if (!roster.has(t)) roster.set(t, new Set()); roster.get(t).add(r.player_id); }
  const allClubs = [...new Set([...qidOfPlayer.values()].flatMap(c => c.teams))];
  const facts = await clubFacts(politeFetch, allClubs);
  const proofs = new Map();
  for (const [teamId, ps] of roster) {
    const perPlayer = [...ps].map(pid => qidOfPlayer.get(pid)).filter(Boolean).map(c => c.teams.filter(q => facts.get(q)?.is_club));
    proofs.set(teamId, proveClubByRoster(perPlayer.filter(c => c.length)));
  }
  const claim = new Map();
  for (const [t, pr] of proofs) if (pr.qid) claim.set(pr.qid, [...(claim.get(pr.qid) || []), t]);
  const teams = new Map((await selectIn('soccer_teams', 'id', [...roster.keys()], { columns: ['id', 'name', 'slug'] })).map(t => [t.id, t]));
  report.teams.with_espn_lineups = roster.size; report.teams.verdicts = {}; report.teams.proofs = [];
  for (const [teamId, pr] of proofs) {
    let reason = pr.reason;
    if (pr.qid && claim.get(pr.qid).length > 1) reason = 'club_claimed_by_several_teams';
    const f = pr.qid ? facts.get(pr.qid) : null;
    if (reason === 'roster_proof' && f.logos.length !== 1) reason = f.logos.length ? 'several_logos' : 'club_has_no_logo_on_wikidata';
    tally(report.teams.verdicts, reason);
    report.teams.proofs.push({ team: teams.get(teamId)?.name, qid: pr.qid, reason, players_matched: pr.players_matched, top: pr.top, runner_up: pr.runner_up });
    if (reason !== 'roster_proof') continue;
    crestJobs.push({ team: teams.get(teamId), qid: pr.qid, file: fileNameOf(f.logos[0]), proof: pr });
  }
  log('crest candidates', crestJobs.length, JSON.stringify(report.teams.verdicts));
}

// ---- Commons metadata + rights
const files = [...new Set([...portraitJobs, ...crestJobs].map(j => j.file))];
const info = await commonsInfo(politeFetch, files, { width: policy.thumb_width });
log('commons files', files.length, 'resolved', [...info.values()].filter(Boolean).length);
const rows = [];
for (const j of portraitJobs) {
  const i = info.get(j.file); if (!i) { tally(report.files, 'commons_file_missing'); continue; }
  rows.push(mediaRow({ entityType: 'player', entityId: j.player.id, mediaType: 'portrait', info: i, sourceEntity: j.qid, policy,
    evidence: { method: 'wikidata_espn_fc_player_id', property: 'P3681', espn_id: j.espn, qid: j.qid, birth_date_checked: j.dob_checked } }));
}
for (const j of crestJobs) {
  const i = info.get(j.file); if (!i) { tally(report.files, 'commons_file_missing'); continue; }
  rows.push(mediaRow({ entityType: 'team', entityId: j.team.id, mediaType: 'crest', info: i, sourceEntity: j.qid, policy,
    evidence: { method: 'wikidata_roster_proof', qid: j.qid, players_matched: j.proof.players_matched, top: j.proof.top, runner_up: j.proof.runner_up } }));
}
for (const r of rows) tally(report.rows, `${r.entity_type}:${r.rights_status}`);
report.licenses = {}; for (const r of rows) tally(report.licenses, `${r.rights_status}:${r.license}`);
report.samples = rows.slice(0, 5).map(r => ({ entity: r.entity_id, file: r.source_url, license: r.license, author: r.author, status: r.rights_status, notes: r.rights_notes }));
log('rows', JSON.stringify(report.rows));

// ---- cache approved bytes (write-once, content-addressed) and mark primary
let cached = 0; let reused = 0;
// Re-runs: a row already cached for the same file keeps its verified copy (no re-download).
const prior = new Map((await selectIn('soccer_entity_media', 'id', rows.map(r => r.id), { columns: ['id', 'url', 'object_key', 'content_sha256', 'cached_url', 'verified_at', 'mime'] })).map(x => [x.id, x]));
for (const r of rows.filter(x => x.rights_status === 'approved')) {
  if (DRY) break;
  const was = prior.get(r.id);
  if (was?.object_key && was.url === r.url) {
    Object.assign(r, { object_key: was.object_key, content_sha256: was.content_sha256, cached_url: was.cached_url, verified_at: new Date(was.verified_at).toISOString(), mime: was.mime, is_primary: true });
    reused += 1; continue;
  }
  try {
    const res = await politeFetch(r.url, { minIntervalMs: 700, headers: { accept: 'image/*' } });
    if (res.status !== 200 || !/^image\//.test(res.contentType || '')) throw new Error(`HTTP ${res.status} ${res.contentType}`);
    const sha = createHash('sha256').update(res.bytes).digest('hex');
    const key = `soccer-source/media/sha256/${sha.slice(0, 2)}/${sha}`;
    const put = await fetch(`${INGEST}/v1/admin/raw?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': res.contentType }, body: res.bytes });
    const pj = await put.json();
    if (!(put.status === 201 || put.status === 200) || (pj.sha256 && pj.sha256 !== sha)) throw new Error(`R2 put ${put.status}`);
    Object.assign(r, { object_key: key, content_sha256: sha, cached_url: `/api/soccer/media/${sha}`, verified_at: new Date().toISOString(), is_primary: true, mime: res.contentType.split(';')[0] });
    cached += 1;
    if (cached % 50 === 0) log('cached', cached);
  } catch (e) {
    Object.assign(r, { rights_status: 'review_required', rights_notes: `${r.rights_notes} Cache failed: ${String(e.message).slice(0, 120)}` });
    tally(report.files, 'cache_failed');
  }
}
report.rows_after_cache = {}; for (const r of rows) tally(report.rows_after_cache, `${r.entity_type}:${r.rights_status}`);
report.cached = cached; report.reused = reused;
// One primary per entity/media type: keep the first approved.
const seen = new Set();
for (const r of rows) { const k = `${r.entity_type}:${r.entity_id}:${r.media_type}`; if (r.is_primary && seen.has(k)) r.is_primary = false; if (r.is_primary) seen.add(k); }
if (!DRY) report.sync = await syncRows(store, { table: 'soccer_entity_media', key: ['id'], rows: rows.map(r => ({ is_primary: false, cached_url: null, object_key: null, content_sha256: null, verified_at: null, ...r })), touch: true });
report.finished_at = new Date().toISOString(); report.elapsed_s = Math.round((Date.now() - t0) / 1000);
mkdirSync('docs/evidence/media', { recursive: true });
const file = `docs/evidence/media/wikimedia-${report.started_at.slice(0, 10)}${DRY ? '-dry' : ''}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
log('wrote', file, JSON.stringify({ rows: report.rows_after_cache, cached, sync: report.sync }));
