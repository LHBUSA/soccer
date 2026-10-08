// LEAGUE HUB: OVERVIEW · TABLE · RESULTS · UPCOMING · TEAMS.
// All panels come from one load; tabs switch in place (?tab= keeps the state).
// MLS: conference tables (verified against canonical results) are the primary view,
// the overall table stays available. UCL: the verified league-phase table.
// GROUPS (Nations League; later World Cup / EURO): tier -> group tables, each verified on its own,
// group leaders on the overview, and NO overall table anywhere.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { compMeta } from '../lib/competitions.js';
import { boardWithin } from '../data/kalshi.js';
import { competitionMark, empty, errorState, link, matchGrid, mountTabs, sectionHead, sourcePanel, tabBar, tabPanel, teamMark } from '../components/ui.js';
import { groupTables, mountGroupTables, mountTableViews, tableView, tableViews } from '../components/table.js';
import { mountRelatedNews } from '../components/related.js';

export const title = d => {
  const n = d?.comp?.value?.data?.name; if (!n) return 'Competition Intelligence | PropBetEdge';
  if (compMeta(d.slug)?.format === 'groups') return `${n}${d.season ? ` ${d.season}` : ''} — ${d.table?.status === 'fulfilled' && d.table.value.data.verified_groups > 0 ? 'Tables, ' : ''}Fixtures & Match Intelligence | PropBetEdge`;
  const hasTable = d.table?.status === 'fulfilled' && (d.table.value.data.rows || []).length > 0;
  return hasTable ? `${n} Table, Results & Match Intelligence | PropBetEdge` : `${n} Results & Match Intelligence | PropBetEdge`;
};

const TABS = [['overview', 'OVERVIEW'], ['table', 'TABLE'], ['results', 'RESULTS'], ['upcoming', 'UPCOMING'], ['teams', 'TEAMS']];
// Release-gated pilot: leave other league and international hub layouts unchanged.
const PILOT_LEAGUES = new Set(['mls', 'premier-league', 'bundesliga']);
const settled = async p => { try { return { status: 'fulfilled', value: await p }; } catch (reason) { return { status: 'rejected', reason }; } };

export async function load([slug], query) {
  const comp = await api(`competitions/${slug}`); // 404 surfaces as the page error
  const seasons = comp.data.seasons || [];
  const current = seasons[0]?.label || null;
  const season = seasons.some(s => s.label === query.get('season')) ? query.get('season') : current;
  const isCurrent = season === current;
  const today = todayUtc();
  const grouped = compMeta(slug)?.format === 'groups';
  // The Kalshi board (card lines for upcoming / live fixtures) loads beside the fixtures; bounded, never fails the page.
  const [table, recent, upcoming, cov, live] = await Promise.allSettled([
    api('table', { competition: slug, season, ...(grouped ? { expand: 'groups' } : {}) }),
    api('matches', { competition: slug, season, status: 'finished', ...(isCurrent ? { to: today } : {}), limit: 30 }),
    isCurrent ? api('matches', { competition: slug, season, status: 'scheduled', from: today, order: 'asc', limit: 30 }) : Promise.resolve(null),
    api('coverage'),
    isCurrent && comp.data.current?.live ? api('matches', { competition: slug, season, status: 'live', limit: 12 }) : Promise.resolve(null),
    isCurrent ? boardWithin() : null,
  ]);
  // Conference tables (only where the API lists conference groups for the season).
  const groups = table.status === 'fulfilled' ? (table.value.data.groups || []).filter(g => g.type === 'conference') : [];
  const confs = await Promise.all(groups.map(async g => ({ key: g.key, label: g.name, res: await settled(api('table', { competition: slug, season, group: g.key })) })));
  const tab = TABS.some(([k]) => k === query.get('tab')) ? query.get('tab') : 'overview';
  return { slug, comp: { status: 'fulfilled', value: comp }, season, current, isCurrent, table, confs, recent, upcoming, cov, live, tab, grouped };
}

function teamsPanel(c) {
  const teams = c.current?.teams || [];
  const national = c.current?.team_kind === 'national';
  if (!teams.length) return empty(national ? 'No nations stored for this season' : 'No teams stored for this season');
  return `<ul class="teamgrid">${join(teams, t => `<li>${link(`/teams/${t.slug}`, `${teamMark(t)}<span>${esc(t.name)}</span>`)}</li>`)}</ul>
    <p class="caveat">${national ? 'National teams' : 'Teams'} appearing in canonical matches of ${esc(c.current.season)}. Initials marks unless an approved ${national ? 'badge' : 'crest'} with provenance exists.</p>`;
}

