// TEAM and PLAYER INTELLIGENCE pages (V2). Only what source data shows.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { DASH, FOOT, ROLE, dateLong, dateShort, num, scoreline } from '../lib/format.js';
import { compMeta } from '../lib/competitions.js';
import { compMono, formChips, link, matchGrid, playerChip, portrait, sectionHead, sourcePanel, teamLink, teamMark } from '../components/ui.js';
import { portraitOf } from '../components/media.js';
import { pitchSvg, validShots } from '../components/pitch.js';
import { mountPlayerDna, mountTeamDna } from '../components/dna.js';
import { mountRelatedNews } from '../components/related.js';

function recordCard(r) {
  const f = compMeta(r.competition?.slug);
  const head = `<span class="rc-head">${compMono(r.competition?.slug, 'xs')}<span>${esc(f?.name || r.competition?.name || 'Competition')}</span><span class="muted">${esc(r.season || '')}</span></span>`;
  if (!r.record) return `<div class="rcard">${head}<p class="muted small">No league-stage record stored for this season${f?.format === 'ucl' ? ' (Champions League matches are stored without a league table)' : ''}.</p></div>`;
  const x = r.record;
  return `<div class="rcard"><div class="rc-top">${head}<div class="rc-pos"><b>${num(r.position)}</b><span>of ${num(r.teams_in_table)}</span></div></div>
    <dl class="rc-grid">${join([['P', x.played], ['W', x.won], ['D', x.drawn], ['L', x.lost], ['GD', x.goal_difference > 0 ? `+${x.goal_difference}` : x.goal_difference], ['PTS', x.points]], ([k, v]) => `<div><dt>${k}</dt><dd>${typeof v === 'string' ? esc(v) : num(v)}</dd></div>`)}</dl>
    ${when(x.form?.length, () => `<div class="rc-form">${formChips(x.form)}</div>`)}
  </div>`;
}

