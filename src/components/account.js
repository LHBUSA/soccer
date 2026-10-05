// ACCOUNT: the PropBetEdge premium account sheet for Soccer (network standard, NFL benchmark).
// One composition: a story column (owned procedural stadium art) and an access panel that changes from
// "here is what All Access contains" to "this is yours". Every state is the server verdict from
// /api/soccer/pro/access (lib/pro.js); nothing here decides access, and no premium value is rendered.
//   signed_out  magic-link sign-in through the network auth + the All Access offer
//   signed_in   SIGNED IN + email, "your account is ready" + the offer (never FREE)
//   check       the server could not verify: retry / sign out, never pricing or sales
//   all_access  SOCCER · PLATINUM MEMBER, unlocked grid, no purchase CTA
//   owner       SOCCER · VERIFIED OWNER, unlocked grid, no purchase CTA
import { esc, join } from '../lib/html.js';
import { proAccess, requestSignIn, resetAccess, signOut } from '../lib/pro.js';
import { offerCard } from './offer.js';
import { FREE_FEATURES, LOCAL_ALL_ACCESS_PATH, PRO_UNLOCKS, RESEARCH, accountView, designation, headerLabel } from '../lib/account-surface.js';

let dlg = null;
// Kept for callers that still import it: the header label now comes from the server verdict.
export const accountButtonLabel = m => headerLabel({ pro: m?.state === 'all_access' || m?.state === 'owner', membership: m || {}, check: 'ok' });

function ensure() {
  if (dlg) return dlg;
  dlg = document.createElement('dialog');
  dlg.className = 'acct';
  dlg.setAttribute('aria-label', 'PropBetEdge Soccer account');
  document.body.appendChild(dlg);
  // One delegated listener set for the dialog's whole life: re-renders never add handlers.
  dlg.addEventListener('click', async e => {
    if (e.target === dlg || e.target.closest('[data-acct-close]')) { dlg.close(); return; }
    if (e.target.closest('a[data-link]')) { dlg.close(); return; }
    if (e.target.closest('[data-acct-out]')) { await signOut(); dlg.close(); location.reload(); return; }
    if (e.target.closest('[data-acct-retry]')) { resetAccess(); render(); }
  });
  dlg.addEventListener('submit', async e => {
    const form = e.target.closest('[data-acct-form]'); if (!form) return;
    e.preventDefault();
    const msg = dlg.querySelector('.acct-msg'); const email = dlg.querySelector('#acct-email').value.trim();
    msg.textContent = 'Sending…';
    try { msg.textContent = await requestSignIn(email); } catch (err) { msg.textContent = err.message; }
  });
  return dlg;
}

const CLOSE = '<button type="button" class="acct-x" data-acct-close aria-label="Close account">×</button>';

function story(view) {
  const member = view === 'all_access' || view === 'owner';
  const eyebrow = member ? 'PROPBETEDGE SOCCER · VERIFIED' : view === 'check' ? 'PROPBETEDGE SOCCER · ACCESS CHECK' : 'PROPBETEDGE SOCCER · ALL ACCESS';
  const title = view === 'check' ? 'Your access<br><em>is protected.</em>' : member ? 'Every desk<br><em>is live.</em>' : 'Read the match<br><em>beneath the scoreline.</em>';
  const copy = view === 'check'
    ? 'While verification is unavailable, nothing about your membership changes, and every public soccer page keeps working.'
    : 'Workload, rotation and matchup intelligence built from the canonical soccer graph: schedules, sourced lineups, minutes, shots and results, with the components behind every number.';
  return `<div class="acct-story is-${member ? 'member' : view === 'check' ? 'check' : 'prospect'}">
    <ul class="acct-chips" aria-hidden="true"><li><i></i>SOURCED LINEUPS</li><li><i></i>CANONICAL GRAPH</li>${member ? '<li class="on"><i></i>UNLOCKED</li>' : ''}</ul>
    <div class="acct-story-copy"><p class="acct-eyebrow">${eyebrow}</p><h2 class="acct-title">${title}</h2><p>${copy}</p>
      ${view === 'signed_out' || view === 'signed_in' ? `<p class="acct-k">ALL ACCESS ON SOCCER</p><ul class="acct-feat">${join(PRO_UNLOCKS, f => `<li><b>${esc(f.label)}</b><span>${esc(f.sub)}</span></li>`)}</ul>` : ''}</div>
  </div>`;
}

function grid(unlocked) {
  return `<section class="acct-caps${unlocked ? ' on' : ''}" aria-label="${unlocked ? 'Unlocked on this account' : 'What All Access contains on Soccer'}">
    <p class="acct-k">${unlocked ? 'UNLOCKED ON THIS ACCOUNT' : 'WHAT ALL ACCESS CONTAINS'}</p>
    <ul>${join(PRO_UNLOCKS, c => `<li><a href="${c.href}" data-link><i aria-hidden="true"></i><b>${esc(c.label)}</b><span>${esc(c.sub)}</span></a></li>`)}
      ${join(RESEARCH, c => `<li class="pending"><a href="${c.href}" data-link><i aria-hidden="true"></i><b>${esc(c.label)}</b><span>${esc(c.sub)}</span></a></li>`)}</ul>
    <p class="acct-free">Free for every reader: ${esc(FREE_FEATURES.join(' · '))}.</p>
  </section>`;
}

