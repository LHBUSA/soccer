#!/usr/bin/env node
// Close open identity-queue entries whose provider id has SINCE been proven by an
// allowed method (crosswalk exists). Never creates a crosswalk; only closes the
// queue entry and records the crosswalk it found. Read-mostly; prints what it closed.
import { readFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { crosswalkTable, resolveQueued } from '../../workers/soccer-ingest/src/identity.js';
const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const open = await store.select('soccer_identity_queue', { columns: ['entity_type', 'provider', 'external_id', 'reason'], eq: { status: 'open', entity_type: 'team' } });
let closed = 0;
for (const q of open) {
  const [table, col] = crosswalkTable(q.entity_type);
  const [x] = await store.select(table, { columns: [col, 'method'], eq: { provider: q.provider, external_id: q.external_id }, limit: 1 });
  if (!x) continue;
  await resolveQueued(store, { entity_type: q.entity_type, provider: q.provider, external_id: q.external_id, resolution: { method: x.method, [col]: x[col], closed_by: 'close-proven-queue' } });
  closed += 1;
  console.log('closed', q.entity_type, q.provider, q.external_id, q.reason, '->', x.method);
}
console.log({ open_team_entries: open.length, closed });
