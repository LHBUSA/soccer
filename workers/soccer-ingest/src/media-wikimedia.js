// Wikimedia media resolution (portraits + crests). Identity first, rights second:
//   PLAYER  -> Wikidata item via EXACT ESPN FC player id (P3681 = our ESPN athlete id);
//              one item per id, and a stated birth date must equal ours (else no media).
//   TEAM    -> Wikidata club by one of four DETERMINISTIC paths (never by name):
//              roster proof (current club P54 of >= 5 id-matched players, >= 60%, runner-up
//              <= 30%); dated roster proof (same thresholds, the P54 spell overlapping the dates
//              we observed each player at this team); exact ESPN team id (P13590) on exactly one
//              club item; exact OpenLigaDB team id -> its Commons icon file -> exactly one club
//              whose logo (P154) is that file. Paths that disagree, or a club claimed by two
//              canonical teams, give no identity.
//   IMAGE   -> P18 (portrait) / P154 (logo) file on Commons; rights per file via
//              media-rights.js. The URL existing is not permission.
import { uuidv5 } from '../../shared/ids.js';
import { classifyCommons } from '../../shared/media-rights.js';

export const MEDIA_VERSION = 'media-wikimedia/1.1.0'; // 1.1.0: dated roster proof, ESPN team id, OpenLigaDB icon identity; current-logo choice
export const SPARQL = 'https://query.wikidata.org/sparql';
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
// association football club, soccer club (US usage), women's association football club
export const CLUB_TYPES = new Set(['Q476028', 'Q103229495', 'Q61740358']);

const qidOf = uri => String(uri || '').split('/').pop();
export const fileNameOf = uri => decodeURIComponent(String(uri || '').split('/Special:FilePath/').pop() || '').replace(/_/g, ' ');

export function mediaId(entityType, entityId, mediaType, sourceUrl) {
  return uuidv5(`media:${entityType}:${entityId}:${mediaType}:${sourceUrl}`);
}

async function sparql(fetcher, query) {
  const res = await fetcher(`${SPARQL}?format=json&query=${encodeURIComponent(query)}`, { headers: { accept: 'application/sparql-results+json' }, minIntervalMs: 1500 });
  if (res.status !== 200) throw new Error(`wikidata sparql HTTP ${res.status}`);
  return JSON.parse(new TextDecoder().decode(res.bytes)).results.bindings;
}

// ESPN athlete ids -> Wikidata items (image, birth date, current clubs).
export async function wikidataByEspnIds(fetcher, espnIds, { batch = 120 } = {}) {
  const out = new Map();
  for (let i = 0; i < espnIds.length; i += batch) {
    const values = espnIds.slice(i, i + batch).map(id => `"${String(id).replace(/\D/g, '')}"`).join(' ');
    const rows = await sparql(fetcher, `SELECT ?item ?espn ?img ?dob (GROUP_CONCAT(DISTINCT ?team; separator=" ") AS ?teams) (GROUP_CONCAT(DISTINCT ?spell; separator=" ") AS ?spells) WHERE {
      VALUES ?espn { ${values} } ?item wdt:P3681 ?espn .
      OPTIONAL { ?item wdt:P18 ?img } OPTIONAL { ?item wdt:P569 ?dob }
      OPTIONAL { ?item p:P54 ?st . ?st ps:P54 ?team . FILTER NOT EXISTS { ?st pq:P582 ?end } }
      OPTIONAL { ?item p:P54 ?s2 . ?s2 ps:P54 ?club2 . OPTIONAL { ?s2 pq:P580 ?a } OPTIONAL { ?s2 pq:P582 ?b }
        BIND(CONCAT(STRAFTER(STR(?club2), 'entity/'), '|', COALESCE(SUBSTR(STR(?a), 1, 10), ''), '|', COALESCE(SUBSTR(STR(?b), 1, 10), '')) AS ?spell) }
    } GROUP BY ?item ?espn ?img ?dob`);
    for (const r of rows) {
      const id = r.espn.value; const qid = qidOf(r.item.value);
      const list = out.get(id) || [];
      let e = list.find(x => x.qid === qid);
      if (!e) { e = { qid, images: [], dobs: [], teams: [], spells: [] }; list.push(e); }
      for (const sp of (r.spells?.value || '').split(' ').filter(Boolean)) { const [club, start, end] = sp.split('|'); if (!e.spells.some(x => x.club === club && x.start === (start || null) && x.end === (end || null))) e.spells.push({ club, start: start || null, end: end || null }); }
      if (r.img && !e.images.includes(r.img.value)) e.images.push(r.img.value);
      if (r.dob && !e.dobs.includes(r.dob.value.slice(0, 10))) e.dobs.push(r.dob.value.slice(0, 10));
      for (const t of (r.teams?.value || '').split(' ').filter(Boolean).map(qidOf)) if (!e.teams.includes(t)) e.teams.push(t);
      out.set(id, list);
    }
  }
  return out;
}

