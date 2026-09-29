// HOMEPAGE: hero (PBECAST primary) · [score ticker lives in the shell] · featured intelligence ·
// news desk (lead + latest) · leagues · Player DNA discovery · data depth.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { ago, num } from '../lib/format.js';
import { FEATURED, FEATURED_COMPS, compByDesk, compMeta } from '../lib/competitions.js';
import { latestNews, selectHomepageLead, storyLabel } from '../lib/news.js';
import { liveView } from '../lib/cast.js';
import { competitionMark, empty, errorState, link, pctPill, portrait, sectionHead, sourcePanel, statusPill, teamMark } from '../components/ui.js';
import { keyPlayerRows, todayLine } from '../components/keyplayers.js';

export { FEATURED };
export const title = () => 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge';

const settle = p => p.then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));

// Featured match: a live match first; else the most material recent finished match that has an
// event map (a real PBEcast replay), by total goals then recency. Deterministic.
export function pickFeatured(x) {
  if (!x) return null;
  if (x.live?.length) return { m: x.live[0], kind: 'live' };
  const mapped = (x.recent || []).filter(m => m.intel?.event_map && m.score);
  if (!mapped.length) return null;
  const goals = m => (m.score.home || 0) + (m.score.away || 0);
  return { m: [...mapped].sort((a, b) => goals(b) - goals(a) || Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at))[0], kind: 'replay' };
}

export async function load() {
  const [comps, cov, news, live, leadersA, leadersB] = await Promise.all([
    settle(api('competitions')), settle(api('coverage')), settle(api('news', { limit: 30 })), settle(api('live', {}, { fresh: true })),
    settle(api('players', { competition: 'premier-league', sort: 'goal_contributions_per90', limit: 4 })),
    settle(api('players', { competition: 'mls', sort: 'goal_contributions_per90', limit: 4 })),
  ]);
  const feat = pickFeatured(live.status === 'fulfilled' ? live.value.data : null);
  const detail = feat ? await settle(api(`matches/${feat.m.id}`)) : null;
  return { comps, cov, news, live, leadersA, leadersB, feat, detail };
}

const val = r => (r?.status === 'fulfilled' ? r.value : null);

// ---- news desk ------------------------------------------------------------
// Image priority: approved editorial image (none published yet) -> approved portrait -> approved
// crest -> the owned branded Soccer fallback (stadium art + competition monogram). Never junk art.
export function newsMedia(a, size = 'card') {
  const f = compByDesk(a.desk);
  const bg = `<img class="nm-bg" src="/brand/soccer-stadium-1600.webp" alt="" loading="lazy" decoding="async" width="1600" height="900">`;
  if (a.image?.url && a.image.kind === 'portrait') return `<span class="nmedia k-portrait s-${size}">${bg}${portrait({ portrait: a.image }, size === 'lead' ? 'xl' : 'lg')}</span>`;
  if (a.image?.url && a.image.kind === 'crest') return `<span class="nmedia k-crest s-${size}">${bg}${teamMark({ name: a.image.alt, crest: a.image }, 'xl')}</span>`;
  return `<span class="nmedia k-brand s-${size} a-${esc(f?.accent || 'x')}">${bg}${f ? competitionMark(f.slug, size === 'lead' ? 'xl' : 'lg', { tone: 'dark' }) : ''}</span>`;
}

export function newsLead(a) {
  const f = compByDesk(a.desk);
  return `<a class="nlead" href="/news/${esc(a.desk)}/${esc(a.slug)}" data-link>
    ${newsMedia(a, 'lead')}
    <span class="nl-body">
      <span class="nl-kicker">${f ? competitionMark(f.slug, 'xs') : ''}<span>${esc(f?.name || a.desk)}</span><span class="nl-cat">${esc(storyLabel(a.story_class).toUpperCase())}</span></span>
      <b class="nl-head">${esc(a.headline)}</b>
      ${when(a.dek, () => `<span class="nl-dek">${esc(a.dek)}</span>`)}
      <span class="nl-foot"><span class="nl-age">${esc(ago(a.published_at))}</span><span class="nl-cta">READ THE STORY →</span></span>
    </span>
  </a>`;
}

