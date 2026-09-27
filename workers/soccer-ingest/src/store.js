// Store contract used by every ingest lane. Two backends implement the same
// primitives, so lanes run unchanged in tests (PGlite) and production (PostgREST):
//
//   store.select(table, { columns, eq, neq, gte, lte, in: {col: [...]}, is: {col: null|true|false}, order, limit })
//   store.insert(table, rows)
//   store.upsert(table, rows, onConflictCols)      // merge-duplicates on a real unique key
//   store.count(table, { eq, in })
//
// Nothing in a lane may issue raw SQL: production has no SQL channel for Workers.

// Idempotent, change-tracked batch write.
//   * rows whose key is absent are inserted;
//   * rows whose key exists and whose `compare` columns differ are upserted, and
//     every changed field is logged to soccer_source_changes;
//   * identical rows are left alone (a re-run writes nothing).
export async function syncRows(store, {
  table, key, rows, compare = null, provider = null, captureId = null, entityIdCol = null, chunk = 1000, touch = false,
}) {
  // touch: stamp updated_at on rows that actually changed (never compared, so re-runs stay no-ops).
  const stats = { inserted: 0, updated: 0, unchanged: 0 };
  if (!rows.length) return stats;
  const cols = Object.keys(rows[0]);
  for (const r of rows) for (const c of cols) if (!(c in r)) throw new Error(`${table}: row missing column ${c}`);
  const cmp = compare || cols.filter(c => !key.includes(c));
  const idCol = entityIdCol || (cols.includes('id') ? 'id' : null);
  const keyOf = r => key.map(k => String(r[k])).join('\u0001');
  const seen = new Set();
  for (const r of rows) {
    const k = keyOf(r);
    if (seen.has(k)) throw new Error(`${table}: duplicate key in batch ${k.replace(/\u0001/g, '|')}`);
    seen.add(k);
  }
  for (let i = 0; i < rows.length; i += chunk) {
    const batch = rows.slice(i, i + chunk);
    const existing = await selectByKeys(store, table, key, batch, [...new Set([...key, ...cmp, ...(idCol ? [idCol] : [])])]);
    const have = new Map(existing.map(r => [keyOf(r), r]));
    const toInsert = []; const toUpdate = []; const changes = [];
    for (const r of batch) {
      const cur = have.get(keyOf(r));
      if (!cur) { toInsert.push(r); continue; }
      const diff = cmp.filter(c => !sameValue(cur[c], r[c]));
      if (!diff.length) { stats.unchanged += 1; continue; }
      toUpdate.push(r);
      for (const f of diff) {
        changes.push({ entity_table: table, entity_id: String(idCol ? cur[idCol] : keyOf(r)), field: f, old_value: toJson(cur[f]), new_value: toJson(r[f]), provider, capture_id: captureId });
      }
    }
    if (toInsert.length) { await store.insert(table, toInsert); stats.inserted += toInsert.length; }
    if (toUpdate.length) {
      const stamp = new Date().toISOString();
      await store.upsert(table, touch ? toUpdate.map(r => ({ ...r, updated_at: stamp })) : toUpdate, key);
      stats.updated += toUpdate.length;
    }
    if (changes.length) await store.insert('soccer_source_changes', changes);
  }
  return stats;
}

// Fetch existing rows for a batch of keys: `in` on the most selective key
// column, `eq` on columns that are constant in the batch, exact match client-side.
export async function selectByKeys(store, table, key, batch, columns) {
  const distinct = key.map(k => [k, [...new Set(batch.map(r => String(r[k])))]]);
  const eq = {}; let inCol = null; let inVals = [];
  for (const [k, vals] of distinct) {
    if (vals.length === 1) eq[k] = vals[0];
    else if (vals.length > inVals.length) { if (inCol) eq[inCol] = undefined; inCol = k; inVals = vals; }
  }
  for (const k of Object.keys(eq)) if (eq[k] === undefined) delete eq[k];
  const multi = distinct.filter(([k, v]) => v.length > 1 && k !== inCol).map(([k]) => k);
  const out = [];
  const step = store.inChunk || 500;
  const lists = inCol ? chunkArr(inVals, step) : [null];
  for (const list of lists) {
    const rows = await store.select(table, { columns, eq, in: list ? { [inCol]: list } : {} });
    out.push(...rows);
  }
  if (!multi.length) return out;
  const want = new Set(batch.map(r => key.map(k => String(r[k])).join('\u0001')));
  return out.filter(r => want.has(key.map(k => String(r[k])).join('\u0001')));
}

export const chunkArr = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