// Decide whether a Wikidata match may carry media for a canonical player.
export function playerMatchVerdict(canonical, candidates) {
  if (!candidates?.length) return { ok: false, reason: 'no_wikidata_item_for_espn_id' };
  if (candidates.length > 1) return { ok: false, reason: 'espn_id_on_several_items', qids: candidates.map(c => c.qid) };
  const c = candidates[0];
  const ours = canonical.birth_date ? String(canonical.birth_date).slice(0, 10) : null;
  if (ours && c.dobs.length && !c.dobs.includes(ours)) return { ok: false, reason: 'birth_date_contradiction', qid: c.qid, ours, theirs: c.dobs };
  if (c.images.length !== 1) return { ok: false, reason: c.images.length ? 'several_images' : 'no_image', qid: c.qid };
  return { ok: true, qid: c.qid, image: c.images[0], dob_checked: Boolean(ours && c.dobs.length) };
}

// Pure roster proof. clubsPerPlayer: array (one per id-matched player) of current club QIDs
// already filtered to football clubs.
export function proveClubByRoster(clubsPerPlayer, { min = 5, share = 0.6, runnerMax = 0.3 } = {}) {
  const n = clubsPerPlayer.length;
  const counts = new Map();
  for (const clubs of clubsPerPlayer) for (const q of new Set(clubs)) counts.set(q, (counts.get(q) || 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [top, runner] = ranked;
  const ev = { players_matched: n, top: top ? { qid: top[0], players: top[1] } : null, runner_up: runner ? { qid: runner[0], players: runner[1] } : null };
  if (n < min || !top) return { qid: null, reason: 'too_few_matched_players', ...ev };
  if (top[1] < min || top[1] / n < share) return { qid: null, reason: 'no_majority_club', ...ev };
  if (runner && runner[1] / n > runnerMax) return { qid: null, reason: 'runner_up_too_strong', ...ev };
  return { qid: top[0], reason: 'roster_proof', ...ev };
}

export async function clubFacts(fetcher, qids) {
  const out = new Map();
  for (let i = 0; i < qids.length; i += 150) {
    const values = qids.slice(i, i + 150).map(q => `wd:${q}`).join(' ');
    const rows = await sparql(fetcher, `SELECT ?club ?type ?logo ?rank ?lend ?country ?league WHERE { VALUES ?club { ${values} } OPTIONAL { ?club wdt:P31 ?type } OPTIONAL { ?club wdt:P17 ?country } OPTIONAL { ?club wdt:P118 ?league }
      OPTIONAL { ?club p:P154 ?ls . ?ls ps:P154 ?logo . ?ls wikibase:rank ?rank . OPTIONAL { ?ls pq:P582 ?lend } } }`);
    for (const r of rows) {
      const q = qidOf(r.club.value);
      const e = out.get(q) || { qid: q, types: [], logos: [], logo_statements: [], countries: [], leagues: [] };
      if (r.league && !e.leagues.includes(qidOf(r.league.value))) e.leagues.push(qidOf(r.league.value));
      if (r.type && !e.types.includes(qidOf(r.type.value))) e.types.push(qidOf(r.type.value));
      if (r.country && !e.countries.includes(qidOf(r.country.value))) e.countries.push(qidOf(r.country.value));
      if (r.logo && !e.logo_statements.some(x => x.file === r.logo.value)) e.logo_statements.push({ file: r.logo.value, preferred: /PreferredRank$/.test(r.rank?.value || ''), deprecated: /DeprecatedRank$/.test(r.rank?.value || ''), ended: !!r.lend });
      out.set(q, e);
    }
  }
  for (const e of out.values()) { e.is_club = e.types.some(t => CLUB_TYPES.has(t)); e.logos = currentLogos(e.logo_statements); }
  return out;
}

// Commons file metadata (<= 50 titles per call), thumbnails at `width`.
export async function commonsInfo(fetcher, fileNames, { width = 480 } = {}) {
  const out = new Map();
  for (let i = 0; i < fileNames.length; i += 50) {
    const titles = fileNames.slice(i, i + 50).map(f => `File:${f}`).join('|');
    const res = await fetcher(`${COMMONS_API}?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url|size|mime|sha1|extmetadata&iiurlwidth=${width}&titles=${encodeURIComponent(titles)}`, { minIntervalMs: 1000 });
    if (res.status !== 200) throw new Error(`commons HTTP ${res.status}`);
    const j = JSON.parse(new TextDecoder().decode(res.bytes));
    const norm = new Map((j.query?.normalized || []).map(n => [n.to, n.from]));
    for (const p of j.query?.pages || []) {
      const ii = p.imageinfo?.[0];
      const asked = (norm.get(p.title) || p.title).replace(/^File:/, '');
      if (!ii || p.missing) { out.set(asked, null); continue; }
      out.set(asked, { title: p.title, page_url: ii.descriptionurl, file_url: ii.url, thumb_url: ii.thumburl || ii.url, thumb_width: ii.thumbwidth || ii.width, thumb_height: ii.thumbheight || ii.height, mime: ii.thumbmime || ii.mime, meta: ii.extmetadata || {} });
    }
  }
  return out;
}

// Registry row (before bytes are cached). Only approved rows get bytes + primary.
export function mediaRow({ entityType, entityId, mediaType, info, sourceEntity, evidence, policy }) {
  const verdict = classifyCommons(info.meta, { mediaType, fileUrl: info.page_url, policy });
  // A crest is an emblem: a wide wordmark in a round mark is illegible, so it is not published.
  const ratio = info.thumb_width && info.thumb_height ? info.thumb_width / info.thumb_height : null;
  if (mediaType === 'crest' && verdict.rights_status === 'approved' && (ratio === null || ratio < 0.6 || ratio > 1.67)) {
    verdict.rights_status = 'review_required'; verdict.rights_notes = `${verdict.rights_notes} Shape ${info.thumb_width}x${info.thumb_height}: a wordmark, not an emblem.`;
  }
  return {
    id: mediaId(entityType, entityId, mediaType, info.page_url), entity_type: entityType, entity_id: entityId, media_type: mediaType,
    url: info.thumb_url, source: 'wikimedia_commons', source_url: info.page_url, source_entity: sourceEntity,
    match_evidence: { version: MEDIA_VERSION, ...evidence },
    ...verdict, mime: info.mime, width: info.thumb_width || null, height: info.thumb_height || null,
  };
}

// ---- Tier 2 portraits: attribute corroboration inside a PROVEN club --------------
// Mirrors the owner-approved attribute_corroborated identity rule, never a name match:
// exact normalized name (label or alias) + exact birth date + membership of the SAME
// club (QID proven by roster proof) in a period overlapping the seasons we observed the
// player at that club + exactly one candidate. Anything else is recorded, not attached.
const NAME_LANGS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'mul'];
// since (YYYY-MM-DD, optional): only spells that can overlap our observations (end >= since or open);
// the overlap is re-checked per player, this only keeps the query small for big clubs.
export async function clubMembers(fetcher, clubQid, { since = null } = {}) {
  const rows = await sparql(fetcher, `SELECT ?p ?dob ?img ?start ?end ?name WHERE {
    ?p p:P54 ?st . ?st ps:P54 wd:${clubQid} . ?p wdt:P569 ?dob . ?p wdt:P18 ?img .
    OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end }
    ${since && /^\d{4}-\d{2}-\d{2}$/.test(since) ? `FILTER(!BOUND(?end) || ?end >= "${since}T00:00:00Z"^^xsd:dateTime)` : ''}
    { ?p rdfs:label ?name } UNION { ?p skos:altLabel ?name }
    FILTER (LANG(?name) IN (${NAME_LANGS.map(l => `"${l}"`).join(',')}))
  }`);
  const out = new Map();
  for (const r of rows) {
    const q = qidOf(r.p.value);
    const e = out.get(q) || { qid: q, dobs: new Set(), images: new Set(), names: new Set(), spells: [] };
    e.dobs.add(r.dob.value.slice(0, 10)); e.images.add(r.img.value); e.names.add(r.name.value);
    const spell = { start: r.start?.value?.slice(0, 10) || null, end: r.end?.value?.slice(0, 10) || null };
    if (!e.spells.some(s => s.start === spell.start && s.end === spell.end)) e.spells.push(spell);
    out.set(q, e);
  }
  return [...out.values()].map(e => ({ ...e, dobs: [...e.dobs], images: [...e.images], names: [...e.names] }));
}

// window: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } observed at the club.
export function spellOverlaps(spells, window) {
  return spells.some(s => (!s.start || s.start <= window.to) && (!s.end || s.end >= window.from));
}

export function corroborateInClub(player, members, window, norm) {
  const want = norm(player.full_name || player.display_name);
  const dob = player.birth_date ? String(player.birth_date).slice(0, 10) : null;
  if (!dob || !want) return { ok: false, reason: 'no_birth_date_or_name' };
  const hits = members.filter(m => m.dobs.includes(dob) && m.names.some(n => norm(n) === want || norm(n) === norm(player.display_name)));
  if (!hits.length) return { ok: false, reason: 'no_club_member_with_same_name_and_birth_date' };
  if (hits.length > 1) return { ok: false, reason: 'several_club_members_match', qids: hits.map(h => h.qid) };
  const h = hits[0];
  if (h.dobs.length > 1) return { ok: false, reason: 'conflicting_birth_dates_on_item', qid: h.qid };
  if (!spellOverlaps(h.spells, window)) return { ok: false, reason: 'no_overlapping_club_spell', qid: h.qid };
  if (h.images.length !== 1) return { ok: false, reason: h.images.length ? 'several_images' : 'no_image', qid: h.qid };
  return { ok: true, qid: h.qid, image: h.images[0], spells: h.spells };
}

// The club's CURRENT logo(s): drop deprecated and ended statements; if a preferred-rank statement
// exists, only preferred ones count. The caller requires exactly one.
export function currentLogos(statements = []) {
  const live = statements.filter(x => !x.deprecated && !x.ended);
  const pref = live.filter(x => x.preferred);
  return (pref.length ? pref : live).map(x => x.file);
}

// Dated roster proof input: per id-matched player, the clubs whose P54 spell overlaps the dates we
// observed that player at this team (same thresholds as the current-club proof).
export function clubsAtWindow(spells, window) {
  return [...new Set((spells || []).filter(s => (!s.start || s.start <= window.to) && (!s.end || s.end >= window.from)).map(s => s.club))];
}

// Exact ESPN team id (Wikidata P13590 "espn.com soccer team ID") -> club items.
export async function clubsByEspnTeamIds(fetcher, ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 150) {
    const values = ids.slice(i, i + 150).map(id => `"${String(id).replace(/\D/g, '')}"`).join(' ');
    for (const r of await sparql(fetcher, `SELECT ?item ?id WHERE { VALUES ?id { ${values} } ?item wdt:P13590 ?id . }`)) {
      const list = out.get(r.id.value) || []; const q = qidOf(r.item.value); if (!list.includes(q)) list.push(q); out.set(r.id.value, list);
    }
  }
  return out;
}

