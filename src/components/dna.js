// PLAYER DNA / TEAM DNA panels. Descriptive, time-safe profiles from the API; every
// percentile names its comparison group. Filled after render (never blocks the page).
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num } from '../lib/format.js';
import { competitionMark, sectionHead, sourcePanel, formChips } from './ui.js';

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
      <p class="dna-intro">${d.competition ? competitionMark(d.competition.slug, 'xs') : ''} ${esc(String(d.matches))} matches before ${esc(d.as_of.slice(0, 10))}. Percentiles rank against the ${esc(String(d.teams_compared))} teams of the same competition-season (p100 = best).${when(d.form?.length, () => ` Last results: ${formChips(d.form.slice(0, 10))}`)}</p>
      ${metricRows(d.metrics, TEAM_LABELS)}
      ${when(d.conceded_first, () => `<p class="caveat">Came back to win ${esc(String(d.comeback_wins))} of ${esc(String(d.conceded_first))} matches after conceding first.</p>`)}
      ${sourcePanel(env.meta, { title: 'HOW TEAM DNA IS BUILT' })}`;
  } catch { slot.innerHTML = ''; }
}

// ---- PLAYER DNA V2 ----
// One view for the player page and the Player DNA drawer: per competition-season, a volume
// strip, the DNA signature (one column per rate, height = percentile), grouped percentile rows,
// home/away and last-5 splits. Percentiles only when the season is eligible (>= min minutes);
// the comparison group is always named. Descriptive, not a forecast.
export const DNA_GROUPS = [
  ['SCORING', ['goals_per90', 'shots_per90', 'shots_on_target_rate', 'goals_per_shot']],
  ['CREATION', ['assists_per90', 'key_passes_per90', 'goal_contributions_per90']],
  ['ROLE', ['start_rate', 'minutes_per_appearance']],
  ['DISCIPLINE', ['cards_per90']],
];
const SHORT = { goals_per90: 'G/90', shots_per90: 'Sh/90', shots_on_target_rate: 'SoT%', goals_per_shot: 'G/Sh', assists_per90: 'A/90', key_passes_per90: 'KP/90', goal_contributions_per90: 'G+A', start_rate: 'Start', minutes_per_appearance: 'Min', cards_per90: 'Card' };
const tier = p => (p >= 90 ? 't5' : p >= 75 ? 't4' : p >= 50 ? 't3' : p >= 25 ? 't2' : 't1');

// Percentile radar: one axis per ranked metric (grouped order), radius = percentile; rings at
// p25/50/75/100. Only metrics with a percentile are drawn; nothing is imputed.
export function dnaRadar(metrics, { size = 260 } = {}) {
  const order = DNA_GROUPS.flatMap(([, keys]) => keys);
  const pts = order.map(k => metrics.find(m => m.key === k)).filter(m => m && m.percentile !== null && m.percentile !== undefined);
  if (pts.length < 3) return '';
  const c = size / 2; const R = c - 34;
  const at = (i, r) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / pts.length; return [c + r * Math.cos(a), c + r * Math.sin(a)]; };
  const ring = f => pts.map((_, i) => at(i, R * f).map(v => v.toFixed(1)).join(',')).join(' ');
  const poly = pts.map((m, i) => at(i, (R * Math.max(2, m.percentile)) / 100).map(v => v.toFixed(1)).join(',')).join(' ');
  return `<svg class="dna-radar" viewBox="0 0 ${size} ${size}" role="img" aria-label="Percentile profile: ${esc(pts.map(m => `${PLAYER_LABELS[m.key]?.[0] || m.key} p${m.percentile}`).join(', '))}">
    ${[0.25, 0.5, 0.75, 1].map(f => `<polygon class="rr${f === 1 ? ' outer' : ''}" points="${ring(f)}"/>`).join('')}
    ${pts.map((_, i) => { const [x, y] = at(i, R); return `<line class="ra" x1="${c}" y1="${c}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}"/>`; }).join('')}
    <polygon class="rp" points="${poly}"/>
    ${pts.map((m, i) => { const [x, y] = at(i, (R * Math.max(2, m.percentile)) / 100); return `<circle class="rd ${tier(m.percentile)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.4"/>`; }).join('')}
    ${pts.map((m, i) => { const [x, y] = at(i, R + 17); return `<text class="rl" x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}" text-anchor="middle">${esc(SHORT[m.key] || m.key)}</text>`; }).join('')}
  </svg>`;
}

export function dnaSignature(metrics) {
  const order = DNA_GROUPS.flatMap(([, keys]) => keys);
  const cols = order.map(k => metrics.find(m => m.key === k)).filter(m => m && m.percentile !== null && m.percentile !== undefined);
  if (!cols.length) return '';
  return `<div class="dna-sig" role="img" aria-label="DNA signature: ${esc(cols.map(m => `${PLAYER_LABELS[m.key]?.[0] || m.key} p${m.percentile}`).join(', '))}">
    ${join(cols, m => `<span class="sig-col ${tier(m.percentile)}" title="${esc(PLAYER_LABELS[m.key]?.[0] || m.key)}: p${m.percentile}"><i style="height:${Math.max(4, m.percentile)}%"></i><b>${esc(SHORT[m.key] || m.key)}</b></span>`)}
  </div>`;
}

function dnaGroups(metrics) {
  return join(DNA_GROUPS, ([title, keys]) => {
    const rows = keys.map(k => metrics.find(m => m.key === k)).filter(Boolean);
    if (!rows.length) return '';
    return `<div class="dna-group"><p class="dna-gt">${esc(title)}</p>${metricRows(rows, PLAYER_LABELS)}</div>`;
  });
}

export function playerSeasonView(s, minMinutes, { compact = false } = {}) {
  const vol = [['Apps', `${num(s.appearances)}`, s.starts !== undefined ? `${num(s.starts)} starts` : ''], ['Minutes', num(s.minutes_nominal), 'nominal'], ['Goals', num(s.goals), ''], ['Assists', num(s.assists), ''], ['Shots', num(s.shots), s.shots_on_target !== undefined ? `${num(s.shots_on_target)} on target` : ''], ['Key passes', num(s.key_passes), '']];
  const eligible = s.eligible_for_percentiles;
  const sp = s.splits; const l5 = s.last5;
  return `<div class="dna2${compact ? ' compact' : ''}">
    <div class="dna-vol">${join(compact ? vol.slice(0, 4) : vol, ([k, v, sub]) => `<div><b>${esc(v)}</b><span>${esc(k)}</span>${sub ? `<small>${esc(sub)}</small>` : ''}</div>`)}</div>
    ${eligible ? `${compact ? dnaSignature(s.metrics) : `<div class="dna-viz">${dnaRadar(s.metrics)}${dnaSignature(s.metrics)}</div>`}
      <p class="dna-intro">Percentiles rank against the <b>${num(s.players_compared)}</b> players with at least ${num(minMinutes)} nominal minutes in ${esc(s.competition?.name || 'this competition')} ${esc(s.season || '')} (p100 = best in the group).</p>
      ${compact ? '' : dnaGroups(s.metrics)}`
    : `<p class="dna-intro">${num(s.minutes_nominal)} of the ${num(minMinutes)} nominal minutes needed for percentile ranks in ${esc(s.competition?.name || 'this competition')} ${esc(s.season || '')}, so no ranks yet. Counts above are complete.</p>`}
    ${when(!compact && (sp || l5), () => `<div class="dna-splits">
      ${when(sp?.home, () => `<div><p class="dna-gt">HOME</p><b>${num(sp.home.goals)}</b><span>goals in ${num(sp.home.appearances)} apps</span></div>`)}
      ${when(sp?.away, () => `<div><p class="dna-gt">AWAY</p><b>${num(sp.away.goals)}</b><span>goals in ${num(sp.away.appearances)} apps</span></div>`)}
      ${when(l5, () => `<div><p class="dna-gt">LAST ${num(l5.appearances)}</p><b>${num(l5.goals)}</b><span>goals · ${num(l5.shots)} shots</span></div>`)}
    </div>`)}
  </div>`;
}

// Season switcher: competition-season chips; the first (latest) is selected.
export function playerDnaView(env, { compact = false } = {}) {
  const d = env.data;
  const seasons = d.seasons || [];
  if (!seasons.length) return '';
  const chip = (s, i) => `<button type="button" class="dna-chip" role="tab" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-dna-season="${i}">${s.competition ? competitionMark(s.competition.slug, 'xs') : ''}<span>${esc(s.season || '')}</span></button>`;
  return `<div class="dna-v2" data-dna-v2>
    ${seasons.length > 1 ? `<div class="dna-chips" role="tablist" aria-label="Competition and season">${join(seasons, chip)}</div>` : `<p class="dna-one">${seasons[0].competition ? competitionMark(seasons[0].competition.slug, 'xs') : ''} ${esc(seasons[0].competition?.name || '')} ${esc(seasons[0].season || '')}</p>`}
    ${join(seasons, (s, i) => `<div class="dna-panel" role="${seasons.length > 1 ? 'tabpanel' : 'group'}" data-dna-panel="${i}"${i === 0 ? '' : ' hidden'}>${playerSeasonView(s, d.min_minutes_for_percentiles, { compact })}</div>`)}
  </div>`;
}

export function mountDnaSwitch(root) {
  for (const box of root.querySelectorAll('[data-dna-v2]')) {
    const chips = [...box.querySelectorAll('[data-dna-season]')];
    const select = (i, focus) => {
      chips.forEach(c => { const on = c.dataset.dnaSeason === String(i); c.setAttribute('aria-selected', String(on)); c.tabIndex = on ? 0 : -1; if (on && focus) c.focus(); });
      box.querySelectorAll('[data-dna-panel]').forEach(p => { p.hidden = p.dataset.dnaPanel !== String(i); });
    };
    box.addEventListener('click', e => { const c = e.target.closest('[data-dna-season]'); if (c) select(c.dataset.dnaSeason); });
    box.addEventListener('keydown', e => {
      const i = chips.findIndex(c => c.getAttribute('aria-selected') === 'true');
      const n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
      if (n === null || i < 0) return; e.preventDefault(); select((n + chips.length) % chips.length, true);
    });
  }
}

export async function mountPlayerDna(root, slug) {
  const slot = root.querySelector('[data-player-dna]'); if (!slot) return;
  try {
    const env = await api(`players/${slug}/dna`);
    if (!env.data.seasons?.length || !slot.isConnected) { slot.innerHTML = ''; return; }
    slot.innerHTML = `${sectionHead('PLAYER DNA', 'Profile by competition-season')}${playerDnaView(env)}
      ${sourcePanel(env.meta, { title: 'HOW PLAYER DNA IS BUILT' })}`;
    mountDnaSwitch(slot);
  } catch { slot.innerHTML = ''; }
}