export function newsCard(a) {
  const f = compByDesk(a.desk);
  return `<a class="ncard2" href="/news/${esc(a.desk)}/${esc(a.slug)}" data-link>
    ${newsMedia(a, 'thumb')}
    <span class="nc2-body"><span class="nc2-top">${f ? competitionMark(f.slug, 'xs') : ''}<span>${esc(storyLabel(a.story_class))}</span></span>
      <b class="nc2-head">${esc(a.headline)}</b><span class="nc2-age">${esc(ago(a.published_at))}</span></span>
  </a>`;
}

export function newsDesk(env, { rail = 5 } = {}) {
  const items = env?.data || [];
  if (!items.length) return '';
  const lead = selectHomepageLead(items);
  const latest = latestNews(items, lead).slice(0, rail);
  return `<div class="ndesk">${newsLead(lead)}<div class="nrail"><p class="nrail-h">LATEST</p>${join(latest, newsCard)}${link('/news', 'ALL NEWS →', 'nrail-all')}</div></div>`;
}

// ---- featured intelligence ---------------------------------------------------
export function featured(d) {
  if (!d.feat) return '';
  const m = val(d.detail)?.data || d.feat.m;
  const lv = d.feat.kind === 'live' ? liveView(d.feat.m) : { score: m.score, clock: null };
  const kp = keyPlayerRows(m, 3);
  const facts = todayLine;
  return `<section class="canvas feat-dark"><div class="wrap">
    ${sectionHead('FEATURED INTELLIGENCE', d.feat.kind === 'live' ? 'Live now on PBEcast' : 'The match to replay')}
    <div class="featm">
      <a class="fm-board" href="/pbecast/${esc(m.id)}" data-link>
        <span class="fm-top">${m.competition ? competitionMark(m.competition.slug, 'xs', { tone: 'dark' }) : ''}<span>${esc(compMeta(m.competition?.slug)?.name || m.competition?.name || '')}</span>${d.feat.kind === 'live' ? statusPill('live') : '<span class="fm-tag">PBECAST REPLAY</span>'}</span>
        <span class="fm-teams">
          <span class="fm-t">${teamMark(m.home, 'xl')}<b>${esc(m.home?.short_name || m.home?.name || '')}</b></span>
          <span class="fm-sc">${lv.score ? `${esc(String(lv.score.home))}<i>–</i>${esc(String(lv.score.away))}` : 'v'}</span>
          <span class="fm-t">${teamMark(m.away, 'xl')}<b>${esc(m.away?.short_name || m.away?.name || '')}</b></span>
        </span>
        <span class="fm-cta">${d.feat.kind === 'live' ? 'WATCH THE LIVE PBECAST →' : '▶ REPLAY EVERY SHOT, GOAL AND CARD →'}</span>
      </a>
      ${kp.length ? `<div class="fm-keys"><p class="nrail-h">KEY PLAYERS</p>${join(kp, r => `<a class="fm-key" href="/players/${esc(r.player.slug)}" data-link data-player-slug="${esc(r.player.slug)}" data-match-id="${esc(m.id)}">${portrait(r.player, 'md')}<span><b>${esc(r.player.name)}</b><small>${esc(facts(r))}</small></span></a>`)}</div>` : ''}
    </div>
  </div></section>`;
}

// ---- Player DNA discovery ---------------------------------------------------
function leaderBlock(env, slug) {
  const x = env?.data; if (!x?.players?.length) return '';
  const f = compMeta(slug);
  return `<div class="dnadisc"><p class="nrail-h">${competitionMark(slug, 'xs')} ${esc(f?.name || slug)} · goals + assists per 90</p>
    ${join(x.players, (p, i) => `<a class="dd-row pcard-lite" href="/players/${esc(p.slug)}" data-link data-player-slug="${esc(p.slug)}"><span class="dd-rank">${i + 1}</span>${portrait(p, 'md')}<span class="dd-id"><b>${esc(p.name)}</b><small>${p.team ? `${teamMark(p.team, 'xs')} ${esc(p.team.short_name || p.team.name)}` : ''}</small></span><span class="dd-val"><b>${num(p.value, { dp: 2 })}</b>${pctPill(p.percentile, num(p.compared_with))}</span></a>`)}
    ${link(`/players?competition=${slug}&sort=goal_contributions_per90`, 'ALL LEADERS →', 'nrail-all')}</div>`;
}

