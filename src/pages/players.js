// PLAYER DNA DIRECTORY (/players): every player named in sourced lineups of the latest season of
// each product competition. Filters and paging live in the URL. Rate leaders exist only inside
// ONE competition-season and only among qualified players (the API refuses anything else).
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, ROLE } from '../lib/format.js';
import { FEATURED_COMPS, compMeta } from '../lib/competitions.js';
import { compMono, empty, link, portrait, sectionHead, sourcePanel, teamMark } from '../components/ui.js';

export const title = () => 'Player DNA Directory — Soccer Player Stats & Profiles | PropBetEdge';

const PAGE = 48;
const COUNT_SORTS = [['goals', 'Goals'], ['assists', 'Assists'], ['minutes', 'Minutes']];
const DEFAULT_SORT = 'goals';
const RATE_SORTS = [['goal_contributions_per90', 'G+A per 90'], ['goals_per90', 'Goals per 90'], ['assists_per90', 'Assists per 90'], ['shots_per90', 'Shots per 90'], ['key_passes_per90', 'Key passes per 90']];
const ROLES = [['', 'All roles'], ['forward', 'Forwards'], ['midfielder', 'Midfielders'], ['defender', 'Defenders'], ['goalkeeper', 'Goalkeepers']];

export function readQuery(q) {
  const competition = FEATURED_COMPS.some(c => c.slug === q.get('competition')) ? q.get('competition') : '';
  const rate = RATE_SORTS.some(([k]) => k === q.get('sort'));
  const sort = (rate && competition) || COUNT_SORTS.some(([k]) => k === q.get('sort')) ? q.get('sort') : DEFAULT_SORT;
  const role = ROLES.some(([k]) => k && k === q.get('role')) ? q.get('role') : '';
  const text = (q.get('q') || '').slice(0, 40).trim();
  const team = competition && /^[a-z0-9-]{1,120}$/.test(q.get('team') || '') ? q.get('team') : '';
  const page = Math.max(1, Math.min(100, Number.parseInt(q.get('page'), 10) || 1));
  return { competition, sort, role, q: text, team, page };
}

export function hrefFor(s, patch = {}) {
  const n = { ...s, ...patch };
  if (patch.competition !== undefined && !patch.competition && RATE_SORTS.some(([k]) => k === n.sort)) n.sort = DEFAULT_SORT;
  if (patch.competition !== undefined && patch.competition !== s.competition) n.team = '';
  const u = new URLSearchParams();
  if (n.competition) u.set('competition', n.competition);
  if (n.sort && n.sort !== DEFAULT_SORT) u.set('sort', n.sort);
  if (n.role) u.set('role', n.role);
  if (n.team && n.competition) u.set('team', n.team);
  if (n.q) u.set('q', n.q);
  if (n.page > 1) u.set('page', String(n.page));
  const qs = u.toString();
  return `/players${qs ? `?${qs}` : ''}`;
}

export async function load(_p, query) {
  const s = readQuery(query);
  const [env, comp] = await Promise.all([
    api('players', { competition: s.competition || undefined, sort: s.sort, role: s.role || undefined, q: s.q || undefined, team: s.team || undefined, limit: PAGE, offset: (s.page - 1) * PAGE }),
    s.competition ? api(`competitions/${s.competition}`).catch(() => null) : Promise.resolve(null),
  ]);
  const teams = (comp?.data?.current?.teams || []).slice().sort((a, b) => a.name.localeCompare(b.name));
  return { s, env, teams };
}

// Goals + assists per 90 nominal minutes: the Player DNA definition, shown only for players over
// the percentile threshold (qualified); otherwise a dash (not enough minutes), never 0.
export function quickGA(p) {
  if (!p.qualified || !p.minutes_nominal || p.goals === null || p.goals === undefined || p.assists === null || p.assists === undefined) return '—';
  return num(((p.goals + p.assists) * 90) / p.minutes_nominal, { dp: 2 });
}

export function playerCard(p, { leaders = false } = {}) {
  const f = compMeta(p.competition?.slug);
  return `<a class="pcard" href="/players/${esc(p.slug)}" data-link data-player-slug="${esc(p.slug)}">
    <span class="pc-top">${portrait(p, 'lg')}<span class="pc-id"><b>${esc(p.name)}</b>
      <span class="pc-team">${p.team ? `${teamMark(p.team, 'xs')}<span>${esc(p.team.short_name || p.team.name)}</span>` : '<span class="muted">Team not stated</span>'}</span>
      <span class="pc-meta">${f ? compMono(f.slug, 'xs') : ''}<span>${esc(ROLE[p.role] || 'Role not stated')}</span></span></span></span>
    ${leaders ? `<span class="pc-lead"><b>${num(p.value, { dp: 2 })}</b>${p.percentile !== null && p.percentile !== undefined ? `<span>p${esc(String(p.percentile))} of ${num(p.compared_with)}</span>` : ''}</span>` : ''}
    <span class="pc-stats"><span><b>${num(p.appearances)}</b>apps</span><span><b>${num(p.minutes_nominal)}</b>min</span><span><b>${num(p.goals)}</b>goals</span><span><b>${num(p.assists)}</b>assists</span><span><b>${quickGA(p)}</b>G+A/90</span></span>
    ${p.qualified ? '' : '<span class="pc-note">Below the minutes needed for percentile ranks</span>'}
  </a>`;
}

