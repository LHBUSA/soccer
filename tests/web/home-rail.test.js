// Homepage live rail: live first (provider clock), next kick-offs within 36 h, then replays;
// every tile opens its PBEcast; nothing renders when the API has nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { liveRail, railItems } from '../../src/pages/home.js';

const m = (id, extra = {}) => ({ id: `5b0c8f3e-1111-5222-8333-44445555${id}`, competition: { slug: 'mls', name: 'MLS' }, home: { name: 'Home FC', short_name: 'Home' }, away: { name: 'Away FC', short_name: 'Away' }, kickoff_at: new Date(Date.now() + 3600e3).toISOString(), score: null, ...extra });

test('rail order and window', () => {
  const x = { live: [m('0001', { score: { home: 1, away: 0 }, live: { display_clock: "63'" } })], upcoming: [m('0002'), m('0003', { kickoff_at: new Date(Date.now() + 72 * 3600e3).toISOString() })], recent: [m('0004', { score: { home: 2, away: 2 } })] };
  assert.deepEqual(railItems(x).map(i => i.k), ['live', 'next', 'ft']);
  const html = liveRail({ data: x });
  assert.match(html, /LIVE NOW · 1/);
  assert.match(html, /63&#39;|63'/);
  assert.equal((html.match(/href="\/pbecast\/5b0c8f3e-/g) || []).length, 3);
  assert.match(html, /aria-label="Home FC 1–0 Away FC, live, open PBEcast"/);
});

test('rail is absent when there is nothing to show', () => {
  assert.equal(liveRail({ data: { live: [], upcoming: [], recent: [] } }), '');
  assert.equal(liveRail(null), '');
});
