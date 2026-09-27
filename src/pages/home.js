import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { num, todayUtc } from '../lib/format.js';
import { empty, errorState, link, matchGrid, sectionHead, sourcePanel } from '../components/ui.js';

export const FEATURED = ['bundesliga', 'premier-league', 'uefa-champions-league'];
export const title = () => 'PropBetEdge Soccer Intelligence';

export async function load() {
  const today = todayUtc();
  const [comps, cov, todays, recent, upcoming] = await Promise.allSettled([
    api('competitions'), api('coverage'),
    api('matches', { date: today, limit: 40 }),
    api('matches', { status: 'finished', to: today, limit: 12 }),
    api('matches', { status: 'scheduled', from: today, order: 'asc', limit: 8 }),
  ]);
  return { comps, cov, todays, recent, upcoming, today };
}

const val = r => (r.status === 'fulfilled' ? r.value : null);

export function coverageCards(compsEnv, covEnv) {
  const comps = compsEnv?.data || [];
  const cov = new Map((covEnv?.data?.competitions || []).map(c => [c.slug, c]));
  const cards = FEATURED.map(slug => comps.find(c => c.slug === slug)).filter(Boolean);
  if (!cards.length) return empty('No competitions stored yet', 'Coverage cards appear as soon as the canonical graph holds matches.');
  return `<div class="covgrid">${join(cards, c => {
    const k = cov.get(c.slug);
    return `<a class="covcard" href="/competitions/${esc(c.slug)}" data-link>
      <span class="cc-kicker">${esc(c.type === 'league' ? 'LEAGUE' : 'COMPETITION')}</span>
      <span class="cc-name">${esc(c.name)}</span>
      <span class="cc-season">Season ${esc(c.latest_season || '—')}</span>
      <span class="cc-stats">
        <span><b>${num(c.matches)}</b> canonical matches</span>
        <span><b>${num(c.seasons)}</b> ${c.seasons === 1 ? 'season' : 'seasons'}</span>
        ${when(k, () => `<span><b>${num(k.coordinate_backed_matches)}</b> event-mapped</span>`)}
      </span>
      <span class="cc-cta">OPEN COMPETITION →</span>
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

export function render(d) {
  const comps = val(d.comps); const cov = val(d.cov);
  const todays = val(d.todays); const recent = val(d.recent); const upcoming = val(d.upcoming);
  const todayList = todays?.data || [];
  return `
  <section class="hero">
    <div class="wrap hero-grid">
      <div>
        <p class="kicker gold">SOCCER INTELLIGENCE</p>
        <h1 class="display">Every match. Every event.<br><span>One canonical field.</span></h1>
        <p class="lede">PropBetEdge turns match results, lineups, spatial events and source evidence into one soccer intelligence layer.</p>
        <p class="hero-cta">${link('/matches', 'MATCH INTELLIGENCE', 'btn gold')} ${link('/tables', 'TABLES', 'btn ghost')}</p>
      </div>
      <div class="hero-pitch" aria-hidden="true"><div class="hp-field"><span class="hp-half"></span><span class="hp-circle"></span><span class="hp-box l"></span><span class="hp-box r"></span></div>
        <p class="hp-caption">Every event has a place on the pitch.</p></div>
    </div>
  </section>
  <section class="canvas"><div class="wrap">
    ${sectionHead('COVERAGE', 'Competitions on the graph')}
    ${d.comps.status === 'rejected' ? errorState(d.comps.reason) : coverageCards(comps, cov)}
  </div></section>
  <section class="canvas alt"><div class="wrap">
    ${sectionHead('TODAY', todayList.length ? 'Matches today' : 'No matches today', `<p class="sec-note">UTC ${esc(d.today)}</p>`)}
    ${d.todays.status === 'rejected' ? errorState(d.todays.reason) : todayList.length ? matchGrid(todayList) : '<p class="muted">No canonical matches are scheduled today in the covered competitions.</p>'}
    ${sectionHead('RECENT', 'Latest results', link('/matches', 'All matches →', 'sec-link'))}
    ${d.recent.status === 'rejected' ? errorState(d.recent.reason) : matchGrid(recent?.data) || empty('No finished matches yet')}
    ${when(upcoming?.data?.length, () => `${sectionHead('NEXT', 'Upcoming')}${matchGrid(upcoming.data)}`)}
  </div></section>
  ${cov ? dataDepth(cov) : ''}
  <section class="canvas"><div class="wrap pillars">
    <div><p class="kicker">FOOTBALL INTELLIGENCE, REBUILT</p><p>Results, lineups and events from several sources resolve into one PropBetEdge identity for every match, team and player. When sources disagree, both observations are kept.</p></div>
    <div><p class="kicker">FROM RESULT TO EVENT MAP</p><p>Where a legitimate event ledger exists, every shot sits on one canonical 105 × 68 m pitch. These are event locations, never player tracking.</p></div>
    <div><p class="kicker">SOURCES YOU CAN SEE</p><p>Every page carries its source, freshness, coverage and meaning. Missing data is shown as missing, never as zero. ${link('/sources', 'How it works →')}</p></div>
  </div></section>`;
}
