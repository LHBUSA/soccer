// SOCCER PRO (/pro) and the PRO MATCH CENTER (/pro/matches/:id).
// Commercial page is public and indexable; premium VALUES are fetched only for an entitled reader
// (server-side decision, 403 otherwise) and are never rendered, hidden or blurred for anyone else.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateLong, num } from '../lib/format.js';
import { proAccess, proGet } from '../lib/pro.js';
import { competitionMark, errorState, sectionHead, sourcePanel, teamMark } from '../components/ui.js';
import { openAccount } from '../components/account.js';
import { offerCard } from '../components/offer.js';
import { mountAnalyzer } from '../components/analyzer.js';
import { LOCAL_ALL_ACCESS_PATH, OFFER_LINE, accountView, designation } from '../lib/account-surface.js';
import { proCopy } from '../i18n/pro-copy.js';

const pct = v => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);

// Membership strip: member designation (◆ PLATINUM / VERIFIED OWNER), ACCESS CHECK while unverified,
// SIGNED IN for a known non-member, ALL ACCESS for an anonymous reader. Never FREE.
function stateStrip(a) {
  const m = a.membership || {}; const view = accountView(a);
  if (view === 'all_access' || view === 'owner') return `<p class="pro-state on"><span class="pro-pill">${esc(designation(view).badge)}</span>${m.email ? `<span>${esc(m.email)}</span>` : ''}${m.show_manage && m.manage_url ? `<a href="${esc(m.manage_url)}" rel="noopener">Manage membership ↗</a>` : ''}<a href="${LOCAL_ALL_ACCESS_PATH}" data-link>Your network →</a></p>`;
  const pill = view === 'check' ? 'ACCESS CHECK' : view === 'signed_in' ? 'SIGNED IN' : 'ALL ACCESS';
  return `<p class="pro-state"><span class="pro-pill free">${pill}</span>${m.email ? `<span>${esc(m.email)}</span>` : `<button type="button" class="pro-signin" data-account-open>SIGN IN</button>`}</p>`;
}
// The offer only where the verdict allows a sale: never for members, never during an access check.
const offerFor = a => (accountView(a) === 'check' ? '' : offerCard(a.membership));

// A locked module: what it evaluates and outputs, plus a shell with NO numbers in it.
function lockedShell(mod) {
  return `<div class="pro-lock" aria-label="${esc(mod.name)}: All Access">
    ${join(mod.outputs, o => `<div class="pl-row"><span class="pl-k">${esc(o)}</span><span class="pl-bar" aria-hidden="true"></span><span class="pl-tag">ALL ACCESS</span></div>`)}
    <p class="pl-note">Calculated for every upcoming match. Values are sent only to All Access members.</p>
  </div>`;
}

function moduleSection(mod, a, extra = '') {
  const id = { fatigue: 'fatigue', rotation: 'rotation', matchup: 'matchup', model_lab: 'model-lab' }[mod.key];
  return `<section class="pro-mod" id="${id}">
    <header><p class="kicker gold">${esc(mod.name.toUpperCase())}</p><h2>${esc(mod.outputs.join(' · '))}</h2></header>
    <div class="pro-mod-grid"><div><p class="pro-h">WHAT IT EVALUATES</p><ul class="pro-list">${join(mod.evaluates, e => `<li>${esc(e)}</li>`)}</ul></div>
    <div>${mod.key === 'model_lab' ? '' : a.pro ? extra : lockedShell(mod)}</div></div>
  </section>`;
}

function boardView(res) {
  if (!res || res.status !== 200) return errorState({ status: res?.status || 0, message: 'Match Center unavailable right now.' });
  const rows = res.body.data || [];
  if (!rows.length) return '<p class="muted">No upcoming matches in the next seven days.</p>';
  const side = s => `<span class="pb-side">${teamMark(s.team, 'xs')}<span>${esc(s.team?.short_name || s.team?.name || '')}</span><b title="Team fatigue index">${num(s.team_fatigue_index)}</b><small>${s.days_since_last === null ? '—' : `${num(s.days_since_last)}d rest`}</small></span>`;
  return `<ul class="pro-board">${join(rows, m => `<li><a href="/pro/matches/${esc(m.id)}" data-link>${competitionMark(m.competition, 'xs')}<span class="pb-when">${esc(dateLong(m.kickoff_at))}</span>${side(m.home)}<span class="pb-v">v</span>${side(m.away)}<span class="pb-go">MATCH CENTER →</span></a></li>`)}</ul>
  <p class="caveat">${esc(res.body.meta?.semantics || '')}</p>`;
}

