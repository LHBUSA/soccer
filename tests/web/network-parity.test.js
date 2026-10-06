// Footer family parity: src/lib/network.js must agree with the vendored canonical registry src/lib/family.json
// (LHBUSA/propbetedge-workers shared/network/family.json; re-vendor, never hand-edit).
import test from 'node:test';
import assert from 'node:assert/strict';
import FAMILY from '../../src/lib/family.json' with { type: 'json' };
import { SPORTS, PRODUCTS, NETWORK_LINKS } from '../../src/lib/network.js';
import { SPORT_LABELS, NETWORK as CONTRACT_NETWORK } from '../../src/lib/pbe-membership.js';
import { networkFooter } from '../../src/components/footer.js';

test('footer sports registry matches family.json (set, order, urls)', () => {
  assert.deepEqual(SPORTS.map(s => [s.key, s.url]), FAMILY.sports.map(s => [s.key, s.url]));
});

test('All Access products are separate products, never sports', () => {
  assert.deepEqual(PRODUCTS.map(p => [p.key, p.url]), FAMILY.products.map(p => [p.key, p.url]));
  for (const p of PRODUCTS) {
    assert.ok(!SPORTS.some(s => s.key === p.key));
    assert.ok(!(p.key in SPORT_LABELS));
    assert.ok(!CONTRACT_NETWORK.some(s => s.key === p.key));
  }
});

test('network links match family.json', () => {
  assert.deepEqual(NETWORK_LINKS, Object.fromEntries(FAMILY.network.map(n => [n.key, n.url])));
  const f = networkFooter();
  for (const n of FAMILY.network) assert.ok(f.includes(`href="${n.url}"`), n.key);
  assert.ok(f.includes('href="https://propbetedge.ai/pro"'), 'All Access network destination');
});

test('rendered footer: sports + All Access products linked canonically, no retired hosts', () => {
  const f = networkFooter();
  const hrefs = [...f.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  for (const s of FAMILY.sports) if (s.key !== 'soccer') assert.equal(hrefs.filter(h => h === s.url).length, 1, s.key);
  assert.equal(hrefs.filter(h => h.includes('f1.propbetedge.ai')).length, 1);
  for (const p of FAMILY.products) assert.equal(hrefs.filter(h => h === p.url).length, 1, p.key);
  for (const host of FAMILY.retired_hosts) assert.ok(!f.includes(host), host);
  assert.ok(!/http:\/\/[^"]*propbetedge\.ai/.test(f));
  assert.ok(!/\b(11|eleven) sports\b/i.test(f));
});
