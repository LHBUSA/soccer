// Soccer Pro access — decided SERVER-SIDE by the network auth authority, never by the browser.
// The pbe_session cookie (Domain=.propbetedge.ai, issued by propbetedge-auth-magic) reaches
// soccer.propbetedge.ai; the same-origin proxy forwards ONLY that cookie on /pro/* requests, and this
// Worker asks auth-magic `GET /membership?sport=soccer` (Service Binding AUTH), which validates the
// session and asks sports-billing for pbe_all_access. Soccer has no sport-only plan: the only grants
// are 'all_access' and 'owner'. Any failure (no binding, timeout, non-200, unreadable body) = FREE
// for Pro; public soccer routes never call this.
export const PRO_STATES = new Set(['all_access', 'owner']);
const AUTH_URL = 'https://auth.propbetedge.ai/membership?sport=soccer';
const TIMEOUT_MS = 2500;

export function sessionCookie(req) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === 'pbe_session') { const val = v.join('='); return /^[A-Za-z0-9_\-.]{20,4096}$/.test(val) ? val : null; }
  }
  return null;
}

const FREE = (check, reason) => ({ granted: false, check, reason, membership: { state: 'free', label: 'FREE', sport: 'soccer', show_purchase_cta: true, show_manage: false, email: null } });

// Browser-safe subset of the contract membership (no product internals beyond what the account card shows).
function safeMembership(m) {
  return {
    state: m.state, label: m.label, sport: 'soccer', email: m.email || null,
    current_period_end: m.current_period_end || null, cancel_at_period_end: !!m.cancel_at_period_end,
    show_purchase_cta: !!m.show_purchase_cta, show_manage: !!m.show_manage, manage_url: m.show_manage ? m.manage_url : null,
  };
}

export async function proAccess(req, env) {
  const token = sessionCookie(req);
  if (!token) return FREE('ok', 'no_session');
  if (!env.AUTH || typeof env.AUTH.fetch !== 'function') return FREE('unavailable', 'auth_binding_missing');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await env.AUTH.fetch(AUTH_URL, { headers: { cookie: `pbe_session=${token}`, accept: 'application/json' }, signal: ctrl.signal });
    if (r.status !== 200) return FREE('unavailable', `auth_http_${r.status}`);
    const body = await r.json();
    const m = body?.membership;
    if (!m || m.sport !== 'soccer' || typeof m.state !== 'string') return FREE('unavailable', 'auth_shape');
    const granted = PRO_STATES.has(m.state) && m.entitled === true;
    return { granted, check: 'ok', reason: body.reason || null, authenticated: !!body.authenticated, membership: safeMembership(m) };
  } catch {
    return FREE('unavailable', 'auth_unreachable');
  } finally {
    clearTimeout(timer);
  }
}
