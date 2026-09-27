// Identity resolution. Rules (docs/DATA_MODEL.md#identity):
//   1. A provider id already in a crosswalk resolves to that canonical id. Always.
//   2. Otherwise a lane that is allowed to FOUND this entity kind mints a new id —
//      unless an existing canonical entity collides on strong attributes
//      (players: normalized full name AND birth date), in which case the record is
//      QUEUED, not founded and not merged.
//   3. Non-founding lanes must prove identity (fixture graph, event alignment,
//      shared stable id). Anything unproven is queued.
// Names alone never merge anything.

import { mintId, slugify } from '../../shared/ids.js';

const XW = {
  competition: ['soccer_competition_external_ids', 'competition_id'],
  season: ['soccer_season_external_ids', 'season_id'],
  team: ['soccer_team_external_ids', 'team_id'],
  player: ['soccer_player_external_ids', 'player_id'],
  manager: ['soccer_manager_external_ids', 'manager_id'],
  venue: ['soccer_venue_external_ids', 'venue_id'],
  match: ['soccer_match_external_ids', 'match_id'],
};

export function crosswalkTable(kind) {
  const x = XW[kind];
  if (!x) throw new Error(`no crosswalk for ${kind}`);
  return x;
}

// Returns Map(external_id -> canonical id) for the ids that resolve.
export async function resolveMany(store, kind, provider, externalIds) {
  const [table, col] = crosswalkTable(kind);
  const ids = [...new Set(externalIds.map(String))];
  const out = new Map();
  const step = store.inChunk || 500;
  for (let i = 0; i < ids.length; i += step) {
    const rows = await store.select(table, { columns: ['external_id', col], eq: { provider }, in: { external_id: ids.slice(i, i + step) } });
    for (const r of rows) out.set(r.external_id, r[col]);
  }
  return out;
}

// Queue an unresolved identity. An already-resolved/rejected entry is never reopened.
export async function queueIdentity(store, { entity_type, provider, external_id, reason, candidate_ids = [], payload = {} }) {
  const key = { entity_type, provider, external_id: String(external_id) };
  const [cur] = await store.select('soccer_identity_queue', { columns: ['status', 'reason', 'candidate_ids', 'payload'], eq: key, limit: 1 });
  if (cur && cur.status !== 'open') return 'kept_' + cur.status;
  if (!cur) { await store.insert('soccer_identity_queue', [{ ...key, reason, candidate_ids, payload }]); return 'queued'; }
  // The FIRST reason is kept: a later, weaker observation (e.g. "no canonical
  // identity" in a season without an event ledger) must not overwrite evidence
  // such as an event-alignment conflict. Later reasons are recorded alongside.
  const prev = cur.payload || {};
  const seen = new Set([...(prev.also_seen || [])]);
  if (reason !== cur.reason) seen.add(reason);
  const cands = [...new Set([...(cur.candidate_ids || []), ...candidate_ids])].sort();
  const same = JSON.stringify([...(cur.candidate_ids || [])].sort()) === JSON.stringify(cands) && seen.size === (prev.also_seen || []).length;
  if (same) return 'unchanged';
  await store.upsert('soccer_identity_queue', [{ ...key, reason: cur.reason, candidate_ids: cands, payload: { ...prev, also_seen: [...seen].sort() } }], ['entity_type', 'provider', 'external_id']);
  return 'updated';
}

// Close an open queue entry once a proven crosswalk exists.
export async function resolveQueued(store, { entity_type, provider, external_id, resolution }) {
  const key = { entity_type, provider, external_id: String(external_id) };
  const [cur] = await store.select('soccer_identity_queue', { columns: ['status', 'reason', 'candidate_ids', 'payload'], eq: key, limit: 1 });
  if (!cur || cur.status !== 'open') return false;
  await store.upsert('soccer_identity_queue', [{ ...key, reason: cur.reason, candidate_ids: cur.candidate_ids || [], payload: cur.payload || {}, status: 'resolved', resolution, resolved_at: new Date().toISOString() }], ['entity_type', 'provider', 'external_id']);
  return true;
}

export function normName(s) {
  return slugify(s || '').replace(/-/g, ' ').trim();
}

// Deterministic, collision-safe slugs: base, then base-<year>, then base-<id6>.
export function allocateSlugs(entries, taken) {
  // entries: [{ id, name, year }], processed in id order for determinism.
  const out = new Map();
  const used = new Set(taken);
  for (const e of [...entries].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const base = slugify(e.name) || 'unnamed';
    const tries = [base, e.year ? `${base}-${e.year}` : null, `${base}-${e.id.slice(0, 6)}`].filter(Boolean);
    const slug = tries.find(s => !used.has(s)) || `${base}-${e.id.slice(0, 13)}`;
    used.add(slug);
    out.set(e.id, slug);
  }
  return out;
}

export { mintId };
