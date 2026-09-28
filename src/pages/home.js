import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateShort, num, todayUtc } from '../lib/format.js';
import { FEATURED, FEATURED_COMPS } from '../lib/competitions.js';
import { compMono, empty, errorState, link, matchGrid, sectionHead, sourcePanel } from '../components/ui.js';

export { FEATURED };
export const title = () => 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge';

export async function load() {
  const today = todayUtc();
  const [comps, cov, todays, recent, upcoming, news] = await Promise.allSettled([
    api('competitions'), api('coverage'),
    api('matches', { date: today, limit: 40 }),
    api('matches', { status: 'finished', to: today, limit: 12 }),
    api('matches', { status: 'scheduled', from: today, order: 'asc', limit: 12 }),
    api('news', { limit: 6 }),
  ]);
  return { comps, cov, todays, recent, upcoming, news, today };
}

const val = r => (r.status === 'fulfilled' ? r.value : null);

// The four product competitions as large tiles. Counts come from the API only.
export function coverageCards(compsEnv, covEnv) {
  const comps = compsEnv?.data || [];
  const cov = new Map((covEnv?.data?.competitions || []).map(c => [c.slug, c]));
  const cards = FEATURED_COMPS.map(f => ({ f, c: comps.find(c => c.slug === f.slug) })).filter(x => x.c);
  if (!cards.length) return empty('No competitions stored yet', 'Competition tiles appear as soon as the canonical graph holds matches.');
  return `<div class="compgrid">${join(cards, ({ f, c }) => {
    const k = cov.get(c.slug);
    return `<a class="comptile a-${f.accent}" href="/competitions/${esc(c.slug)}" data-link>
      <span class="ct-top">${compMono(c.slug, 'lg')}<span class="ct-season">${esc(c.latest_season || '—')}</span></span>
      <span class="ct-name">${esc(f.name)}</span>
      <span class="ct-stats">
        <span><b>${num(c.matches)}</b>matches</span>
        ${k ? `<span><b>${num(k.matches_with_lineups)}</b>with lineups</span><span><b>${num(k.coordinate_backed_matches)}</b>event-mapped</span>` : `<span><b>${num(c.seasons)}</b>${c.seasons === 1 ? 'season' : 'seasons'}</span>`}
      </span>
      <span class="ct-cta">OPEN LEAGUE HUB →</span>
    </a>`;
  })}</div>`;
}

export function dataDepth(covEnv) {
  const t = covEnv?.data?.totals;
  if (!t) return '';
  const items = [
    ['Canonical matches', t.canonical_matches], ['Finished matches', t.finished_matches],
    ['Match events', t.events], ['Events with a pitch location', t.events_with_coordinates],
    ['Coordinate-backed matches', t.coordinate_backed_matches], ['Matches with sourced lineups', t.matches_with_lineups],
  ];
  return `<section class="band dark depth">
    <div class="wrap">
      ${sectionHead('DATA DEPTH', 'Built on the PropBetEdge canonical soccer graph')}
      <div class="depthgrid">${join(items, ([k, v]) => `<div class="depth-item"><b>${num(v)}</b><span>${esc(k)}</span></div>`)}</div>
      ${sourcePanel(covEnv.meta, { title: 'HOW THESE ARE COUNTED' })}
    </div>
  </section>`;
}

export function newsCard(a) {
  const f = FEATURED_COMPS.find(c => c.desk === a.desk);
  return `<a class="ncard" href="/news/${esc(a.desk)}/${esc(a.slug)}" data-link>
    <span class="nc-top">${f ? compMono(f.slug, 'xs') : ''}<span>${esc(f?.name || a.desk)}</span><span class="nc-kind">${esc(String(a.story_class || '').replace(/_/g, ' ').toUpperCase())}</span></span>
    <b class="nc-head">${esc(a.headline)}</b>
    ${when(a.dek, () => `<span class="nc-dek">${esc(a.dek)}</span>`)}
    <span class="nc-date">${esc(dateShort(a.published_at))}</span>
  </a>`;
}

export function newsRail(env) {
  const items = env?.data || [];
  if (!items.length) return '';
  return `<section class="canvas"><div class="wrap">
    ${sectionHead('NEWSROOM', 'Latest from the desks', link('/news', 'All news →', 'sec-link'))}
    <div class="newsgrid">${join(items.slice(0, 6), newsCard)}</div>
  </div></section>`;
}

export function render(d) {
  const comps = val(d.comps); const cov = val(d.cov);
  const todays = val(d.todays); const recent = val(d.recent); const upcoming = val(d.upcoming);
  const todayList = (todays?.data || []).slice().sort((a, b) => (b.status === 'live') - (a.status === 'live'));
  const live = todayList.filter(m => m.status === 'live').length;
  return `
  <section class="hero home">
    <div class="wrap hero-grid">
      <div>
        <p class="kicker gold">PROPBETEDGE · SOCCER INTELLIGENCE</p>
        <h1 class="display">Soccer intelligence.<br><span>The match is only the start.</span></h1>
        <p class="lede">Live match intelligence, Player DNA, event maps, team profiles and original data-backed soccer news across MLS, Premier League, Champions League and Bundesliga.</p>
        <p class="hero-cta">${link('/matches', 'MATCHES', 'btn gold')} ${link('/tables', 'TABLES', 'btn ghost')} ${link('/news', 'NEWS', 'btn ghost')}</p>
      </div>
    </div>
  </section>
  <section class="canvas"><div class="wrap">
    ${sectionHead('LEAGUES', 'Four competitions, one graph')}
    ${d.comps.status === 'rejected' ? errorState(d.comps.reason) : coverageCards(comps, cov)}
  </div></section>
  <section class="canvas alt"><div class="wrap">
    ${sectionHead('TODAY', todayList.length ? (live ? `Live now · ${live}` : 'Matches today') : 'No matches today', `<p class="sec-note">UTC ${esc(d.today)}</p>`)}
    ${d.todays.status === 'rejected' ? errorState(d.todays.reason) : todayList.length ? matchGrid(todayList) : '<p class="muted">No canonical matches are scheduled today in the covered competitions.</p>'}
    ${sectionHead('RESULTS', 'Latest results', link('/matches', 'All matches →', 'sec-link'))}
    ${d.recent.status === 'rejected' ? errorState(d.recent.reason) : matchGrid(recent?.data) || empty('No finished matches yet')}
    ${when(upcoming?.data?.length, () => `${sectionHead('UPCOMING', 'Next fixtures', link('/matches?view=upcoming', 'All fixtures →', 'sec-link'))}${matchGrid(upcoming.data)}`)}
  </div></section>
  ${newsRail(val(d.news))}
  ${cov ? dataDepth(cov) : ''}
  <section class="canvas"><div class="wrap pillars">
    <div><p class="kicker">FOOTBALL INTELLIGENCE, REBUILT</p><p>Results, lineups and events from several sources resolve into one PropBetEdge identity for every match, team and player. When sources disagree, both observations are kept.</p></div>
    <div><p class="kicker">FROM RESULT TO EVENT MAP</p><p>Where a legitimate event ledger exists, every shot sits on one canonical 105 × 68 m pitch. These are event locations, never player tracking.</p></div>
    <div><p class="kicker">SOURCES YOU CAN SEE</p><p>Every page carries its source, freshness, coverage and meaning. Missing data is shown as missing, never as zero. ${link('/sources', 'How it works →')}</p></div>
  </div></section>`;
}
