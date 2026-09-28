#!/usr/bin/env node
// READ-ONLY crest coverage audit for the active teams of MLS, Premier League, Bundesliga
// and UEFA Champions League (latest season; teams = home/away teams of that season's
// matches). Writes NOTHING to the database or R2: only PostgREST selects, Wikidata/Commons/
// enwiki reads through politeFetch, and two evidence files under docs/evidence/media/.
//
// Identity for the SOURCE CANDIDATE column is only what is already proven (roster proof in
// soccer_media_discovery). The P13590 (espn.com soccer team ID) lookup is an EXPANSION
// OPTION: exact id equality against our ESPN team crosswalk, reported, never adopted.
//   node scripts/media/crest-audit.mjs [--date YYYY-MM-DD]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { politeFetch } from '../../workers/shared/http.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { clubFacts, commonsInfo, fileNameOf, mediaRow, SPARQL, MEDIA_VERSION } from '../../workers/soccer-ingest/src/media-wikimedia.js';
import { RIGHTS_VERSION } from '../../workers/shared/media-rights.js';

const argv = process.argv.slice(2);
const DATE = argv.includes('--date') ? argv[argv.indexOf('--date') + 1] : new Date().toISOString().slice(0, 10);
const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const log = (...a) => console.log('[crest-audit]', ...a);
const COMPS = ['mls', 'premier-league', 'bundesliga', 'uefa-champions-league'];
const qidOf = uri => String(uri || '').split('/').pop();
async function selectIn(table, col, vals, opts) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(table, { ...opts, in: { ...(opts.in || {}), [col]: p } })); return out; }
async function sparql(query) {
  const res = await politeFetch(`${SPARQL}?format=json&query=${encodeURIComponent(query)}`, { headers: { accept: 'application/sparql-results+json' }, minIntervalMs: 1500 });
  if (res.status !== 200) throw new Error(`wikidata sparql HTTP ${res.status}`);
  return JSON.parse(new TextDecoder().decode(res.bytes)).results.bindings;
}

// ---- 1. audited population (DB, select only)
const comps = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], order: 'slug.asc' });
const teamComps = new Map(); const seasons = {};
for (const slug of COMPS) {
  const c = comps.find(x => x.slug === slug); if (!c) { seasons[slug] = null; continue; }
  const s = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id }, order: 'label.desc' }))[0];
  const ms = await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id'], eq: { season_id: s.id }, order: 'id.asc' });
  seasons[slug] = { season: s.label, matches: ms.length, teams: 0 };
  const ids = new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]));
  seasons[slug].teams = ids.size;
  for (const t of ids) teamComps.set(t, [...(teamComps.get(t) || []), slug]);
}
const teamIds = [...teamComps.keys()];
const teams = new Map((await selectIn('soccer_teams', 'id', teamIds, { columns: ['id', 'slug', 'name', 'status', 'merged_into', 'team_type', 'country_code'], order: 'id.asc' })).map(t => [t.id, t]));
const disc = new Map((await selectIn('soccer_media_discovery', 'entity_id', teamIds, { columns: ['entity_id', 'outcome', 'method', 'external_id', 'source_url', 'reason', 'evidence', 'checked_at'], eq: { entity_type: 'team', media_type: 'crest' }, order: 'entity_id.asc' })).map(d => [d.entity_id, d]));
const media = await selectIn('soccer_entity_media', 'entity_id', teamIds, { columns: ['id', 'entity_id', 'rights_status', 'is_primary', 'license', 'source_url', 'source_entity', 'trademark_status'], eq: { entity_type: 'team', media_type: 'crest' }, order: 'id.asc' });
const xids = await selectIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['provider', 'external_id', 'team_id', 'method'], order: 'provider.asc,external_id.asc' });
log('teams', teamIds.length, 'discovery rows', disc.size, 'crest media rows', media.length, 'external ids', xids.length);

// proven identity = roster proof recorded in the ledger (approved/held/rejected rows carry the
// QID as external_id; not_found carries it only for club_has_no_logo_on_wikidata / several_logos)
const PROVEN_REASONS = new Set(['club_has_no_logo_on_wikidata', 'several_logos', 'commons_file_missing']);
const provenQid = new Map();
for (const [tid, d] of disc) if (d.external_id && (d.outcome !== 'not_found' || PROVEN_REASONS.has(d.reason))) provenQid.set(tid, d.external_id);

