// Wikimedia media resolution (portraits + crests). Identity first, rights second:
//   PLAYER  -> Wikidata item via EXACT ESPN FC player id (P3681 = our ESPN athlete id);
//              one item per id, and a stated birth date must equal ours (else no media).
//   TEAM    -> Wikidata club via ROSTER PROOF: the current club (P54 without an end
//              date) shared by >= 60% (and >= 5) of the team's id-matched players, the
//              runner-up <= 30%, the item a football club, and no two canonical teams
//              claiming the same club. Never by name.
//   IMAGE   -> P18 (portrait) / P154 (logo) file on Commons; rights per file via
//              media-rights.js. The URL existing is not permission.
import { uuidv5 } from '../../shared/ids.js';
import { classifyCommons } from '../../shared/media-rights.js';

export const MEDIA_VERSION = 'media-wikimedia/1.0.0';
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
    const rows = await sparql(fetcher, `SELECT ?item ?espn ?img ?dob (GROUP_CONCAT(DISTINCT ?team; separator=" ") AS ?teams) WHERE {
      VALUES ?espn { ${values} } ?item wdt:P3681 ?espn .
      OPTIONAL { ?item wdt:P18 ?img } OPTIONAL { ?item wdt:P569 ?dob }
      OPTIONAL { ?item p:P54 ?st . ?st ps:P54 ?team . FILTER NOT EXISTS { ?st pq:P582 ?end } }
    } GROUP BY ?item ?espn ?img ?dob`);
    for (const r of rows) {
      const id = r.espn.value; const qid = qidOf(r.item.value);
      const list = out.get(id) || [];
      let e = list.find(x => x.qid === qid);
      if (!e) { e = { qid, images: [], dobs: [], teams: [] }; list.push(e); }
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
    const rows = await sparql(fetcher, `SELECT ?club ?type ?logo WHERE { VALUES ?club { ${values} } OPTIONAL { ?club wdt:P31 ?type } OPTIONAL { ?club wdt:P154 ?logo } }`);
    for (const r of rows) {
      const q = qidOf(r.club.value);
      const e = out.get(q) || { qid: q, types: [], logos: [] };
      if (r.type && !e.types.includes(qidOf(r.type.value))) e.types.push(qidOf(r.type.value));
      if (r.logo && !e.logos.includes(r.logo.value)) e.logos.push(r.logo.value);
      out.set(q, e);
    }
  }
  for (const e of out.values()) e.is_club = e.types.some(t => CLUB_TYPES.has(t));
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
export async function clubMembers(fetcher, clubQid) {
  const rows = await sparql(fetcher, `SELECT ?p ?dob ?img ?start ?end ?name WHERE {
    ?p p:P54 ?st . ?st ps:P54 wd:${clubQid} . ?p wdt:P569 ?dob . ?p wdt:P18 ?img .
    OPTIONAL { ?st pq:P580 ?start } OPTIONAL { ?st pq:P582 ?end }
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
