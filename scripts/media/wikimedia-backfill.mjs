#!/usr/bin/env node
// Governed media backfill: player portraits + club crests from Wikimedia Commons into
// soccer_entity_media, with a per-entity discovery ledger (soccer_media_discovery:
// approved | held_review | rejected | not_found + reason). Identity and rights rules:
// workers/soccer-ingest/src/media-wikimedia.js, workers/shared/media-rights.js,
// data/media/policy.json, docs/MEDIA.md.
//
// Identity tiers (never a name-only match):
//   portraits T1  Wikidata item by EXACT ESPN FC player id (P3681); birth date must agree
//   clubs         deterministic identity paths: roster proof (current club), dated roster proof,
//                 exact ESPN team id (P13590), exact OpenLigaDB team id -> Commons icon -> P154
//   portraits T2  inside a PROVEN club: exact name + exact birth date + overlapping club
//                 spell + unique candidate (the owner's attribute_corroborated rule)
// Approved files are downloaded once (Commons thumbnail), hashed and written write-once,
// content-addressed to R2 through the ingest admin route. Re-runs reuse verified copies.
//   node scripts/media/wikimedia-backfill.mjs [--limit N] [--dry] [--skip-teams]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { politeFetch } from '../../workers/shared/http.js';
import { syncRows, chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { normName } from '../../workers/soccer-ingest/src/identity.js';
import { wikidataByEspnIds, playerMatchVerdict, proveClubByRoster, clubFacts, commonsInfo, fileNameOf, mediaRow, clubMembers, corroborateInClub, clubsAtWindow, clubsByEspnTeamIds, clubsByLogoFiles, commonsFileFromUpload, resolveTeamIdentity, MEDIA_VERSION } from '../../workers/soccer-ingest/src/media-wikimedia.js';

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
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }
const discovery = new Map(); // key -> ledger row (last write wins; approvals set later)
const disc = (entity_type, entity_id, media_type, outcome, method, reason, extra = {}) => discovery.set(`${entity_type}:${entity_id}:${media_type}`, { entity_type, entity_id, media_type, outcome, method, reason, external_id: extra.external_id || null, source_url: extra.source_url || null, evidence: extra.evidence || {}, checked_at: new Date().toISOString() });

// ---- where each player was observed (sourced lineups), by team, with date windows
const lineups = await store.select('soccer_lineups', { columns: ['id', 'team_id', 'match_id'], order: 'id.asc' });
const lps = await selectIn('soccer_lineup_players', 'lineup_id', lineups.map(l => l.id), { columns: ['lineup_id', 'player_id'], order: 'lineup_id.asc,player_id.asc' });
const kick = new Map((await selectIn('soccer_matches', 'id', lineups.map(l => l.match_id), { columns: ['id', 'kickoff_at', 'competition_id'] })).map(m => [m.id, m]));
const lineupOf = new Map(lineups.map(l => [l.id, l]));
const windows = new Map(); // player -> team -> {from,to}
for (const r of lps) {
  const l = lineupOf.get(r.lineup_id); const m = kick.get(l.match_id); if (!m) continue;
  const d = new Date(m.kickoff_at).toISOString().slice(0, 10);
  const byTeam = windows.get(r.player_id) || new Map();
  const w = byTeam.get(l.team_id) || { from: d, to: d };
  if (d < w.from) w.from = d; if (d > w.to) w.to = d;
  byTeam.set(l.team_id, w); windows.set(r.player_id, byTeam);
}
log('players observed in lineups', windows.size);

// ---- T1: exact ESPN FC id
const xw = (await store.select('soccer_player_external_ids', { columns: ['external_id', 'player_id'], eq: { provider: 'espn' }, order: 'external_id.asc' })).slice(0, LIMIT);
const espnOf = new Map(xw.map(x => [x.player_id, x.external_id]));
const allPlayerIds = [...new Set([...xw.map(x => x.player_id), ...windows.keys()])];
const players = new Map((await selectIn('soccer_players', 'id', allPlayerIds, { columns: ['id', 'display_name', 'first_name', 'last_name', 'birth_date', 'status'] })).map(p => [p.id, { ...p, full_name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.display_name }]));
const wd = await wikidataByEspnIds(politeFetch, xw.map(x => x.external_id));
log('wikidata items for', wd.size, 'of', xw.length, 'espn ids');
report.players.espn_linked = xw.length; report.players.wikidata_items = wd.size; report.players.t1 = {}; report.players.t2 = {};
const portraitJobs = []; const qidOfPlayer = new Map();
for (const x of xw) {
  const p = players.get(x.player_id); if (!p || p.status !== 'active') continue;
  const cands = wd.get(x.external_id);
  if (cands?.length === 1 && !(p.birth_date && cands[0].dobs.length && !cands[0].dobs.includes(String(p.birth_date).slice(0, 10)))) qidOfPlayer.set(p.id, cands[0]);
  const v = playerMatchVerdict(p, cands);
  tally(report.players.t1, v.reason || 'ok');
  if (!v.ok) { disc('player', p.id, 'portrait', v.reason === 'birth_date_contradiction' || v.reason === 'espn_id_on_several_items' ? 'rejected' : 'not_found', 'wikidata_espn_fc_player_id', v.reason, { external_id: x.external_id, evidence: { qid: v.qid || null } }); continue; }
  portraitJobs.push({ player: p, qid: v.qid, file: fileNameOf(v.image), evidence: { method: 'wikidata_espn_fc_player_id', property: 'P3681', espn_id: x.external_id, qid: v.qid, birth_date_checked: v.dob_checked } });
}
log('T1 portrait candidates', portraitJobs.length, JSON.stringify(report.players.t1));