// Group leaders: position 1 of every VERIFIED group (a withheld group says so). Not a ranking across groups.
function groupLeaders(env) {
  const groups = env?.data?.groups || [];
  if (!groups.length) return '<p class="muted">No group standings are stored for this season yet.</p>';
  return `<ul class="gleaders">${join(groups, g => {
    const top = g.verified ? (g.rows || [])[0] : null;
    return `<li><span class="gl-g">${esc((g.abbreviation || g.name || g.key).replace(/^Group\s+/i, ''))}</span>${top ? `${link(`/teams/${top.team.slug}`, `${teamMark(top.team, 'xs')}<span>${esc(top.team.short_name || top.team.name)}</span>`)}<b class="gl-pts">${num(top.points)} pts</b>` : '<span class="gl-na">Table withheld</span>'}</li>`;
  })}</ul>`;
}

export function render(d) {
  const c = d.comp.value.data;
  const f = compMeta(d.slug);
  const covRow = d.cov.status === 'fulfilled' ? (d.cov.value.data.competitions || []).find(x => x.slug === d.slug) : null;
  const tableEnv = d.table.status === 'fulfilled' ? d.table.value : null;
  const confEnvs = d.confs.filter(x => x.res.status === 'fulfilled').map(x => ({ key: x.key, label: x.label, env: x.res.value }));
  const verifiedConfs = confEnvs.filter(x => x.env.data.rows?.length);
  const isLeaguePhase = tableEnv?.data?.group?.type === 'league_phase';
  const tableBlock = lim => (d.table.status === 'rejected' ? errorState(d.table.reason) : tableView(tableEnv, { limit: lim }));
  const results = d.recent.status === 'rejected' ? errorState(d.recent.reason) : matchGrid(d.recent.value?.data, { showComp: false }) || empty('No finished matches in this season');
  const upcoming = !d.isCurrent ? empty('Past season', 'Upcoming fixtures are shown for the latest season only.')
    : d.upcoming.status === 'rejected' ? errorState(d.upcoming.reason) : matchGrid(d.upcoming.value?.data, { showComp: false }) || empty('No scheduled fixtures stored');
  const cur = c.current;
  // Overview table: conference tops for MLS when verified, else the main table.
  const overviewTable = verifiedConfs.length
    ? join(verifiedConfs, x => `${sectionHead('STANDINGS', `${x.label} · ${d.season}`)}${tableView(x.env, { limit: 5 })}`)
    : `${sectionHead('TABLE', tableEnv?.data?.rows?.length ? (isLeaguePhase ? `League phase · ${d.season}` : d.slug === 'mls' ? `Top of the overall standings · ${d.season}` : `Top of the table · ${d.season}`) : 'Table')}${tableBlock(tableEnv?.data?.rows?.length ? 6 : null)}`;
  const pilot = PILOT_LEAGUES.has(d.slug);
  const liveRows = d.isCurrent && d.live?.status === 'fulfilled' ? d.live.value?.data || [] : [];
  const overview = `${when(pilot && liveRows.length, () => `${sectionHead('LIVE NOW', 'In play')}${matchGrid(liveRows, { showComp: false })}`)}
    ${when(pilot, () => `<p class="caveat">Explore <a href="/pbecast" data-link class="sec-link">Soccer PBEcast</a> · <a href="/players?competition=${esc(d.slug)}" data-link class="sec-link">League Player DNA</a> · <a href="/news/${esc(f?.desk || d.slug)}" data-link class="sec-link">League newsroom</a></p>`)}
  <div class="two">
    <div>${overviewTable}
      ${when(tableEnv?.data?.rows?.length > 6 || verifiedConfs.length, () => `<p><a href="?tab=table" class="sec-link" data-goto-tab="table">Full table →</a></p>`)}
    </div>
    <div>
      ${when(d.isCurrent, () => `${sectionHead('UPCOMING', 'Next fixtures')}${d.upcoming.status === 'fulfilled' ? matchGrid(d.upcoming.value?.data?.slice(0, 4), { showComp: false }) || '<p class="muted">No scheduled fixtures stored.</p>' : ''}`)}
      ${sectionHead('RESULTS', 'Latest results')}
      ${d.recent.status === 'fulfilled' ? matchGrid(d.recent.value?.data?.slice(0, 4), { showComp: false }) || '<p class="muted">No finished matches in this season.</p>' : ''}
    </div>
  </div>
  ${when(pilot, () => '<div data-related-news></div>')}
  ${sectionHead('DATA COVERAGE', 'What the graph holds for this competition')}
  ${covRow ? `<div class="depthgrid light">
    <div class="depth-item"><b>${num(covRow.matches)}</b><span>canonical matches</span></div>
    <div class="depth-item"><b>${num(covRow.finished)}</b><span>finished</span></div>
    <div class="depth-item"><b>${num(covRow.matches_with_lineups)}</b><span>with sourced lineups</span></div>
    <div class="depth-item"><b>${num(covRow.coordinate_backed_matches)}</b><span>with an event map</span></div>
  </div>` : '<p class="muted">Coverage counts unavailable right now.</p>'}
  ${sourcePanel(d.comp.value.meta, { title: 'COMPETITION SOURCE' })}`;
  if (d.grouped) return renderGroups(d, c, f, covRow, tableEnv, results, upcoming);
  const tablePanel = confEnvs.length
    ? `${sectionHead('TABLE', `${d.season || ''} standings`)}${tableViews([...confEnvs, ...(tableEnv ? [{ key: 'overall', label: 'Overall', env: tableEnv }] : [])], confEnvs[0].key)}
       ${sourcePanel((verifiedConfs[0] || confEnvs[0]).env.meta, { title: 'HOW CONFERENCE TABLES ARE VERIFIED' })}${when(tableEnv, () => sourcePanel(tableEnv.meta, { title: 'HOW THE OVERALL TABLE IS COMPUTED' }))}`
    : `${sectionHead('TABLE', isLeaguePhase ? `${d.season || ''} league phase` : `${d.season || ''} standings`)}${tableBlock(null)}${when(tableEnv, () => sourcePanel(tableEnv.meta, { title: isLeaguePhase ? 'HOW THE LEAGUE-PHASE TABLE IS VERIFIED' : 'HOW THIS TABLE IS COMPUTED' }))}`;
  return `
  <section class="hero compact league a-${esc(f?.accent || 'x')}"><div class="wrap">
    <div class="lh-top">${competitionMark(d.slug, 'xl', { tone: 'dark' })}<div>
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
    ${tabPanel('table', d.tab, tablePanel)}
    ${tabPanel('results', d.tab, `${sectionHead('RESULTS', d.isCurrent ? 'Recent results' : `Results · ${d.season}`)}${results}`)}
    ${tabPanel('upcoming', d.tab, `${sectionHead('UPCOMING', 'Fixtures')}${upcoming}`)}
    ${tabPanel('teams', d.tab, `${sectionHead('TEAMS', `${cur?.season || ''} clubs`)}${teamsPanel(c)}`)}
  </div></section>`;
}

