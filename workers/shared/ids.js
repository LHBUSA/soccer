// Canonical identity primitives.
//
// Every canonical entity gets a PropBetEdge UUID. The UUID is minted ONCE, from
// the founding source reference, with UUIDv5 so that re-ingesting the same
// founding record on a fresh database yields the same id (idempotency across
// rebuilds). The founding reference is an input to the mint, not the identity:
// the id never changes if that provider later renumbers, and every other
// provider's id is a crosswalk row pointing at it.
//
// Workers need `compatibility_flags = ["nodejs_compat"]` for node:crypto.

import { createHash } from 'node:crypto';

// Fixed namespace for all soccer canonical ids. Never change it: doing so would
// re-mint every id on the next rebuild.
export const SOCCER_NAMESPACE = '6f1c9a52-3b0e-5d47-9a1e-2c5b7d8e4f10';

export const ENTITY_KINDS = Object.freeze([
  'competition', 'season', 'stage', 'team', 'player', 'manager', 'referee',
  'venue', 'match', 'lineup', 'substitution', 'event', 'possession', 'capture',
  'article', 'news_event', 'group',
]);

function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '');
  if (!/^[0-9a-f]{32}$/i.test(hex)) throw new Error(`bad uuid: ${uuid}`);
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(b) {
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function uuidv5(name, namespace = SOCCER_NAMESPACE) {
  const hash = createHash('sha1').update(uuidToBytes(namespace)).update(String(name), 'utf8').digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  return bytesToUuid(b);
}

// mintId('player', 'wyscout', 3359) -> stable uuid.
// Only call this when FOUNDING a canonical entity. To look an entity up by a
// provider id, go through the crosswalk (identity.js) — a provider id that was
// crosswalked onto an existing entity must never mint a second one.
export function mintId(kind, provider, externalId) {
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`unknown entity kind: ${kind}`);
  if (!provider || externalId === undefined || externalId === null || externalId === '') {
    throw new Error(`mintId(${kind}) needs provider + external id`);
  }
  return uuidv5(`${kind}:${provider}:${externalId}`);
}

// Ids for rows that are natural children of a canonical parent (a season of a
// competition, a lineup of a match+team). Deterministic from canonical ids only.
export function childId(kind, ...parts) {
  if (!ENTITY_KINDS.includes(kind)) throw new Error(`unknown entity kind: ${kind}`);
  if (parts.some(p => p === undefined || p === null || p === '')) throw new Error(`childId(${kind}) missing part`);
  return uuidv5(`${kind}:child:${parts.join('|')}`);
}

export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

// Stable JSON (sorted keys) so a payload hash does not depend on key order.
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function payloadHash(obj) {
  return sha256Hex(stableStringify(obj));
}

export function slugify(text) {
  return String(text)
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss').replace(/ø/g, 'o').replace(/æ/g, 'ae').replace(/đ/g, 'd').replace(/ł/g, 'l')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
