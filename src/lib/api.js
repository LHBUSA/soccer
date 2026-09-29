// The browser talks to ONE place: the same-origin read-only proxy /api/soccer/*.
// Never a provider, never the Worker hostname directly, never Supabase.
export const API_BASE = '/api/soccer/';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cache = new Map(); // per page-load memo (the edge caches across users)
const cachedAt = new Map();
const inflight = new Set();
const FRESH_REUSE_MS = new Map([['live', 30000]]); // shell/home/PBEcast may request the same live snapshot together

export function apiPath(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const qs = q.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

export async function api(path, params = {}, { fresh = false } = {}) {
  const url = apiPath(path, params);
  const reuseMs = FRESH_REUSE_MS.get(path) || 0;
  if (cache.has(url) && (!fresh || inflight.has(url) || (reuseMs && Date.now() - (cachedAt.get(url) || 0) < reuseMs))) return cache.get(url);
  const p = (async () => {
    let res;
    try { res = await fetch(url, { headers: { accept: 'application/json' } }); } catch { throw new ApiError(0, 'Network unavailable'); }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body?.error || `HTTP ${res.status}`);
    if (!body || !('data' in body) || !body.meta) throw new ApiError(502, 'Unexpected response shape');
    return body;
  })();
  cache.set(url, p);
  inflight.add(url);
  p.then(() => { inflight.delete(url); cachedAt.set(url, Date.now()); }, () => { inflight.delete(url); cache.delete(url); cachedAt.delete(url); });
  return p;
}
