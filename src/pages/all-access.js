// /all-access: the native PropBetEdge All Access page on Soccer (owner decision 2026-10-05). A real local
// page (the edge middleware serves it with its own title, canonical and summary; no redirect, no iframe).
// The state panel renders the server verdict from /api/soccer/pro/access; the network and Soccer content
// below it is the same for every reader. Owner link policy: GET ALL ACCESS is the canonical Stripe link;
// Platinum and owner see no purchase action; an unverified check never becomes a sales screen.
import { esc, join } from '../lib/html.js';
import { proAccess, resetAccess, signOut } from '../lib/pro.js';
import { FREE_FEATURES, NETWORK_SPORTS, OFFER_LINE, PREDICTIONS, PREDICTIONS_BLURB, PRICE, PRO_UNLOCKS, PROMO_LINE, RESEARCH, accountView, checkoutFor, designation } from '../lib/account-surface.js';

const LINES = {
  mlb: 'Pitch-level evidence, HR and strikeout models, sharp tools',
  nfl: 'PBE Algo, official picks, Player DNA, PBEcast',
  nba: 'Game intelligence, Player DNA, load and rotations',
  wnba: 'Game intelligence, WinBA, Player DNA',
  nhl: 'Goalies, lines, shot intelligence, PBEcast',
  ufc: 'Fight DNA, PBE Algo, Fight Simulator',
  tennis: 'Player and match DNA, live match intelligence',
  soccer: 'Match intelligence, PBEcast, workload and matchup intelligence',
  golf: 'Player and Course DNA, field and tournament intelligence',
  f1: 'Race, driver and circuit intelligence',
};

function launcher(owner) {
  return `<section class="aap-launch" aria-label="PropBetEdge network"><p class="acct-k">${owner ? 'THE FULL NETWORK · UNLOCKED' : 'YOUR NETWORK · UNLOCKED'}</p>
    <ul>${join(NETWORK_SPORTS, s => (s.here ? `<li><span class="here" aria-current="page"><b>${esc(s.name)}</b><em>YOU ARE HERE</em></span></li>` : `<li><a href="${esc(s.url)}" rel="noopener"><b>${esc(s.name)}</b><em>OPEN →</em></a></li>`))}</ul>
    <a class="aap-pred" href="${esc(PREDICTIONS.url)}" rel="noopener"><span>INTELLIGENCE</span><b>◆ ${esc(PREDICTIONS.label)}</b><em>OPEN →</em></a></section>`;
}

function panel(view, a) {
  const m = a.membership || {};
  if (view === 'check') return `<div class="acct-panel">${m.email ? `<p class="acct-id check"><i></i>SIGNED IN<b>${esc(m.email)}</b></p>` : ''}
    <p class="acct-eyebrow">SOCCER · ACCESS CHECK</p><h2 class="acct-h">Access check temporarily unavailable.</h2>
    <p class="acct-lede">We could not verify All Access just now. Nothing about your membership has changed, and every public soccer page keeps working.</p>
    <p class="acct-protect"><b>Your account is not being treated as unsubscribed.</b> Pricing and upgrade prompts stay hidden until verification answers cleanly.</p>
    <div class="acct-actions"><button type="button" class="acct-cta" data-aap-retry>RETRY VERIFIED ACCESS</button>${m.email ? '<button type="button" class="acct-btn" data-aap-out>SIGN OUT</button>' : ''}</div></div>`;
  if (view === 'all_access' || view === 'owner') {
    const d = designation(view);
    return `<div class="acct-panel"><p class="acct-eyebrow on">${view === 'owner' ? 'PROPBETEDGE · VERIFIED OWNER' : 'PROPBETEDGE ALL ACCESS · PLATINUM MEMBER'}</p>
      <h2 class="acct-h big">${view === 'owner' ? 'Owner access is active.' : 'Your network<br>is unlocked.'}</h2>
      <section class="acct-verified ${d.tone}" aria-label="Verified account"><p class="acct-vtop"><span>VERIFIED ACCOUNT</span><b class="acct-badge ${d.tone}">${esc(d.badge)}</b></p>
        ${m.email ? `<p class="acct-email">${esc(m.email)}</p>` : ''}<p class="acct-vmeta"><span>${esc(view === 'owner' ? 'Owner access · no subscription required' : 'PropBetEdge All Access · active')}</span>${d.truth ? `<span>${esc(d.truth)}</span>` : ''}</p></section>
      ${launcher(view === 'owner')}
      <div class="acct-actions"><a class="acct-cta" href="/pro" data-link>OPEN PRO MATCH CENTER</a>
        ${m.show_manage && m.manage_url ? `<a class="acct-btn" href="${esc(m.manage_url)}" target="_blank" rel="noopener">MANAGE MEMBERSHIP ↗</a>` : ''}
        <button type="button" class="acct-btn" data-aap-retry>REFRESH VERIFIED ACCESS</button></div>
      <p class="acct-secure on">◆ ${esc(view === 'owner' ? 'Verified owner · no checkout, no subscription required' : `${d.status} · ${d.truth}`)}</p></div>`;
  }
  return `<div class="acct-panel">${view === 'signed_in' ? `<p class="acct-id"><i></i>SIGNED IN<b>${esc(m.email)}</b></p>` : ''}
    <p class="acct-eyebrow">PROPBETEDGE ALL ACCESS</p>
    <h2 class="acct-h">${view === 'signed_in' ? 'Your account is ready.' : `${esc(OFFER_LINE)}.<br>One membership.`}</h2>
    <p class="aap-price"><b>${esc(PRICE.replace('/month', ''))}</b><span>/month</span><small>${esc(PROMO_LINE)}</small></p>
    <div class="aap-incl"><p class="acct-k">SPORTS · ${NETWORK_SPORTS.length}</p><ul>${join(NETWORK_SPORTS, s => `<li${s.here ? ' class="on"' : ''}>${esc(s.name)}</li>`)}</ul>
      <p class="acct-k">INTELLIGENCE</p><p class="aap-intel"><b>◆ ${esc(PREDICTIONS.label)}</b></p></div>
    <div class="acct-actions"><a class="acct-cta" href="${esc(checkoutFor(m.email))}" rel="noopener" data-pbe-placement="soccer_all_access_page">GET ALL ACCESS</a>${view === 'signed_out' ? '<button type="button" class="acct-btn" data-account-open>SIGN IN</button>' : '<button type="button" class="acct-btn" data-aap-out>SIGN OUT</button>'}</div>
    <p class="acct-secure">◆ Secure checkout by Stripe · Passwordless PropBetEdge access</p></div>`;
}

