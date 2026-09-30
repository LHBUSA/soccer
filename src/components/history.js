import { api } from '../lib/api.js';
import { esc, join } from '../lib/html.js';
import { num, dateShort } from '../lib/format.js';
import { sectionHead, sourcePanel, errorState, link } from './ui.js';

const split = (label, r) => `<div><span>${esc(label)}</span><b>${num(r?.won)}W · ${num(r?.drawn)}D · ${num(r?.lost)}L</b><small>${num(r?.played)} matches · ${num(r?.goals_for)} GF / ${num(r?.goals_against)} GA</small></div>`;
export function historyView(d, slug, selected = d.competitions[0]?.slug) {
  const c = d.competitions.find(c => c.slug === selected); const s = c?.summary || d.summary;
  const rows = d.seasons.filter(r => r.competition?.slug === selected);
  if (!rows.length) return '<p class="muted">No historical score aggregates are stored for this team.</p>';
  const cur = rows.at(-1);
  return `<div class="history-panel">
    ${d.competitions.length > 1 ? `<label class="history-select">COMPETITION <select data-history-comp>${join(d.competitions, c => `<option value="${esc(c.slug)}"${c.slug === selected ? ' selected' : ''}>${esc(c.name)}</option>`)}</select></label>` : `<p class="kicker">${esc(c?.name || selected)}</p>`}
    <p class="caveat">${num(rows.length)} stored ${rows.length === 1 ? 'season' : 'seasons'} · ${esc(s.historical_window)}. Coverage is stored matches, not a claim of complete club history.</p>
    <div class="history-summary">${join([['Matches', s.played], ['Wins', s.won], ['Draws', s.drawn], ['Losses', s.lost], ['Goals for', s.goals_for], ['Goals against', s.goals_against], ['Win rate', s.win_rate === null ? null : `${Math.round(s.win_rate * 100)}%`]], ([k,v]) => `<div><b>${typeof v === 'string' ? esc(v) : num(v)}</b><span>${esc(k)}</span></div>`)}</div>
    <p class="history-window">${esc(dateShort(s.first_stored_match))} → ${esc(dateShort(s.last_stored_match))}${s.best_verified_league_finish ? ` · Best verified league finish: ${num(s.best_verified_league_finish.position)} (${esc(s.best_verified_league_finish.season)})` : ''}</p>
    <h3>Latest stored season · ${esc(cur.season)}</h3><div class="history-splits">${split('HOME',cur.home)}${split('AWAY',cur.away)}</div>
    ${rows.some(r => r.played) ? `<div class="history-trend" role="img" aria-label="Scoring and conceding rates by stored season, ${esc(c?.name || selected)}"><p class="caveat">GOALS PER MATCH · green: scored · gold: conceded</p><div class="history-bars">${join(rows, r => { const max = Math.max(1, ...rows.flatMap(x => [x.goals_per_match || 0, x.goals_allowed_per_match || 0])); return `<div class="history-bar"><div><i style="height:${r.played ? r.goals_per_match / max * 100 : 0}%" title="${esc(r.season)}: ${num(r.goals_per_match,{dp:2})} scored/match"></i><i class="conceded" style="height:${r.played ? r.goals_allowed_per_match / max * 100 : 0}%" title="${esc(r.season)}: ${num(r.goals_allowed_per_match,{dp:2})} conceded/match"></i></div><small>${esc(r.season)}</small></div>`; })}</div></div>` : ''}
    <div class="tablewrap" tabindex="0" role="region" aria-label="Season history"><table class="ltable history-table"><thead><tr>${join(['Season','P','W','D','L','GF','GA','GD','Pts','PPG','GF/m','GA/m','Finish / group','Home W/D/L','Away W/D/L','Coverage'], k=>`<th scope="col">${esc(k)}</th>`)}</tr></thead><tbody>${join(rows,r=>`<tr><th scope="row">${link(`/matches?competition=${selected}&season=${encodeURIComponent(r.season)}&team=${slug}`,esc(r.season))}</th>${join([r.played,r.won,r.drawn,r.lost,r.goals_for,r.goals_against,r.goal_difference,r.points,r.points_per_game,r.goals_per_match,r.goals_allowed_per_match],v=>`<td>${num(v,{dp:Number.isInteger(v)?0:2})}</td>`)}<td>${r.table_finish ? `${num(r.table_finish.position)} / ${num(r.table_finish.teams)}` : r.group_position ? `${esc(r.group_position.name)}: ${num(r.group_position.position)}` : '—'}</td><td>${r.home.won}/${r.home.drawn}/${r.home.lost}</td><td>${r.away.won}/${r.away.drawn}/${r.away.lost}</td><td>${num(r.score_coverage.counted)} / ${num(r.score_coverage.stored)} stored</td></tr>`)}</tbody></table></div>
    <p class="caveat">All-stage W/D/L and goals from finished score pairs. Points only where league/group rules apply to the entire sample. A dash is unavailable. Finish only for verified complete single-table seasons; group positions are group-scoped. No trophies inferred.</p>
    ${link(`/matches?competition=${selected}&team=${slug}`, 'HISTORICAL RESULTS →', 'sec-link')}
  </div>`;
}

export async function mountHistory(root, teamEnv, { isCurrent = () => true } = {}) {
  const slot = root.querySelector('[data-team-history]'); if (!slot) return;
  // Additive Worker contract: automatic frontend pushes remain compatible with the live API.
  if (!teamEnv.meta.features?.includes('team_history')) { slot.innerHTML = '<p class="muted">Historical season aggregates are unavailable right now. The latest stored season snapshot is shown above.</p>'; return; }
  try {
    const env = await api(`teams/${teamEnv.data.slug}/history`); if (!isCurrent() || !slot.isConnected) return;
    const show = selected => { slot.innerHTML = historyView(env.data, teamEnv.data.slug, selected) + sourcePanel(env.meta, { title: 'HISTORY SOURCE & COVERAGE' }); slot.querySelector('[data-history-comp]')?.addEventListener('change', e => show(e.target.value)); };
    show();
  } catch (err) { if (isCurrent() && slot.isConnected) slot.innerHTML = errorState(err, false); }
}
