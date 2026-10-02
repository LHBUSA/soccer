import { test } from 'node:test';
import assert from 'node:assert/strict';
import { noTransform } from '../workers/soccer-api/src/transport.js';

test('transport: public JSON keeps its TTL and gains no-transform (Cloudflare must not pre-compress for Vercel)', async () => {
  const res = noTransform(new Response('{"data":[]}', { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=300, s-maxage=300', 'access-control-allow-origin': 'https://soccer.propbetedge.ai', vary: 'origin' } }));
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300, s-maxage=300, no-transform');
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(res.headers.get('access-control-allow-origin'), 'https://soccer.propbetedge.ai');
  assert.equal(res.headers.get('vary'), 'origin');
  assert.deepEqual(await res.json(), { data: [] });
});

test('transport: Pro/private responses stay private, no-store and Vary: Cookie', () => {
  const res = noTransform(new Response('{"error":"all_access_required"}', { status: 403, headers: { 'cache-control': 'private, no-store', vary: 'Cookie' } }));
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('cache-control'), 'private, no-store, no-transform');
  assert.equal(res.headers.get('vary'), 'Cookie');
  assert.match(res.headers.get('cache-control'), /^private, no-store/);
});

test('transport: errors without Cache-Control and already-tagged responses', () => {
  assert.equal(noTransform(new Response(null, { status: 204 })).headers.get('cache-control'), 'no-transform');
  const tagged = new Response('x', { headers: { 'cache-control': 'no-store, no-transform' } });
  assert.equal(noTransform(tagged), tagged);
});
