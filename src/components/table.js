// League table from /v1/table. Mobile keeps Pos · Team · P · GD · Pts; GF/GA
// appear from 560px. An unavailable table is explained, never faked.
import { esc, join } from '../lib/html.js';
import { num } from '../lib/format.js';
import { link } from './ui.js';

export function tableView(env) {
  const t = env?.data;
  if (!t || !t.rows?.length) {
    const notes = env?.meta?.coverage?.notes || [];
    return `<div class="state empty"><p class="state-title">Table not available</p><p>${esc(notes[0] || 'No finished league-stage matches are stored for this competition and season, so PropBetEdge does not compute a table here.')}</p></div>`;
  }
  return `<div class="tablewrap"><table class="ltable">
    <thead><tr><th class="pos">#</th><th class="tm">Team</th><th>P</th><th class="wide">GF</th><th class="wide">GA</th><th>GD</th><th class="pts">Pts</th></tr></thead>
    <tbody>${join(t.rows, r => `<tr>
      <td class="pos">${num(r.position)}</td>
      <td class="tm">${r.team?.slug ? link(`/teams/${r.team.slug}`, esc(r.team.name)) : esc(r.team?.name || '—')}</td>
      <td>${num(r.played)}</td><td class="wide">${num(r.goals_for)}</td><td class="wide">${num(r.goals_against)}</td>
      <td>${r.goal_difference > 0 ? '+' : ''}${num(r.goal_difference)}</td><td class="pts">${num(r.points)}</td></tr>`)}</tbody>
  </table></div>
  <p class="caveat">${esc(env.meta?.semantics || '')} ${t.matches_counted !== undefined ? `Matches counted: ${num(t.matches_counted)}.` : ''}</p>`;
}