// ---- clubs: four deterministic identity paths (media-wikimedia.js header), never by name
const crestJobs = []; const clubOfTeam = new Map();
const roster = new Map();
for (const [pid, byTeam] of windows) for (const tid of byTeam.keys()) { if (!roster.has(tid)) roster.set(tid, new Set()); roster.get(tid).add(pid); }
const teams = new Map((await selectIn('soccer_teams', 'id', [...roster.keys()], { columns: ['id', 'name', 'slug'] })).map(t => [t.id, t]));
const teamExt = await selectIn('soccer_team_external_ids', 'team_id', [...roster.keys()], { columns: ['team_id', 'provider', 'external_id'] });
const extOf = (tid, prov) => teamExt.filter(x => x.team_id === tid && x.provider === prov).map(x => x.external_id);
// path 3: exact ESPN team id -> P13590
const espnTeamIds = [...new Set(teamExt.filter(x => x.provider === 'espn').map(x => x.external_id))];
const byEspnTeam = await clubsByEspnTeamIds(politeFetch, espnTeamIds);
// path 4: exact OpenLigaDB team id -> current-season teamIconUrl -> Commons file -> P154
const oldbSeason = new Date().getUTCMonth() >= 6 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
const oldbRes = await politeFetch(`https://api.openligadb.de/getavailableteams/bl1/${oldbSeason}`, { minIntervalMs: 700 });
const oldbTeams = oldbRes.status === 200 ? JSON.parse(new TextDecoder().decode(oldbRes.bytes)) : [];
const iconFileOfOldb = new Map(oldbTeams.map(t => [String(t.teamId), { file: commonsFileFromUpload(t.teamIconUrl), url: t.teamIconUrl }]));
const iconFiles = [...new Set([...iconFileOfOldb.values()].map(x => x.file).filter(Boolean))];
const byLogoFile = await clubsByLogoFiles(politeFetch, iconFiles);
report.teams.openligadb_icons = { teams: oldbTeams.length, commons: iconFiles.length, other_hosts: oldbTeams.length - iconFiles.length };
// facts for every club any path can name
const pathClubs = new Set([...qidOfPlayer.values()].flatMap(c => [...c.teams, ...(c.spells || []).map(s => s.club)]));
for (const l of byEspnTeam.values()) l.forEach(q => pathClubs.add(q));
for (const l of byLogoFile.values()) l.forEach(q => pathClubs.add(q));
const facts = await clubFacts(politeFetch, [...pathClubs]);
const isClub = q => facts.get(q)?.is_club;
const onlyClub = list => { const c = (list || []).filter(isClub); return c.length === 1 ? { qid: c[0] } : { qid: null, reason: c.length ? 'several_club_items' : 'no_club_item' }; };
const identities = new Map();
for (const [teamId, ps] of roster) {
  const matched = [...ps].filter(pid => qidOfPlayer.get(pid));
  const p1 = proveClubByRoster(matched.map(pid => qidOfPlayer.get(pid).teams.filter(isClub)).filter(c => c.length));
  const p2 = proveClubByRoster(matched.map(pid => clubsAtWindow(qidOfPlayer.get(pid).spells, windows.get(pid).get(teamId)).filter(isClub)).filter(c => c.length));
  const e3 = extOf(teamId, 'espn').map(id => onlyClub(byEspnTeam.get(String(id)))); const p3 = e3.find(x => x.qid) || { qid: null, reason: e3[0]?.reason || 'no_espn_team_id_on_wikidata' };
  const icons = extOf(teamId, 'openligadb').map(id => iconFileOfOldb.get(String(id))).filter(Boolean);
  // Competition consistency: the OpenLigaDB bl1 team is the senior club in the (2.) Bundesliga on Wikidata
  // (P118), which separates it from reserve / women's / season items that reuse the same logo file.
  const BL = new Set(['Q82595', 'Q151011']);
  const seniorClub = list => { const c = (list || []).filter(q => isClub(q) && (facts.get(q)?.leagues || []).some(l => BL.has(l))); return c.length === 1 ? { qid: c[0] } : { qid: null, reason: c.length ? 'several_bundesliga_club_items' : 'no_bundesliga_club_item' }; };
  const e4 = icons.map(i => (i.file ? { ...seniorClub(byLogoFile.get(i.file)), file: i.file } : { qid: null, reason: 'icon_not_on_commons' })); const p4 = e4.find(x => x.qid) || { qid: null, reason: icons.length ? e4[0].reason : 'no_openligadb_team' };
  identities.set(teamId, resolveTeamIdentity([
    { method: 'wikidata_roster_proof', qid: p1.qid, reason: p1.reason, evidence: { players_matched: p1.players_matched, top: p1.top, runner_up: p1.runner_up } },
    { method: 'wikidata_dated_roster_proof', qid: p2.qid, reason: p2.reason, evidence: { players_matched: p2.players_matched, top: p2.top, runner_up: p2.runner_up } },
    { method: 'espn_team_id_P13590', qid: p3.qid, reason: p3.qid ? 'exact' : p3.reason, evidence: { espn_team_ids: extOf(teamId, 'espn') } },
    { method: 'openligadb_team_icon_P154', qid: p4.qid, reason: p4.qid ? 'exact' : p4.reason, evidence: { openligadb_team_ids: extOf(teamId, 'openligadb'), file: p4.file || null } },
  ]));
}
const claim = new Map();
for (const [t, id] of identities) if (id.qid) claim.set(id.qid, [...(claim.get(id.qid) || []), t]);
report.teams.with_lineups = roster.size; report.teams.verdicts = {}; report.teams.methods = {}; report.teams.proofs = [];
for (const [teamId, id] of identities) {
  let reason = id.reason;
  if (id.qid && claim.get(id.qid).length > 1) reason = 'club_claimed_by_several_teams';
  const ok = reason === 'identity_proven';
  if (ok) { clubOfTeam.set(teamId, id.qid); for (const m of id.methods) tally(report.teams.methods, m); }
  const f = ok ? facts.get(id.qid) : null;
  if (ok && f.logos.length !== 1) reason = f.logos.length ? 'several_current_logos' : 'club_has_no_current_logo_on_wikidata';
  tally(report.teams.verdicts, reason);
  const evidence = { identity_methods: id.methods || [], paths: id.paths.map(p => ({ method: p.method, qid: p.qid, reason: p.reason, ...p.evidence })) };
  report.teams.proofs.push({ team: teams.get(teamId)?.name, qid: id.qid, reason, methods: id.methods || [] });
  if (reason !== 'identity_proven') { disc('team', teamId, 'crest', 'not_found', ok ? (id.methods || []).join('+') : 'deterministic_team_identity', reason, { external_id: id.qid || null, evidence }); continue; }
  crestJobs.push({ team: teams.get(teamId), qid: id.qid, file: fileNameOf(f.logos[0]), proof: evidence });
}
log('clubs proven', clubOfTeam.size, 'crest candidates', crestJobs.length, JSON.stringify(report.teams.verdicts), JSON.stringify(report.teams.methods));