function panel(view, a) {
  const m = a.membership || {};
  if (view === 'check') {
    return `<div class="acct-panel">${m.email ? `<p class="acct-id check"><i></i>SIGNED IN<b>${esc(m.email)}</b></p>` : ''}
      <p class="acct-eyebrow">SOCCER · ACCESS CHECK</p><h3 class="acct-h">Access check temporarily unavailable.</h3>
      <p class="acct-lede">We could not verify All Access just now. Nothing about your membership has changed.</p>
      <p class="acct-protect"><b>Your account is not being treated as unsubscribed.</b> Pricing and upgrade prompts stay hidden until verification answers cleanly.</p>
      <div class="acct-actions"><button type="button" class="acct-cta" data-acct-retry>RETRY VERIFIED ACCESS</button>${m.email ? '<button type="button" class="acct-btn" data-acct-out>SIGN OUT</button>' : ''}</div></div>`;
  }
  if (view === 'all_access' || view === 'owner') {
    const d = designation(view);
    return `<div class="acct-panel"><p class="acct-eyebrow on">${esc(d.eyebrow)}</p>
      <h3 class="acct-h big">${view === 'owner' ? 'Owner access is active.' : 'Your Soccer desk<br>is unlocked.'}</h3>
      <p class="acct-lede">${view === 'owner' ? 'Every Soccer Pro surface is unlocked on this verified owner account. No subscription required.' : 'Your PropBetEdge All Access membership unlocks the full network — 10 sports plus PropBetEdge Predictions. Soccer is one of them.'}</p>
      <section class="acct-verified ${d.tone}" aria-label="Verified account"><p class="acct-vtop"><span>VERIFIED ACCOUNT</span><b class="acct-badge ${d.tone}">${esc(d.badge)}</b></p>
        ${m.email ? `<p class="acct-email">${esc(m.email)}</p>` : ''}<p class="acct-vmeta"><span>${esc(view === 'owner' ? 'Owner access · no subscription required' : d.status)}</span>${d.truth ? `<span>${esc(d.truth)}</span>` : ''}</p></section>
      ${grid(true)}
      <div class="acct-actions"><a class="acct-cta" href="/pro" data-link>OPEN PRO MATCH CENTER</a>
        ${m.show_manage && m.manage_url ? `<a class="acct-btn" href="${esc(m.manage_url)}" target="_blank" rel="noopener">MANAGE MEMBERSHIP ↗</a>` : ''}
        <button type="button" class="acct-btn" data-acct-retry>REFRESH VERIFIED ACCESS</button>
        <a class="acct-btn" href="${LOCAL_ALL_ACCESS_PATH}" data-link>YOUR NETWORK</a>
        <button type="button" class="acct-btn" data-acct-out>SIGN OUT</button></div>
      <p class="acct-secure on">◆ ${esc(d.status)} · verified by PropBetEdge</p></div>`;
  }
  if (view === 'signed_in') {
    return `<div class="acct-panel"><p class="acct-id"><i></i>SIGNED IN<b>${esc(m.email)}</b></p>
      <p class="acct-eyebrow">ACCOUNT READY</p><h3 class="acct-h">Your account is ready.</h3>
      <p class="acct-lede">Soccer Pro is part of PropBetEdge All Access. A single-sport plan from another sport does not include Soccer.</p>
      ${offerCard(m, { compact: true })}${grid(false)}
      <div class="acct-actions"><button type="button" class="acct-btn" data-acct-retry>ALREADY JOINED? REFRESH ACCESS</button><button type="button" class="acct-btn" data-acct-out>SIGN OUT</button></div></div>`;
  }
  return `<div class="acct-panel"><p class="acct-eyebrow">VERIFIED MEMBER ACCESS</p><h3 class="acct-h">Welcome back.</h3>
    <p class="acct-lede">Sign in with the email on your PropBetEdge All Access membership. We email a one-time link that brings you back to this page.</p>
    <form class="acct-form" data-acct-form><label for="acct-email">Email address</label><input id="acct-email" type="email" autocomplete="email" required maxlength="200"><button type="submit">SEND SECURE SIGN-IN LINK</button></form>
    <p class="acct-msg" role="status" aria-live="polite"></p>
    <p class="acct-divider" role="separator"><span>NEW TO ALL ACCESS?</span></p>${offerCard(m, { compact: true })}${grid(false)}</div>`;
}

async function render() {
  const d = ensure();
  d.innerHTML = `<div class="acct-shell">${CLOSE}<div class="acct-story is-check"><div class="acct-story-copy"><p class="acct-eyebrow">PROPBETEDGE SOCCER</p></div></div><div class="acct-panel"><p class="muted">Checking your account…</p></div></div>`;
  const a = await proAccess();
  const view = accountView(a);
  d.dataset.view = view;
  d.innerHTML = `<div class="acct-shell">${CLOSE}${story(view)}${panel(view, a)}</div>`;
}

export async function openAccount() {
  const d = ensure();
  if (!d.open) d.showModal();
  await render();
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
