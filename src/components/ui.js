// Shared UI pieces (V2). All data rendering reads the API envelope; nothing here
// invents a value. Missing = shown as missing. No crests or photos are drawn:
// teams get a typographic initials mark, competitions a typographic monogram.
import { esc, join, when } from '../lib/html.js';
import { ago, coverageOf, dateShort, dateTime, scoreline, sourceName, time } from '../lib/format.js';
import { compMeta } from '../lib/competitions.js';

export const link = (href, inner, cls = '') => `<a href="${esc(href)}" data-link${cls ? ` class="${cls}"` : ''}>${inner}</a>`;

export const sectionHead = (kicker, title, extra = '') =>
  `<header class="sec-head"><p class="kicker">${esc(kicker)}</p><h2>${esc(title)}</h2>${extra}</header>`;

export const loading = (label = 'Loading intelligence') =>
  `<div class="state loading" role="status" aria-live="polite"><span class="pulse"></span><span>${esc(label)}…</span></div>`;

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

// The one reusable SOURCE / COVERAGE component.
export function sourcePanel(meta, { title = 'SOURCE & COVERAGE', extra = [], open = false } = {}) {
  if (!meta) return '';
  const notes = meta.coverage?.notes || [];
  const rows = [
    ['Source', sourceName(meta.source)],
    ['Updated', meta.source_updated_at ? `${dateTime(meta.source_updated_at)} (${ago(meta.source_updated_at)})` : 'Not stated'],
    ...extra,
  ];
  return `<details class="source"${open ? ' open' : ''}>
    <summary><span class="src-title">${esc(title)}</span>${coverageBadge(meta)}</summary>
    <div class="src-body">
      <dl>${join(rows, ([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)}</dl>
      ${when(meta.semantics, () => `<p class="semantics"><b>What this means.</b> ${esc(meta.semantics)}</p>`)}
      ${when(notes.length, () => `<ul class="notes">${join(notes, n => `<li>${esc(n)}</li>`)}</ul>`)}
      ${when((meta.attribution || []).length, () => `<p class="attrib">${join(meta.attribution, a => `<span>${esc(a)}</span>`)}</p>`)}
    </div>
  </details>`;
}

// LIVE / UPCOMING / FINAL, plus the honest non-standard states.
export const BADGE = { live: 'LIVE', scheduled: 'UPCOMING', finished: 'FINAL', postponed: 'POSTPONED', cancelled: 'CANCELLED', abandoned: 'ABANDONED' };
export function statusPill(status) {
  const s = BADGE[status] ? status : 'unknown';
  return `<span class="status st-${esc(s)}">${s === 'live' ? '<i class="livedot" aria-hidden="true"></i>' : ''}${esc(BADGE[status] || 'AWAITING RESULT')}</span>`;
}

const SKIP = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'cd', 'sv', 'vfl', 'vfb', 'tsg', 'fsv', '1.', 'de', 'of', 'the', 'and', '&', 'club']);
export function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s.&-]/gu, '').split(/[\s-]+/).filter(Boolean);
  const core = words.filter(w => !SKIP.has(w.toLowerCase()) && !/^\d/.test(w));
  const use = core.length ? core : words;
  if (!use.length) return '?';
  if (use.length === 1) return use[0].slice(0, 3).toUpperCase();
  return use.slice(0, 3).map(w => w[0]).join('').toUpperCase();
}

// Typographic team mark (never a crest). Approved crest media replaces it only
// when the API exposes one with provenance (t.crest).
export function teamMark(t, size = '') {
  if (t?.crest?.url) return `<span class="tmark img${size ? ` ${size}` : ''}"><img src="${esc(t.crest.url)}" alt="" title="${esc(t.crest.attribution || '')}" loading="lazy" decoding="async" width="64" height="64" data-fallback="${esc(initials(t.short_name || t.name))}"></span>`;
  return `<span class="tmark${size ? ` ${size}` : ''}" aria-hidden="true">${esc(initials(t?.short_name || t?.name))}</span>`;
}

export function compMono(slug, size = '') {
  const c = compMeta(slug);
  return `<span class="cmono a-${esc(c?.accent || 'x')}${size ? ` ${size}` : ''}" aria-hidden="true">${esc(c?.mono || initials(String(slug || '').replace(/-/g, ' ')))}</span>`;
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

export function matchCard(m, { showComp = true } = {}) {
  const sc = m.score && m.score.home !== null && m.score.home !== undefined;
  const hw = sc && m.score.home > m.score.away; const aw = sc && m.score.away > m.score.home;
  const row = (t, s, win) => `<div class="mc-row${win ? ' win' : ''}">${teamMark(t)}<span class="mc-name">${teamLink(t)}</span><span class="mc-goals">${sc ? esc(String(s)) : ''}</span></div>`;
  return `<article class="mcard st-${esc(m.status || 'unknown')}">
    <div class="mc-top">
      ${when(showComp && m.competition, () => `${link(`/competitions/${m.competition.slug}`, `${compMono(m.competition.slug, 'xs')}<span>${esc(compMeta(m.competition.slug)?.name || m.competition.name)}</span>`, 'mc-comp')}`)}
      ${statusPill(m.status)}
    </div>
    <div class="mc-body">
      ${row(m.home, m.score?.home, hw)}
      ${row(m.away, m.score?.away, aw)}
      ${sc ? '' : '<span class="vs">v</span>'}
    </div>
    <div class="mc-when">${esc(dateShort(m.kickoff_at))}${m.status === 'scheduled' || m.status === 'live' ? ` · ${esc(time(m.kickoff_at))}` : ''}${sc && m.score.home_ht !== null && m.score.home_ht !== undefined ? ` · HT ${esc(scoreline({ home: m.score.home_ht, away: m.score.away_ht }))}` : ''}</div>
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

// Broken approved media never shows a broken image: swap to the initials mark.
export function mountMediaFallbacks(root) {
  for (const img of root.querySelectorAll('img[data-fallback]')) {
    const swap = () => { const s = document.createElement('span'); s.className = img.parentElement.className.replace(' img', ''); s.textContent = img.dataset.fallback; s.setAttribute('aria-hidden', 'true'); img.parentElement.replaceWith(s); };
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  }
}