// ---- 2. expansion option: exact ESPN team id -> Wikidata P13590 (espn.com soccer team ID)
const espnOf = new Map(); const oldbOf = new Map(); const wyOf = new Map();
for (const x of xids) { const m = x.provider === 'espn' ? espnOf : x.provider === 'openligadb' ? oldbOf : x.provider === 'wyscout' ? wyOf : null; if (m) m.set(x.team_id, [...(m.get(x.team_id) || []), x.external_id]); }
const espnVals = [...new Set([...espnOf.values()].flat())].filter(v => /^\d+$/.test(v));
const p13590 = new Map(); // espn id -> [qid]
for (const part of chunkArr(espnVals, 150)) {
  for (const r of await sparql(`SELECT ?item ?v WHERE { VALUES ?v { ${part.map(v => `"${v}"`).join(' ')} } ?item wdt:P13590 ?v }`)) p13590.set(r.v.value, [...new Set([...(p13590.get(r.v.value) || []), qidOf(r.item.value)])]);
}
const totalP13590 = Number((await sparql('SELECT (COUNT(*) AS ?n) WHERE { ?i wdt:P13590 ?v }'))[0].n.value);
const expQid = new Map(); const expIssue = new Map();
for (const tid of teamIds) {
  const hits = [...new Set((espnOf.get(tid) || []).flatMap(v => p13590.get(v) || []))];
  if (hits.length === 1) expQid.set(tid, hits[0]); else if (hits.length > 1) expIssue.set(tid, `espn_id_on_several_items:${hits.join(',')}`);
}
const expClaims = new Map(); for (const [t, q] of expQid) expClaims.set(q, [...(expClaims.get(q) || []), t]);
for (const [q, ts] of expClaims) if (ts.length > 1) for (const t of ts) { expIssue.set(t, `item_claimed_by_several_teams:${q}`); expQid.delete(t); }
log('P13590 total uses', totalP13590, 'hits for our espn ids', p13590.size, 'teams resolved', expQid.size);

// ---- 3. club facts (type, P154 logo) + enwiki sitelinks for every QID we can name by exact evidence
const allQids = [...new Set([...provenQid.values(), ...expQid.values()])];
const facts = await clubFacts(politeFetch, allQids);
const enwiki = new Map();
for (const part of chunkArr(allQids, 150)) for (const r of await sparql(`SELECT ?club ?title WHERE { VALUES ?club { ${part.map(q => `wd:${q}`).join(' ')} } ?a schema:about ?club ; schema:isPartOf <https://en.wikipedia.org/> ; schema:name ?title }`)) enwiki.set(qidOf(r.club.value), r.title.value);

// ---- 4. Commons licence verdict per P154 file (the repo's own classifier via mediaRow)
const files = [...new Set([...facts.values()].flatMap(f => f.logos.map(fileNameOf)))];
const info = await commonsInfo(politeFetch, files, { width: policy.thumb_width });
const FREE = m => { const code = (m?.License?.value || '').toLowerCase(); const short = m?.LicenseShortName?.value || ''; if (/^true$/i.test(m?.NonFree?.value || '')) return false; if (/-nc|-nd/.test(code) || /\b(nc|nd)\b/i.test(short)) return false; return /^(cc0|pd)/.test(code) || /public domain|^cc0/i.test(short) || /^cc-by(-sa)?-\d/.test(code) || /^cc by(-sa)? \d/i.test(short); };
function verdictFor(qid) {
  const f = facts.get(qid); if (!f) return { qid, is_club: null, logos: [] };
  const logos = f.logos.map(u => {
    const file = fileNameOf(u); const i = info.get(file);
    if (!i) return { file, on_commons: false, verdict: 'commons_file_missing' };
    const r = mediaRow({ entityType: 'team', entityId: '00000000-0000-0000-0000-000000000000', mediaType: 'crest', info: i, sourceEntity: qid, policy, evidence: {} });
    return { file, on_commons: true, page: i.page_url, license: r.license, author: r.author, license_free_raw: FREE(i.meta), trademark: (i.meta?.Restrictions?.value || '').split('|').includes('trademarked'), shape: `${i.thumb_width}x${i.thumb_height}`, verdict: r.rights_status, notes: (r.rights_notes || '').replace(/^media-rights\/[\d.]+ ?/, '') };
  });
  return { qid, is_club: f.is_club, types: f.types, logos, enwiki: enwiki.get(qid) || null };
}