// ---- T2: attribute corroboration inside proven clubs, for players T1 did not cover
const covered = new Set(portraitJobs.map(j => j.player.id));
for (const [teamId, qid] of clubOfTeam) {
  const since = [...(roster.get(teamId) || [])].map(pid => windows.get(pid)?.get(teamId)?.from).filter(Boolean).sort()[0] || null;
  let members;
  try { members = await clubMembers(politeFetch, qid, { since }); } catch (e) {
    try { members = await clubMembers(politeFetch, qid, { since }); } catch (e2) { tally(report.players.t2, 'club_members_query_failed'); log('T2 club members failed', qid, String(e2.message).slice(0, 80)); continue; }
  }
  for (const pid of roster.get(teamId) || []) {
    if (covered.has(pid)) continue;
    const p = players.get(pid); if (!p || p.status !== 'active') continue;
    const v = corroborateInClub(p, members, windows.get(pid).get(teamId), normName);
    tally(report.players.t2, v.reason || 'ok');
    if (!v.ok) { if (!discovery.has(`player:${pid}:portrait`)) disc('player', pid, 'portrait', v.reason === 'several_club_members_match' || v.reason === 'conflicting_birth_dates_on_item' ? 'held_review' : 'not_found', 'wikidata_club_attribute_corroboration', v.reason, { external_id: v.qid || null, evidence: { club_qid: qid } }); continue; }
    covered.add(pid);
    portraitJobs.push({ player: p, qid: v.qid, file: fileNameOf(v.image), evidence: { method: 'wikidata_club_attribute_corroboration', rule: 'exact name + exact birth date + overlapping spell at roster-proven club + unique', club_qid: qid, team_id: teamId, observed: windows.get(pid).get(teamId), qid: v.qid, spells: v.spells } });
  }
}
for (const pid of windows.keys()) if (!covered.has(pid) && !discovery.has(`player:${pid}:portrait`) && players.get(pid)?.status === 'active') disc('player', pid, 'portrait', 'not_found', espnOf.has(pid) ? 'wikidata_espn_fc_player_id' : 'wikidata_club_attribute_corroboration', espnOf.has(pid) ? 'no_wikidata_item_for_espn_id' : 'club_not_proven_or_no_espn_id');
log('T2', JSON.stringify(report.players.t2), 'portrait candidates total', portraitJobs.length);

