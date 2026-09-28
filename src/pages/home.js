import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateShort, num, time, todayUtc } from '../lib/format.js';
import { liveView } from '../lib/cast.js';
import { FEATURED, FEATURED_COMPS } from '../lib/competitions.js';
import { compMono, empty, errorState, link, matchGrid, portrait, sectionHead, sourcePanel, teamMark } from '../components/ui.js';

export { FEATURED };
export const title = () => 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge';

export async function load() {
  const today = todayUtc();
  const [comps, cov, todays, recent, upcoming, news, live] = await Promise.allSettled([
    api('competitions'), api('coverage'),
    api('matches', { date: today, limit: 40 }),
    api('matches', { status: 'finished', to: today, limit: 12 }),
    api('matches', { status: 'scheduled', from: today, order: 'asc', limit: 12 }),
    api('news', { limit: 6 }),
    api('live', {}, { fresh: true }),
  ]);
  return { comps, cov, todays, recent, upcoming, news, live, today };
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
  // Card image: the approved portrait / crest the API picked for the story, else no image.
  const img = a.image?.url ? (a.image.kind === 'portrait' ? portrait({ portrait: a.image }, 'lg') : teamMark({ name: a.image.alt, crest: a.image }, 'md')) : '';
  return `<a class="ncard${img ? ' has-img' : ''}" href="/news/${esc(a.desk)}/${esc(a.slug)}" data-link>
    ${img ? `<span class="nc-img">${img}</span>` : ''}
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

// LIVE RAIL (PBEcast): live first (provider clock), then the next kick-offs, then replays.
// Every tile opens its PBEcast. Empty when the API has nothing to show.
const RAIL_MAX = 16;
export function railItems(x) {
  if (!x) return [];
  const now = Date.now();
  const soon = (x.upcoming || []).filter(m => Date.parse(m.kickoff_at) - now < 36 * 3600e3);
  return [...(x.live || []).map(m => ({ m, k: 'live' })), ...soon.slice(0, 6).map(m => ({ m, k: 'next' })), ...(x.recent || []).map(m => ({ m, k: 'ft' }))].slice(0, RAIL_MAX);
}
export function liveRail(env) {
  const items = railItems(env?.data);
  if (!items.length) return '';
  const live = items.filter(i => i.k === 'live').length;
  const tile = ({ m, k }) => {
    const lv = k === 'live' ? liveView(m) : { score: m.score, clock: null };
    const sc = lv.score && lv.score.home !== null && lv.score.home !== undefined;
    const row = (t, s) => `<span class="lr-row">${teamMark(t, 'xs')}<span class="lr-name">${esc(t?.short_name || t?.name || '—')}</span>${sc ? `<b>${esc(String(s))}</b>` : ''}</span>`;
    const tag = k === 'live' ? `<span class="lr-live"><i class="livedot" aria-hidden="true"></i>${esc(lv.clock || 'LIVE')}</span>` : k === 'next' ? `<span class="lr-when">${esc(dateShort(m.kickoff_at))} · ${esc(time(m.kickoff_at))}</span>` : `<span class="lr-when">FT · ${esc(dateShort(m.kickoff_at))}</span>`;
    return `<li><a class="lr-tile k-${k}" href="/pbecast/${esc(m.id)}" data-link aria-label="${esc(`${m.home?.name} ${sc ? `${lv.score.home}–${lv.score.away}` : 'v'} ${m.away?.name}, ${k === 'live' ? 'live' : k === 'next' ? 'upcoming' : 'full time'}, open PBEcast`)}">
      <span class="lr-top">${m.competition ? compMono(m.competition.slug, 'xs') : ''}${tag}</span>${row(m.home, lv.score?.home)}${row(m.away, lv.score?.away)}</a></li>`;
  };
  return `<section class="lrail" aria-label="PBEcast live rail" data-live-rail><div class="wrap">
    <div class="lr-head"><p class="kicker gold">${live ? `<i class="livedot" aria-hidden="true"></i> LIVE NOW · ${num(live)}` : 'PBECAST'}</p>${link('/pbecast', 'All casts →', 'lr-all')}</div>
    <ol class="lr-list">${join(items, tile)}</ol>
  </div></section>`;
}

export function mount(root, d) {
  // Only the rail refreshes, and only while something is live (hidden tabs skip a beat).
  const tick = () => setTimeout(async () => {
    const slot = root.querySelector('[data-live-rail]');
    if (!slot || !slot.isConnected || location.pathname !== '/') return;
    if (document.hidden) return tick();
    try { const env = await api('live', {}, { fresh: true }); const html = liveRail(env); if (html) slot.outerHTML = html; if (env.data.live?.length) tick(); } catch { tick(); }
  }, 30000);
  if (d.live?.status === 'fulfilled' && d.live.value.data.live?.length) tick();
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
        <p class="hero-cta">${link('/matches', 'MATCHES', 'btn gold')} ${link('/pbecast', 'PBECAST', 'btn ghost')} ${link('/players', 'PLAYER DNA', 'btn ghost')} ${link('/news', 'NEWS', 'btn ghost')}</p>
      </div>
    </div>
  </section>
  ${liveRail(val(d.live))}
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
