// PostgREST implementation of the store primitives (workers/soccer-ingest/src/store.js)
// for the SPORTS Supabase project. Worker/backfill side only: service role.
// Env: SOCCER_MODEL_SUPABASE_URL + SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY.
// Refuses any host that is not the sports project, so a mis-set secret can never
// write soccer rows into the identity/billing database.

export const SPORTS_PROJECT_REF = 'tkmlnhmylqnttmnsnief';
const MAX_ROWS = 1000; // Supabase max-rows per response

export class StoreError extends Error {
  constructor(status, body, where) {
    super(`postgrest ${status} ${where}: ${String(body).slice(0, 400)}`);
    this.name = 'StoreError';
    this.status = status;
  }
}

export function storeFromEnv(env, { fetch: f = (...a) => globalThis.fetch(...a) } = {}) {
  const url = env?.SOCCER_MODEL_SUPABASE_URL;
  const key = env?.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  if (!new URL(url).host.startsWith(`${SPORTS_PROJECT_REF}.`)) throw new Error('SOCCER_MODEL_SUPABASE_URL is not the sports project');
  return postgrestStore(url, key, f);
}

const enc = v => {
  const s = String(v);
  return /[,()"\\:\s]/.test(s) ? `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : s;
};

export function buildQuery({ columns = '*', eq = {}, neq = {}, in: inn = {}, is = {}, gte = {}, lte = {}, order, limit, offset } = {}) {
  const p = [`select=${encodeURIComponent(Array.isArray(columns) ? columns.join(',') : columns)}`];
  for (const [k, v] of Object.entries(eq)) p.push(`${k}=eq.${encodeURIComponent(v)}`);
  for (const [k, v] of Object.entries(neq)) p.push(`${k}=neq.${encodeURIComponent(v)}`);
  for (const [k, v] of Object.entries(gte)) p.push(`${k}=gte.${encodeURIComponent(v)}`);
  for (const [k, v] of Object.entries(lte)) p.push(`${k}=lte.${encodeURIComponent(v)}`);
  for (const [k, v] of Object.entries(inn)) p.push(`${k}=in.(${v.map(x => encodeURIComponent(enc(x))).join(',')})`);
  for (const [k, v] of Object.entries(is)) p.push(`${k}=is.${v === null ? 'null' : v ? 'true' : 'false'}`);
  if (order) p.push(`order=${order}`);
  if (limit !== undefined) p.push(`limit=${limit}`);
  if (offset) p.push(`offset=${offset}`);
  return p.join('&');
}

export function postgrestStore(url, key, f = (...a) => globalThis.fetch(...a)) {
  const base = `${url.replace(/\/+$/, '')}/rest/v1`;
  const headers = extra => ({ apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extra });
  const store = {
    kind: 'postgrest', requests: 0, inChunk: 150,
    async req(method, path, { body, prefer, retries = 2 } = {}) {
      for (let attempt = 0; ; attempt++) {
        store.requests += 1;
        const res = await f(`${base}/${path}`, { method, headers: headers(prefer ? { prefer } : {}), body: body === undefined ? undefined : JSON.stringify(body) });
        const text = await res.text();
        if (res.ok) return text ? JSON.parse(text) : null;
        if ((res.status >= 500 || res.status === 429) && attempt < retries) { await new Promise(r => setTimeout(r, 500 * 2 ** attempt)); continue; }
        throw new StoreError(res.status, text, `${method} ${path.split('?')[0]}`);
      }
    },
    // Pages through max-rows unless an explicit limit is given.
    async select(table, opts = {}) {
      if (opts.limit !== undefined && opts.limit <= MAX_ROWS) return (await store.req('GET', `${table}?${buildQuery(opts)}`)) || [];
      const out = [];
      const cap = opts.limit ?? Infinity;
      for (let offset = 0; out.length < cap; offset += MAX_ROWS) {
        const page = (await store.req('GET', `${table}?${buildQuery({ ...opts, limit: Math.min(MAX_ROWS, cap - out.length), offset, order: opts.order || undefined })}`)) || [];
        out.push(...page);
        if (page.length < MAX_ROWS) break;
      }
      return out;
    },
    async insert(table, rows, { chunk = 1000 } = {}) {
      for (let i = 0; i < rows.length; i += chunk) await store.req('POST', table, { body: rows.slice(i, i + chunk), prefer: 'return=minimal' });
    },
    async upsert(table, rows, onConflict, { chunk = 1000 } = {}) {
      for (let i = 0; i < rows.length; i += chunk) {
        await store.req('POST', `${table}?on_conflict=${onConflict.join(',')}`, { body: rows.slice(i, i + chunk), prefer: 'resolution=merge-duplicates,return=minimal' });
      }
    },
    async count(table, opts = {}) {
      store.requests += 1;
      const res = await f(`${base}/${table}?${buildQuery({ ...opts, columns: opts.columns || '*' })}`, { method: 'HEAD', headers: headers({ prefer: 'count=exact', range: '0-0' }) });
      if (!res.ok && res.status !== 206) throw new StoreError(res.status, '', `HEAD ${table}`);
      const n = Number((res.headers.get('content-range') || '').split('/')[1]);
      if (!Number.isFinite(n)) throw new StoreError(res.status, res.headers.get('content-range'), `count ${table}`);
      return n;
    },
  };
  return store;
}
