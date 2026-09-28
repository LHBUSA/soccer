// NEWSROOM: /news, /news/:desk, /news/:desk/:slug. Only published, gate-passed
// articles exist here; each one names its frozen evidence packet.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateLong, dateTime } from '../lib/format.js';
import { FEATURED_COMPS, compByDesk } from '../lib/competitions.js';
import { competitionMark, link, mountMediaFallbacks, sourcePanel } from '../components/ui.js';
import { newsCard, mountNewsImages } from '../components/newscard.js';
import { officialVideo, mountOfficialVideos } from '../components/video.js';
import { latestNews, selectHomepageLead } from '../lib/news.js';
import { renderArticle, mountArticle } from './article.js';

const INDEX = 'index, follow, max-image-preview:large';
const tab = (href, inner, on) => `<a href="${esc(href)}" data-link class="nr2-tab${on ? ' on' : ''}"${on ? ' aria-current="page"' : ''}>${inner}</a>`;
const deskTabs = active => `<nav class="nr2-tabs" aria-label="News desks">${tab('/news', '<span>All news</span>', !active)}${join(FEATURED_COMPS, c => tab(`/news/${c.desk}`, `${competitionMark(c.slug, 'xs', { tone: 'dark' })}<span>${esc(c.name)}</span>`, c.desk === active))}</nav>`;

const emptyRoom = desk => `<section class="newsroom"><div class="wrap narrow center">
  <p class="kicker gold">PROPBETEDGE SOCCER NEWSROOM${desk ? ` · ${esc(compByDesk(desk)?.name.toUpperCase() || '')}` : ''}</p>
  <h1 class="display">Evidence-backed soccer reporting is coming online.</h1>
  <p class="lede">Every story is written from a frozen evidence packet drawn from the canonical graph, and checked by publication gates before it runs. Every number traces to a source. No invented quotes, injuries or odds.</p>
  <div class="nr-steps"><div><b>01</b><span>Canonical data</span></div><div><b>02</b><span>Frozen evidence packet</span></div><div><b>03</b><span>Original composition</span></div><div><b>04</b><span>Publication gates</span></div></div>
  <p>${link('/matches', 'Explore match intelligence', 'btn gold')}</p>
</div></section>`;

// WATCH: official video from verified publisher channels (docs/VIDEO.md), poster-first, max four.
export function watchModule(videos, desk) {
  const v = (videos || []).slice(0, 4);
  if (!v.length) return '';
  const c = desk ? compByDesk(desk) : null;
  return `<section class="nr2-mod nr2-watch" aria-labelledby="nr2-watch-h">
    <header class="nr2-mh"><p class="nr2-k">WATCH</p><h2 id="nr2-watch-h" class="nr2-h">${esc(c ? `Latest official ${c.name} video` : 'Latest official video')}</h2></header>
    <div class="nw-grid${v.length === 1 ? ' one' : ''}">${officialVideo(v[0], { feature: true })}${v.length > 1 ? `<div class="nw-list">${join(v.slice(1), x => officialVideo(x))}</div>` : ''}</div>
  </section>`;
}

// Editorial sections from what is left after the lead + Latest (each story appears once on the page).
const GROUPS = [
  ['MATCH REPORTS', 'Full-time analysis', a => a.story_class === 'match_recap'],
  ['FORM & TRENDS', 'Players and teams on a run', a => a.story_class === 'player_form' || a.story_class === 'team_trend'],
  ['TABLE WATCH', 'Where the standings moved', a => a.story_class === 'competition_intelligence'],
];
export function newsroomSections(rest) {
  const used = new Set(); const out = []; const leftovers = [];
  for (const [kicker, title, pred] of GROUPS) {
    const list = rest.filter(a => pred(a) && !used.has(a.slug));
    if (list.length >= 2) { list.forEach(a => used.add(a.slug)); out.push({ kicker, title, list }); } else leftovers.push(...list);
  }
  const more = rest.filter(a => !used.has(a.slug));
  if (more.length) out.push({ kicker: 'MORE STORIES', title: 'Also in the newsroom', list: more });
  return out;
}
const section = g => `<section class="nr2-mod" aria-label="${esc(g.title)}"><header class="nr2-mh"><p class="nr2-k">${esc(g.kicker)}</p><h2 class="nr2-h">${esc(g.title)}</h2></header><div class="nr2-grid">${join(g.list, a => newsCard(a, 'standard'))}</div></section>`;

