// Competitions index, Matches browser, Tables, News, Sources.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { competitionMark, empty, errorState, link, matchGrid, sectionHead, sourcePanel } from '../components/ui.js';
import { mountTableViews, tableView, tableViews } from '../components/table.js';
import { coverageCards } from './home.js';
import { FEATURED, FEATURED_COMPS, compMeta } from '../lib/competitions.js';

// ---- /competitions
export const competitions = {
  title: () => 'Competitions — Soccer Intelligence | PropBetEdge',
  async load() { const [comps, cov] = await Promise.allSettled([api('competitions'), api('coverage')]); return { comps, cov }; },
  render(d) {
    if (d.comps.status === 'rejected') return `<section class="canvas"><div class="wrap">${errorState(d.comps.reason)}</div></section>`;
    const all = d.comps.value.data;
    const covEnv = d.cov.status === 'fulfilled' ? d.cov.value : null;
    const others = all.filter(c => !FEATURED.includes(c.slug));
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">COMPETITIONS</p><h1 class="display">Competitions on the canonical graph</h1>
      <p class="lede">Each competition is certified through the same source, identity and canary gates before it appears here.</p></div></section>
      <section class="canvas"><div class="wrap">${coverageCards(d.comps.value, covEnv)}
      ${when(others.length, () => `${sectionHead('ALSO STORED', 'More competitions')}<ul class="plainlist">${join(others, c => `<li>${link(`/competitions/${c.slug}`, esc(c.name))} <span class="muted">${num(c.matches)} matches</span></li>`)}</ul>`)}
      ${sourcePanel(d.comps.value.meta)}</div></section>`;
  },
};

// ---- /matches
const VIEWS = { recent: 'Recent results', upcoming: 'Upcoming', today: 'Today' };
export const matches = {
  title: () => 'Matches — Results, Fixtures & Match Intelligence | PropBetEdge',
  async load(_p, q) {
    const view = VIEWS[q.get('view')] ? q.get('view') : 'recent';
    const comp = FEATURED.includes(q.get('competition')) ? q.get('competition') : '';
    const today = todayUtc();
    const params = view === 'today' ? { date: today } : view === 'upcoming' ? { status: 'scheduled', from: today, order: 'asc' } : { status: 'finished', to: today };
    const [list, comps] = await Promise.allSettled([api('matches', { ...params, competition: comp || undefined, limit: 40 }), api('competitions')]);
    return { view, comp, list, comps };
  },
  render(d) {
    const stored = d.comps.status === 'fulfilled' ? d.comps.value.data.map(c => c.slug) : [];
    const comps = FEATURED_COMPS.filter(c => stored.includes(c.slug));
    const q = (view, comp) => `/matches?view=${view}${comp ? `&competition=${comp}` : ''}`;
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">MATCHES</p><h1 class="display">From result to event map</h1>
      <nav class="tabs" aria-label="Match views">${join(Object.entries(VIEWS), ([k, v]) => link(q(k, d.comp), esc(v), `tab${k === d.view ? ' on' : ''}`))}</nav>
      <nav class="tabs sub" aria-label="Competition filter">${link(q(d.view, ''), 'All', `tab${!d.comp ? ' on' : ''}`)}${join(comps, c => link(q(d.view, c.slug), `${competitionMark(c.slug, 'xs')}${esc(c.name)}`, `tab${c.slug === d.comp ? ' on' : ''}`))}</nav>
      </div></section>
      <section class="canvas"><div class="wrap">
      ${d.list.status === 'rejected' ? errorState(d.list.reason) : matchGrid(d.list.value.data) || empty(`No ${VIEWS[d.view].toLowerCase()} matches`, d.view === 'today' ? 'Nothing is scheduled today in the covered competitions.' : 'The canonical graph has no matches for this view yet.')}
      ${d.list.status === 'fulfilled' ? sourcePanel(d.list.value.meta) : ''}</div></section>`;
  },
};

