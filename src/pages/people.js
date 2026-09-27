// TEAM and PLAYER INTELLIGENCE pages.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { DASH, FOOT, ROLE, dateLong, num } from '../lib/format.js';
import { formChips, matchGrid, sectionHead, sourcePanel } from '../components/ui.js';

export const team = {
  title: d => `${d.env?.data?.name || 'Team'} · PropBetEdge Soccer`,
  async load([slug]) { return { env: await api(`teams/${slug}`) }; },
  render(d) {
    const t = d.env.data;
    const place = [t.city, t.country_code].filter(Boolean).join(' · ');
    return `<section class="hero compact"><div class="wrap">
      <p class="kicker gold">TEAM${t.type === 'national' ? ' · NATIONAL TEAM' : ''}</p>
      <h1 class="display">${esc(t.name)}</h1>
      ${when(t.official_name && t.official_name !== t.name, () => `<p class="lede">${esc(t.official_name)}</p>`)}
      <div class="hero-facts">
        <div><b>${esc(place || DASH)}</b><span>location</span></div>
        <div><b class="formwrap">${formChips(t.form)}</b><span>last five, newest first</span></div>
      </div>
    </div></section>
    <section class="canvas"><div class="wrap two">
      <div>${sectionHead('RECENT', 'Recent results')}${matchGrid(t.recent) || '<p class="muted">No finished matches stored for this team.</p>'}</div>
      <div>${sectionHead('UPCOMING', 'Next matches')}${matchGrid(t.upcoming) || '<p class="muted">No scheduled matches stored for this team.</p>'}
        <p class="muted small">Squad lists are not shown: the graph only holds players seen in sourced lineups and events.</p>
        ${sourcePanel(d.env.meta)}</div>
    </div></section>`;
  },
};

const STAT_COLS = [
  ['appearances', 'Apps'], ['minutes_nominal', 'Min'], ['goals', 'Goals'], ['assists', 'Assists'], ['shots', 'Shots'],
  ['shots_on_target', 'On target'], ['key_passes', 'Key passes'], ['passes_completed', 'Passes compl.'], ['duels_won', 'Duels won'],
];

export const player = {
  title: d => `${d.env?.data?.name || 'Player'} · Player Intelligence`,
  async load([slug]) { return { env: await api(`players/${slug}`) }; },
  render(d) {
    const p = d.env.data; const meta = d.env.meta;
    const facts = [
      ['Role', ROLE[p.role] || DASH], ['Nationality', p.nationality_code || DASH], ['Born', p.birth_date ? dateLong(`${String(p.birth_date).slice(0, 10)}T12:00:00Z`) : DASH],
      ['Preferred foot', FOOT[p.foot] || DASH], ['Height', p.height_cm ? `${p.height_cm} cm` : DASH],
    ];
    const seasons = p.seasons || [];
    return `<section class="hero compact"><div class="wrap">
      <p class="kicker gold">PLAYER INTELLIGENCE</p>
      <h1 class="display">${esc(p.name)}</h1>
      ${when(p.first_name || p.last_name, () => `<p class="lede">${esc([p.first_name, p.last_name].filter(Boolean).join(' '))}</p>`)}
      <div class="facts">${join(facts, ([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`)}</div>
    </div></section>
    <section class="canvas"><div class="wrap">
      ${sectionHead('SEASON HISTORY', 'Event-derived statistics')}
      ${seasons.length ? `<div class="tablewrap"><table class="ltable ptable"><thead><tr><th class="tm">Season</th>${join(STAT_COLS, ([, l]) => `<th>${esc(l)}</th>`)}</tr></thead>
        <tbody>${join(seasons, s => `<tr><td class="tm">${esc(s.season)}</td>${join(STAT_COLS, ([k]) => `<td>${num(s[k])}</td>`)}</tr>`)}</tbody></table></div>
        <p class="caveat">Counts come from the event ledger (PBE derived counts), only for seasons that have one. Minutes are nominal (90/120, cut at substitution or dismissal). A dash means the value is not recorded, not zero.</p>`
        : '<div class="state empty"><p class="state-title">No event-level season history</p><p>This player has no season in the graph with an event ledger. Their identity and appearances in sourced lineups or reported goals may still exist.</p></div>'}
      ${when(p.reported_goals_other_seasons, () => `<p class="note-line"><b>${num(p.reported_goals_other_seasons)}</b> goals reported by OpenLigaDB in seasons without an event ledger.</p>`)}
      <p class="muted small">This is not Soccer DNA. Player profiles and percentiles stay unpublished until the model-readiness gates pass.</p>
      ${sourcePanel(meta, { title: 'SOURCE & COVERAGE' })}
    </div></section>`;
  },
};
