// Shared UI pieces (V3). All data rendering reads the API envelope; nothing here
// invents a value. Missing = shown as missing. Crests and portraits are drawn only from
// approved media (./media.js); competitions get their approved logo or a typographic monogram (competitionMark).
import { esc, join, when } from '../lib/html.js';
import { competitionMark, crest, initials, mountMediaFallbacks, portrait } from './media.js';
import { ago, coverageOf, dateShort, dateTime, scoreline, sourceName, time } from '../lib/format.js';
import { compMeta } from '../lib/competitions.js';
import { kalshiLineFor } from '../data/kalshi.js';

export const link = (href, inner, cls = '') => `<a href="${esc(href)}" data-link${cls ? ` class="${cls}"` : ''}>${inner}</a>`;

// Percentile as a colour-coded pill (p90+ elite, p75+ strong, p50+ above median, below that neutral), with the
// comparison group size beside it. The metric value itself is rendered bold by the caller.
export function pctPill(p, of = null) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return '';
  const n = Number(p); const tier = n >= 90 ? 'elite' : n >= 75 ? 'strong' : n >= 50 ? 'mid' : 'low';
  return `<span class="pct"><span class="pct-pill pct-${tier}" title="Percentile ${esc(String(n))} of 100">p${esc(String(n))}</span>${of !== null && of !== undefined ? `<small>of ${esc(String(of))}</small>` : ''}</span>`;
}

export const sectionHead = (kicker, title, extra = '') =>
  `<header class="sec-head"><p class="kicker">${esc(kicker)}</p><h2>${esc(title)}</h2>${extra}</header>`;

export const loading = (label = 'Loading intelligence') =>
  `<div class="state loading" role="status" aria-live="polite"><span class="pulse"></span><span>${esc(label)}…</span></div>`;

export const routeSkeleton = (page = '') => `<section class="hero compact route-skeleton" role="status" aria-label="Loading ${esc(page)}"><div class="wrap"><div class="sk-line short"></div><div class="sk-line heading"></div><div class="sk-line"></div></div></section><section class="canvas route-skeleton" aria-hidden="true"><div class="wrap sk-grid"><div class="sk-card"></div><div class="sk-card"></div></div></section>`;

export const empty = (title, body) => `<div class="state empty"><p class="state-title">${esc(title)}</p>${when(body, () => `<p>${esc(body)}</p>`)}</div>`;

export const errorState = (err, retry = true) => `<div class="state error" role="alert">
  <p class="state-title">${err?.status === 404 ? 'Not found' : 'Could not load this data'}</p>
  <p>${esc(err?.status === 404 ? 'This record is not in the PropBetEdge canonical soccer graph.' : 'The intelligence API did not respond as expected. Nothing is shown rather than something wrong.')}</p>
  ${retry && err?.status !== 404 ? '<button class="btn" data-retry>Try again</button>' : ''}
</div>`;

export const notFoundPage = () => `<section class="canvas narrow center">
  <p class="kicker">404</p><h1 class="display">Off the pitch.</h1>
  <p class="lede">That page does not exist in PropBetEdge Soccer Intelligence.</p>
  <p>${link('/', 'Back to today', 'btn gold')}</p></section>`;

export function coverageBadge(meta) {
  const c = coverageOf(meta);
  return `<span class="cov cov-${c.tone}" title="Coverage: ${esc(c.label)}">${esc(c.label)}</span>`;
}

