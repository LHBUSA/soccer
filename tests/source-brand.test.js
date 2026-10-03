// Network source-brand standard (DATA · PropSports): customer surfaces and soccer-api serializers carry no upstream
// branding; licence credits (Wyscout CC BY, OpenLigaDB ODbL) stay; legacy lane fields stay as deprecated aliases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../scripts/guard-source-brand.mjs';
import { envelope, brandText, DEPRECATED_FIELDS } from '../workers/soccer-api/src/envelope.js';

test('source-brand guard: src and soccer-api serializers are clean', () => {
  assert.deepEqual(scan(), []);
});
test('envelope: lane attribution dropped, licence credits kept, semantics branded, deprecations documented', () => {
  const m = envelope({}, { version: 't', semantics: "Table uses ESPN's published standings (secondary source).", attribution: ['espn', 'openligadb', 'wyscout'], deprecated: DEPRECATED_FIELDS }).meta;
  assert.doesNotMatch(JSON.stringify(m.attribution) + m.semantics, /ESPN/);
  assert.equal(m.attribution.length, 2);
  assert.match(m.attribution.join(' '), /ODbL/);
  assert.match(m.attribution.join(' '), /CC BY 4\.0/);
  assert.ok(m.deprecated_fields.result_source);
  assert.equal(brandText('from ESPN (secondary source)'), 'from PropSports');
});