// Group tournament hub (format 'groups'): INTERNATIONAL hero, live / upcoming / results, group leaders,
// tier -> group tables, nations. There is no overall table on this page or behind it.
function renderGroups(d, c, f, covRow, tableEnv, results, upcoming) {
  const cur = c.current;
  const national = cur?.team_kind === 'national';
  const liveRows = d.live?.status === 'fulfilled' ? d.live.value?.data || [] : [];
  const verified = tableEnv?.data?.verified_groups ?? 0; const total = tableEnv?.data?.groups?.length ?? 0;
  const overview = `${when(liveRows.length, () => `${sectionHead('LIVE NOW', 'In play')}${matchGrid(liveRows, { showComp: false })}`)}
  <div class="two">
    <div>${sectionHead('GROUP STANDINGS', total ? `Group leaders · ${num(verified)} of ${num(total)} tables verified · ${d.season}` : 'Group standings')}
      ${d.table.status === 'rejected' ? errorState(d.table.reason) : groupLeaders(tableEnv)}
      ${when(total, () => `<p><a href="?tab=table" class="sec-link" data-goto-tab="table">All group tables →</a></p>`)}
    </div>
    <div>
      ${when(d.isCurrent, () => `${sectionHead('UPCOMING', 'Next fixtures')}${d.upcoming.status === 'fulfilled' ? matchGrid(d.upcoming.value?.data?.slice(0, 4), { showComp: false }) || '<p class="muted">No scheduled fixtures stored.</p>' : ''}`)}
      ${sectionHead('RESULTS', 'Latest results')}
      ${d.recent.status === 'fulfilled' ? matchGrid(d.recent.value?.data?.slice(0, 4), { showComp: false }) || '<p class="muted">No finished matches in this season.</p>' : ''}
    </div>
  </div>
  <div data-related-news></div>
  ${sectionHead('DATA COVERAGE', 'What the graph holds for this competition')}
  ${covRow ? `<div class="depthgrid light">
    <div class="depth-item"><b>${num(covRow.matches)}</b><span>canonical matches</span></div>
    <div class="depth-item"><b>${num(covRow.finished)}</b><span>finished</span></div>
    <div class="depth-item"><b>${num(covRow.matches_with_lineups)}</b><span>with sourced lineups</span></div>
    <div class="depth-item"><b>${num(covRow.coordinate_backed_matches)}</b><span>with an event map</span></div>
  </div>` : '<p class="muted">Coverage counts unavailable right now.</p>'}
  ${sourcePanel(d.comp.value.meta, { title: 'COMPETITION SOURCE' })}`;
  const tablePanel = `${sectionHead('TABLES', `${d.season || ''} league phase · groups`)}
    ${d.table.status === 'rejected' ? errorState(d.table.reason) : groupTables(tableEnv)}
    ${when(tableEnv, () => sourcePanel(tableEnv.meta, { title: 'HOW GROUP TABLES ARE VERIFIED' }))}`;
  return `
  <section class="hero compact league a-${esc(f?.accent || 'x')}"><div class="wrap">
    <div class="lh-top">${competitionMark(d.slug, 'xl', { tone: 'dark' })}<div>
      <p class="kicker gold">INTERNATIONAL</p>
      <h1 class="display">${esc(f?.long || c.name)}</h1></div></div>
    <div class="hero-facts">
      <div><b>${esc(d.season || '—')}</b><span>season</span></div>
      ${cur && d.isCurrent ? `<div><b>${num(cur.teams?.length)}</b><span>${national ? 'nations' : 'teams'}</span></div><div><b>${num(cur.finished)}</b><span>played</span></div><div><b>${num(cur.scheduled)}</b><span>to play</span></div>` : ''}
      ${when(cur?.live, () => `<div><b class="live">${num(cur.live)}</b><span>live now</span></div>`)}
    </div>
    <label class="season-select">SEASON
      <select data-season>${join(c.seasons, s => `<option value="${esc(s.label)}"${s.label === d.season ? ' selected' : ''}>${esc(s.label)} · ${num(s.matches)} matches</option>`)}</select>
    </label>
  </div>
  <div class="wrap">${tabBar(TABS, d.tab, `${c.name} sections`)}</div></section>
  <section class="canvas"><div class="wrap">
    ${tabPanel('overview', d.tab, overview)}
    ${tabPanel('table', d.tab, tablePanel)}
    ${tabPanel('results', d.tab, `${sectionHead('RESULTS', d.isCurrent ? 'Recent results' : `Results · ${d.season}`)}${results}`)}
    ${tabPanel('upcoming', d.tab, `${sectionHead('UPCOMING', 'Fixtures')}${upcoming}`)}
    ${tabPanel('teams', d.tab, `${sectionHead(national ? 'NATIONS' : 'TEAMS', `${cur?.season || ''} ${national ? 'national teams' : 'teams'}`)}${teamsPanel(c)}`)}
  </div></section>`;
}

export function mount(root, d, { navigate }) {
  root.querySelector('[data-season]')?.addEventListener('change', e => navigate(`/competitions/${d.slug}?season=${encodeURIComponent(e.target.value)}`));
  mountTabs(root);
  mountTableViews(root);
  mountGroupTables(root);
  const desk = compMeta(d.slug)?.desk;
  if (desk && (d.grouped || PILOT_LEAGUES.has(d.slug))) {
    mountRelatedNews(root, { desk }, { kicker: 'NEWS', title: d.grouped ? 'From the International desk' : `From the ${compMeta(d.slug).name} desk` });
  }
}
