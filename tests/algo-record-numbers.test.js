// Public record numbers are per model (owner decision 2026-10-03): soccer_algo_picks.record_no is one identity shared by
// every model and rolled-back ledger proofs consume values, so the public number is the pick's position within its own
// algo_version; the immutable identity is exposed as ledger_id. No ledger row is changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelRecordNumbers, renumber } from '../workers/soccer-api/src/algo.js';

// shared identity with gaps (1-2 consumed by rolled-back proofs), V1 and V2 interleaved
const LEDGER = [{ record_no: 3, algo_version: 'soccer-algo-v1.0.0' }, { record_no: 4, algo_version: 'soccer-algo-v2.1.0' }, { record_no: 6, algo_version: 'soccer-algo-v2.1.0' }, { record_no: 7, algo_version: 'soccer-algo-v1.0.0' }];
const store = { async select(table, { eq, order, limit = 1000, offset = 0 }) { assert.equal(table, 'soccer_algo_picks'); assert.equal(order, 'record_no.asc'); return LEDGER.filter(r => r.algo_version === eq.algo_version).sort((a, b) => a.record_no - b.record_no).slice(offset, offset + limit); } };

test('each model numbers its own record from #1 in issue order, whatever the shared identity', async () => {
  const v1 = await modelRecordNumbers(store, 'soccer-algo-v1.0.0'); const v2 = await modelRecordNumbers(store, 'soccer-algo-v2.1.0');
  assert.deepEqual([...v1], [[3, 1], [7, 2]]); assert.deepEqual([...v2], [[4, 1], [6, 2]]);
});

test('renumber keeps the immutable ledger id and never mutates the stored row', async () => {
  const rows = [{ record_no: '7', status: 'pending' }, { record_no: '3', status: 'win' }];
  const before = structuredClone(rows);
  const out = renumber(rows, await modelRecordNumbers(store, 'soccer-algo-v1.0.0'));
  assert.deepEqual(out.map(r => [r.record_no, r.ledger_id]), [[2, 7], [1, 3]]);
  assert.deepEqual(rows, before);
});