// ---- /tables
export const tables = {
  title: () => 'Tables — League Standings | PropBetEdge',
  async load(_p, q) {
    const comps = await Promise.allSettled([api('competitions')]).then(([r]) => r);
    const stored = comps.status === 'fulfilled' ? comps.value.data.map(c => c.slug) : FEATURED;
    // Default to the first product competition the graph actually holds.
    const comp = FEATURED.includes(q.get('competition')) ? q.get('competition') : FEATURED.find(s => stored.includes(s)) || FEATURED[0];
    const [table] = await Promise.allSettled([api('table', { competition: comp })]);
    const groups = table.status === 'fulfilled' ? (table.value.data.groups || []).filter(g => g.type === 'conference') : [];
    const confs = (await Promise.allSettled(groups.map(g => api('table', { competition: comp, group: g.key })))).map((r, i) => ({ key: groups[i].key, label: groups[i].name, env: r.status === 'fulfilled' ? r.value : null }));
    return { comp, table, comps, confs };
  },
  render(d) {
    const stored = d.comps.status === 'fulfilled' ? d.comps.value.data.map(c => c.slug) : [];
    const comps = FEATURED_COMPS.filter(c => stored.includes(c.slug));
    const name = compMeta(d.comp)?.long || d.comp;
    const t = d.table.status === 'fulfilled' ? d.table.value : null;
    const season = t?.data?.season ? `<p class="kicker">SEASON ${esc(t.data.season)}</p>` : '';
    const withConfs = (d.confs || []).some(c => c.env);
    const body = d.table.status === 'rejected' ? errorState(d.table.reason)
      : withConfs ? `${season}${tableViews([...d.confs, { key: 'overall', label: 'Overall', env: t }], d.confs[0].key)}${sourcePanel(d.confs.find(c => c.env).env.meta, { title: 'HOW CONFERENCE TABLES ARE VERIFIED', open: true })}`
        : `${season}${tableView(t)}${sourcePanel(t.meta, { title: 'HOW THIS TABLE IS COMPUTED', open: true })}`;
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">TABLES</p><h1 class="display">${esc(name)}</h1>
      <nav class="tabs" aria-label="Competition">${join(comps, c => link(`/tables?competition=${c.slug}`, `${competitionMark(c.slug, 'xs')}${esc(c.name)}`, `tab${c.slug === d.comp ? ' on' : ''}`))}</nav></div></section>
      <section class="canvas"><div class="wrap mid">${body}</div></section>`;
  },
  mount(root) { mountTableViews(root); },
};

// ---- /news lives in ./news.js (re-exported for existing imports)
export { news } from './news.js';

// ---- /sources (static trust page: attributions and rules, no data claims)
export const sources = {
  title: () => 'Sources & Method — Soccer Intelligence | PropBetEdge',
  async load() { return {}; },
  render() {
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">SOURCES</p><h1 class="display">Where every fact comes from</h1>
      <p class="lede">PropBetEdge Soccer is built on an owned canonical graph. Sources are captured, archived and normalized by PropBetEdge. The browser never calls a data provider.</p></div></section>
      <section class="canvas"><div class="wrap narrow prose">
        <h2>Sources in use</h2>
        <dl class="srclist">
          <div><dt>Wyscout public dataset</dt><dd>Event data with pitch locations for the 2017/18 Bundesliga. Pappalardo et al. (2019), CC BY 4.0.</dd></div>
          <div><dt>OpenLigaDB</dt><dd>Bundesliga fixtures, results and reported goals, 2004/05 to today. Open Database License (ODbL).</dd></div>
          <div><dt>ESPN (secondary)</dt><dd>Structured current-season facts: fixtures, results, lineups, team statistics and event locations for MLS, the Premier League, Champions League and Bundesliga. Secondary source: it never overrides a stronger source, and its provider xG is labelled as ESPN's.</dd></div>
        </dl>
        <h2>Rules the product follows</h2>
        <ul>
          <li>Every match, team and player has one PropBetEdge identity. Provider ids are cross-references, and nobody is merged by name alone.</li>
          <li>When sources disagree, both observations are kept.</li>
          <li>Event maps show where on-ball events happened on a 105 × 68 m pitch. They are not player tracking.</li>
          <li>Missing data is shown as missing, never as zero.</li>
          <li>Team statistics are labelled either PBE DERIVED COUNTS (computed by PropBetEdge from the event ledger) or SOURCE MATCH STATISTICS (supplied by a provider).</li>
          <li>Proprietary models such as xG, xT and Soccer DNA are not published until they are validated.</li>
        </ul>
      </div></section>`;
  },
};
