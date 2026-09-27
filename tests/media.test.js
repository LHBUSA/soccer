import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCommons } from '../workers/shared/media-rights.js';
import { playerMatchVerdict, proveClubByRoster, fileNameOf, mediaRow } from '../workers/soccer-ingest/src/media-wikimedia.js';

const meta = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]));

test('rights: free licences approved only with author + licence URL; NC/ND restricted; non-free rejected', () => {
  const ok = classifyCommons(meta({ LicenseShortName: 'CC BY-SA 4.0', License: 'cc-by-sa-4.0', LicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0', Artist: '<a href="//x">Jane Doe</a>' }));
  assert.equal(ok.rights_status, 'approved'); assert.equal(ok.author, 'Jane Doe');
  assert.equal(ok.attribution, 'Jane Doe, CC BY-SA 4.0, via Wikimedia Commons');
  assert.equal(classifyCommons(meta({ LicenseShortName: 'CC BY-SA 4.0', License: 'cc-by-sa-4.0', LicenseUrl: 'https://c/l' })).rights_status, 'review_required'); // no author
  assert.equal(classifyCommons(meta({ LicenseShortName: 'CC BY-NC 2.0', License: 'cc-by-nc-2.0', LicenseUrl: 'https://c', Artist: 'A' })).rights_status, 'restricted');
  assert.equal(classifyCommons(meta({ LicenseShortName: 'CC BY-ND 4.0', License: 'cc-by-nd-4.0', LicenseUrl: 'https://c', Artist: 'A' })).rights_status, 'restricted');
  assert.equal(classifyCommons(meta({ LicenseShortName: 'Fair use', NonFree: 'true' })).rights_status, 'rejected');
  assert.equal(classifyCommons(meta({ LicenseShortName: 'GFDL', License: 'gfdl', Artist: 'A' })).rights_status, 'review_required');
  assert.equal(classifyCommons(meta({})).rights_status, 'review_required');
  const pd = classifyCommons(meta({ LicenseShortName: 'Public domain', License: 'pd', Restrictions: 'trademarked' }), { mediaType: 'crest', fileUrl: 'https://commons.wikimedia.org/wiki/File:X.svg' });
  assert.equal(pd.rights_status, 'approved'); assert.equal(pd.license_url, 'https://commons.wikimedia.org/wiki/File:X.svg'); assert.match(pd.rights_notes, /trademark/);
  assert.equal(classifyCommons(meta({ LicenseShortName: 'Public domain', License: 'pd', Restrictions: 'trademarked' }), { mediaType: 'crest', policy: { crest_trademark: 'review' } }).rights_status, 'review_required');
  assert.match(classifyCommons(meta({ LicenseShortName: 'CC BY 2.0', License: 'cc-by-2.0', LicenseUrl: 'https://c', Artist: 'A', Restrictions: 'personality' })).rights_notes, /personality/);
});

test('player media identity: exact id, one item, one image, no birth-date contradiction', () => {
  const p = { birth_date: '2001-09-05' };
  assert.equal(playerMatchVerdict(p, undefined).reason, 'no_wikidata_item_for_espn_id');
  assert.equal(playerMatchVerdict(p, [{ qid: 'Q1', images: ['i'], dobs: [] }, { qid: 'Q2', images: ['i'], dobs: [] }]).reason, 'espn_id_on_several_items');
  assert.equal(playerMatchVerdict(p, [{ qid: 'Q1', images: ['i'], dobs: ['2001-09-06'] }]).reason, 'birth_date_contradiction');
  assert.equal(playerMatchVerdict(p, [{ qid: 'Q1', images: [], dobs: ['2001-09-05'] }]).reason, 'no_image');
  const ok = playerMatchVerdict(p, [{ qid: 'Q1', images: ['http://commons.wikimedia.org/wiki/Special:FilePath/Bukayo%20Saka%202023.jpg'], dobs: ['2001-09-05'] }]);
  assert.equal(ok.ok, true); assert.equal(ok.dob_checked, true);
  assert.equal(fileNameOf(ok.image), 'Bukayo Saka 2023.jpg');
});

test('club identity: roster proof needs a clear majority, never a name', () => {
  const six = Array.from({ length: 6 }, () => ['Q9617']);
  assert.equal(proveClubByRoster(six).qid, 'Q9617');
  assert.equal(proveClubByRoster(six.slice(0, 4)).reason, 'too_few_matched_players');
  assert.equal(proveClubByRoster([...six, ['Q1'], ['Q1'], ['Q1'], ['Q1']]).reason, 'runner_up_too_strong');
  assert.equal(proveClubByRoster([['Q1'], ['Q2'], ['Q3'], ['Q4'], ['Q5'], ['Q6']]).reason, 'no_majority_club');
  assert.equal(proveClubByRoster([...six, ['Q9617', 'Q2']]).qid, 'Q9617'); // loan + parent club: majority still decides
});

test('media rows carry provenance; only approved can be primary later', () => {
  const r = mediaRow({ entityType: 'player', entityId: 'p', mediaType: 'portrait', info: { page_url: 'https://commons.wikimedia.org/wiki/File:X.jpg', thumb_url: 'https://upload.wikimedia.org/x.jpg', mime: 'image/jpeg', thumb_width: 480, thumb_height: 600, meta: meta({ LicenseShortName: 'CC BY 2.0', License: 'cc-by-2.0', LicenseUrl: 'https://creativecommons.org/licenses/by/2.0', Artist: 'A' }) }, sourceEntity: 'Q1', evidence: { method: 'wikidata_espn_fc_player_id' }, policy: {} });
  assert.equal(r.rights_status, 'approved'); assert.equal(r.source, 'wikimedia_commons'); assert.equal(r.source_url, 'https://commons.wikimedia.org/wiki/File:X.jpg');
  assert.equal(r.match_evidence.method, 'wikidata_espn_fc_player_id'); assert.equal(r.is_primary, undefined);
});
