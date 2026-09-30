import test from 'node:test';
import assert from 'node:assert/strict';
import { api, reuseMs } from '../../src/lib/api.js';
import * as home from '../../src/pages/home.js';

test('homepage critical load never waits for news, coverage, leaders or featured detail', async () => {
  const before = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async url => { calls.push(url); assert.equal(url, '/api/soccer/live'); return Response.json({ data: { live: [], recent: [] }, meta: {} }); };
  try { assert.match(home.initial(), /Soccer intelligence/); const d = await home.load(); assert.equal(d.live.status, 'fulfilled'); assert.deepEqual(calls, ['/api/soccer/live']); } finally { globalThis.fetch = before; }
});
test('API coalesces concurrent fresh requests and evicts failures for retry', async () => {
  const before = globalThis.fetch; let n = 0; let release;
  globalThis.fetch = async () => { n++; await new Promise(r => { release = r; }); return Response.json({ data: [], meta: {} }); };
  try { const a = api('competitions', { q: 'coalesce' }, { fresh: true }); const b = api('competitions', { q: 'coalesce' }, { fresh: true }); release(); await Promise.all([a, b]); assert.equal(n, 1);
    globalThis.fetch = async () => { n++; return Response.json({ error: 'fail' }, { status: 502 }); };
    await assert.rejects(api('coverage', { q: 'retry' })); await assert.rejects(api('coverage', { q: 'retry' })); assert.equal(n, 3);
  } finally { globalThis.fetch = before; }
});
test('live reuse stays seconds; historical reads are bounded separately', () => { assert.equal(reuseMs('live'), 10000); assert.ok(reuseMs('teams/a/history') > reuseMs('live')); assert.equal(reuseMs('pro/board'), 0); });
