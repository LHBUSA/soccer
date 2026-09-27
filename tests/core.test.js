import test from 'node:test';
import assert from 'node:assert/strict';
import { childId, mintId, payloadHash, slugify, stableStringify, uuidv5 } from '../workers/shared/ids.js';
import { fromCanonical, toCanonical, toMatchFrame, zoneOf } from '../workers/shared/coords.js';
import { displayMinute, footballMinute } from '../workers/shared/clock.js';
import { captureIdFor, normalizeUrl, payloadKey } from '../workers/shared/archive.js';
import { detectAccessControl } from '../workers/shared/http.js';

test('uuidv5 matches the RFC 4122 reference vector', () => {
  // uuid5(NAMESPACE_DNS, 'www.example.com')
  assert.equal(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'), '2ed6657d-e927-568b-95e1-2665a8aea6a2');
});

test('canonical ids are deterministic, kind-scoped and refuse missing parts', () => {
  assert.equal(mintId('player', 'wyscout', 3359), mintId('player', 'wyscout', '3359'));
  assert.notEqual(mintId('player', 'wyscout', 3359), mintId('team', 'wyscout', 3359));
  assert.notEqual(mintId('player', 'wyscout', 3359), mintId('player', 'openligadb', 3359));
  assert.throws(() => mintId('player', 'wyscout', ''));
  assert.throws(() => mintId('widget', 'wyscout', 1));
  assert.throws(() => childId('lineup', 'a', null));
});

test('payload hash ignores key order', () => {
  assert.equal(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] }), stableStringify({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.equal(payloadHash({ x: 1, y: 2 }), payloadHash({ y: 2, x: 1 }));
});

test('slugify folds diacritics', () => {
  assert.equal(slugify('Bayern München'), 'bayern-munchen');
  assert.equal(slugify("Borussia M'gladbach"), 'borussia-m-gladbach');
  assert.equal(slugify('Ádám Szalai'), 'adam-szalai');
});

test('wyscout percentages map onto the 105 x 68 attacking frame', () => {
  assert.deepEqual(toCanonical('wyscout_pct_v1', 0, 0), { x_m: 0, y_m: 0 });
  assert.deepEqual(toCanonical('wyscout_pct_v1', 100, 100), { x_m: 105, y_m: 68 });
  assert.deepEqual(toCanonical('wyscout_pct_v1', 50, 50), { x_m: 52.5, y_m: 34 });
  assert.deepEqual(toCanonical('wyscout_pct_v1', 88, 50), { x_m: 92.4, y_m: 34 });
});

test('statsbomb yards and opta (y flipped) share the same frame', () => {
  assert.deepEqual(toCanonical('statsbomb_yd_v1', 120, 80), { x_m: 105, y_m: 68 });
  assert.deepEqual(toCanonical('opta_pct_v1', 100, 0), { x_m: 105, y_m: 68 });
  assert.deepEqual(toCanonical('opta_pct_v1', 0, 100), { x_m: 0, y_m: 0 });
});

test('out-of-range source points keep no canonical value (never clamped)', () => {
  assert.deepEqual(toCanonical('wyscout_pct_v1', 28, 101), { x_m: null, y_m: null });
  assert.deepEqual(toCanonical('wyscout_pct_v1', NaN, 3), { x_m: null, y_m: null });
  assert.throws(() => toCanonical('mystery', 1, 1));
});

test('canonical -> source round trip reconstructs the original coordinates', () => {
  for (const [x, y] of [[0, 0], [12, 87], [50, 50], [99, 3], [100, 100]]) {
    const c = toCanonical('wyscout_pct_v1', x, y);
    const back = fromCanonical('wyscout_pct_v1', c.x_m, c.y_m);
    assert.ok(Math.abs(back.x - x) < 0.01 && Math.abs(back.y - y) < 0.02, `${x},${y} -> ${back.x},${back.y}`);
  }
});

test('match frame rotates away-team events 180 degrees', () => {
  assert.deepEqual(toMatchFrame({ x_m: 100, y_m: 10 }, { isHomeTeam: true }), { x: 100, y: 10 });
  assert.deepEqual(toMatchFrame({ x_m: 100, y_m: 10 }, { isHomeTeam: false }), { x: 5, y: 58 });
  assert.deepEqual(zoneOf(80, 60), { third: 'final', channel: 'right' });
});

test('football minutes are 1-based with stoppage display', () => {
  assert.equal(footballMinute('1H', 250), 5);   // 04:10 -> 5'
  assert.equal(footballMinute('1H', 0), 1);
  assert.equal(footballMinute('2H', 0), 46);
  assert.equal(footballMinute('1H', -1), null);
  assert.equal(displayMinute('1H', 46), "45+1'");
  assert.equal(displayMinute('2H', 93), "90+3'");
  assert.equal(displayMinute('2H', 90), "90'");
});

test('capture ids depend on method, normalized URL and time; payload keys on content', () => {
  const t = '2026-09-27T12:00:00.000Z';
  assert.equal(captureIdFor('GET', 'https://x.test/a?b=2&a=1', t), captureIdFor('get', 'https://x.test/a?a=1&b=2#frag', t));
  assert.notEqual(captureIdFor('GET', 'https://x.test/a', t), captureIdFor('GET', 'https://x.test/a', '2026-09-27T12:00:01.000Z'));
  assert.equal(normalizeUrl('https://x.test/p?z=1&a=2'), 'https://x.test/p?a=2&z=1');
  assert.equal(payloadKey('wyscout_figshare', 'ab'.repeat(32)), `soccer-source/wyscout_figshare/sha256/ab/${'ab'.repeat(32)}`);
});

test('access control is detected and never treated as data', () => {
  const h = obj => ({ get: k => obj[k] ?? null });
  assert.equal(detectAccessControl(403, h({ server: 'cloudflare', 'cf-mitigated': 'challenge' }), ''), 'cloudflare_challenge');
  assert.equal(detectAccessControl(403, h({ server: 'AkamaiGHost' }), 'Access Denied'), 'akamai');
  assert.equal(detectAccessControl(200, h({}), '<title>Just a moment...</title>'), 'cloudflare_challenge');
  assert.equal(detectAccessControl(401, h({}), ''), 'auth_required');
  assert.equal(detectAccessControl(200, h({}), '{"ok":true}'), null);
});
