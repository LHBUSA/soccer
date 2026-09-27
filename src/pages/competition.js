import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { empty, errorState, link, matchGrid, sectionHead, sourcePanel, coverageBadge } from '../components/ui.js';
import { tableView } from '../components/table.js';

export const title = d => (d?.comp?.value?.data?.name ? `${d.comp.value.data.name} · PropBetEdge Soccer` : 'Competition · PropBetEdge Soccer');

export async function load([slug], query) {
  const comp = await api(`competitions/${slug}`); // 404 surfaces as the page error
  const seasons = comp.data.seasons || [];
  const current = seasons[0]?.label || null;
  const season = seasons.some(s => s.label === query.get('season')) ? query.get('season') : current;
  const isCurrent = season === current;
  const today = todayUtc();
  const [table, recent, upcoming, cov] = await Promise.allSettled([
    api('table', { competition: slug, season }),
    api('matches', { competition: slug, season, status: 'finished', ...(isCurrent ? { to: today } : {}), limit: 12 }),
    isCurrent ? api('matches', { competition: slug, season, status: 'scheduled', from: today, order: 'asc', limit: 10 }) : Promise.resolve(null),
    api('coverage'),
  ]);
  return { slug, comp: { status: 'fulfilled', value: comp }, season, current, isCurrent, table, recent, upcoming, cov };
}

export function render(d) {
  const c = d.comp.value.data;
  const total = (c.seasons || []).reduce((n, s) => n + (s.matches || 0), 0);
  const covRow = d.cov.status === 'fulfilled' ? (d.cov.value.data.competitions || []).find(x => x.slug === d.slug) : null;
  return `
  <section class="hero compact"><div class="wrap">
    <p class="kicker gold">${esc(c.type === 'league' ? 'LEAGUE' : 'COMPETITION')}${c.country_code ? ` · ${esc(c.country_code)}` : ''}</p>
    <h1 class="display">${esc(c.name)}</h1>
    <div class="hero-facts">
      <div><b>${esc(d.current || '—')}</b><span>latest season</span></div>
      <div><b>${num((c.seasons || []).length)}</b><span>stored seasons</span></div>
      <div><b>${num(total)}</b><span>canonical matches</span></div>
    </div>
    <label class="season-select">SEASON
      <select data-season>${join(c.seasons, s => `<option value="${esc(s.label)}"${s.label === d.season ? ' selected' : ''}>${esc(s.label)} · ${num(s.matches)} matches</option>`)}</select>
    </label>
  </div></section>
  <section class="canvas"><div class="wrap two">
    <div>
      ${sectionHead('TABLE', `${d.season || ''} standings`)}
      ${d.table.status === 'rejected' ? errorState(d.table.reason) : tableView(d.table.value)}
    </div>
    <div>
      ${when(d.isCurrent, () => `${sectionHead('UPCOMING', 'Next fixtures')}${d.upcoming.status === 'rejected' ? errorState(d.upcoming.reason) : matchGrid(d.upcoming.value?.data, { showComp: false }) || '<p class="muted">No scheduled fixtures stored.</p>'}`)}
      ${sectionHead('RESULTS', d.isCurrent ? 'Recent results' : `Results · ${d.season}`)}
      ${d.recent.status === 'rejected' ? errorState(d.recent.reason) : matchGrid(d.recent.value?.data, { showComp: false }) || empty('No finished matches in this season')}
    </div>
  </div></section>
  <section class="canvas alt"><div class="wrap">
    ${sectionHead('DATA COVERAGE', 'What the graph holds for this competition')}
    ${covRow ? `<div class="depthgrid light">
      <div class="depth-item"><b>${num(covRow.matches)}</b><span>canonical matches</span></div>
      <div class="depth-item"><b>${num(covRow.finished)}</b><span>finished</span></div>
      <div class="depth-item"><b>${num(covRow.coordinate_backed_matches)}</b><span>with an event map</span></div>
      <div class="depth-item"><b>${num(covRow.matches_with_lineups)}</b><span>with sourced lineups</span></div>
    </div>` : '<p class="muted">Coverage counts unavailable right now.</p>'}
    ${sourcePanel(d.comp.value.meta, { title: 'COMPETITION SOURCE' })}
    ${when(d.table.status === 'fulfilled', () => sourcePanel(d.table.value.meta, { title: 'TABLE SOURCE' }))}
  </div></section>`;
}

export function mount(root, d, { navigate }) {
  root.querySelector('[data-season]')?.addEventListener('change', e => navigate(`/competitions/${d.slug}?season=${encodeURIComponent(e.target.value)}`));
}