function byCompetition(items) {
  const rows = FEATURED_COMPS.map(c => ({ c, n: items.filter(a => a.desk === c.desk).length })).filter(r => r.n);
  if (rows.length < 2) return '';
  return `<section class="nr2-mod nr2-bycomp" aria-label="By competition"><header class="nr2-mh"><p class="nr2-k">BY COMPETITION</p><h2 class="nr2-h">Every desk</h2></header>
    <div class="nr2-comps">${join(rows, ({ c, n }) => link(`/news/${c.desk}`, `${competitionMark(c.slug, 'lg')}<span class="nbc-name">${esc(c.name)}</span><span class="nbc-n">${n} ${n === 1 ? 'story' : 'stories'}</span><span class="nbc-go">Open desk →</span>`, `nbc a-${c.accent}`))}</div></section>`;
}

function listPage(d, desk) {
  const env = d.env; const items = env.data || [];
  if (!items.length) return emptyRoom(desk);
  const c = desk ? compByDesk(desk) : null;
  const lead = selectHomepageLead(items);
  const latest = latestNews(items, lead);
  const rail = latest.slice(0, 4);
  const rest = latest.slice(4);
  return `<section class="nr2-top"><div class="wrap nr2">
      <p class="nr2-kicker">PROPBETEDGE SOCCER</p>
      <h1 class="nr2-title">${esc(c ? `${c.name} newsroom` : 'Newsroom')}</h1>
      <p class="nr2-sub">Evidence-backed football reporting. Every figure traces to a frozen evidence packet; no quotes, injuries, rumours or odds.</p>
      ${deskTabs(desk)}
    </div></section>
    <section class="nr2-body"><div class="wrap nr2">
      <div class="nr2-lead">${newsCard(lead, 'featured')}
        <aside class="nr2-mod nr2-rail" aria-labelledby="nr2-latest-h"><header class="nr2-mh"><p class="nr2-k">LATEST</p><h2 id="nr2-latest-h" class="nr2-h sr-only">Latest stories</h2></header>${join(rail, a => newsCard(a, 'rail'))}${rest.length ? '<a class="nr2-more" href="#nr2-sections">More stories ↓</a>' : ''}</aside>
      </div>
      ${watchModule(d.videos, desk)}
      <div id="nr2-sections">${join(newsroomSections(rest), section)}</div>
      ${desk ? '' : byCompetition(items)}
      <div class="nr2-mod nr2-src">${sourcePanel(env.meta, { title: 'HOW THE NEWSROOM WORKS' })}</div>
    </div></section>`;
}

const settle = p => p.then(v => v, () => null);
const mountList = root => { mountNewsImages(root); mountOfficialVideos(root); mountMediaFallbacks(root); };

export const news = {
  title: () => 'Soccer News — Evidence-Backed Reporting | PropBetEdge',
  robots: d => (d?.env?.data?.length ? INDEX : 'noindex, follow'),
  async load() { const [env, vids] = await Promise.all([api('news', { limit: 40 }), settle(api('videos', { limit: 4 }))]); return { env, videos: vids?.data || [] }; },
  render(d) { return listPage(d, null); },
  mount: mountList,
};

export const newsDesk = {
  title: d => `${compByDesk(d?.desk)?.name || ''} Soccer News | PropBetEdge`,
  robots: d => (d?.env?.data?.length ? INDEX : 'noindex, follow'),
  async load([desk]) { const [env, vids] = await Promise.all([api('news', { desk, limit: 40 }), settle(api('videos', { desk, limit: 4 }))]); return { desk, env, videos: vids?.data || [] }; },
  render(d) { return listPage(d, d.desk); },
  mount: mountList,
};

const typeLabel = s => String(s || '').replace('competition_intelligence', 'table race').replace(/_/g, ' ').toUpperCase();

export const article = {
  title: d => `${d?.env?.data?.headline || 'Article'} | PropBetEdge Soccer`,
  async load([desk, slug]) {
    const env = await api(`news/${slug}`);
    if (env.data.desk !== desk) { const e = new Error('not found'); e.status = 404; throw e; }
    return { env };
  },
  render(d) { return renderArticle(d.env); },
  mount(root, d) { mountArticle(root, d.env); },
};
