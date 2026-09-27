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
  if (!externalIds.length) return new Map();
  const { rows } = await store.query(
    `select external_id, ${col} as id from public.${table} where provider = $1 and external_id = any($2::text[])`,
    [provider, externalIds.map(String)],
  );
  return new Map(rows.map(r => [r.external_id, r.id]));
}

export async function queueIdentity(store, { entity_type, provider, external_id, reason, candidate_ids = [], payload = {} }) {
  await store.query(
    `insert into public.soccer_identity_queue (entity_type, provider, external_id, reason, candidate_ids, payload)
     values ($1,$2,$3,$4,$5::uuid[],$6::jsonb)
     on conflict (entity_type, provider, external_id) do update
       set reason = excluded.reason, candidate_ids = excluded.candidate_ids, payload = excluded.payload
       where soccer_identity_queue.status = 'open'`,
    [entity_type, provider, String(external_id), reason, candidate_ids, JSON.stringify(payload)],
  );
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
