// LEAGUE HUB: OVERVIEW · TABLE · RESULTS · UPCOMING · TEAMS.
// All panels come from one load; tabs switch in place (?tab= keeps the state).
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { compMeta } from '../lib/competitions.js';
import { compMono, empty, errorState, link, matchGrid, mountTabs, sectionHead, sourcePanel, tabBar, tabPanel, teamMark } from '../components/ui.js';
import { tableView } from '../components/table.js';

export const title = d => (d?.comp?.value?.data?.name ? `${d.comp.value.data.name} · PropBetEdge Soccer` : 'Competition · PropBetEdge Soccer');

const TABS = [['overview', 'OVERVIEW'], ['table', 'TABLE'], ['results', 'RESULTS'], ['upcoming', 'UPCOMING'], ['teams', 'TEAMS']];

export async function load([slug], query) {
  const comp = await api(`competitions/${slug}`); // 404 surfaces as the page error
  const seasons = comp.data.seasons || [];
  const current = seasons[0]?.label || null;
  const season = seasons.some(s => s.label === query.get('season')) ? query.get('season') : current;
  const isCurrent = season === current;
  const today = todayUtc();
  const [table, recent, upcoming, cov] = await Promise.allSettled([
    api('table', { competition: slug, season }),
    api('matches', { competition: slug, season, status: 'finished', ...(isCurrent ? { to: today } : {}), limit: 30 }),
    isCurrent ? api('matches', { competition: slug, season, status: 'scheduled', from: today, order: 'asc', limit: 30 }) : Promise.resolve(null),
    api('coverage'),
  ]);
  const tab = TABS.some(([k]) => k === query.get('tab')) ? query.get('tab') : 'overview';
  return { slug, comp: { status: 'fulfilled', value: comp }, season, current, isCurrent, table, recent, upcoming, cov, tab };
}

// UCL: the stored competition has no league stage, so there is no table to show.
const noTableReason = f => (f?.format === 'ucl'
  ? 'Champions League table not available. The league phase and knockout rounds are stored as matches only; PropBetEdge does not compute a league-phase table it cannot verify.'
  : null);

function teamsPanel(c) {
  const teams = c.current?.teams || [];
  if (!teams.length) return empty('No teams stored for this season');
  return `<ul class="teamgrid">${join(teams, t => `<li>${link(`/teams/${t.slug}`, `${teamMark(t)}<span>${esc(t.name)}</span>`)}</li>`)}</ul>
    <p class="caveat">Teams appearing in canonical matches of ${esc(c.current.season)}. Initials marks, not club crests.</p>`;
}

