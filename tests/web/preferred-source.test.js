import test from 'node:test';
import assert from 'node:assert/strict';
import { preferredSourceTarget, preferredSourceDeeplink, renderPreferredSource, mountPreferredSource, __test } from '../../src/components/preferred-source.js';

test('soccer host is not a Google-listed source: deeplink to propbetedge.ai, no SDK', () => {
  assert.deepEqual(preferredSourceTarget('soccer.propbetedge.ai'), { source: 'propbetedge.ai', sdk: false });
  assert.deepEqual(preferredSourceTarget('soccer-git-x.vercel.app'), { source: 'propbetedge.ai', sdk: false });
  assert.equal(preferredSourceTarget('mlb.propbetedge.ai').sdk, true);
  assert.equal(preferredSourceDeeplink('propbetedge.ai'), 'https://www.google.com/preferences/source?q=propbetedge.ai');
});

test('markup is our own control with a working deeplink', () => {
  const f = renderPreferredSource({ surface: 'footer' });
  assert.match(f, /href="https:\/\/www\.google\.com\/preferences\/source\?q=propbetedge\.ai"/);
  assert.match(f, /data-surface="footer"/);
  assert.match(f, /data-sport="soccer"/);
  assert.doesNotMatch(f, /google-add-preferred-source-btn|publisher\.js/);
  assert.match(renderPreferredSource({ surface: 'article' }), /data-surface="article"/);
});

test('mount is idempotent and tracks preferred_source_click without PII', () => {
  __test.reset();
  const listeners = [];
  const doc = { addEventListener: (t, fn) => listeners.push([t, fn]) };
  const events = [];
  const win = { gtag: (...a) => events.push(a) };
  assert.equal(mountPreferredSource({ win, doc }), true);
  assert.equal(mountPreferredSource({ win, doc }), false);
  assert.equal(listeners.length, 1);
  const el = { dataset: { surface: 'article', sport: 'soccer' } };
  listeners[0][1]({ target: { closest: () => el } });
  assert.deepEqual(events, [['event', 'preferred_source_click', { surface: 'article', sport: 'soccer', method: 'deeplink_fallback' }]]);
});