// ---- Commons metadata + rights
const files = [...new Set([...portraitJobs, ...crestJobs].map(j => j.file))];
const info = await commonsInfo(politeFetch, files, { width: policy.thumb_width });
log('commons files', files.length, 'resolved', [...info.values()].filter(Boolean).length);
const rows = [];
const trademark = i => ((i.meta?.Restrictions?.value || '').split('|').includes('trademarked') ? 'trademark_notice' : 'none');
for (const j of [...portraitJobs.map(x => ({ ...x, entityType: 'player', entityId: x.player.id, mediaType: 'portrait' })), ...crestJobs.map(x => ({ ...x, entityType: 'team', entityId: x.team.id, mediaType: 'crest', evidence: { method: x.proof.identity_methods.join('+'), qid: x.qid, identity: x.proof } }))]) {
  const i = info.get(j.file); if (!i) { tally(report.files, 'commons_file_missing'); disc(j.entityType, j.entityId, j.mediaType, 'not_found', j.evidence.method, 'commons_file_missing', { external_id: j.qid }); continue; }
  const r = mediaRow({ entityType: j.entityType, entityId: j.entityId, mediaType: j.mediaType, info: i, sourceEntity: j.qid, policy, evidence: j.evidence });
  r.trademark_status = trademark(i); r.retrieved_at = new Date().toISOString();
  r.rejection_reason = r.rights_status === 'approved' ? null : (r.rights_notes || '').replace(/^media-rights\/[\d.]+ ?/, '') || r.rights_status;
  rows.push(r);
}
for (const r of rows) tally(report.rows, `${r.entity_type}:${r.rights_status}`);
log('rows', JSON.stringify(report.rows));