export function render(d) {
  const c = d.comp.value.data;
  const f = compMeta(d.slug);
  const covRow = d.cov.status === 'fulfilled' ? (d.cov.value.data.competitions || []).find(x => x.slug === d.slug) : null;
  const tableEnv = d.table.status === 'fulfilled' ? d.table.value : null;
  const reason = noTableReason(f);
  const tableBlock = lim => (d.table.status === 'rejected' ? errorState(d.table.reason) : tableView(tableEnv, { limit: lim, reason }));
  const results = d.recent.status === 'rejected' ? errorState(d.recent.reason) : matchGrid(d.recent.value?.data, { showComp: false }) || empty('No finished matches in this season');
  const upcoming = !d.isCurrent ? empty('Past season', 'Upcoming fixtures are shown for the latest season only.')
    : d.upcoming.status === 'rejected' ? errorState(d.upcoming.reason) : matchGrid(d.upcoming.value?.data, { showComp: false }) || empty('No scheduled fixtures stored');
  const cur = c.current;
  const overview = `<div class="two">
    <div>${sectionHead('TABLE', tableEnv?.data?.rows?.length ? (d.slug === 'mls' ? `Top of the overall standings · ${d.season}` : `Top of the table · ${d.season}`) : 'Table')}
      ${tableBlock(tableEnv?.data?.rows?.length ? 6 : null)}
      ${when(tableEnv?.data?.rows?.length > 6, () => `<p><a href="?tab=table" class="sec-link" data-goto-tab="table">Full table →</a></p>`)}
    </div>
    <div>
      ${when(d.isCurrent, () => `${sectionHead('UPCOMING', 'Next fixtures')}${d.upcoming.status === 'fulfilled' ? matchGrid(d.upcoming.value?.data?.slice(0, 4), { showComp: false }) || '<p class="muted">No scheduled fixtures stored.</p>' : ''}`)}
      ${sectionHead('RESULTS', 'Latest results')}
      ${d.recent.status === 'fulfilled' ? matchGrid(d.recent.value?.data?.slice(0, 4), { showComp: false }) || '<p class="muted">No finished matches in this season.</p>' : ''}
    </div>
  </div>
  ${sectionHead('DATA COVERAGE', 'What the graph holds for this competition')}
  ${covRow ? `<div class="depthgrid light">
    <div class="depth-item"><b>${num(covRow.matches)}</b><span>canonical matches</span></div>
    <div class="depth-item"><b>${num(covRow.finished)}</b><span>finished</span></div>
    <div class="depth-item"><b>${num(covRow.matches_with_lineups)}</b><span>with sourced lineups</span></div>
    <div class="depth-item"><b>${num(covRow.coordinate_backed_matches)}</b><span>with an event map</span></div>
  </div>` : '<p class="muted">Coverage counts unavailable right now.</p>'}
  ${sourcePanel(d.comp.value.meta, { title: 'COMPETITION SOURCE' })}`;
  return `
  <section class="hero compact league a-${esc(f?.accent || 'x')}"><div class="wrap">
    <div class="lh-top">${compMono(d.slug, 'xl')}<div>
      <p class="kicker gold">${esc(c.type === 'league' ? 'LEAGUE' : 'COMPETITION')}${c.country_code ? ` · ${esc(c.country_code)}` : ''}</p>
      <h1 class="display">${esc(f?.long || c.name)}</h1></div></div>
    <div class="hero-facts">
      <div><b>${esc(d.season || '—')}</b><span>season</span></div>
      ${cur && d.isCurrent ? `<div><b>${num(cur.teams?.length)}</b><span>teams</span></div><div><b>${num(cur.finished)}</b><span>played</span></div><div><b>${num(cur.scheduled)}</b><span>to play</span></div>` : ''}
      ${when(cur?.live, () => `<div><b class="live">${num(cur.live)}</b><span>live now</span></div>`)}
    </div>
    <label class="season-select">SEASON
      <select data-season>${join(c.seasons, s => `<option value="${esc(s.label)}"${s.label === d.season ? ' selected' : ''}>${esc(s.label)} · ${num(s.matches)} matches</option>`)}</select>
    </label>
  </div>
  <div class="wrap">${tabBar(TABS, d.tab, `${c.name} sections`)}</div></section>
  <section class="canvas"><div class="wrap">
    ${tabPanel('overview', d.tab, overview)}
    ${tabPanel('table', d.tab, `${sectionHead('TABLE', !tableEnv?.data?.rows?.length ? (f?.format === 'ucl' ? `${d.season || ''} league phase` : 'Standings') : d.slug === 'mls' ? `${d.season || ''} overall standings (both conferences)` : `${d.season || ''} standings`)}${tableBlock(null)}${when(tableEnv, () => sourcePanel(tableEnv.meta, { title: 'HOW THIS TABLE IS COMPUTED' }))}`)}
    ${tabPanel('results', d.tab, `${sectionHead('RESULTS', d.isCurrent ? 'Recent results' : `Results · ${d.season}`)}${results}`)}
    ${tabPanel('upcoming', d.tab, `${sectionHead('UPCOMING', 'Fixtures')}${upcoming}`)}
    ${tabPanel('teams', d.tab, `${sectionHead('TEAMS', `${cur?.season || ''} clubs`)}${teamsPanel(c)}`)}
  </div></section>`;
}

export function mount(root, d, { navigate }) {
  root.querySelector('[data-season]')?.addEventListener('change', e => navigate(`/competitions/${d.slug}?season=${encodeURIComponent(e.target.value)}`));
  mountTabs(root);
}