function story(view) {
  const member = view === 'all_access' || view === 'owner';
  const title = view === 'check' ? 'Your access<br><em>is protected.</em>' : member ? 'The whole network<br><em>is open.</em>' : 'Soccer intelligence is one desk.<br><em>All Access opens the network.</em>';
  const copy = view === 'check'
    ? 'While verification is unavailable, nothing about your membership changes, and public soccer intelligence keeps working.'
    : 'Workload, rotation and matchup intelligence are how PropBetEdge reads a soccer match. All Access brings the same evidence-first intelligence to every sport in the network, plus PropBetEdge Predictions.';
  return `<div class="acct-story is-${member ? 'member' : view === 'check' ? 'check' : 'prospect'}">
    <ul class="acct-chips" aria-hidden="true"><li><i></i>10 SPORTS · ONE MEMBERSHIP</li><li><i></i>PREDICTIONS · INCLUDED</li><li><i></i>SOCCER · YOU ARE HERE</li>${member ? '<li class="on"><i></i>UNLOCKED</li>' : ''}</ul>
    <div class="acct-story-copy"><p class="acct-eyebrow">PROPBETEDGE NETWORK · ALL ACCESS</p><h1 class="acct-title">${title}</h1><p>${copy}</p></div></div>`;
}

export const allAccess = {
  title: () => 'PropBetEdge All Access on Soccer — 10 Sports + Predictions, $29/month | PropBetEdge',
  async load() { return { access: await proAccess() }; },
  render(d) {
    const a = d.access; const view = accountView(a); const member = view === 'all_access' || view === 'owner';
    return `<section class="aap"><div class="wrap">
      <div class="acct-shell page" data-aap-view="${view}">${story(view)}${panel(view, a)}</div>
      <section class="aap-sec" aria-labelledby="aap-network"><p class="kicker gold">THE PROPBETEDGE NETWORK</p><h2 id="aap-network">Ten sport desks. One intelligence product.</h2>
        <p class="muted">Every desk is built for how its sport actually works. Features vary by sport; each one lists only what it actually ships.</p>
        <ul class="aap-grid">${join(NETWORK_SPORTS, s => `<li${s.here ? ' class="here"' : ''}>${s.here ? `<span aria-current="page"><b>${esc(s.name)}</b><em>YOU ARE HERE</em><small>${esc(LINES[s.key] || '')}</small></span>` : `<a href="${esc(s.url)}" rel="noopener"><b>${esc(s.name)}</b><em>OPEN ${esc(s.name.toUpperCase())} →</em><small>${esc(LINES[s.key] || '')}</small></a>`}</li>`)}</ul>
        <a class="aap-intel-row" href="${esc(PREDICTIONS.url)}" rel="noopener"><span>INTELLIGENCE PRODUCT · NOT A SPORT</span><b>◆ ${esc(PREDICTIONS.label)}</b><small>${esc(PREDICTIONS_BLURB)}</small></a></section>
      <section class="aap-sec" aria-labelledby="aap-soccer"><p class="kicker gold">THROUGH THE SOCCER LENS</p><h2 id="aap-soccer">What the Soccer desk brings to All Access.</h2>
        <section class="acct-caps${member ? ' on' : ''}" aria-label="${member ? 'Unlocked on this account' : 'What All Access contains on Soccer'}"><p class="acct-k">${member ? 'UNLOCKED ON THIS ACCOUNT' : 'WHAT ALL ACCESS CONTAINS ON SOCCER'}</p>
          <ul>${join(PRO_UNLOCKS, c => `<li><a href="${c.href}" data-link><i aria-hidden="true"></i><b>${esc(c.label)}</b><span>${esc(c.sub)}</span></a></li>`)}${join(RESEARCH, c => `<li class="pending"><a href="${c.href}" data-link><i aria-hidden="true"></i><b>${esc(c.label)}</b><span>${esc(c.sub)}</span></a></li>`)}</ul>
          <p class="acct-free">Free for every reader: ${esc(FREE_FEATURES.join(' · '))}.</p></section>
        <p class="caveat">The Matchup Analyzer is descriptive, never a win probability. Model Lab publishes no probabilities until a model passes formal prospective promotion. PropBetEdge is independent and is not affiliated with any league, club or sportsbook.</p></section>
    </div></section>`;
  },
  mount(root) {
    // [data-account-open] is handled once, globally, in main.js (never a second listener here).
    root.querySelectorAll('[data-aap-retry]').forEach(b => b.addEventListener('click', () => { resetAccess(); location.reload(); }));
    root.querySelectorAll('[data-aap-out]').forEach(b => b.addEventListener('click', async () => { await signOut(); location.reload(); }));
  },
};