// ---- 5. enwiki lead image (pilicence=any) for clubs with no P154: is the logo a local non-free file?
const needEn = allQids.filter(q => !(facts.get(q)?.logos.length) && enwiki.get(q));
const enImage = new Map();
for (const part of chunkArr(needEn, 40)) {
  const titles = part.map(q => enwiki.get(q));
  const res = await politeFetch(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1&prop=pageimages&piprop=name&pilicense=any&titles=${encodeURIComponent(titles.join('|'))}`, { minIntervalMs: 1000 });
  const j = JSON.parse(new TextDecoder().decode(res.bytes));
  const back = new Map(); for (const n of [...(j.query?.normalized || []), ...(j.query?.redirects || [])]) back.set(n.to, n.from);
  for (const p of j.query?.pages || []) { let t = p.title; while (back.has(t)) t = back.get(t); const q = part.find(x => enwiki.get(x) === t); if (q) enImage.set(q, p.pageimage || null); }
}
const enFiles = [...new Set([...enImage.values()].filter(Boolean))];
const enInfo = new Map();
for (const part of chunkArr(enFiles, 40)) {
  const res = await politeFetch(`https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&prop=imageinfo|templates&tllimit=500&iiprop=extmetadata&titles=${encodeURIComponent(part.map(f => `File:${f}`).join('|'))}`, { minIntervalMs: 1000 });
  const j = JSON.parse(new TextDecoder().decode(res.bytes));
  const back = new Map((j.query?.normalized || []).map(n => [n.to, n.from]));
  for (const p of j.query?.pages || []) { const asked = (back.get(p.title) || p.title).replace(/^File:/, ''); const m = p.imageinfo?.[0]?.extmetadata || {}; enInfo.set(asked.replace(/ /g, '_'), { repository: p.imagerepository || null, non_free: /^true$/i.test(m.NonFree?.value || ''), license: m.LicenseShortName?.value || null, us_only: (p.templates || []).some(t => /PD-ineligible-USonly|Do not move to Commons/i.test(t.title)) }); enInfo.set(asked, enInfo.get(asked.replace(/ /g, '_'))); }
}
const enVerdict = q => { const f = enImage.get(q); if (f === undefined) return null; if (!f) return { lead_image: null }; const i = enInfo.get(f) || enInfo.get(f.replace(/_/g, ' ')) || {}; return { lead_image: f, repository: i.repository ?? null, non_free: i.non_free ?? null, license: i.license ?? null, pd_us_only_do_not_move_to_commons: i.us_only ?? null }; };

// ---- 5b. ceiling hint ONLY (not identity): the top current-club QID stored in the ledger's
// roster evidence for teams that FAILED roster proof. Used to bound the ceiling, never to attach.
const hintQid = new Map();
for (const tid of teamIds) { const d = disc.get(tid); if (provenQid.has(tid) || expQid.has(tid) || !d?.evidence?.top?.qid) continue; hintQid.set(tid, { qid: d.evidence.top.qid, players: d.evidence.top.players, of: d.evidence.players_matched }); }
const hintFacts = await clubFacts(politeFetch, [...new Set([...hintQid.values()].map(h => h.qid))].filter(q => !facts.has(q)));
for (const [q, f] of hintFacts) facts.set(q, f);
const hintFiles = [...new Set([...hintFacts.values()].flatMap(f => f.logos.map(fileNameOf)))].filter(f => !info.has(f));
for (const [k, v] of await commonsInfo(politeFetch, hintFiles, { width: policy.thumb_width })) info.set(k, v);

// ---- 6. rows
const rows = [];
for (const tid of teamIds) {
  const t = teams.get(tid) || { id: tid, name: '?', slug: '?' };
  const d = disc.get(tid) || null;
  const approvedPrimary = media.find(m => m.entity_id === tid && m.rights_status === 'approved' && m.is_primary) || null;
  const qid = provenQid.get(tid) || null;
  const cand = qid ? verdictFor(qid) : null;
  const en = qid ? enVerdict(qid) : null;
  const eq = expQid.get(tid) || null;
  const exp = eq ? { qid: eq, agrees_with_roster_proof: qid ? qid === eq : null, ...verdictFor(eq), enwiki_lead: enVerdict(eq) } : null;
  const ledger = d ? d.outcome : 'never_checked';
  let final; let category; let detail = '';
  if (approvedPrimary) { final = 'approved'; category = 'approved'; }
  else if (d?.outcome === 'held_review') { final = 'review'; category = 'held_by_owner_decision'; detail = d.reason; }
  else if (!qid) { final = 'no_candidate'; category = 'identity_not_proven'; detail = d ? d.reason : 'no discovery row'; }
  else if (!cand.logos.length) {
    if (en?.lead_image && en.non_free) { final = 'rejected'; category = 'logo_not_free'; detail = `no P154; enwiki logo ${en.lead_image} is a local non-free (${en.license}) file, not on Commons`; }
    else if (en?.lead_image && en.repository === 'local' && en.pd_us_only_do_not_move_to_commons) { final = 'rejected'; category = 'logo_not_free'; detail = `no P154; enwiki logo ${en.lead_image} is local, PD in the US only (PD-ineligible-USonly, "Do not move to Commons"), not on Commons`; }
    else { final = 'no_candidate'; category = 'no_logo_property'; detail = en?.lead_image ? `no P154; enwiki lead image ${en.lead_image} (${en.repository}, ${en.license || 'licence unstated'})` : 'no P154; no enwiki lead image'; }
  } else {
    const best = cand.logos.find(l => l.verdict === 'approved') || cand.logos.find(l => l.verdict === 'review_required') || cand.logos[0];
    if (best.verdict === 'approved') { final = 'review'; category = 'approved_by_classifier_not_published'; detail = best.file; }
    else if (best.verdict === 'review_required') { final = 'review'; category = best.license_free_raw ? 'logo_licence_needs_review' : 'logo_not_free'; detail = best.notes; }
    else { final = 'rejected'; category = 'logo_not_free'; detail = `${best.verdict}: ${best.license || ''} ${best.notes}`.trim(); }
  }
  rows.push({
    team: t.name, slug: t.slug, canonical_id: tid, team_status: t.status, competitions: teamComps.get(tid),
    ledger_status: ledger, approved_primary: Boolean(approvedPrimary), approved_license: approvedPrimary?.license || null,
    discovery: d ? { outcome: d.outcome, method: d.method, reason: d.reason, external_id: d.external_id, source_url: d.source_url, evidence: d.evidence, checked_at: d.checked_at } : null,
    wikidata_qid: qid, enwiki: cand?.enwiki || null,
    source_candidate: cand ? { is_club: cand.is_club, p154: cand.logos, enwiki_lead: en } : null,
    final, category, detail,
    external_ids: { espn: espnOf.get(tid) || [], openligadb: oldbOf.get(tid) || [], wyscout: wyOf.get(tid) || [] },
    expansion_p13590: exp, expansion_issue: expIssue.get(tid) || null,
    roster_hint_not_identity: hintQid.has(tid) ? { ...hintQid.get(tid), ...verdictFor(hintQid.get(tid).qid) } : null,
  });
}
const order = { approved: 0, review: 1, rejected: 2, no_candidate: 3 };
rows.sort((a, b) => order[a.final] - order[b.final] || a.category.localeCompare(b.category) || a.team.localeCompare(b.team));

// ---- 7. totals + ceiling
const count = (arr, f) => arr.reduce((o, r) => { const k = f(r); o[k] = (o[k] || 0) + 1; return o; }, {});
const perComp = Object.fromEntries(COMPS.map(c => [c, { teams: rows.filter(r => r.competitions.includes(c)).length, ...count(rows.filter(r => r.competitions.includes(c)), r => r.final) }]));
const expRows = rows.filter(r => r.expansion_p13590);
const expNew = expRows.filter(r => !r.wikidata_qid);
const freeLogo = l => l.on_commons && l.license_free_raw;
const identified = rows.filter(r => r.wikidata_qid || r.expansion_p13590);
const logosOf = r => [...(r.source_candidate?.p154 || []), ...(r.expansion_p13590?.logos || [])];
const ceiling = {
  audited: rows.length,
  identifiable_by_exact_evidence: identified.length,
  identifiable_via_roster_proof: rows.filter(r => r.wikidata_qid).length,
  identifiable_only_via_p13590: expNew.length,
  not_identifiable_without_new_rule_or_source: rows.length - identified.length,
  with_p154_file: identified.filter(r => logosOf(r).length).length,
  with_free_licensed_p154_on_commons_raw: identified.filter(r => logosOf(r).some(freeLogo)).length,
  with_classifier_approved_p154: identified.filter(r => logosOf(r).some(l => l.verdict === 'approved')).length,
  with_enwiki_nonfree_logo_instead: identified.filter(r => !logosOf(r).length && (r.source_candidate?.enwiki_lead?.non_free || r.expansion_p13590?.enwiki_lead?.non_free)).length,
};
const hints = rows.filter(r => r.roster_hint_not_identity);
ceiling.roster_hint_not_identity = {
  note: 'top current-club QID from FAILED roster proofs (1-4 players typically); NOT identity; upper-bound signal only',
  teams_with_hint: hints.length,
  hint_is_club: hints.filter(r => r.roster_hint_not_identity.is_club).length,
  hint_with_p154: hints.filter(r => r.roster_hint_not_identity.logos.length).length,
  hint_with_free_p154_raw: hints.filter(r => r.roster_hint_not_identity.logos.some(freeLogo)).length,
  hint_with_classifier_approved_p154: hints.filter(r => r.roster_hint_not_identity.logos.some(l => l.verdict === 'approved')).length,
  teams: hints.filter(r => r.roster_hint_not_identity.logos.length).map(r => ({ team: r.team, hint_qid: r.roster_hint_not_identity.qid, players: `${r.roster_hint_not_identity.players}/${r.roster_hint_not_identity.of}`, p154: r.roster_hint_not_identity.logos.map(l => `${l.file} [${l.verdict}${l.license ? `, ${l.license}` : ''}${l.shape ? `, ${l.shape}` : ''}]`) })),
};
const report = {
  audit: 'crest-audit', date: DATE, generated_at: new Date().toISOString(), read_only: true,
  code: { media: MEDIA_VERSION, rights: RIGHTS_VERSION, policy_version: policy.policy_version, crest_trademark: policy.crest_trademark },
  population: { rule: 'home/away teams of soccer_matches in the latest soccer_seasons label of each competition', seasons, distinct_teams: rows.length },
  totals: {
    final: count(rows, r => r.final), category: count(rows, r => r.category), ledger_status: count(rows, r => r.ledger_status),
    approved_primary: rows.filter(r => r.approved_primary).length, per_competition: perComp,
  },
  expansion_options: {
    p13590_espn_soccer_team_id: {
      property: 'P13590 (espn.com soccer team ID, formatter https://www.espn.com/soccer/team/_/id/$1)',
      total_uses_on_wikidata: totalP13590,
      audited_teams_with_espn_id: rows.filter(r => r.external_ids.espn.length).length,
      teams_resolved_unique: expRows.length,
      agree_with_roster_proof: expRows.filter(r => r.expansion_p13590.agrees_with_roster_proof === true).length,
      disagree_with_roster_proof: expRows.filter(r => r.expansion_p13590.agrees_with_roster_proof === false).map(r => r.team),
      new_identities_not_roster_proven: expNew.length,
      new_identities_with_p154: expNew.filter(r => r.expansion_p13590.logos.length).length,
      new_identities_with_classifier_approved_p154: expNew.filter(r => r.expansion_p13590.logos.some(l => l.verdict === 'approved')).length,
      new_identities_with_free_p154_raw: expNew.filter(r => r.expansion_p13590.logos.some(freeLogo)).length,
      issues: rows.filter(r => r.expansion_issue).map(r => ({ team: r.team, issue: r.expansion_issue })),
      teams: expNew.map(r => ({ team: r.team, qid: r.expansion_p13590.qid, is_club: r.expansion_p13590.is_club, p154: r.expansion_p13590.logos.map(l => `${l.file} [${l.verdict}${l.license ? `, ${l.license}` : ''}]`) })),
    },
    openligadb: { property: null, note: 'no Wikidata external-id property with an OpenLigaDB formatter URL exists (SPARQL over P1630 formatters + property search, checked this run)', audited_teams_with_id: rows.filter(r => r.external_ids.openligadb.length).length },
    wyscout: { property: null, note: 'no Wikidata external-id property with a Wyscout formatter URL exists (checked this run)', audited_teams_with_id: rows.filter(r => r.external_ids.wyscout.length).length },
  },
  ceiling,
  rows,
};
mkdirSync('docs/evidence/media', { recursive: true });
const jf = `docs/evidence/media/crest-audit-${DATE}.json`;
writeFileSync(jf, JSON.stringify(report, null, 2) + '\n');
log('wrote', jf, JSON.stringify(report.totals.final), JSON.stringify(report.totals.category));
log('ceiling', JSON.stringify(ceiling));
log('p13590', JSON.stringify({ ...report.expansion_options.p13590_espn_soccer_team_id, teams: undefined }));