export const pro = {
  title: () => 'Soccer Pro — Match Center, Matchup Lab & Fatigue Intelligence | PropBetEdge',
  async load() {
    const [catalog, access] = await Promise.all([api('pro/catalog'), proAccess()]);
    const board = access.pro ? await proGet('board') : null; // premium values are requested only for an entitled reader
    return { catalog, access, board };
  },
  render(d) {
    const c = d.catalog.data; const a = d.access;
    const mods = Object.fromEntries(c.modules.map(m => [m.key, m]));
    return `<section class="hero compact pro-hero"><div class="wrap">
      <p class="kicker gold">SOCCER PRO · PROPBETEDGE ALL ACCESS</p>
      <h1 class="display">The match before the score</h1>
      <p class="lede">Workload, rotation and matchup intelligence built only from the canonical soccer graph: schedules, sourced lineups, minutes, shots and results. Every number shows the components behind it.</p>
      ${stateStrip(a)}
    </div></section>
    <section class="canvas"><div class="wrap">
      <div class="pro-top">
        <section class="pro-mod" id="match-center"><header><p class="kicker gold">PRO MATCH CENTER</p><h2>Upcoming matches, both sides' load</h2></header>
          ${a.pro ? boardView(d.board) : lockedShell({ name: 'Pro Match Center', outputs: ['TEAM FATIGUE INDEX', 'REST DIFFERENTIAL', 'PBE MATCHUP RATING'] })}</section>
        ${offerFor(a)}
      </div>
      ${moduleSection(mods.fatigue, a, '<p class="muted">Open any match in the Match Center for both teams\' TEAM FATIGUE INDEX, XI LOAD and the components behind them.</p>')}
      ${moduleSection(mods.rotation, a, '<p class="muted">XI STABILITY, ROTATION PRESSURE and REST DIFFERENTIAL are in every Match Center page.</p>')}
      ${moduleSection(mods.matchup, a, '<p class="muted">The PBE MATCHUP RATING and its seven components are in every Match Center page. It is descriptive, never a win probability.</p>')}
      <section class="pro-mod" id="model-lab"><header><p class="kicker gold">MODEL LAB</p><h2>${esc(c.model_lab.label)}</h2></header>
        <p>${esc(c.model_lab.detail)}</p><p class="pro-h">AFTER FORMAL PROMOTION ONLY</p><ul class="pro-list">${join(c.model_lab.will_include_after_promotion, x => `<li>${esc(x)}</li>`)}</ul></section>
      <section class="pro-mod" id="track-record"><header><p class="kicker gold">TRACK RECORD</p><h2>Nothing published, nothing to hide</h2></header>
        <p>Soccer Pro publishes no predictions yet, so there is no track record to show. When a model is promoted, every prediction is frozen before kick-off and graded here.</p></section>
      <section class="pro-mod" id="included"><header><p class="kicker gold">FREE VS ALL ACCESS</p><h2>What is included</h2></header>
        <div class="pro-mod-grid"><div><p class="pro-h">FREE</p><ul class="pro-list">${join(c.free_includes, x => `<li>${esc(x)}</li>`)}</ul></div>
        <div><p class="pro-h">ALL ACCESS</p><ul class="pro-list"><li>Pro Match Center</li><li>Fatigue Intelligence values</li><li>Rotation / XI Stability values</li><li>Matchup Lab values</li><li>Validated predictive models (after promotion)</li><li>${esc(OFFER_LINE)}</li></ul></div></div></section>
      <p class="caveat">Coverage: ${num(c.coverage.finished_matches)} finished matches and ${num(c.coverage.sourced_lineups)} sourced lineups across ${num(c.coverage.competitions.length)} competitions. Workload intelligence is not a medical or fitness assessment.</p>
      ${sourcePanel(d.catalog.meta, { title: 'METHOD' })}
    </div></section>`;
  },
  mount(root) { root.querySelectorAll('[data-account-open]').forEach(b => b.addEventListener('click', () => openAccount())); },
};

