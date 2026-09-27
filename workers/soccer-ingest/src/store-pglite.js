// PGlite implementation of the store primitives + migration runner.
// Tests, proofs and local rehearsals ONLY: never imported by Worker code
// (it pulls in @electric-sql/pglite and node:fs).

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
  const where = ({ eq = {}, neq = {}, in: inn = {}, is = {}, gte = {}, lte = {}, cs = {} } = {}, params) => {
    const w = [];
    for (const [k, v] of Object.entries(gte)) { params.push(v); w.push(`${q(k)} >= $${params.length}`); }
    for (const [k, v] of Object.entries(lte)) { params.push(v); w.push(`${q(k)} <= $${params.length}`); }
    for (const [k, v] of Object.entries(eq)) { params.push(v); w.push(`${q(k)}::text = $${params.length}::text`); }
    for (const [k, v] of Object.entries(neq)) { params.push(v); w.push(`${q(k)}::text is distinct from $${params.length}::text`); }
    for (const [k, v] of Object.entries(inn)) { params.push(v.map(String)); w.push(`${q(k)}::text = any($${params.length}::text[])`); }
    for (const [k, v] of Object.entries(is)) w.push(`${q(k)} is ${v === null ? 'null' : v ? 'true' : 'false'}`);
    for (const [k, v] of Object.entries(cs)) { params.push(v.map(String)); w.push(`${q(k)}::text[] @> $${params.length}::text[]`); }
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