function toJson(v) {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

// Compare a stored value with an incoming JSON value without false positives
// from type round-trips (numeric strings, Date objects, timestamps, jsonb).
export function sameValue(dbVal, newVal) {
  if (dbVal === null || dbVal === undefined) return newVal === null || newVal === undefined;
  if (newVal === null || newVal === undefined) return false;
  if (dbVal instanceof Date) {
    if (typeof newVal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(newVal)) return dbVal.toISOString().slice(0, 10) === newVal;
    return dbVal.getTime() === new Date(newVal).getTime();
  }
  if (typeof dbVal === 'number' || typeof newVal === 'number') return Number(dbVal) === Number(newVal);
  if (typeof dbVal === 'object' || typeof newVal === 'object') return JSON.stringify(canon(dbVal)) === JSON.stringify(canon(newVal));
  if (typeof dbVal === 'string' && typeof newVal === 'string') {
    if (/^-?\d+(\.\d+)?$/.test(dbVal) && /^-?\d+(\.\d+)?$/.test(newVal)) return Number(dbVal) === Number(newVal);
    // timestamptz round-trips as '2017-08-18T18:30:00+00:00'; dates as 'YYYY-MM-DD'
    if (/^\d{4}-\d{2}-\d{2}T/.test(dbVal) && /^\d{4}-\d{2}-\d{2}T/.test(newVal)) return Date.parse(dbVal) === Date.parse(newVal);
  }
  return String(dbVal) === String(newVal);
}

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map(k => [k, canon(v[k])]));
  return v;
}

// ---------------------------------------------------------------- PGlite
// SQL implementation of the primitives. Tests and local proofs only.
export async function openPglite({ dataDir, sportsProjectStubs = true } = {}) {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = dataDir ? new PGlite(dataDir) : new PGlite();
  await db.waitReady;
  if (sportsProjectStubs) {
    // The migrations' target guard demands the sports project's marker tables.
    await db.exec('create table if not exists public.ufc_bouts (id int); create table if not exists public.ufc_model_versions (id int);');
  }
  return pgliteStore(db);
}

const q = s => `"${s.replace(/"/g, '')}"`;

export function pgliteStore(db) {
  const where = ({ eq = {}, neq = {}, in: inn = {}, is = {}, gte = {}, lte = {} } = {}, params) => {
    const w = [];
    for (const [k, v] of Object.entries(gte)) { params.push(v); w.push(`${q(k)} >= $${params.length}`); }
    for (const [k, v] of Object.entries(lte)) { params.push(v); w.push(`${q(k)} <= $${params.length}`); }
    for (const [k, v] of Object.entries(eq)) { params.push(v); w.push(`${q(k)}::text = $${params.length}::text`); }
    for (const [k, v] of Object.entries(neq)) { params.push(v); w.push(`${q(k)}::text is distinct from $${params.length}::text`); }
    for (const [k, v] of Object.entries(inn)) { params.push(v.map(String)); w.push(`${q(k)}::text = any($${params.length}::text[])`); }
    for (const [k, v] of Object.entries(is)) w.push(`${q(k)} is ${v === null ? 'null' : v ? 'true' : 'false'}`);
    return w.length ? ` where ${w.join(' and ')}` : '';
  };
  return {
    db, kind: 'pglite', inChunk: 5000,
    async select(table, opts = {}) {
      const params = [];
      const cols = !opts.columns || opts.columns === '*' ? '*' : (Array.isArray(opts.columns) ? opts.columns : opts.columns.split(',')).map(c => q(c.trim())).join(',');
      let sql = `select ${cols} from public.${q(table)}${where(opts, params)}`;
      if (opts.order) sql += ` order by ${opts.order.split(',').map(o => { const [c, d] = o.trim().split('.'); return `${q(c)} ${d === 'desc' ? 'desc' : 'asc'}`; }).join(',')}`;
      if (opts.limit) sql += ` limit ${Number(opts.limit)}`;
      return (await db.query(sql, params)).rows;
    },
    async insert(table, rows) {
      if (!rows.length) return;
      const cols = Object.keys(rows[0]).map(q).join(',');
      await db.query(`insert into public.${q(table)} (${cols}) select ${cols} from jsonb_populate_recordset(null::public.${q(table)}, $1::jsonb)`, [JSON.stringify(rows)]);
    },
    async upsert(table, rows, onConflict) {
      if (!rows.length) return;
      const colList = Object.keys(rows[0]);
      const cols = colList.map(q).join(',');
      const set = colList.filter(c => !onConflict.includes(c)).map(c => `${q(c)} = excluded.${q(c)}`).join(', ');
      await db.query(`insert into public.${q(table)} (${cols}) select ${cols} from jsonb_populate_recordset(null::public.${q(table)}, $1::jsonb)
        on conflict (${onConflict.map(q).join(',')}) do ${set ? `update set ${set}` : 'nothing'}`, [JSON.stringify(rows)]);
    },
    async count(table, opts = {}) {
      const params = [];
      return Number((await db.query(`select count(*)::int n from public.${q(table)}${where(opts, params)}`, params)).rows[0].n);
    },
    async query(sql, params = []) { return db.query(sql, params); }, // tests/proofs only
    async exec(sql) { return db.exec(sql); },
    async close() { await db.close(); },
  };
}

export async function applyMigrations(store, dir = 'supabase/migrations') {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const files = (await fs.readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) await store.exec(await fs.readFile(path.join(dir, f), 'utf8'));
  return files;
}
