// Player identity through an EXACT external-id crosswalk (TheSportsDB used ONLY as an id crosswalk,
// never as an image source): our ESPN athlete id == TheSportsDB idESPN (exactly one record) ->
// that record's idWikidata -> the Wikidata item must agree: same birth date as ours, and no DIFFERENT
// ESPN FC id (P3681). Name search only LOCATES candidate records; it never proves anything.
// The item's P18 then goes through the unchanged Commons rights classifier (media-rights.js).

export const CROSSWALK_VERSION = 'media-crosswalk/1.0.0';

// Candidate TheSportsDB player records (full lookups) -> the one whose idESPN equals ours.
export function tsdbExactEspn(espnId, records) {
  const hits = (records || []).filter(r => r && String(r.idESPN || '').trim() === String(espnId));
  const qids = [...new Set(hits.map(r => String(r.idWikidata || '').trim()).filter(q => /^Q\d+$/.test(q)))];
  if (!hits.length) return { ok: false, reason: 'no_tsdb_record_with_exact_espn_id' };
  if (new Set(hits.map(r => String(r.idPlayer))).size > 1) return { ok: false, reason: 'espn_id_on_several_tsdb_records' };
  if (qids.length !== 1) return { ok: false, reason: qids.length ? 'several_wikidata_ids' : 'tsdb_record_has_no_wikidata_id' };
  return { ok: true, qid: qids[0], tsdb_id: String(hits[0].idPlayer), tsdb_dob: hits[0].dateBorn || null, transfermarkt: hits[0].idTransferMkt || null };
}

// A Wikidata item (wbgetentities JSON) must agree with our player record before its image is used.
export function wikidataAgrees(item, { birthDate, espnId }) {
  if (!item || item.missing !== undefined) return { ok: false, reason: 'wikidata_item_missing' };
  const claims = item.claims || {};
  const vals = p => (claims[p] || []).filter(c => c.rank !== 'deprecated').map(c => c.mainsnak?.datavalue?.value).filter(Boolean);
  const human = vals('P31').some(v => v.id === 'Q5');
  if (!human) return { ok: false, reason: 'not_a_human' };
  const espn = vals('P3681').map(String);
  if (espn.length && !espn.includes(String(espnId))) return { ok: false, reason: 'wikidata_has_different_espn_id' };
  const dobs = vals('P569').filter(v => v.precision >= 11).map(v => String(v.time).replace(/^\+/, '').slice(0, 10));
  if (!birthDate) return { ok: false, reason: 'no_birth_date_on_our_record' };
  if (!dobs.length) return { ok: false, reason: 'no_day_precision_birth_date_on_wikidata' };
  if (!dobs.includes(String(birthDate).slice(0, 10))) return { ok: false, reason: 'birth_date_contradiction' };
  const images = vals('P18');
  if (images.length !== 1) return { ok: false, reason: images.length ? 'several_images' : 'no_image' };
  return { ok: true, image: String(images[0]), espn_on_item: espn.length > 0 };
}
