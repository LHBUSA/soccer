// League table from /v1/table: POS · CLUB · P · W · D · L · GD · PTS (+ GF/GA and
// FORM on wider screens, FORM only when the API supplies real results).
// The club column is sticky so the numbers scroll under it on phones.
// An unavailable table is explained, never faked.
import { esc, join } from '../lib/html.js';
import { num } from '../lib/format.js';
import { formDots, link, teamMark } from './ui.js';

export function tableView(env, { limit = null, highlight = null, reason = null } = {}) {
  const t = env?.data;
  if (!t || !t.rows?.length) {
    const notes = env?.meta?.coverage?.notes || [];
    return `<div class="state empty"><p class="state-title">Table not available</p><p>${esc(reason || notes[0] || 'No finished league-stage matches are stored for this competition and season, so PropBetEdge does not compute a table here.')}</p></div>`;
  }
  const rows = limit ? t.rows.slice(0, limit) : t.rows;
  const hasForm = rows.some(r => r.form?.length);
  const hasWdl = rows.every(r => r.won !== undefined);
  const gd = v => (v > 0 ? `+${num(v)}` : num(v));
  return `<div class="tablewrap"><table class="ltable">
    <thead><tr><th class="pos" scope="col">Pos</th><th class="tm" scope="col">Club</th><th scope="col" title="Played">P</th>${hasWdl ? '<th scope="col" title="Won">W</th><th scope="col" title="Drawn">D</th><th scope="col" title="Lost">L</th>' : ''}<th class="wide" scope="col" title="Goals for">GF</th><th class="wide" scope="col" title="Goals against">GA</th><th scope="col" title="Goal difference">GD</th><th class="pts" scope="col" title="Points">PTS</th>${hasForm ? '<th class="formcol wide" scope="col">Form</th>' : ''}</tr></thead>
    <tbody>${join(rows, r => `<tr${highlight && r.team?.slug === highlight ? ' class="hl"' : ''}>
      <td class="pos">${num(r.position)}</td>
      <th class="tm" scope="row">${r.team?.slug ? link(`/teams/${r.team.slug}`, `${teamMark(r.team, 'xs')}<span>${esc(r.team.short_name || r.team.name)}</span>`) : esc(r.team?.name || '—')}</th>
      <td>${num(r.played)}</td>${hasWdl ? `<td>${num(r.won)}</td><td>${num(r.drawn)}</td><td>${num(r.lost)}</td>` : ''}<td class="wide">${num(r.goals_for)}</td><td class="wide">${num(r.goals_against)}</td>
      <td>${gd(r.goal_difference)}</td><td class="pts">${num(r.points)}</td>${hasForm ? `<td class="formcol wide">${formDots(r.form)}</td>` : ''}</tr>`)}</tbody>
  </table></div>
  ${limit && t.rows.length > limit ? '' : `<p class="caveat">${esc(env.meta?.semantics || '')} ${t.matches_counted !== undefined ? `Matches counted: ${num(t.matches_counted)}.` : ''}</p>`}`;
}
