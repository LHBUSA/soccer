import test from 'node:test';
import assert from 'node:assert/strict';
import { live } from '../workers/soccer-api/src/cast.js';
import {
  LIVE_SNAPSHOT_DIRTY_KEY,
  LIVE_SNAPSHOT_KEY,
  LIVE_SNAPSHOT_VERSION,
  refreshLiveEnvelope,
  snapshotRefreshReason,
  snapshotServeable,
  writeLiveSnapshot,
} from '../workers/shared/live-snapshot.js';

const T = Date.parse('2026-09-29T15:00:00Z');

function envelope({ liveRows = [], upcoming = [] } = {}) {
  return {
    data: { live: liveRows, recent: [], upcoming, lane: { cadence_seconds: 60 } },
    meta: { source: 'pbe', source_updated_at: '2026-09-29T14:59:30Z', semantics: 'test', coverage: { state: 'ok', notes: [] }, attribution: [], generated_at: '2026-09-29T15:00:00Z', api_version: 'test' },
  };
}

function snapshot(env, builtAt = T) {
  return { snapshot_version: LIVE_SNAPSHOT_VERSION, built_at: new Date(builtAt).toISOString(), reason: 'test', envelope: env };
}

test('snapshot refresh policy: active every minute, idle every 15m, dirty is immediate', () => {
  const idle = snapshot(envelope(), T);
  assert.equal(snapshotRefreshReason(idle, null, T + 10 * 60e3), null);
  assert.equal(snapshotRefreshReason(idle, null, T + 15 * 60e3), 'idle_safety');

  const active = snapshot(envelope({ liveRows: [{ id: 'm1' }] }), T);
  assert.equal(snapshotRefreshReason(active, null, T + 30e3), null);
  assert.equal(snapshotRefreshReason(active, null, T + 56e3), 'live_active');

  const near = snapshot(envelope({ upcoming: [{ kickoff_at: new Date(T + 10 * 60e3).toISOString() }] }), T);
  assert.equal(snapshotRefreshReason(near, null, T + 56e3), 'kickoff_near');

  assert.equal(snapshotRefreshReason(idle, { at: new Date(T + 1).toISOString() }, T + 1000), 'ingest_dirty');
  assert.equal(snapshotRefreshReason(null, null, T), 'missing_or_version');
});

test('snapshot serving has tight live staleness and wider idle staleness', () => {
  const idle = snapshot(envelope(), T);
  const active = snapshot(envelope({ liveRows: [{ id: 'm1' }] }), T);
  assert.equal(snapshotServeable(idle, T + 19 * 60e3), true);
  assert.equal(snapshotServeable(idle, T + 21 * 60e3), false);
  assert.equal(snapshotServeable(active, T + 2 * 60e3), true);
  assert.equal(snapshotServeable(active, T + 4 * 60e3), false);
});

test('stored enrichment freshness is recomputed at read time', () => {
  const env = envelope({ liveRows: [{ id: 'm1', live: { enrichment: { fetched_at: new Date(T).toISOString(), freshness: { age_seconds: 0, stale: false, stale_after_seconds: 300 } } } }] });
  const fresh = refreshLiveEnvelope(env, T + 60e3);
  assert.equal(fresh.data.live[0].live.enrichment.freshness.age_seconds, 60);
  assert.equal(fresh.data.live[0].live.enrichment.freshness.stale, false);
  const stale = refreshLiveEnvelope(env, T + 301e3);
  assert.equal(stale.data.live[0].live.enrichment.freshness.stale, true);
  assert.equal(env.data.live[0].live.enrichment.freshness.age_seconds, 0, 'stored object is never mutated');
});

test('/live reads the materialized KV envelope with zero PostgREST calls', async () => {
  const mem = new Map();
  const kv = {
    async get(k) { return mem.has(k) ? JSON.parse(mem.get(k)) : null; },
    async put(k, v) { mem.set(k, v); },
  };
  // live() reads the wall clock, so the snapshot is built relative to it (a fixed T only passed within the
  // 20-minute idle serve window of 2026-09-29 15:00Z).
  const now = Date.now();
  const env0 = envelope({ upcoming: [{ id: 'm2', kickoff_at: new Date(now + 2 * 3600e3).toISOString() }] });
  await writeLiveSnapshot(kv, env0, { now, reason: 'test', storeRequests: 11 });
  const store = {
    requests: 0,
    async select() { throw new Error('PostgREST must not be called on snapshot hit'); },
  };
  const out = await live(store, { SOCCER_STATE: kv });
  assert.equal(store.requests, 0);
  assert.deepEqual(out.data, env0.data);
  assert.equal(out.meta.snapshot.source, 'kv');
  assert.equal(out.meta.snapshot.version, LIVE_SNAPSHOT_VERSION);
});

test('failover: a missing or stale snapshot serves database_fallback from the canonical builder and rewrites the snapshot', async () => {
  const { openPglite, applyMigrations } = await import('../workers/soccer-ingest/src/store-pglite.js');
  const { readLiveSnapshot, LIVE_SNAPSHOT_STATUS_KEY } = await import('../workers/shared/live-snapshot.js');
  const store = await openPglite(); await applyMigrations(store);
  const mem = new Map();
  const kv = { async get(k, t) { const v = mem.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } };
  // missing snapshot
  const a = await live(store, { SOCCER_STATE: kv });
  assert.equal(a.meta.snapshot.source, 'database_fallback');
  const written = await readLiveSnapshot(kv);
  assert.equal(written.reason, 'api_fallback'); assert.deepEqual(written.envelope.data, a.data);
  assert.equal(JSON.parse(mem.get(LIVE_SNAPSHOT_STATUS_KEY)).reason, 'api_fallback');
  // stale (idle, 21 minutes old): not served; rebuilt from the database and rewritten
  await writeLiveSnapshot(kv, envelope(), { now: Date.now() - 21 * 60e3, reason: 'old' });
  const b = await live(store, { SOCCER_STATE: kv });
  assert.equal(b.meta.snapshot.source, 'database_fallback');
  assert.equal((await readLiveSnapshot(kv)).reason, 'api_fallback');
  // the rewritten snapshot now serves from KV
  const c = await live(store, { SOCCER_STATE: kv });
  assert.equal(c.meta.snapshot.source, 'kv');
  // no KV binding at all: still available from the database
  assert.equal((await live(store, {})).meta.snapshot.source, 'database_fallback');
  await store.close();
});

test('snapshot KV keys are stable and public snapshot status is separate from dirty state', async () => {
  assert.equal(LIVE_SNAPSHOT_KEY, 'public:live:v1');
  assert.equal(LIVE_SNAPSHOT_DIRTY_KEY, 'public:live:dirty:v1');
});
