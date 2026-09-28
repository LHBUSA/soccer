// ESPN -> TheSportsDB (id crosswalk only) -> Wikidata: exact ids and birth-date agreement, never names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tsdbExactEspn, wikidataAgrees } from '../workers/soccer-ingest/src/media-crosswalk.js';

const rec = (o = {}) => ({ idPlayer: '34176462', idESPN: '268731', idWikidata: 'Q81040518', dateBorn: '2000-07-04', ...o });
const claim = (v, rank = 'normal') => ({ rank, mainsnak: { datavalue: { value: v } } });
const item = (o = {}) => ({ claims: { P31: [claim({ id: 'Q5' })], P569: [claim({ time: '+2000-07-04T00:00:00Z', precision: 11 })], P18: [claim('Osaze Urhoghide.jpg')], ...o } });

test('crosswalk: only the TheSportsDB record whose idESPN equals ours', () => {
  assert.deepEqual(tsdbExactEspn('268731', [rec(), rec({ idPlayer: '9', idESPN: '1' })]).qid, 'Q81040518');
  assert.equal(tsdbExactEspn('26873', [rec()]).reason, 'no_tsdb_record_with_exact_espn_id', 'no prefix / fuzzy id');
  assert.equal(tsdbExactEspn('268731', [rec(), rec({ idPlayer: '2' })]).reason, 'espn_id_on_several_tsdb_records');
  assert.equal(tsdbExactEspn('268731', [rec({ idWikidata: null })]).reason, 'tsdb_record_has_no_wikidata_id');
  assert.equal(tsdbExactEspn('268731', [rec({ idWikidata: 'not-a-qid' })]).reason, 'tsdb_record_has_no_wikidata_id');
});

test('wikidata must agree: human, same day-precision birth date, no different ESPN id, one image', () => {
  assert.equal(wikidataAgrees(item(), { birthDate: '2000-07-04', espnId: '268731' }).image, 'Osaze Urhoghide.jpg');
  assert.equal(wikidataAgrees(item(), { birthDate: '2000-07-05', espnId: '268731' }).reason, 'birth_date_contradiction');
  assert.equal(wikidataAgrees(item(), { birthDate: null, espnId: '268731' }).reason, 'no_birth_date_on_our_record');
  assert.equal(wikidataAgrees(item({ P569: [claim({ time: '+2000-00-00T00:00:00Z', precision: 9 })] }), { birthDate: '2000-07-04', espnId: '1' }).reason, 'no_day_precision_birth_date_on_wikidata');
  assert.equal(wikidataAgrees(item({ P3681: [claim('999')] }), { birthDate: '2000-07-04', espnId: '268731' }).reason, 'wikidata_has_different_espn_id');
  assert.equal(wikidataAgrees(item({ P3681: [claim('268731')] }), { birthDate: '2000-07-04', espnId: '268731' }).ok, true);
  assert.equal(wikidataAgrees(item({ P31: [claim({ id: 'Q476028' })] }), { birthDate: '2000-07-04', espnId: '268731' }).reason, 'not_a_human');
  assert.equal(wikidataAgrees(item({ P18: [] }), { birthDate: '2000-07-04', espnId: '268731' }).reason, 'no_image');
  assert.equal(wikidataAgrees(item({ P18: [claim('a.jpg'), claim('b.jpg')] }), { birthDate: '2000-07-04', espnId: '268731' }).reason, 'several_images');
  assert.equal(wikidataAgrees({ missing: '' }, { birthDate: '2000-07-04', espnId: '268731' }).reason, 'wikidata_item_missing');
});