export function render(d) {
  const { s } = d; const x = d.env.data;
  const sorts = s.competition ? [...COUNT_SORTS, ...RATE_SORTS] : COUNT_SORTS;
  const pages = Math.max(1, Math.ceil(x.total / PAGE));
  const seasonLine = join(x.seasons, z => `<span>${compMono(z.competition.slug, 'xs')} ${esc(z.season)} · ${num(z.players)} players · ${num(z.qualified)} ranked</span>`);
  return `<section class="hero compact"><div class="wrap">
    <p class="kicker gold">PLAYER DNA</p><h1 class="display">Player directory</h1>
    <p class="lede">Every player named in sourced lineups this season across MLS, the Premier League, the Champions League and the Bundesliga. Open any player for their full Player DNA.</p>
    <nav class="tabs" aria-label="Competition">${link(hrefFor(s, { competition: '', page: 1 }), 'All', `tab${!s.competition ? ' on' : ''}`)}${join(FEATURED_COMPS, c => link(hrefFor(s, { competition: c.slug, page: 1 }), `${compMono(c.slug, 'xs')}${esc(c.name)}`, `tab${c.slug === s.competition ? ' on' : ''}`))}</nav>
  </div></section>
  <section class="canvas"><div class="wrap">
    <form class="pfilters" data-pfilters role="search" aria-label="Filter players">
      <label>Search<input type="search" name="q" value="${esc(s.q)}" placeholder="Player name" autocomplete="off" maxlength="40"></label>
      <label>Role<select name="role">${join(ROLES, ([k, l]) => `<option value="${k}"${k === s.role ? ' selected' : ''}>${esc(l)}</option>`)}</select></label>
      ${d.teams?.length ? `<label>Team<select name="team"><option value="">All teams</option>${join(d.teams, t => `<option value="${esc(t.slug)}"${t.slug === s.team ? ' selected' : ''}>${esc(t.name)}</option>`)}</select></label>` : ''}
      <label>Sort<select name="sort">${join(sorts, ([k, l]) => `<option value="${k}"${k === s.sort ? ' selected' : ''}>${esc(l)}</option>`)}</select></label>
      <button class="btn gold" type="submit">Apply</button>
    </form>
    ${when(!s.competition, () => '<p class="caveat">Rate leaders (per-90 sorts) are available inside one competition: choose a competition above. There is no cross-competition ranking.</p>')}
    ${when(x.leaders, () => `<p class="caveat">Leaders among the ${num(x.min_minutes_for_percentiles)}+ nominal-minute players of ${esc(compMeta(s.competition)?.long || s.competition)}; the percentile ranks against that group.</p>`)}
    ${sectionHead('PLAYERS', `${num(x.total)} ${x.total === 1 ? 'player' : 'players'}${s.q ? ` matching “${esc(s.q)}”` : ''}`)}
    ${x.players.length ? `<div class="pgrid">${join(x.players, p => playerCard(p, { leaders: x.leaders }))}</div>` : empty('No players match', 'Try another name, role or competition.')}
    ${when(pages > 1, () => `<nav class="pager" aria-label="Pages">${s.page > 1 ? link(hrefFor(s, { page: s.page - 1 }), '← Previous', 'btn ghost') : ''}<span>Page ${num(s.page)} of ${num(pages)}</span>${s.page < pages ? link(hrefFor(s, { page: s.page + 1 }), 'Next →', 'btn ghost') : ''}</nav>`)}
    <p class="season-line">${seasonLine}</p>
    ${sourcePanel(d.env.meta, { title: 'HOW THE DIRECTORY IS BUILT' })}
  </div></section>`;
}

export function mount(root, d, { navigate }) {
  const form = root.querySelector('[data-pfilters]'); if (!form) return;
  const go = () => { const f = new FormData(form); navigate(hrefFor(d.s, { q: String(f.get('q') || '').trim(), role: String(f.get('role') || ''), team: String(f.get('team') || ''), sort: String(f.get('sort') || DEFAULT_SORT), page: 1 })); };
  form.addEventListener('submit', e => { e.preventDefault(); go(); });
  for (const sel of form.querySelectorAll('select')) sel.addEventListener('change', go);
}

