// Raw evidence contract. Every source response is archived BEFORE it is parsed.
//
//   payload:  soccer-source/<family>/sha256/<aa>/<sha256>          (write-once, content-addressed)
//   capture:  soccer-source/<family>/captures/<yyyy-mm-dd>/<capture_id>.json
//
// capture_id = first 24 hex of sha256(METHOD + ' ' + normalized URL + '|' + captured_at).
// A capture record holds request identity, HTTP status, content hash, size,
// content type and the parser version that consumed it. Canonical rows point at
// capture_id, so every stored fact can be traced back to the exact bytes.
//
// Storage backends implement { head(key) -> bool, put(key, body, contentType) }.
// Production: R2 (r2Storage). Local proofs: the same key layout on disk (fsStorage).

import { sha256Hex } from './ids.js';

export const ARCHIVE_ROOT = 'soccer-source';

export function normalizeUrl(url) {
  const u = new URL(url);
  const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  u.search = '';
  for (const [k, v] of params) u.searchParams.append(k, v);
  u.hash = '';
  return u.toString();
}

export function payloadKey(family, sha) {
  return `${ARCHIVE_ROOT}/${family}/sha256/${sha.slice(0, 2)}/${sha}`;
}

export function captureKey(family, capturedAt, captureId) {
  return `${ARCHIVE_ROOT}/${family}/captures/${capturedAt.slice(0, 10)}/${captureId}.json`;
}

export function captureIdFor(method, url, capturedAt) {
  return sha256Hex(`${method.toUpperCase()} ${normalizeUrl(url)}|${capturedAt}`).slice(0, 24);
}

// bytes: Uint8Array | Buffer. Returns the capture record (also persisted).
export async function archiveCapture(storage, {
  family, sourceKey, method = 'GET', url, status, contentType = null, bytes,
  capturedAt = new Date().toISOString(), parserVersion = null, notes = null,
}) {
  if (!family || !sourceKey || !url) throw new Error('archiveCapture needs family, sourceKey, url');
  if (!(bytes instanceof Uint8Array)) throw new Error('archiveCapture needs raw bytes');
  const sha = sha256Hex(bytes);
  const pKey = payloadKey(family, sha);
  if (!(await storage.head(pKey))) await storage.put(pKey, bytes, contentType || 'application/octet-stream');
  const captureId = captureIdFor(method, url, capturedAt);
  const record = {
    capture_id: captureId,
    source_key: sourceKey,
    family,
    request_method: method.toUpperCase(),
    request_url: normalizeUrl(url),
    captured_at: capturedAt,
    http_status: status,
    content_type: contentType,
    content_sha256: sha,
    bytes: bytes.length,
    raw_key: pKey,
    parser_version: parserVersion,
    notes,
  };
  await storage.put(captureKey(family, capturedAt, captureId), JSON.stringify(record, null, 2), 'application/json');
  return record;
}

export function r2Storage(bucket) {
  return {
    async head(key) { return (await bucket.head(key)) !== null; },
    async put(key, body, contentType) { await bucket.put(key, body, { httpMetadata: { contentType } }); },
    async get(key) { const o = await bucket.get(key); return o ? new Uint8Array(await o.arrayBuffer()) : null; },
  };
}

// Local mirror of the R2 layout, for backfills and proofs run from a workstation.
export async function fsStorage(rootDir) {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const full = key => path.join(rootDir, ...key.split('/'));
  return {
    async head(key) { try { await fs.access(full(key)); return true; } catch { return false; } },
    async put(key, body) {
      await fs.mkdir(path.dirname(full(key)), { recursive: true });
      await fs.writeFile(full(key), body);
    },
    async get(key) { try { return new Uint8Array(await fs.readFile(full(key))); } catch { return null; } },
  };
}
