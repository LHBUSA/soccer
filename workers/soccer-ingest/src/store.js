// Store contract used by every ingest lane.
//   store.query(sql, params) -> { rows }
//   store.tx(async (store) => ...)
// Backends: PGlite (local proofs/tests) and, for Workers, a Postgres-over-HTTP
// adapter against the sports project. Lanes only speak SQL through syncRows.

// Idempotent, change-tracked batch write.
//   * rows whose key is absent are inserted;
//   * rows whose key exists and whose `compare` columns differ are updated, and
//     every changed field is logged to soccer_source_changes;
//   * identical rows are left alone (a re-run writes nothing).
// Returns { inserted, updated, unchanged }.
export async function syncRows(store, {
  table, key, rows, compare = null, provider = null, captureId = null, entityIdCol = null, chunk = 2000,
}) {
  const stats = { inserted: 0, updated: 0, unchanged: 0 };
  if (!rows.length) return stats;
  const cols = Object.keys(rows[0]);
  for (const r of rows) {
    for (const c of cols) if (!(c in r)) throw new Error(`${table}: row missing column ${c}`);
  }
  const cmp = compare || cols.filter(c => !key.includes(c));
  const idCol = entityIdCol || (cols.includes('id') ? 'id' : null);
  const q = s => `"${s}"`;
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const payload = JSON.stringify(batch);
    const keyTuple = key.map(q).join(',');
    const existing = await store.query(
      `select ${[...new Set([...key, ...cmp, ...(idCol ? [idCol] : [])])].map(c => `t.${q(c)}`).join(',')}
         from public.${table} t
        where (${key.map(k => `t.${q(k)}`).join(',')}) in (
          select ${keyTuple} from jsonb_populate_recordset(null::public.${table}, $1::jsonb))`,
      [payload],
    );
    const keyOf = r => key.map(k => String(r[k])).join('\u0001');
    const have = new Map(existing.rows.map(r => [keyOf(r), r]));
    const toInsert = [];
    const toUpdate = [];
    const changes = [];
    for (const r of batch) {
      const cur = have.get(keyOf(r));
      if (!cur) { toInsert.push(r); continue; }
      const diff = cmp.filter(c => !sameValue(cur[c], r[c]));
      if (!diff.length) { stats.unchanged += 1; continue; }
      toUpdate.push(r);
      for (const f of diff) {
        changes.push({
          entity_table: table,
          entity_id: String(idCol ? cur[idCol] : keyOf(r)),
          field: f, old_value: toJson(cur[f]), new_value: toJson(r[f]),
          provider, capture_id: captureId,
        });
      }
    }
    if (toInsert.length) {
      await store.query(
        `insert into public.${table} (${cols.map(q).join(',')})
         select ${cols.map(q).join(',')} from jsonb_populate_recordset(null::public.${table}, $1::jsonb)`,
        [JSON.stringify(toInsert)],
      );
      stats.inserted += toInsert.length;
    }
    if (toUpdate.length) {
      const set = cmp.map(c => `${q(c)} = s.${q(c)}`).join(', ');
      await store.query(
        `update public.${table} t set ${set}
           from jsonb_populate_recordset(null::public.${table}, $1::jsonb) s
          where ${key.map(k => `t.${q(k)} = s.${q(k)}`).join(' and ')}`,
        [JSON.stringify(toUpdate)],
      );
      stats.updated += toUpdate.length;
    }
    if (changes.length) {
      await store.query(
        `insert into public.soccer_source_changes (entity_table, entity_id, field, old_value, new_value, provider, capture_id)
         select entity_table, entity_id, field, old_value, new_value, provider, capture_id
           from jsonb_to_recordset($1::jsonb) as x(entity_table text, entity_id text, field text, old_value jsonb, new_value jsonb, provider text, capture_id text)`,
        [JSON.stringify(changes)],
      );
    }
  }
  return stats;
}

function toJson(v) {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

// Compare a DB value with an incoming JSON value without false positives from
// type round-trips (numeric strings, Date objects, arrays, jsonb).
export function sameValue(dbVal, newVal) {
  if (dbVal === null || dbVal === undefined) return newVal === null || newVal === undefined;
  if (newVal === null || newVal === undefined) return false;
  if (dbVal instanceof Date) {
    if (typeof newVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(newVal)) return dbVal.toISOString().slice(0, 10) === newVal;
    return dbVal.getTime() === new Date(newVal).getTime();
  }
  if (typeof dbVal === 'number' || typeof newVal === 'number') return Number(dbVal) === Number(newVal);
  if (typeof dbVal === 'object' || typeof newVal === 'object') return JSON.stringify(canon(dbVal)) === JSON.stringify(canon(newVal));
  if (typeof dbVal === 'string' && typeof newVal === 'string' && /^-?\d+(\.\d+)?$/.test(dbVal) && /^-?\d+(\.\d+)?$/.test(newVal)) return Number(dbVal) === Number(newVal);
  return String(dbVal) === String(newVal);
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]));
  return v;
}

// PGlite adapter. Migrations are the repo's SQL files, applied in order.
export async function openPglite({ dataDir, sportsProjectStubs = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  if (sportsProjectStubs) {
    // The migrations' target guard demands the sports project's marker tables.
    await db.exec('create table if not exists public.ufc_bouts (id int); create table if not exists public.ufc_model_versions (id int);');
  }
  const store = {
    db,
    async query(sql, params = []) { return db.query(sql, params); },
    async exec(sql) { return db.exec(sql); },
    async tx(fn) { return db.transaction(async t => fn({ query: (s, p = []) => t.query(s, p), exec: s => t.exec(s), tx: null })); },
    async close() { await db.close(); },
  };
  return store;
}

export async function applyMigrations(store, dir = 'supabase/migrations') {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) await store.exec(await fs.readFile(path.join(dir, f), 'utf8'));
  return files;
}
