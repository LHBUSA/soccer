// The browser talks to ONE place: the same-origin read-only proxy /api/soccer/*.
// Never a provider, never the Worker hostname directly, never Supabase.
export const API_BASE = '/api/soccer/';

export class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const cache = new Map(); // per page-load memo (the edge caches across users)
const cachedAt = new Map();
const inflight = new Set();
export const reuseMs = path => path === 'live' || /\/cast$/.test(path) ? 10000
  : path.startsWith('pro/') ? 0 : /\/history$/.test(path) || path === 'coverage' ? 300000
    : /\/dna$/.test(path) ? 60000 : path === 'matches' || path.startsWith('matches/') ? 15000 : 60000;

export function apiPath(path, params = {}) {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const qs = q.toString();
  return `${API_BASE}${path}${qs ? `?${qs}` : ''}`;
}

export async function api(path, params = {}, { fresh = false } = {}) {
  const url = apiPath(path, params);
  const ttl = reuseMs(path);
  if (cache.has(url) && (inflight.has(url) || (!fresh && Date.now() - (cachedAt.get(url) || 0) < ttl) || (path === 'live' && Date.now() - (cachedAt.get(url) || 0) < ttl))) return cache.get(url);
  const p = (async () => {
    let res;
    try { res = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(20000) }); } catch { throw new ApiError(0, 'Network unavailable or request timed out'); }
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, body?.error || `HTTP ${res.status}`);
    if (!body || !('data' in body) || !body.meta) throw new ApiError(502, 'Unexpected response shape');
    return body;
  })();
  cache.set(url, p);
  inflight.add(url);
  p.then(() => { inflight.delete(url); cachedAt.set(url, Date.now()); if (cache.size > 100) { const old = [...cache.keys()].find(k => !inflight.has(k)); cache.delete(old); cachedAt.delete(old); } }, () => { inflight.delete(url); cache.delete(url); cachedAt.delete(url); });
  return p;
}