export function coverageCards(compsEnv, covEnv) {
  const comps = compsEnv?.data || [];
  const cov = new Map((covEnv?.data?.competitions || []).map(c => [c.slug, c]));
  const cards = FEATURED_COMPS.map(f => ({ f, c: comps.find(c => c.slug === f.slug) })).filter(x => x.c);
  if (!cards.length) return empty('No competitions stored yet', 'Competition tiles appear as soon as the canonical graph holds matches.');
  return `<div class="compgrid">${join(cards, ({ f, c }) => {
    const k = cov.get(c.slug);
    return `<a class="comptile a-${f.accent}" href="/competitions/${esc(c.slug)}" data-link>
      <span class="ct-top">${competitionMark(c.slug, 'lg', { tone: 'dark' })}<span class="ct-season">${esc(c.latest_season || '—')}</span></span>
      <span class="ct-name">${esc(f.name)}</span>
      <span class="ct-stats">
        <span><b>${num(c.matches)}</b>matches</span>
        ${k ? `<span><b>${num(k.matches_with_lineups)}</b>with lineups</span><span><b>${num(k.coordinate_backed_matches)}</b>event-mapped</span>` : `<span><b>${num(c.seasons)}</b>${c.seasons === 1 ? 'season' : 'seasons'}</span>`}
      </span>
      <span class="ct-cta">${f.format === 'groups' ? 'OPEN COMPETITION HUB' : 'OPEN LEAGUE HUB'} →</span>
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
  const comps = val(d.comps); const cov = val(d.cov); const news = val(d.news);
  const disc = [leaderBlock(val(d.leadersA), 'premier-league'), leaderBlock(val(d.leadersB), 'mls')].filter(Boolean);
  return `
  <section class="hero home">
    <div class="wrap hero-grid">
      <div>
        <p class="kicker gold">PROPBETEDGE · SOCCER INTELLIGENCE</p>
        <h1 class="display">Soccer intelligence.<br><span>The match is only the start.</span></h1>
        <p class="lede">Live match intelligence, Player DNA, event maps, team profiles and original data-backed soccer news across MLS, Premier League, Champions League and Bundesliga.</p>
        <p class="hero-cta"><span class="cta-primary">${link('/pbecast', '▶ PBECAST', 'btn gold btn-hero')}</span><span class="cta-secondary">${link('/matches', 'MATCHES', 'btn ghost')}${link('/players', 'PLAYER DNA', 'btn ghost')}${link('/news', 'NEWS', 'btn ghost')}</span></p>
      </div>
    </div>
  </section>
  ${featured(d)}
  ${news?.data?.length ? `<section class="canvas"><div class="wrap">${sectionHead('NEWSROOM', 'Top story and the latest from the desks', link('/news', 'All news →', 'sec-link'))}${newsDesk(news)}</div></section>` : ''}
  <section class="canvas alt"><div class="wrap">
    ${sectionHead('LEAGUES', 'Four competitions, one graph')}
    ${d.comps.status === 'rejected' ? errorState(d.comps.reason) : coverageCards(comps, cov)}
  </div></section>
  ${disc.length ? `<section class="canvas"><div class="wrap">${sectionHead('PLAYER DNA', 'Rate leaders inside each competition', link('/players', 'Player directory →', 'sec-link'))}<div class="dnadisc-grid">${disc.join('')}</div><p class="caveat">Leaders among players with at least 450 nominal minutes in that competition-season; the percentile ranks against that group. There is no cross-competition ranking.</p></div></section>` : ''}
  ${cov ? dataDepth(cov) : ''}`;
}
