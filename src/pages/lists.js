// Competitions index, Matches browser, Tables, News, Sources.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { empty, errorState, link, matchGrid, sectionHead, sourcePanel } from '../components/ui.js';
import { tableView } from '../components/table.js';
import { coverageCards, FEATURED } from './home.js';

// ---- /competitions
export const competitions = {
  title: () => 'Competitions · PropBetEdge Soccer',
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
  title: () => 'Matches · PropBetEdge Soccer',
  async load(_p, q) {
    const view = VIEWS[q.get('view')] ? q.get('view') : 'recent';
    const comp = FEATURED.includes(q.get('competition')) ? q.get('competition') : '';
    const today = todayUtc();
    const params = view === 'today' ? { date: today } : view === 'upcoming' ? { status: 'scheduled', from: today, order: 'asc' } : { status: 'finished', to: today };
    const [list, comps] = await Promise.allSettled([api('matches', { ...params, competition: comp || undefined, limit: 40 }), api('competitions')]);
    return { view, comp, list, comps };
  },
  render(d) {
    const comps = d.comps.status === 'fulfilled' ? d.comps.value.data.filter(c => FEATURED.includes(c.slug)) : [];
    const q = (view, comp) => `/matches?view=${view}${comp ? `&competition=${comp}` : ''}`;
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">MATCHES</p><h1 class="display">From result to event map</h1>
      <nav class="tabs" aria-label="Match views">${join(Object.entries(VIEWS), ([k, v]) => link(q(k, d.comp), esc(v), `tab${k === d.view ? ' on' : ''}`))}</nav>
      <nav class="tabs sub" aria-label="Competition filter">${link(q(d.view, ''), 'All', `tab${!d.comp ? ' on' : ''}`)}${join(comps, c => link(q(d.view, c.slug), esc(c.name), `tab${c.slug === d.comp ? ' on' : ''}`))}</nav>
      </div></section>
      <section class="canvas"><div class="wrap">
      ${d.list.status === 'rejected' ? errorState(d.list.reason) : matchGrid(d.list.value.data) || empty(`No ${VIEWS[d.view].toLowerCase()} matches`, d.view === 'today' ? 'Nothing is scheduled today in the covered competitions.' : 'The canonical graph has no matches for this view yet.')}
      ${d.list.status === 'fulfilled' ? sourcePanel(d.list.value.meta) : ''}</div></section>`;
  },
};

// ---- /tables
export const tables = {
  title: () => 'Tables · PropBetEdge Soccer',
  async load(_p, q) {
    const comp = FEATURED.includes(q.get('competition')) ? q.get('competition') : 'bundesliga';
    const [table, comps] = await Promise.allSettled([api('table', { competition: comp }), api('competitions')]);
    return { comp, table, comps };
  },
  render(d) {
    const comps = d.comps.status === 'fulfilled' ? d.comps.value.data.filter(c => FEATURED.includes(c.slug)) : [];
    const name = comps.find(c => c.slug === d.comp)?.name || d.comp;
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">TABLES</p><h1 class="display">${esc(name)}</h1>
      <nav class="tabs" aria-label="Competition">${join(comps, c => link(`/tables?competition=${c.slug}`, esc(c.name), `tab${c.slug === d.comp ? ' on' : ''}`))}</nav></div></section>
      <section class="canvas"><div class="wrap narrow">
      ${d.table.status === 'rejected' ? errorState(d.table.reason) : `${d.table.value.data?.season ? `<p class="kicker">SEASON ${esc(d.table.value.data.season)}</p>` : ''}${tableView(d.table.value)}${sourcePanel(d.table.value.meta, { title: 'HOW THIS TABLE IS COMPUTED', open: true })}`}
      </div></section>`;
  },
};

// ---- /news
export const news = {
  title: () => 'News · PropBetEdge Soccer',
  robots: 'noindex',
  async load() { return { env: await api('news') }; },
  render(d) {
    const items = d.env.data || [];
    if (!items.length) {
      return `<section class="newsroom"><div class="wrap narrow center">
        <p class="kicker gold">PROPBETEDGE SOCCER NEWSROOM</p>
        <h1 class="display">Evidence-backed soccer reporting is coming online.</h1>
        <p class="lede">Every story will be written from a frozen evidence packet drawn from the canonical graph, and checked by publication gates before it runs. Every number traces to a source. No invented quotes, injuries or odds.</p>
        <div class="nr-steps"><div><b>01</b><span>Canonical data</span></div><div><b>02</b><span>Frozen evidence packet</span></div><div><b>03</b><span>Original composition</span></div><div><b>04</b><span>Publication gates</span></div></div>
        <p>${link('/matches', 'Explore match intelligence', 'btn gold')}</p>
      </div></section>`;
    }
    return `<section class="canvas"><div class="wrap narrow">${sectionHead('NEWS', 'Latest')}<ul class="newslist">${join(items, a => `<li><a href="/news/${esc(a.slug)}" data-link><b>${esc(a.headline)}</b><span>${esc(a.dek || '')}</span></a></li>`)}</ul></div></section>`;
  },
};

// ---- /sources (static trust page: attributions and rules, no data claims)
export const sources = {
  title: () => 'Sources · PropBetEdge Soccer',
  async load() { return {}; },
  render() {
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">SOURCES</p><h1 class="display">Where every fact comes from</h1>
      <p class="lede">PropBetEdge Soccer is built on an owned canonical graph. Sources are captured, archived and normalized by PropBetEdge. The browser never calls a data provider.</p></div></section>
      <section class="canvas"><div class="wrap narrow prose">
        <h2>Sources in use</h2>
        <dl class="srclist">
          <div><dt>Wyscout public dataset</dt><dd>Event data with pitch locations for the 2017/18 Bundesliga. Pappalardo et al. (2019), CC BY 4.0.</dd></div>
          <div><dt>OpenLigaDB</dt><dd>Bundesliga fixtures, results and reported goals, 2004/05 to today. Open Database License (ODbL).</dd></div>
          <div><dt>ESPN (secondary)</dt><dd>Structured current-season facts: fixtures, results, lineups, team statistics and event locations for the Bundesliga, Premier League and Champions League. Secondary source: it never overrides a stronger source, and its provider xG is labelled as ESPN's.</dd></div>
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
