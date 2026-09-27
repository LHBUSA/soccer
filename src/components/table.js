// League table from /v1/table: POS · CLUB · P · W · D · L · GD · PTS (+ GF/GA and
// FORM on wider screens, FORM only when the API supplies real results).
// The club column is sticky so the numbers scroll under it on phones.
// Zones (qualification lines) are shown ONLY when the source states them per row
// (e.g. "Qualifies for round of 16"); nothing is inferred from position.
// An unavailable table is explained, never faked.
import { esc, join } from '../lib/html.js';
import { num } from '../lib/format.js';
import { formDots, link, teamMark } from './ui.js';

// Stable zone palette by the order zones first appear in the table.
const ZONE_CLASSES = ['z1', 'z2', 'z3', 'z4', 'z5'];

export function tableView(env, { limit = null, highlight = null, reason = null, caption = null } = {}) {
  const t = env?.data;
  if (!t || !t.rows?.length) {
    const notes = env?.meta?.coverage?.notes || [];
    return `<div class="state empty"><p class="state-title">Table not available</p><p>${esc(reason || notes[0] || 'No finished league-stage matches are stored for this competition and season, so PropBetEdge does not compute a table here.')}</p></div>`;
  }
  const rows = limit ? t.rows.slice(0, limit) : t.rows;
  const hasForm = rows.some(r => r.form?.length);
  const hasWdl = rows.every(r => r.won !== undefined);
  const zones = [...new Set(t.rows.map(r => r.zone?.label).filter(Boolean))];
  const zoneClass = label => ZONE_CLASSES[zones.indexOf(label)] || '';
  const gd = v => (v > 0 ? `+${num(v)}` : num(v));
  const cap = caption || (t.group ? `${t.group.name} ${t.season || ''}` : `${t.season || ''} standings`);
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="${esc(cap)} (scrolls horizontally)"><table class="ltable">
    <caption class="sr-only">${esc(cap)}</caption>
    <thead><tr><th class="pos" scope="col">Pos</th><th class="tm" scope="col">Club</th><th scope="col"><abbr title="Played">P</abbr></th>${hasWdl ? '<th scope="col"><abbr title="Won">W</abbr></th><th scope="col"><abbr title="Drawn">D</abbr></th><th scope="col"><abbr title="Lost">L</abbr></th>' : ''}<th class="wide" scope="col"><abbr title="Goals for">GF</abbr></th><th class="wide" scope="col"><abbr title="Goals against">GA</abbr></th><th scope="col"><abbr title="Goal difference">GD</abbr></th><th class="pts" scope="col"><abbr title="Points">PTS</abbr></th>${hasForm ? '<th class="formcol wide" scope="col">Form</th>' : ''}</tr></thead>
    <tbody>${join(rows, r => `<tr class="${[highlight && r.team?.slug === highlight ? 'hl' : '', r.zone ? `zone ${zoneClass(r.zone.label)}` : ''].filter(Boolean).join(' ')}"${r.zone ? ` title="${esc(r.zone.label)}"` : ''}>
      <td class="pos">${num(r.position)}${r.zone ? `<span class="sr-only"> (${esc(r.zone.label)})</span>` : ''}</td>
      <th class="tm" scope="row">${r.team?.slug ? link(`/teams/${r.team.slug}`, `${teamMark(r.team, 'xs')}<span>${esc(r.team.short_name || r.team.name)}</span>`) : esc(r.team?.name || '—')}</th>
      <td>${num(r.played)}</td>${hasWdl ? `<td>${num(r.won)}</td><td>${num(r.drawn)}</td><td>${num(r.lost)}</td>` : ''}<td class="wide">${num(r.goals_for)}</td><td class="wide">${num(r.goals_against)}</td>
      <td>${gd(r.goal_difference)}</td><td class="pts">${num(r.points)}${r.deductions ? `<span class="ded" title="${num(r.deductions)} point deduction applied by the competition">*</span>` : ''}</td>${hasForm ? `<td class="formcol wide">${formDots(r.form)}</td>` : ''}</tr>`)}</tbody>
  </table></div>
  ${zones.length ? `<ul class="zones" aria-label="Zones as stated by the source">${join(zones, z => `<li><i class="zdot ${zoneClass(z)}" aria-hidden="true"></i>${esc(z)}</li>`)}</ul>` : ''}
  ${limit && t.rows.length > limit ? '' : `<p class="caveat">${esc(env.meta?.semantics || '')} ${t.matches_counted !== undefined ? `Matches counted: ${num(t.matches_counted)}.` : ''}</p>`}`;
}

// Sub-views of a table (MLS: Eastern / Western / Overall). Each view is a separate API envelope.
export function tableViews(views, active) {
  const ok = views.filter(v => v.env);
  if (!ok.length) return '';
  return `<div class="subtabs" role="tablist" aria-label="Table view">${join(ok, v => `<button role="tab" type="button" data-view="${esc(v.key)}" aria-selected="${v.key === active}" tabindex="${v.key === active ? 0 : -1}">${esc(v.label)}</button>`)}</div>
  ${join(ok, v => `<div class="tview" data-view-panel="${esc(v.key)}"${v.key === active ? '' : ' hidden'}>${tableView(v.env, { reason: v.reason })}</div>`)}`;
}

export function mountTableViews(root) {
  for (const bar of root.querySelectorAll('.subtabs')) {
    const scope = bar.parentElement;
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-view]'); if (!b) return;
      for (const x of bar.querySelectorAll('[data-view]')) { const on = x === b; x.setAttribute('aria-selected', String(on)); x.tabIndex = on ? 0 : -1; }
      for (const p of scope.querySelectorAll('[data-view-panel]')) p.hidden = p.dataset.viewPanel !== b.dataset.view;
    });
  }
}
