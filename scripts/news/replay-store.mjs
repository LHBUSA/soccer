// Record / replay stores for newsroom parity proofs (scripts/news/runner-parity-capture.mjs, tests/news-runner-parity.test.js).
// recordingStore: forwards SELECTS ONLY to a real store and logs each one (table, options, rows); every write is kept in
//   a local log and never forwarded, so a capture against production is read-only by construction.
//   hideExisting: soccer_news_events reads answer [] (every candidate is treated as a NEW story), so a capture
//   exercises packet -> draft -> gates -> desk routing -> writes on real data without touching production.
// replayStore: answers only reads that were recorded (by table + options), each exactly once, and logs the sequence it
//   was asked; two runs replayed against one recording must issue the identical sequence and consume all of it.
import { createHash } from 'node:crypto';

const canon = v => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])])) : v);
export const opKey = (table, opts) => JSON.stringify([table, canon(opts || {})]);
const clone = v => JSON.parse(JSON.stringify(v));

export function recordingStore(inner, { hideExisting = false } = {}) {
  const reads = []; const writes = [];
  return {
    reads, writes,
    async select(table, opts = {}) {
      const rows = hideExisting && table === 'soccer_news_events' ? [] : await inner.select(table, opts);
      reads.push({ key: opKey(table, opts), rows: clone(rows) });
      return clone(rows);
    },
    async insert(table, rows) { writes.push({ op: 'insert', table, rows: clone(rows) }); },
    async upsert() { throw new Error('recording store: upsert is not part of a newsroom run'); },
    async update() { throw new Error('recording store: update is not part of a newsroom run'); },
    async delete() { throw new Error('recording store: delete is not part of a newsroom run'); },
  };
}

export function replayStore(reads) {
  // Reads are served BY KEY (each recorded read consumed exactly once, FIFO per key): the newsroom issues some reads
  // concurrently, so the recorded completion order is not an issue order. `issued` is this run's own read sequence,
  // which IS deterministic under replay: two runs are compared on it.
  const byKey = new Map();
  for (const r of reads) { if (!byKey.has(r.key)) byKey.set(r.key, []); byKey.get(r.key).push(r.rows); }
  const issued = []; const writes = [];
  return {
    writes, issued, total: reads.length,
    get consumed() { return issued.length; },
    get unconsumed() { return [...byKey.entries()].flatMap(([k, q]) => q.map(() => k)); },
    async select(table, opts = {}) {
      const key = opKey(table, opts);
      const q = byKey.get(key);
      if (!q?.length) throw new Error(`replay: read #${issued.length} not in the recording (or read more often): ${key.slice(0, 300)}`);
      issued.push(key);
      return clone(q.shift());
    },
    async insert(table, rows) { writes.push({ op: 'insert', table, rows: clone(rows) }); },
    async upsert() { throw new Error('replay store: upsert'); },
    async update() { throw new Error('replay store: update'); },
    async delete() { throw new Error('replay store: delete'); },
  };
}

// Compact fixture form: identical row sets are stored once (content-addressed).
export function packReads(reads, blobs) {
  return reads.map(r => { const s = JSON.stringify(r.rows); const h = createHash('sha256').update(s).digest('hex').slice(0, 20); blobs[h] = r.rows; return [r.key, h]; });
}
export const unpackReads = (packed, blobs) => packed.map(([key, h]) => ({ key, rows: blobs[h] }));
