// ACCOUNT: one panel for every reader. Signed out -> magic-link sign-in through the network auth
// (returns to this Soccer page). Signed in -> the shared contract's account panel (state badge,
// email, plan, manage link only when the contract says so, the PropBetEdge network).
import { accountPanelHtml } from '../lib/pbe-membership.js';
import { proAccess, requestSignIn, resetAccess, signOut } from '../lib/pro.js';
import { offerCard } from './offer.js';

let dlg = null;
export const accountButtonLabel = m => (m?.state === 'all_access' || m?.state === 'owner' ? 'ACCOUNT' : m?.email ? 'ACCOUNT' : 'SIGN IN');

function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'acct';
  dlg.setAttribute('aria-label', 'Account');
  document.body.appendChild(dlg);
  dlg.addEventListener('click', e => { if (e.target === dlg || e.target.closest('[data-acct-close]')) dlg.close(); });
  return dlg;
}

export async function openAccount() {
  const d = ensure();
  d.innerHTML = '<div class="acct-body"><p class="muted">Checking your account…</p></div>';
  if (!d.open) d.showModal();
  const a = await proAccess();
  const m = { ...a.membership, sport: 'soccer' };
  const close = '<button type="button" class="acct-x" data-acct-close aria-label="Close">×</button>';
  if (m.email) {
    d.innerHTML = `<div class="acct-body">${close}<p class="kicker gold">PROPBETEDGE ACCOUNT</p>${accountPanelHtml(m, { sport: 'soccer' })}
      ${a.pro ? '<p class="acct-ok">Soccer Pro is unlocked on this account.</p>' : '<p class="muted">Soccer Pro is part of PropBetEdge All Access. A single-sport plan from another sport does not include Soccer.</p>'}
      ${offerCard(m, { compact: true })}<button type="button" class="acct-out" data-acct-out>SIGN OUT</button></div>`;
    d.querySelector('[data-acct-out]').addEventListener('click', async () => { await signOut(); d.close(); location.reload(); });
    return;
  }
  d.innerHTML = `<div class="acct-body">${close}<p class="kicker gold">SIGN IN</p><h2 class="acct-h">PropBetEdge account</h2>
    <p class="muted">We email you a one-time sign-in link. It brings you back to this page.</p>
    <form class="acct-form" data-acct-form><label for="acct-email">Email</label><input id="acct-email" type="email" autocomplete="email" required maxlength="200"><button type="submit">EMAIL ME A LINK</button></form>
    <p class="acct-msg" role="status" aria-live="polite"></p>${offerCard(m, { compact: true })}</div>`;
  d.querySelector('[data-acct-form]').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = d.querySelector('.acct-msg'); const email = d.querySelector('#acct-email').value.trim();
    msg.textContent = 'Sending…';
    try { msg.textContent = await requestSignIn(email); } catch (err) { msg.textContent = err.message; }
  });
}

// After the magic-link round trip (?verified=1) the session cookie is new: re-ask the server.
export function handleVerifiedReturn() {
  const u = new URL(location.href);
  if (u.searchParams.get('verified') !== '1') return false;
  u.searchParams.delete('verified');
  history.replaceState({}, '', u.pathname + (u.search ? u.search : '') + u.hash);
  resetAccess();
  return true;
}