export const team = {
  title: d => `${d.env?.data?.name || 'Team'} Results, Team DNA & Soccer Intelligence | PropBetEdge`,
  async load([slug]) { return { env: await api(`teams/${slug}`) }; },
  render(d) {
    const t = d.env.data;
    // ESPN's team `location` is often the club's short name, not a city: never print it as one.
    const city = t.city && ![t.name, t.short_name].includes(t.city) ? t.city : null;
    const place = [city, t.country_code].filter(Boolean).join(' · ');
    const obs = t.players_observed || { players: [], lineups_counted: 0 };
    return `<section class="hero compact"><div class="wrap">
      <div class="lh-top">${teamMark(t, 'xl')}<div>
        <p class="kicker gold">TEAM${t.type === 'national' ? ' · NATIONAL TEAM' : ''}</p>
        <h1 class="display">${esc(t.name)}</h1>
        ${when(t.official_name && t.official_name !== t.name, () => `<p class="lede">${esc(t.official_name)}</p>`)}
      </div></div>
      ${when(t.crest?.attribution, () => `<p class="credit">Crest: ${t.crest.source_url ? `<a href="${esc(t.crest.source_url)}" rel="noopener" target="_blank">${esc(t.crest.attribution)}</a>` : esc(t.crest.attribution)}. Used to identify the club.</p>`)}
      <div class="hero-facts">
        ${when(place, () => `<div><b>${esc(place)}</b><span>location</span></div>`)}
        <div><b class="formwrap">${formChips(t.form)}</b><span>last five, newest first</span></div>
      </div>
    </div></section>
    <section class="canvas"><div class="wrap">
      ${when((t.records || []).length, () => `${sectionHead('RECORD', 'This season')}<div class="rgrid">${join(t.records, recordCard)}</div>`)}
      <div class="two">
        <div>${sectionHead('FIXTURES', 'Next matches')}${matchGrid(t.upcoming) || '<p class="muted">No scheduled matches stored for this team.</p>'}</div>
        <div>${sectionHead('RESULTS', 'Recent results')}${matchGrid(t.recent) || '<p class="muted">No finished matches stored for this team.</p>'}</div>
      </div>
      <div data-team-dna class="dna-slot" aria-live="polite"></div>
      ${sectionHead('PLAYERS OBSERVED IN SOURCE DATA', obs.players.length ? `${num(obs.players.length)} players · ${num(obs.lineups_counted)} sourced lineups` : 'No sourced lineups')}
      ${obs.players.length ? `<div class="tablewrap"><table class="ltable obs"><thead><tr><th class="tm" scope="col">Player</th><th scope="col">Role</th><th scope="col" title="Started or came on">Apps</th><th scope="col">Starts</th><th class="wide" scope="col" title="Named in the matchday squad">Named</th></tr></thead>
        <tbody>${join(obs.players, p => `<tr><th class="tm" scope="row">${playerChip(p)}</th><td class="role">${esc(ROLE[p.role] || DASH)}</td><td>${num(p.appearances)}</td><td>${num(p.starts)}</td><td class="wide">${num(p.named)}</td></tr>`)}</tbody></table></div>
        <p class="caveat">Not a squad list: only players named in sourced lineups for this season's stored matches. An appearance means the player started or came on.</p>`
        : '<p class="muted">No sourced lineups are stored for this team this season, so no players are listed. Squad lists are never guessed.</p>'}
      <div data-related-news></div>
      ${sourcePanel(d.env.meta)}
    </div></section>`;
  },
  mount(root, d) { mountTeamDna(root, d.env.data.slug); mountRelatedNews(root, { team: d.env.data.slug }, { title: 'Stories mentioning this club' }); },
};

const STAT_COLS = [
  ['appearances', 'Apps'], ['minutes_nominal', 'Min'], ['goals', 'Goals'], ['assists', 'Assists'], ['shots', 'Shots'],
  ['shots_on_target', 'On target'], ['key_passes', 'Key passes'], ['passes_completed', 'Passes compl.'], ['duels_won', 'Duels won'],
];

function observedBlock(o) {
  if (!o || !(o.totals?.lineups_named || o.totals?.goals || o.totals?.shots)) return '';
  const t = o.totals;
  const items = [['Appearances', t.appearances], ['Starts', t.starts], ['Goals', t.goals], ['Shots', t.shots], ['Located events', t.located_events]];
  const shots = validShots((o.shot_map || []).map(s => ({ ...s, team: 'home' })));
  return `${sectionHead('OBSERVED IN SOURCE DATA', 'Appearances, goals and shots')}
    <div class="obsgrid">${join(items, ([k, v]) => `<div><b>${num(v)}</b><span>${esc(k)}</span></div>`)}</div>
    ${when(o.by_competition?.length, () => `<div class="tablewrap"><table class="ltable"><thead><tr><th class="tm" scope="col">Competition</th><th scope="col">Season</th><th class="wide tm2" scope="col">Team</th><th scope="col">Apps</th><th scope="col">Starts</th><th scope="col">Goals</th><th scope="col">Shots</th></tr></thead>
      <tbody>${join(o.by_competition, r => `<tr><th class="tm" scope="row">${r.competition ? link(`/competitions/${r.competition.slug}`, `${compMono(r.competition.slug, 'xs')}<span>${esc(compMeta(r.competition.slug)?.name || r.competition.name)}</span>`) : DASH}</th><td>${esc(r.season || DASH)}</td><td class="wide tm2">${r.team ? teamLink(r.team) : DASH}</td><td>${num(r.appearances)}</td><td>${num(r.starts)}</td><td>${num(r.goals)}</td><td>${num(r.shots)}</td></tr>`)}</tbody></table></div>`)}
    ${when(shots.length, () => `${sectionHead('SHOT LOCATIONS', `${num(shots.length)} located shots`)}
      <div class="panel map"><div class="pitchwrap land">${pitchSvg(shots, { homeName: 'Team', awayName: '' })}</div><div class="pitchwrap port">${pitchSvg(shots, { homeName: 'Team', awayName: '', portrait: true })}</div>
      <p class="legend"><span><i class="lg goal"></i>Goal</span><span><i class="lg on"></i>On target</span><span><i class="lg off"></i>Off target / blocked</span></p>
      <p class="caveat">All shots drawn attacking the same goal, at their recorded event locations on the 105 × 68 m pitch. Event locations, not player tracking.</p></div>`)}
    ${when(o.recent?.length, () => `${sectionHead('RECENT MATCHES', 'In sourced lineups')}<ul class="plist">${join(o.recent, m => `<li>
      ${link(`/matches/${m.id}`, `<span class="pl-date">${esc(dateShort(m.kickoff_at))}</span><span class="pl-teams">${esc(m.home?.name || '')} <b>${esc(scoreline(m.score) || 'v')}</b> ${esc(m.away?.name || '')}</span><span class="pl-role">${m.started ? 'STARTED' : m.came_on ? 'CAME ON' : 'UNUSED'}${m.goals ? ` · ${m.goals} ${m.goals === 1 ? 'GOAL' : 'GOALS'}` : ''}${m.shots ? ` · ${m.shots} ${m.shots === 1 ? 'SHOT' : 'SHOTS'}` : ''}</span>`)}</li>`)}</ul>`)}`;
}

export const player = {
  title: d => `${d.env?.data?.name || 'Player'} Stats, Player DNA & Match Intelligence | PropBetEdge`,
  async load([slug]) { return { env: await api(`players/${slug}`) }; },
  render(d) {
    const p = d.env.data; const meta = d.env.meta;
    const facts = [
      ['Role', ROLE[p.role] || DASH], ['Nationality', p.nationality_code || DASH], ['Born', p.birth_date ? dateLong(`${String(p.birth_date).slice(0, 10)}T12:00:00Z`) : DASH],
      ['Preferred foot', FOOT[p.foot] || DASH], ['Height', p.height_cm ? `${p.height_cm} cm` : DASH],
    ];
    const seasons = p.seasons || [];
    // Columns only for counts the ledger actually carries for this player (never a column of dashes).
    const cols = STAT_COLS.filter(([k]) => seasons.some(x => x[k] !== null && x[k] !== undefined));
    const pic = portraitOf(p);
    const lt = p.observed?.latest_team;
    return `<section class="hero compact"><div class="wrap">
      <div class="lh-top">${portrait(p, 'xl', { alt: pic ? p.name : '' })}<div>
        <p class="kicker gold">PLAYER INTELLIGENCE</p>
        <h1 class="display">${esc(p.name)}</h1>
        ${when(p.first_name || p.last_name, () => `<p class="lede">${esc([p.first_name, p.last_name].filter(Boolean).join(' '))}</p>`)}
        ${when(lt, () => `<p class="latest-team">${link(`/teams/${lt.slug}`, `${teamMark(lt, 'xs')}<span>${esc(lt.name)}</span>`)}<span class="muted">latest sourced lineup, ${esc(dateShort(lt.as_of))}</span></p>`)}
      </div></div>
      ${when(pic?.attribution, () => `<p class="credit">Photo: ${pic.source_url ? `<a href="${esc(pic.source_url)}" rel="noopener" target="_blank">${esc(pic.attribution)}</a>` : esc(pic.attribution)}${pic.license_url ? ` · <a href="${esc(pic.license_url)}" rel="noopener license" target="_blank">licence</a>` : ''}</p>`)}
      <div class="facts">${join(facts, ([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`)}</div>
    </div></section>
    <section class="canvas"><div class="wrap">
      <div data-player-dna class="dna-slot" aria-live="polite"></div>
      ${observedBlock(p.observed)}
      <div data-related-news></div>
      ${sectionHead('SEASON HISTORY', 'Event-derived statistics')}
      ${seasons.length ? `<div class="tablewrap"><table class="ltable ptable"><thead><tr><th class="tm" scope="col">Season</th>${join(cols, ([, l]) => `<th scope="col">${esc(l)}</th>`)}</tr></thead>
        <tbody>${join(seasons, s => `<tr><th class="tm" scope="row">${esc(s.season)}</th>${join(cols, ([k]) => `<td>${num(s[k])}</td>`)}</tr>`)}</tbody></table></div>
        <p class="caveat">Counts come from the event ledger (PBE derived counts), only for seasons that have one. Minutes are nominal (90/120, cut at substitution or dismissal). A dash means the value is not recorded, not zero.</p>`
        : '<div class="state empty"><p class="state-title">No event-level season history</p><p>This player has no season in the graph with an event ledger. Their identity and appearances in sourced lineups or reported goals may still exist.</p></div>'}
      ${when(p.reported_goals_other_seasons, () => `<p class="note-line"><b>${num(p.reported_goals_other_seasons)}</b> goals reported by OpenLigaDB in seasons without an event ledger.</p>`)}
      <p class="muted small">Player DNA is descriptive: time-safe counts and rates from sourced data, not a forecast. Predictive models stay unpublished until they beat declared baselines out of sample.</p>
      ${sourcePanel(meta, { title: 'SOURCE & COVERAGE' })}
    </div></section>`;
  },
  mount(root, d) { mountPlayerDna(root, d.env.data.slug); mountRelatedNews(root, { player: d.env.data.slug }, { title: 'Stories mentioning this player' }); },
};