// Customer source boundary: API text that names a collection lane renders as PropSports; licence credits stay.
const LANE = /\bESPN(?:'s)?\b(?: \(secondary(?: source)?\))?/g;
const customerText = s => String(s || '').replace(LANE, 'PropSports');
const customerAttribution = list => [...new Set((list || []).filter(a => !/ESPN/.test(String(a))))];
// Several API responses behind ONE surface (e.g. one per model lane on /picks) share one provenance block: the latest
// real source timestamp, the worst coverage state, and the union of notes and attribution. Never one card per response.
const COVERAGE_RANK = { ok: 0, partial: 1, unavailable: 2 };
export function mergeMeta(metas) {
  const ms = (metas || []).filter(Boolean);
  if (ms.length <= 1) return ms[0] || null;
  const times = ms.map(m => m.source_updated_at).filter(Boolean).sort();
  const states = ms.map(m => m.coverage?.state).filter(Boolean).sort((a, b) => (COVERAGE_RANK[b] ?? 3) - (COVERAGE_RANK[a] ?? 3));
  const sources = [...new Set(ms.map(m => m.source))];
  return {
    ...ms[0],
    source: sources.length === 1 ? sources[0] : sources.join(' + '),
    source_updated_at: times.at(-1) || null,
    coverage: { state: states[0] || ms[0].coverage?.state, notes: [...new Set(ms.flatMap(m => m.coverage?.notes || []))] },
    attribution: [...new Set(ms.flatMap(m => m.attribution || []))],
    semantics: null,
  };
}

// The one reusable SOURCE / COVERAGE component. `sections` explains several lanes inside the same card.
// No real timestamp = no Updated row (a "Not stated" row tells the reader nothing).
export function sourcePanel(meta, { title = 'SOURCE & COVERAGE', extra = [], open = false, sections = [] } = {}) {
  if (!meta) return '';
  const notes = meta.coverage?.notes || [];
  const rows = [
    ['Source', sourceName(meta.source)],
    ...(meta.source_updated_at ? [['Updated', `${dateTime(meta.source_updated_at)} (${ago(meta.source_updated_at)})`]] : []),
    ...extra,
  ];
  return `<details class="source"${open ? ' open' : ''}>
    <summary><span class="src-title">${esc(title)}</span>${coverageBadge(meta)}</summary>
    <div class="src-body">
      <dl>${join(rows, ([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)}</dl>
      ${when(meta.semantics, () => `<p class="semantics"><b>What this means.</b> ${esc(customerText(meta.semantics))}</p>`)}
      ${join(sections, s => `<div class="src-lane"><p class="src-lane-h"><b>${esc(s.title)}</b></p><p>${esc(customerText(s.text))}</p></div>`)}
      ${when(notes.length, () => `<ul class="notes">${join(notes, n => `<li>${esc(customerText(n))}</li>`)}</ul>`)}
      ${when(customerAttribution(meta.attribution).length, () => `<p class="attrib">${join(customerAttribution(meta.attribution), a => `<span>${esc(a)}</span>`)}</p>`)}
    </div>
  </details>`;
}

// LIVE / UPCOMING / FINAL, plus the honest non-standard states.
export const BADGE = { live: 'LIVE', scheduled: 'UPCOMING', finished: 'FINAL', postponed: 'POSTPONED', cancelled: 'CANCELLED', abandoned: 'ABANDONED' };
export function statusPill(status) {
  const s = BADGE[status] ? status : 'unknown';
  return `<span class="status st-${esc(s)}">${s === 'live' ? '<i class="livedot" aria-hidden="true"></i>' : ''}${esc(BADGE[status] || 'AWAITING RESULT')}</span>`;
}

// Crests and portraits live in ./media.js (the one identity-image component); teamMark is
// the crest-or-initials mark under its historical name.
export const teamMark = crest;
export { competitionMark, initials, portrait, mountMediaFallbacks };

// Portrait + name (linked when the player has a PropBetEdge page). Unresolved source names
// keep their "identity pending" tag and never get a portrait.
export function playerChip(p, { size = 'xs', extra = '' } = {}) {
  if (!p) return '<span class="pchip"><span class="muted">Unidentified player</span></span>';
  if (p.resolved === false) return `<span class="pchip">${portrait(null, size)}<span>${esc(p.name)} <span class="tag">identity pending</span></span></span>`;
  const name = p.slug ? link(`/players/${p.slug}`, esc(p.name)) : esc(p.name || 'Unidentified player');
  return `<span class="pchip">${portrait(p, size)}<span class="pc-name">${name}${extra}</span></span>`;
}


export function teamLink(t, cls = 'team') {
  if (!t) return '<span class="team">—</span>';
  return t.slug ? link(`/teams/${t.slug}`, esc(t.name), cls) : `<span class="${cls}">${esc(t.name || 'Unknown team')}</span>`;
}

// Which Match Intelligence layers exist (from the API's intel flags only).
export function intelBadges(intel, status) {
  if (!intel) return '';
  const on = [['lineups', 'LINEUPS'], ['stats', 'STATS'], ['event_map', 'EVENT MAP']].filter(([k]) => intel[k]);
  if (!on.length) return `<span class="intel none">${status === 'scheduled' ? 'FIXTURE' : 'RESULT ONLY'}</span>`;
  return join(on, ([k, l]) => `<span class="intel i-${k}">${l}</span>`);
}

// Restrained Kalshi prediction-market line for a not-finished match, or the subtle market close line on a
// finished result card, when the page loaded the market board;
// nothing at all otherwise (no placeholder).
const kalshiSlot = m => { const line = kalshiLineFor(m); return line ? `<div class="mc-kx">${line}</div>` : ''; };

export function matchCard(m, { showComp = true } = {}) {
  const sc = m.score && m.score.home !== null && m.score.home !== undefined;
  const hw = sc && m.score.home > m.score.away; const aw = sc && m.score.away > m.score.home;
  const row = (t, s, win) => `<div class="mc-row${win ? ' win' : ''}">${teamMark(t)}<span class="mc-name">${teamLink(t)}</span><span class="mc-goals">${sc ? esc(String(s)) : ''}</span></div>`;
  return `<article class="mcard st-${esc(m.status || 'unknown')}">
    <div class="mc-top">
      ${when(showComp && m.competition, () => `${link(`/competitions/${m.competition.slug}`, `${competitionMark(m.competition.slug, 'xs')}<span>${esc(compMeta(m.competition.slug)?.name || m.competition.name)}</span>`, 'mc-comp')}`)}
      ${statusPill(m.status)}
    </div>
    <div class="mc-body">
      ${row(m.home, m.score?.home, hw)}
      ${row(m.away, m.score?.away, aw)}
      ${sc ? '' : '<span class="vs">v</span>'}
    </div>
    <div class="mc-when">${esc(dateShort(m.kickoff_at))}${m.status === 'scheduled' || m.status === 'live' ? ` · ${esc(time(m.kickoff_at))}` : ''}${sc && m.score.home_ht !== null && m.score.home_ht !== undefined ? ` · HT ${esc(scoreline({ home: m.score.home_ht, away: m.score.away_ht }))}` : ''}</div>
    ${kalshiSlot(m)}
    <div class="mc-foot"><span class="mc-intel">${intelBadges(m.intel, m.status)}</span>${link(`/matches/${m.id}`, 'MATCH INTELLIGENCE <span aria-hidden="true">→</span>', 'mc-cta')}</div>
  </article>`;
}

export const matchGrid = (list, opts) => (list?.length ? `<div class="mgrid">${join(list, m => matchCard(m, opts))}</div>` : '');

const FORM_WORD = { W: 'Win', L: 'Loss', D: 'Draw' };
export function formChips(form) {
  if (!form?.length) return '<span class="muted">No finished matches stored</span>';
  return `<span class="form" aria-label="Form, newest first: ${esc(form.map(r => FORM_WORD[r] || r).join(', '))}">${join(form, r => `<i class="f-${esc(r)}" title="${FORM_WORD[r] || r}">${esc(r)}</i>`)}</span>`;
}

// Compact form dots for tables — only rendered when the API supplies real form.
export function formDots(form) {
  if (!form?.length) return '';
  return `<span class="dots" aria-label="Last ${form.length}, newest first: ${esc(form.map(r => FORM_WORD[r] || r).join(', '))}">${join(form, r => `<i class="d-${esc(r)}" title="${FORM_WORD[r] || r}"></i>`)}</span>`;
}

// Tabs that switch panels in place (keyboard accessible, state in ?tab=).
export function tabBar(tabs, active, label) {
  return `<div class="tabbar" role="tablist" aria-label="${esc(label)}">${join(tabs, ([k, l]) => `<button role="tab" id="tab-${esc(k)}" aria-controls="panel-${esc(k)}" aria-selected="${k === active}" tabindex="${k === active ? 0 : -1}" data-tab="${esc(k)}">${esc(l)}</button>`)}</div>`;
}
export const tabPanel = (k, active, inner) => `<section class="tabpanel" role="tabpanel" id="panel-${esc(k)}" aria-labelledby="tab-${esc(k)}"${k === active ? '' : ' hidden'}>${inner}</section>`;

export function mountTabs(root) {
  const bar = root.querySelector('.tabbar'); if (!bar) return;
  const btns = [...bar.querySelectorAll('[data-tab]')];
  const select = (k, focus = false) => {
    for (const b of btns) { const on = b.dataset.tab === k; b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; if (on && focus) b.focus(); }
    for (const p of root.querySelectorAll('.tabpanel')) p.hidden = p.id !== `panel-${k}`;
    const u = new URL(location.href); if (k === btns[0].dataset.tab) u.searchParams.delete('tab'); else u.searchParams.set('tab', k);
    history.replaceState(history.state, '', u.pathname + u.search);
  };
  bar.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) select(b.dataset.tab); });
  bar.addEventListener('keydown', e => {
    const i = btns.findIndex(b => b.getAttribute('aria-selected') === 'true');
    const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
    if (n === null) return; e.preventDefault(); select(btns[(n + btns.length) % btns.length].dataset.tab, true);
  });
  for (const a of root.querySelectorAll('[data-goto-tab]')) a.addEventListener('click', e => { e.preventDefault(); select(a.dataset.gotoTab); bar.scrollIntoView({ block: 'nearest' }); });
}