// Commons file (exact file name) -> items whose logo (P154) is that exact file.
export async function clubsByLogoFiles(fetcher, fileNames) {
  const out = new Map();
  for (let i = 0; i < fileNames.length; i += 60) {
    // Wikidata stores commonsMedia IRIs with %20 for spaces (not underscores).
    const values = fileNames.slice(i, i + 60).map(f => `<http://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(f.replace(/_/g, ' '))}>`).join(' ');
    for (const r of await sparql(fetcher, `SELECT ?item ?logo WHERE { VALUES ?logo { ${values} } ?item wdt:P154 ?logo . }`)) {
      const f = fileNameOf(r.logo.value); const list = out.get(f) || []; const q = qidOf(r.item.value); if (!list.includes(q)) list.push(q); out.set(f, list);
    }
  }
  return out;
}

// A Commons upload URL -> the exact Commons file name; any other host (Imgur, club or federation
// sites) -> null: a URL a provider hands us is never a licence.
export function commonsFileFromUpload(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (u.host !== 'upload.wikimedia.org') return null;
  const m = u.pathname.match(/^\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/]+)/);
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
}

// Combine identity paths for one canonical team: every path that yields a club must agree.
export function resolveTeamIdentity(paths) {
  const found = paths.filter(p => p.qid);
  if (!found.length) return { qid: null, reason: paths.map(p => `${p.method}:${p.reason}`).join(';'), paths };
  const qids = [...new Set(found.map(p => p.qid))];
  if (qids.length > 1) return { qid: null, reason: 'identity_paths_disagree', paths };
  return { qid: qids[0], reason: 'identity_proven', methods: found.map(p => p.method), paths };
}
