// Soccer Pro on the client. The browser NEVER decides entitlement: it asks the same-origin proxy,
// which forwards only the pbe_session cookie to soccer-api, which asks the network auth authority.
// Premium routes answer 403 without values for a free reader; nothing premium is hidden in the page.
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL } from './pbe-membership.js';
import { OFFER_LINE } from './account-surface.js';

export const AUTH_ORIGIN = 'https://auth.propbetedge.ai';
// OFFER.url is the network reference page (propbetedge.ai/pro); purchase actions use account-surface.js
// ALL_ACCESS_CHECKOUT_URL (the canonical Stripe link) and informational links use LOCAL_ALL_ACCESS_PATH.
export const OFFER = { ...ALL_ACCESS_OFFER, url: ALL_ACCESS_URL, tagline: OFFER_LINE };
const FREE = { state: 'free', label: 'FREE', email: null, show_purchase_cta: true, show_manage: false };

let accessMemo = null;
export function resetAccess() { accessMemo = null; }

// { pro: boolean, membership, check } — fresh per page load (never cached at the edge).
export function proAccess() {
  if (!accessMemo) accessMemo = (async () => {
    try {
      const r = await fetch('/api/soccer/pro/access', { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) });
      // A non-200 or an unreadable body is an outage (access check), never a free reader.
      const b = await r.json();
      return r.ok && b?.data ? { pro: b.data.pro === true, membership: b.data.membership || FREE, check: b.data.check } : { pro: false, membership: FREE, check: 'unavailable' };
    } catch { return { pro: false, membership: FREE, check: 'unavailable' }; }
  })();
  return accessMemo;
}

// Premium read: { status, body }. 403 = all_access_required (no values in the body).
export async function proGet(path) {
  try {
    const r = await fetch(`/api/soccer/pro/${path}`, { headers: { accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(30000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  } catch { return { status: 0, body: null }; }
}

// Magic-link sign-in through the network auth. return_to is honoured by auth-magic only for
// PropBetEdge hosts; the reader lands back on this Soccer page.
export async function requestSignIn(email) {
  const here = new URL(location.href); here.searchParams.delete('verified'); here.hash = '';
  const r = await fetch(`${AUTH_ORIGIN}/magic/request`, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, return_to: here.toString() }) });
  const b = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(b.error || 'Sign-in is unavailable right now.');
  return b.message || 'If that email is registered, a sign-in link is on its way.';
}

export async function signOut() {
  await fetch(`${AUTH_ORIGIN}/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  resetAccess();
}