// ---- Pro Match Center ------------------------------------------------------------------------
function indexCard(title, idx) {
  if (!idx) return '';
  const t = proCopy(); // component labels/details by API code, in the page locale
  return `<div class="pi-card"><p class="pi-h">${esc(title)}</p><p class="pi-score"><b>${num(idx.score)}</b><small>/100</small></p>
    <ul class="pi-comp">${join(idx.components, c => `<li><span>${esc(t.indexLabel(c))}</span><span class="muted">${esc(t.indexDetail(c) || '')}</span><b>+${num(c.contribution, { dp: 1 })}</b></li>`)}</ul></div>`;
}
function sideBlock(name, s) {
  return `<div class="pmc-side"><h3>${esc(name)}</h3>
    ${indexCard('TEAM FATIGUE INDEX', s.team_fatigue_index)}${indexCard('XI LOAD', s.xi_load)}${indexCard('ROTATION PRESSURE', s.rotation_pressure)}
    <dl class="pmc-facts"><div><dt>Days since last match</dt><dd>${num(s.load.days_since_last)}</dd></div><div><dt>Matches 7 / 14 / 21 days</dt><dd>${num(s.load.matches_7)} / ${num(s.load.matches_14)} / ${num(s.load.matches_21)}</dd></div>
      <div><dt>XI continuity</dt><dd>${pct(s.xi_stability.xi_continuity)}</dd></div><div><dt>Top-11 minute share</dt><dd>${pct(s.xi_stability.top11_minute_share)}</dd></div><div><dt>Last five</dt><dd>${esc(s.load.home_away_last5 || '—')}</dd></div></dl></div>`;
}

export const proMatch = {
  title: d => (d?.res?.status === 200 ? `${d.res.body.data.match.home?.name} vs ${d.res.body.data.match.away?.name} Pro Match Center | PropBetEdge` : 'Pro Match Center | PropBetEdge'),
  robots: 'noindex, follow',
  async load([id]) {
    const access = await proAccess();
    const res = access.pro ? await proGet(`matches/${id}`) : { status: 403, body: { error: 'all_access_required', membership: access.membership?.state || 'free' } };
    return { id, access, res };
  },
  render(d) {
    if (d.res.status === 403) return `<section class="hero compact pro-hero"><div class="wrap"><p class="kicker gold">PRO MATCH CENTER</p><h1 class="display">All Access required</h1>
      <p class="lede">Fatigue, rotation and matchup intelligence for this match are calculated. They are sent only to PropBetEdge All Access members.</p>${stateStrip(d.access)}</div></section>
      <section class="canvas"><div class="wrap pro-top">${lockedShell({ name: 'Pro Match Center', outputs: ['TEAM FATIGUE INDEX', 'XI LOAD', 'ROTATION PRESSURE', 'REST DIFFERENTIAL', 'PBE MATCHUP RATING'] })}${offerFor(d.access)}</div>
      <div class="wrap"><p><a href="/matches/${esc(d.id)}" data-link class="sec-link">Free match intelligence for this match →</a></p></div></section>`;
    if (d.res.status !== 200) return `<section class="canvas"><div class="wrap">${errorState({ status: d.res.status, message: d.res.body?.error || 'Unavailable' })}</div></section>`;
    const x = d.res.body.data; const lab = x.matchup_lab;
    return `<section class="hero compact pro-hero"><div class="wrap"><p class="kicker gold">PRO MATCH CENTER · ${esc(dateLong(x.match.kickoff_at))}</p>
      <h1 class="display">${esc(x.match.home?.name)} v ${esc(x.match.away?.name)}</h1>${stateStrip(d.access)}</div></section>
      <section class="canvas"><div class="wrap">
        <div data-analyzer>${x.analyzer_available ? `${sectionHead('PBE MATCHUP ANALYZER', 'Preparing the evidence map')}<div class="module-placeholder" role="status" aria-label="Loading matchup analyzer"><div class="sk-line"></div><div class="sk-line"></div></div>` : ''}</div>
        ${sectionHead('LOAD CONTEXT', 'Fatigue, rotation and XI continuity')}
        ${when(x.rest_differential, () => `${sectionHead('REST DIFFERENTIAL', `${num(x.rest_differential.home_days, { dp: 1 })} v ${num(x.rest_differential.away_days, { dp: 1 })} days`)}`)}
        <div class="two">${sideBlock(x.match.home?.name, x.home)}${sideBlock(x.match.away?.name, x.away)}</div>
        ${sectionHead('MODEL LAB', x.model_lab.label)}<p class="muted">${esc(x.model_lab.detail)}</p>
        ${sourcePanel(d.res.body.meta, { title: 'METHOD' })}
      </div></section>`;
  },
  mount(root, d, ctx) { root.querySelectorAll('[data-account-open]').forEach(b => b.addEventListener('click', () => openAccount())); if (d.res?.status === 200) mountAnalyzer(root, d, ctx); },
};
