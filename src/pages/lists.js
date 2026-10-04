// Competitions index, Matches browser, Tables, News, Sources.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { competitionMark, empty, errorState, link, matchGrid, sectionHead, sourcePanel } from '../components/ui.js';
import { groupTables, mountGroupTables, mountTableViews, tableView, tableViews } from '../components/table.js';
import { coverageCards } from './home.js';
import { FEATURED, FEATURED_COMPS, compMeta, resolveComp } from '../lib/competitions.js';
import { STATE_FILTERS, groupByState, liveByCompetition, uniqueMatches } from '../lib/match-order.js';
import { boardWithin } from '../data/kalshi.js';

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
// Live-first: whatever the view, every LIVE match is shown first under LIVE NOW (src/lib/match-order.js), then
// UPCOMING, then FINAL. All filter state lives in the URL (view, competition, state), so Back from Match
// Intelligence restores the same list.
const VIEWS = { recent: 'Recent results', upcoming: 'Upcoming', today: 'Today' };
const STATE_LABEL = { live: 'Live', upcoming: 'Upcoming', final: 'Final' };
export const matchesHref = (view, comp, state) => `/matches?view=${view}${comp ? `&competition=${comp}` : ''}${state ? `&state=${state}` : ''}`;
export const matches = {
  title: () => 'Matches — Results, Fixtures & Match Intelligence | PropBetEdge',
  async load(_p, q) {
    const view = VIEWS[q.get('view')] ? q.get('view') : 'recent';
    const asked = resolveComp(q.get('competition'))?.slug;
    const comp = FEATURED.includes(asked) ? asked : '';
    const state = view === 'today' && STATE_FILTERS.includes(q.get('state')) ? q.get('state') : '';
    const today = todayUtc();
    const params = view === 'today' ? { date: today } : view === 'upcoming' ? { status: 'scheduled', from: today, order: 'asc' } : { status: 'finished', to: today };
    // Every live match in the covered competitions rides beside the view: it leads every view, feeds the live
    // counts on the competition filter and the "live elsewhere" link. Bounded; a failure only drops that layer.
    // The market board (live lines for not-finished matches, the market close line on recent results) loads beside
    // the fixtures; bounded, never fails the page.
    const [list, comps, live] = await Promise.allSettled([api('matches', { ...params, competition: comp || undefined, season: q.get('season'), team: q.get('team'), limit: view === 'today' ? 100 : 40 }), api('competitions'), api('matches', { status: 'live', limit: 100 }), boardWithin()]);
    // A team-scoped list (?team=) stays scoped: other teams' live matches are not merged into it.
    return { view, comp, state, team: q.get('team') || '', list, comps, live };
  },
  render(d) {
    const stored = d.comps.status === 'fulfilled' ? d.comps.value.data.map(c => c.slug) : [];
    const liveAll = d.live?.status === 'fulfilled' && !d.team ? d.live.value.data || [] : [];
    const liveBy = liveByCompetition(liveAll);
    // Live competitions first (most live matches first), then the product rail order. Nothing newly added is hidden.
    const rail = FEATURED_COMPS.filter(c => stored.includes(c.slug) || liveBy[c.slug]);
    const comps = [...rail].sort((a, b) => (liveBy[b.slug] || 0) - (liveBy[a.slug] || 0) || rail.indexOf(a) - rail.indexOf(b));
    const tabs = `<nav class="tabs" aria-label="Match views">${join(Object.entries(VIEWS), ([k, v]) => link(matchesHref(k, d.comp), esc(v), `tab${k === d.view ? ' on' : ''}`))}</nav>`;
    const compBar = `<nav class="tabs sub cfilter" aria-label="Competition filter">${link(matchesHref(d.view, '', d.state), 'All', `tab${!d.comp ? ' on' : ''}`)}${join(comps, c => link(matchesHref(d.view, c.slug, d.state), `${competitionMark(c.slug, 'xs', { tone: c.slug === d.comp ? 'light' : 'dark' })}<span>${esc(c.name)}</span>${liveBy[c.slug] ? `<span class="cf-live" title="${liveBy[c.slug]} live"><i class="livedot" aria-hidden="true"></i>${liveBy[c.slug]}<span class="sr-only"> live</span></span>` : ''}`, `tab${c.slug === d.comp ? ' on' : ''}`))}</nav>`;
    const hero = body => `<section class="hero compact"><div class="wrap"><p class="kicker gold">MATCHES</p><h1 class="display">From result to event map</h1>${tabs}${compBar}</div></section>
      <section class="canvas"><div class="wrap">${body}</div></section>`;
    if (d.list.status === 'rejected') return hero(errorState(d.list.reason));
    const inComp = m => !d.comp || resolveComp(m.competition)?.slug === d.comp;
    const groups = groupByState(uniqueMatches(liveAll.filter(inComp), d.list.value.data || []));
    const counts = Object.fromEntries(groups.map(g => [g.key, g.matches.length]));
    const shown = d.state ? groups.filter(g => g.key === d.state) : groups;
    const stateBar = d.view === 'today' && groups.length > 1
      ? `<nav class="statebar" aria-label="Match state">${link(matchesHref(d.view, d.comp), `All <b>${groups.reduce((n, g) => n + g.matches.length, 0)}</b>`, `sb${!d.state ? ' on' : ''}`)}${join(STATE_FILTERS.filter(k => counts[k]), k => link(matchesHref(d.view, d.comp, k), `${k === 'live' ? '<i class="livedot" aria-hidden="true"></i>' : ''}${STATE_LABEL[k]} <b>${counts[k]}</b>`, `sb sb-${k}${d.state === k ? ' on' : ''}`))}</nav>` : '';
    const elsewhere = d.comp ? liveAll.filter(m => !inComp(m)).length : 0;
    const elsewhereLink = elsewhere ? `<p class="live-elsewhere">${link(matchesHref(d.view, '', d.state), `<i class="livedot" aria-hidden="true"></i>${elsewhere} more live in other competitions <span aria-hidden="true">→</span>`)}</p>` : '';
    // Headings only where they tell the reader something: LIVE NOW always, the others when groups are mixed.
    const section = g => `<section class="mgroup mg-${g.key}" data-mgroup="${g.key}" aria-label="${esc(g.label)}">${g.key === 'live' || shown.length > 1 ? `<h2 class="mg-head">${g.key === 'live' ? '<i class="livedot" aria-hidden="true"></i>' : ''}${esc(g.label)} <span class="mg-n">· ${g.matches.length}</span></h2>` : ''}${matchGrid(g.matches)}</section>`;
    const list = shown.length ? join(shown, section)
      : empty(`No ${d.state ? STATE_LABEL[d.state].toLowerCase() : VIEWS[d.view].toLowerCase()} matches`, d.view === 'today' ? 'Nothing is scheduled today in the covered competitions.' : 'The canonical graph has no matches for this view yet.');
    return hero(`${stateBar}${elsewhereLink}${list}${sourcePanel(d.list.value.meta)}`);
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
    const [table] = await Promise.allSettled([api('table', { competition: comp, ...(compMeta(comp)?.format === 'groups' ? { expand: 'groups' } : {}) })]);
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
      : t?.data?.view === 'groups' ? `${season}${groupTables(t)}${sourcePanel(t.meta, { title: 'HOW GROUP TABLES ARE VERIFIED', open: true })}`
      : withConfs ? `${season}${tableViews([...d.confs, { key: 'overall', label: 'Overall', env: t }], d.confs[0].key)}${sourcePanel(d.confs.find(c => c.env).env.meta, { title: 'HOW CONFERENCE TABLES ARE VERIFIED', open: true })}`
        : `${season}${tableView(t)}${sourcePanel(t.meta, { title: 'HOW THIS TABLE IS COMPUTED', open: true })}`;
    return `<section class="hero compact"><div class="wrap"><p class="kicker gold">TABLES</p><h1 class="display">${esc(name)}</h1>
      <nav class="tabs" aria-label="Competition">${join(comps, c => link(`/tables?competition=${c.slug}`, `${competitionMark(c.slug, 'xs')}${esc(c.name)}`, `tab${c.slug === d.comp ? ' on' : ''}`))}</nav></div></section>
      <section class="canvas"><div class="wrap mid">${body}</div></section>`;
  },
  mount(root) { mountTableViews(root); mountGroupTables(root); },
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
          <div><dt>ESPN (secondary)</dt><dd>Structured current-season facts: fixtures, results, lineups, team statistics and event locations for MLS, the Premier League, Champions League and Bundesliga. Secondary source: it never overrides a stronger source, and its provider xG is labelled as supplied xG, never PBE xG.</dd></div>
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
        <h2 id="kalshi">Kalshi prediction-market prices</h2>
        <p>Live prediction-market pricing is built into PropBetEdge match pages and PBEcast. Match pages, PBEcast, the score ticker and fixture cards carry prices from Kalshi, a prediction market. They appear as <b>Market Pulse</b>: live prediction-market pricing, with no sportsbook line required. They are traded contract prices: not sportsbook odds and not a PropBetEdge model or prediction.</p>
        <ul>
          <li>A market is shown only when it is matched exactly to that match, is fresh and is trading. Otherwise nothing is shown.</li>
          <li>Every price links to that market on Kalshi.</li>
          <li>Mid-market is the midpoint of the best YES bid and the best YES ask, shown only when the spread is 10¢ or less. It is not a probability. Bid, ask and last trade are labelled separately.</li>
          <li>Movement is drawn only from prices we observed and stored; nothing is interpolated.</li>
          <li>Kalshi soccer match contracts settle on the result after 90 minutes plus stoppage time, with no extra time or penalties.</li>
          <li>When the market closes, the match page and PBEcast keep it as <b>How the market closed</b>: the first price we observed (our first record, not an opening price), the last price we observed before kick-off, Kalshi's final trade and Kalshi's settlement. A finished match is not a settled market: until Kalshi settles it the page says “awaiting settlement”. Settlement is Kalshi's, not our result.</li>
          <li>Your browser reads these prices from PropBetEdge, never from Kalshi directly.</li>
        </ul>
      </div></section>`;
  },
};
