// PLAYER DNA / TEAM DNA panels. Descriptive, time-safe profiles from the API; every
// percentile names its comparison group. Filled after render (never blocks the page).
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num } from '../lib/format.js';
import { compMono, sectionHead, sourcePanel, formChips } from './ui.js';

export const TEAM_LABELS = {
  points_per_match: ['Points per match', 2], goals_for_per_match: ['Goals scored per match', 2], goals_against_per_match: ['Goals conceded per match', 2],
  clean_sheet_rate: ['Clean sheet rate', 'pct'], failed_to_score_rate: ['Failed to score', 'pct'], scored_first_rate: ['Scored first', 'pct'],
  points_per_match_after_conceding_first: ['Points per match after conceding first', 2], shots_per_match: ['Shots per match', 1], shots_against_per_match: ['Shots faced per match', 1],
  shots_on_target_per_match: ['Shots on target per match', 1], shot_conversion: ['Goals per shot', 2], possession_avg: ['Average possession (source)', '%'],
  cards_per_match: ['Card points per match', 2], home_points_per_match: ['Home points per match', 2], away_points_per_match: ['Away points per match', 2], last5_points_per_match: ['Points per match, last 5', 2],
};
export const PLAYER_LABELS = {
  start_rate: ['Start rate', 'pct'], minutes_per_appearance: ['Minutes per appearance (nominal)', 0], goals_per90: ['Goals per 90', 2], assists_per90: ['Assists per 90', 2],
  goal_contributions_per90: ['Goals + assists per 90', 2], shots_per90: ['Shots per 90', 2], shots_on_target_rate: ['Shots on target', 'pct'], goals_per_shot: ['Goals per shot', 2],
  key_passes_per90: ['Key passes per 90', 2], cards_per90: ['Card points per 90', 2],
};

const fmt = (v, f) => (v === null || v === undefined ? '—' : f === 'pct' ? `${Math.round(v * 100)}%` : f === '%' ? `${num(v, { dp: 1 })}%` : num(v, { dp: f }));

export function metricRows(metrics, labels) {
  return `<ul class="dna">${join(metrics.filter(m => labels[m.key]), m => {
    const [label, f] = labels[m.key]; const p = m.percentile;
    return `<li><span class="dna-l">${esc(label)}${m.lower_is_better ? ' <span class="muted" title="Lower is better; the percentile is inverted">(lower is better)</span>' : ''}</span><b class="dna-v">${esc(fmt(m.value, f))}</b>
      ${p === null || p === undefined ? '<span class="dna-p none">no rank</span>' : `<span class="dna-bar" role="img" aria-label="Percentile ${p} of 100"><i style="width:${Math.max(2, p)}%"></i></span><span class="dna-p">p${p}</span>`}</li>`;
  })}</ul>`;
}

export async function mountTeamDna(root, slug) {
  const slot = root.querySelector('[data-team-dna]'); if (!slot) return;
  try {
    const env = await api(`teams/${slug}/dna`);
    const d = env.data;
    if (!d.metrics?.length || !slot.isConnected) { slot.innerHTML = ''; return; }
    slot.innerHTML = `${sectionHead('TEAM DNA', `${d.competition?.name || ''} ${d.season || ''}`)}
      <p class="dna-intro">${d.competition ? compMono(d.competition.slug, 'xs') : ''} ${esc(String(d.matches))} matches before ${esc(d.as_of.slice(0, 10))}. Percentiles rank against the ${esc(String(d.teams_compared))} teams of the same competition-season (p100 = best).${when(d.form?.length, () => ` Last results: ${formChips(d.form.slice(0, 10))}`)}</p>
      ${metricRows(d.metrics, TEAM_LABELS)}
      ${when(d.conceded_first, () => `<p class="caveat">Came back to win ${esc(String(d.comeback_wins))} of ${esc(String(d.conceded_first))} matches after conceding first.</p>`)}
      ${sourcePanel(env.meta, { title: 'HOW TEAM DNA IS BUILT' })}`;
  } catch { slot.innerHTML = ''; }
}

export async function mountPlayerDna(root, slug) {
  const slot = root.querySelector('[data-player-dna]'); if (!slot) return;
  try {
    const env = await api(`players/${slug}/dna`);
    const d = env.data;
    if (!d.seasons?.length || !slot.isConnected) { slot.innerHTML = ''; return; }
    slot.innerHTML = `${sectionHead('PLAYER DNA', 'Profile by competition')}
      ${join(d.seasons, s => `<div class="dna-season"><h3>${s.competition ? compMono(s.competition.slug, 'xs') : ''} ${esc(s.competition?.name || '')} ${esc(s.season || '')}</h3>
        <p class="dna-intro">${esc(String(s.appearances))} appearances (${esc(String(s.starts))} starts), ${esc(num(s.minutes_nominal))} nominal minutes · ${esc(String(s.goals))} goals, ${esc(String(s.assists))} assists, ${esc(String(s.shots))} shots.
        ${s.eligible_for_percentiles ? `Percentiles rank against the ${esc(String(s.players_compared))} players with at least ${esc(String(d.min_minutes_for_percentiles))} nominal minutes.` : `Below ${esc(String(d.min_minutes_for_percentiles))} nominal minutes, so no percentile ranks yet.`}</p>
        ${metricRows(s.metrics, PLAYER_LABELS)}</div>`)}
      ${sourcePanel(env.meta, { title: 'HOW PLAYER DNA IS BUILT' })}`;
  } catch { slot.innerHTML = ''; }
}
