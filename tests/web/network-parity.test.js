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

test('Predictions is a separate product, never a sport', () => {
  assert.deepEqual(PRODUCTS.map(p => [p.key, p.url]), FAMILY.products.map(p => [p.key, p.url]));
  assert.ok(!SPORTS.some(s => s.key === 'predictions'));
  assert.ok(!('predictions' in SPORT_LABELS));
  assert.ok(!CONTRACT_NETWORK.some(s => s.key === 'predictions'));
});

test('network links match family.json', () => {
  assert.deepEqual(NETWORK_LINKS, Object.fromEntries(FAMILY.network.map(n => [n.key, n.url])));
  const f = networkFooter();
  /* Owner decision 2026-10-05: the footer's informational All Access link opens the native /all-access page on
     this site (the registry URL stays the network reference in NETWORK_LINKS, pinned above). Every other network
     destination is linked exactly as the registry says. */
  for (const n of FAMILY.network) {
    if (n.key === 'all_access') assert.ok(f.includes('href="/all-access"'), 'all_access -> local /all-access page');
    else assert.ok(f.includes(`href="${n.url}"`), n.key);
  }
});

test('rendered footer: every other sport linked canonically, one F1 + one Predictions anchor, no retired hosts', () => {
  const f = networkFooter();
  const hrefs = [...f.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  for (const s of FAMILY.sports) if (s.key !== 'soccer') assert.equal(hrefs.filter(h => h === s.url).length, 1, s.key);
  assert.equal(hrefs.filter(h => h.includes('f1.propbetedge.ai')).length, 1);
  assert.equal(hrefs.filter(h => h.includes('predictions.propbetedge.ai')).length, 1);
  assert.ok(hrefs.includes('https://predictions.propbetedge.ai/'));
  for (const host of FAMILY.retired_hosts) assert.ok(!f.includes(host), host);
  assert.ok(!/http:\/\/[^"]*propbetedge\.ai/.test(f));
  assert.ok(!/\b(11|eleven) sports\b/i.test(f));
});