// ---- cache approved bytes (write-once, content-addressed) and mark primary
let cached = 0; let reused = 0;
const prior = new Map((await selectIn('soccer_entity_media', 'id', rows.map(r => r.id), { columns: ['id', 'url', 'object_key', 'content_sha256', 'cached_url', 'verified_at', 'mime'] })).map(x => [x.id, x]));
for (const r of rows.filter(x => x.rights_status === 'approved')) {
  if (DRY) break;
  const was = prior.get(r.id);
  if (was?.object_key && was.url === r.url) { Object.assign(r, { object_key: was.object_key, content_sha256: was.content_sha256, cached_url: was.cached_url, verified_at: new Date(was.verified_at).toISOString(), mime: was.mime, is_primary: true }); reused += 1; continue; }
  try {
    const res = await politeFetch(r.url, { minIntervalMs: 700, headers: { accept: 'image/*' } });
    if (res.status !== 200 || !/^image\//.test(res.contentType || '')) throw new Error(`HTTP ${res.status} ${res.contentType}`);
    const sha = createHash('sha256').update(res.bytes).digest('hex');
    const key = `soccer-source/media/sha256/${sha.slice(0, 2)}/${sha}`;
    const put = await fetch(`${INGEST}/v1/admin/raw?key=${encodeURIComponent(key)}`, { method: 'PUT', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': res.contentType }, body: res.bytes });
    const pj = await put.json();
    if (!(put.status === 201 || put.status === 200) || (pj.sha256 && pj.sha256 !== sha)) throw new Error(`R2 put ${put.status}`);
    Object.assign(r, { object_key: key, content_sha256: sha, cached_url: `/api/soccer/media/${sha}`, verified_at: new Date().toISOString(), is_primary: true, mime: res.contentType.split(';')[0] });
    cached += 1; if (cached % 50 === 0) log('cached', cached);
  } catch (e) {
    Object.assign(r, { rights_status: 'review_required', rights_notes: `${r.rights_notes} Cache failed: ${String(e.message).slice(0, 120)}`, rejection_reason: `cache failed: ${String(e.message).slice(0, 120)}` });
    tally(report.files, 'cache_failed');
  }
}
const seen = new Set();
for (const r of rows) { const k = `${r.entity_type}:${r.entity_id}:${r.media_type}`; if (r.is_primary && seen.has(k)) r.is_primary = false; if (r.is_primary) seen.add(k); }
for (const r of rows) disc(r.entity_type, r.entity_id, r.media_type, r.rights_status === 'approved' ? 'approved' : r.rights_status === 'review_required' ? 'held_review' : 'rejected', r.match_evidence.method, r.rights_status === 'approved' ? 'approved' : r.rejection_reason, { external_id: r.source_entity, source_url: r.source_url, evidence: { license: r.license, trademark_status: r.trademark_status } });
report.rows_after_cache = {}; for (const r of rows) tally(report.rows_after_cache, `${r.entity_type}:${r.rights_status}`);
report.cached = cached; report.reused = reused;
report.discovery = {}; for (const d of discovery.values()) tally(report.discovery, `${d.entity_type}:${d.outcome}`);
if (!DRY) {
  // Priority 1 is a free-licensed crest/portrait: it replaces an owner-approved provider primary.
  for (const r of rows.filter(x => x.is_primary && x.rights_status === 'approved')) await store.update('soccer_entity_media', { is_primary: false }, { eq: { entity_type: r.entity_type, entity_id: r.entity_id, media_type: r.media_type, rights_status: 'owner_approved_identification', is_primary: true } });
  report.sync = await syncRows(store, { table: 'soccer_entity_media', key: ['id'], rows: rows.map(r => ({ is_primary: false, cached_url: null, object_key: null, content_sha256: null, verified_at: null, ...r })), touch: true });
  await store.upsert('soccer_media_discovery', [...discovery.values()], ['entity_type', 'entity_id', 'media_type']);
}

// ---- coverage by competition / club / active (active = in a lineup of the competition's latest season)
const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'] });
const latestSeason = new Map();
for (const c of comps) { const s = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1))[0]; if (s) latestSeason.set(c.id, s.id); }
const matchSeason = new Map((await selectIn('soccer_matches', 'id', lineups.map(l => l.match_id), { columns: ['id', 'season_id', 'competition_id'] })).map(m => [m.id, m]));
const withPhoto = new Set(rows.filter(r => r.entity_type === 'player' && r.rights_status === 'approved').map(r => r.entity_id));
const cov = {}; const byClub = {};
for (const r of lps) {
  const l = lineupOf.get(r.lineup_id); const m = matchSeason.get(l.match_id); if (!m) continue;
  const slug = comps.find(c => c.id === m.competition_id)?.slug; const active = latestSeason.get(m.competition_id) === m.season_id;
  const key = `${slug}:${active ? 'active' : 'historical'}`;
  (cov[key] = cov[key] || { players: new Set(), with_photo: new Set() }).players.add(r.player_id);
  if (withPhoto.has(r.player_id)) cov[key].with_photo.add(r.player_id);
  if (active) { const t = teams.get(l.team_id)?.name || l.team_id; (byClub[t] = byClub[t] || { players: new Set(), with_photo: new Set() }).players.add(r.player_id); if (withPhoto.has(r.player_id)) byClub[t].with_photo.add(r.player_id); }
}
report.coverage = Object.fromEntries(Object.entries(cov).map(([k, v]) => [k, { players: v.players.size, with_photo: v.with_photo.size, pct: Math.round((1000 * v.with_photo.size) / v.players.size) / 10 }]));
report.coverage_by_club_active = Object.fromEntries(Object.entries(byClub).sort((a, b) => b[1].with_photo.size / b[1].players.size - a[1].with_photo.size / a[1].players.size).map(([k, v]) => [k, `${v.with_photo.size}/${v.players.size}`]));
report.finished_at = new Date().toISOString(); report.elapsed_s = Math.round((Date.now() - t0) / 1000);
mkdirSync('docs/evidence/media', { recursive: true });
const file = `docs/evidence/media/wikimedia-${report.started_at.slice(0, 10)}${DRY ? '-dry' : ''}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
log('wrote', file, JSON.stringify({ rows: report.rows_after_cache, cached, reused, discovery: report.discovery }));
log('coverage', JSON.stringify(report.coverage));
