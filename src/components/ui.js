// Shared UI pieces. All data rendering reads the API envelope; nothing here
// invents a value. Missing = shown as missing.
import { esc, join, when } from '../lib/html.js';
import { ago, coverageOf, dateShort, dateTime, scoreline, sourceName, statusLabel, time } from '../lib/format.js';

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
  <p>${link('/', 'Back to today', 'btn')}</p></section>`;

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

export function statusPill(status) {
  return `<span class="status st-${esc(status || 'unknown')}">${esc(statusLabel(status))}</span>`;
}

export function teamLink(t, cls = 'team') {
  if (!t) return '<span class="team">—</span>';
  return t.slug ? link(`/teams/${t.slug}`, esc(t.name), cls) : `<span class="${cls}">${esc(t.name || 'Unknown team')}</span>`;
}

export function matchCard(m, { showComp = true } = {}) {
  const sc = scoreline(m.score);
  const hw = m.score && m.score.home > m.score.away; const aw = m.score && m.score.away > m.score.home;
  return `<article class="mcard">
    <div class="mc-top">
      <span class="mc-when">${esc(dateShort(m.kickoff_at))}${m.status === 'scheduled' ? ` · ${esc(time(m.kickoff_at))}` : ''}</span>
      ${when(showComp && m.competition, () => link(`/competitions/${m.competition.slug}`, esc(m.competition.name), 'mc-comp'))}
      ${statusPill(m.status)}
    </div>
    <div class="mc-body">
      <div class="mc-team${hw ? ' win' : ''}">${teamLink(m.home)}</div>
      <div class="mc-score">${sc ? esc(sc) : '<span class="vs">v</span>'}</div>
      <div class="mc-team away${aw ? ' win' : ''}">${teamLink(m.away)}</div>
    </div>
    ${link(`/matches/${m.id}`, 'MATCH INTELLIGENCE <span aria-hidden="true">→</span>', 'mc-cta')}
  </article>`;
}

export const matchGrid = (list, opts) => (list?.length ? `<div class="mgrid">${join(list, m => matchCard(m, opts))}</div>` : '');

export function formChips(form) {
  if (!form?.length) return '<span class="muted">No finished matches stored</span>';
  return `<span class="form">${join(form, r => `<i class="f-${esc(r)}" title="${r === 'W' ? 'Win' : r === 'L' ? 'Loss' : 'Draw'}">${esc(r)}</i>`)}</span>`;
}
