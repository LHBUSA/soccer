// Provider media under the owner identification policy: exact provider ids only, truthful provenance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { espnCrestCandidate, espnHeadshotCandidate, providerMediaRow } from '../workers/soccer-ingest/src/media-provider.js';

const policy = JSON.parse(readFileSync('data/media/policy.json', 'utf8'));
const listing = [
  { id: '18418', displayName: 'Atlanta United FC', logos: [{ href: 'https://a.espncdn.com/i/teamlogos/soccer/500/18418.png', rel: ['full', 'default'], width: 500, height: 500 }, { href: 'https://a.espncdn.com/i/teamlogos/soccer/500-dark/18418.png', rel: ['full', 'dark'] }] },
  { id: '9', displayName: 'No Logo FC', logos: [] },
  { id: '7', displayName: 'Offsite FC', logos: [{ href: 'https://example.com/7.png', rel: ['full', 'default'] }] },
];

test('crest: exact ESPN team id + its default logo from the provider payload; nothing else', () => {
  const c = espnCrestCandidate('18418', listing);
  assert.equal(c.ok, true); assert.equal(c.url, 'https://a.espncdn.com/i/teamlogos/soccer/500/18418.png');
  assert.equal(espnCrestCandidate(18418, listing).ok, true, 'number vs string id is the same exact id');
  assert.equal(espnCrestCandidate('1841', listing).reason, 'espn_team_id_not_in_current_league_listing', 'no prefix / fuzzy id');
  assert.equal(espnCrestCandidate('9', listing).reason, 'current_crest_not_found');
  assert.equal(espnCrestCandidate('7', listing).reason, 'current_crest_not_found', 'only ESPN-hosted artwork from the payload');
});

test('portrait: exact athlete id, headshot from the payload, birth date guard', () => {
  const roster = [{ id: '304153', displayName: 'Jay Fortune', dateOfBirth: '2002-12-30T08:00Z', headshot: { href: 'https://a.espncdn.com/i/headshots/soccer/players/full/304153.png' } }, { id: '5', displayName: 'No Photo' }];
  assert.equal(espnHeadshotCandidate('304153', roster, '2002-12-30').ok, true);
  assert.equal(espnHeadshotCandidate('304153', roster, '2002-12-31').ok, true, 'one-day timezone shift tolerated');
  assert.equal(espnHeadshotCandidate('304153', roster, '2001-12-30').reason, 'birth_date_contradiction');
  assert.equal(espnHeadshotCandidate('5', roster, null).reason, 'no_headshot_in_payload');
  assert.equal(espnHeadshotCandidate('6', roster, null).reason, 'athlete_not_on_espn_roster');
});

test('row: owner_approved_identification with truthful provenance, never labelled free', () => {
  const r = providerMediaRow({ entityType: 'team', entityId: '11111111-1111-5111-8111-111111111111', mediaType: 'crest', url: 'https://a.espncdn.com/i/teamlogos/soccer/500/18418.png', sourceUrl: 'https://www.espn.com/soccer/team/_/id/18418', subjectName: 'Atlanta United FC', evidence: { method: 'espn_exact_team_id', external_id: '18418' }, policy });
  assert.equal(r.rights_status, 'owner_approved_identification'); assert.equal(r.provider, 'espn'); assert.equal(r.owner_policy_version, policy.owner_identification.policy_version);
  assert.equal(r.source, 'provider_artwork'); assert.equal(r.license_url, null);
  assert.match(r.license, /^Not free-licensed/); assert.doesNotMatch(`${r.license} ${r.attribution} ${r.rights_notes}`, /public domain|CC0|creative commons|free-licensed crest|licensed to/i);
  assert.equal(r.match_evidence.external_id, '18418');
});

test('API exposes free-licensed and owner-approved rows only, with the basis', () => {
  const src = readFileSync('workers/soccer-api/src/routes.js', 'utf8');
  assert.match(src, /DISPLAYABLE = \['approved', 'owner_approved_identification'\]/);
  assert.match(src, /basis: r\.rights_status === 'approved' \? 'free_license' : 'owner_approved_identification'/);
  assert.doesNotMatch(src, /rights_status: 'approved'/, 'no read path still limited to free-licensed only');
});
