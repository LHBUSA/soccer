#!/usr/bin/env node
// Upload the local raw archive (.raw/soccer-source/**, same key layout as R2)
// through the soccer-ingest admin endpoint. Write-once: existing objects are not
// rewritten. Every object's stored sha256 is compared with the local bytes.
// Writes docs/evidence/storage/r2-upload-<date>.json.
//
//   SOCCER_INGEST_URL=https://soccer-ingest.<acct>.workers.dev \
//   node scripts/r2/upload-captures.mjs [--family wyscout_figshare,openligadb]
// Admin token: D:\Workers\secrets\soccer-ingest-admin-token (never printed).

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const base = process.env.SOCCER_INGEST_URL;
if (!base) throw new Error('set SOCCER_INGEST_URL');
const token = readFileSync(process.env.SOCCER_INGEST_TOKEN_FILE || 'D:/Workers/secrets/soccer-ingest-admin-token', 'utf8').trim();
const famArg = process.argv.indexOf('--family');
const families = famArg > 0 ? new Set(process.argv[famArg + 1].split(',')) : null;

const walk = (d, o = []) => { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, o) : o.push(p); } return o; };
const files = walk('.raw/soccer-source').map(p => ({ path: p, key: relative('.raw', p).replace(/\\/g, '/') }))
  .filter(f => !families || families.has(f.key.split('/')[1]))
  // payloads first, so a capture record never points at a missing payload
  .sort((a, b) => Number(a.key.includes('/captures/')) - Number(b.key.includes('/captures/')) || (a.key < b.key ? -1 : 1));

const out = { started_at: new Date().toISOString(), target: base, objects: [] };
let bad = 0;
for (const f of files) {
  const body = readFileSync(f.path);
  const local = createHash('sha256').update(body).digest('hex');
  const res = await fetch(`${base}/v1/admin/raw?key=${encodeURIComponent(f.key)}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': f.key.endsWith('.json') ? 'application/json' : 'application/octet-stream' }, body });
  const j = await res.json().catch(() => ({}));
  const ok = (res.status === 201 && j.verified && j.sha256 === local) || (res.status === 200 && j.identical && j.sha256 === local);
  if (!ok) bad += 1;
  out.objects.push({ key: f.key, bytes: body.length, local_sha256: local, status: res.status, remote_sha256: j.sha256 || null, result: j.written ? 'written' : j.existed ? 'existed' : 'error', ok });
  console.log(`${ok ? 'ok ' : 'BAD'} ${res.status} ${f.key} ${body.length}`);
}
out.finished_at = new Date().toISOString();
out.summary = { objects: out.objects.length, ok: out.objects.length - bad, bad, written: out.objects.filter(o => o.result === 'written').length, existed: out.objects.filter(o => o.result === 'existed').length, bytes: out.objects.reduce((n, o) => n + o.bytes, 0) };
mkdirSync('docs/evidence/storage', { recursive: true });
writeFileSync(`docs/evidence/storage/r2-upload-${out.started_at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(out.summary);
if (bad) process.exit(1);
