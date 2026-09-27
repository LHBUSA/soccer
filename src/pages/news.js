// NEWSROOM: /news, /news/:desk, /news/:desk/:slug. Only published, gate-passed
// articles exist here; each one names its frozen evidence packet.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { dateLong, dateTime } from '../lib/format.js';
import { FEATURED_COMPS, compByDesk } from '../lib/competitions.js';
import { compMono, link, sourcePanel } from '../components/ui.js';
import { newsCard } from './home.js';

const INDEX = 'index, follow, max-image-preview:large';
const deskTabs = active => `<nav class="tabs" aria-label="News desks">${link('/news', 'All desks', `tab${!active ? ' on' : ''}`)}${join(FEATURED_COMPS, c => link(`/news/${c.desk}`, `${compMono(c.slug, 'xs')}${esc(c.name)}`, `tab${c.desk === active ? ' on' : ''}`))}</nav>`;

const emptyRoom = desk => `<section class="newsroom"><div class="wrap narrow center">
  <p class="kicker gold">PROPBETEDGE SOCCER NEWSROOM${desk ? ` · ${esc(compByDesk(desk)?.name.toUpperCase() || '')}` : ''}</p>
  <h1 class="display">Evidence-backed soccer reporting is coming online.</h1>
  <p class="lede">Every story is written from a frozen evidence packet drawn from the canonical graph, and checked by publication gates before it runs. Every number traces to a source. No invented quotes, injuries or odds.</p>
  <div class="nr-steps"><div><b>01</b><span>Canonical data</span></div><div><b>02</b><span>Frozen evidence packet</span></div><div><b>03</b><span>Original composition</span></div><div><b>04</b><span>Publication gates</span></div></div>
  <p>${link('/matches', 'Explore match intelligence', 'btn gold')}</p>
</div></section>`;

function listPage(env, desk) {
  const items = env.data || [];
  if (!items.length) return emptyRoom(desk);
  const c = desk ? compByDesk(desk) : null;
  return `<section class="hero compact"><div class="wrap">
    <p class="kicker gold">PROPBETEDGE SOCCER NEWSROOM</p>
    <h1 class="display">${esc(c ? `${c.name} news` : 'Soccer news')}</h1>
    <p class="lede">Written from frozen evidence packets and published only after every gate passes: no quotes, injuries, rumours or odds.</p>
    ${deskTabs(desk)}
  </div></section>
  <section class="canvas"><div class="wrap"><div class="newsgrid">${join(items, newsCard)}</div>${sourcePanel(env.meta, { title: 'HOW THE NEWSROOM WORKS' })}</div></section>`;
}

export const news = {
  title: () => 'News · PropBetEdge Soccer',
  robots: d => (d?.env?.data?.length ? INDEX : 'noindex, follow'),
  async load() { return { env: await api('news', { limit: 30 }) }; },
  render(d) { return listPage(d.env, null); },
};

export const newsDesk = {
  title: d => `${compByDesk(d?.desk)?.name || ''} News · PropBetEdge Soccer`,
  robots: d => (d?.env?.data?.length ? INDEX : 'noindex, follow'),
  async load([desk]) { return { desk, env: await api('news', { desk, limit: 30 }) }; },
  render(d) { return listPage(d.env, d.desk); },
};

const typeLabel = s => String(s || '').replace('competition_intelligence', 'table race').replace(/_/g, ' ').toUpperCase();

export const article = {
  title: d => `${d?.env?.data?.headline || 'Article'} · PropBetEdge Soccer`,
  async load([desk, slug]) {
    const env = await api(`news/${slug}`);
    if (env.data.desk !== desk) { const e = new Error('not found'); e.status = 404; throw e; }
    return { env };
  },
  render(d) {
    const a = d.env.data; const c = compByDesk(a.desk);
    const sections = a.body?.sections || [];
    const entities = (a.entities || []).filter(e => e.href);
    return `<article>
    <section class="hero compact"><div class="wrap article">
      <p class="kicker gold">${link(`/news/${a.desk}`, `${compMono(c?.slug, 'xs')} ${esc(c?.name.toUpperCase() || a.desk)}`, 'deskline')} · ${esc(typeLabel(a.story_class))}</p>
      <h1 class="display">${esc(a.headline)}</h1>
      ${when(a.dek, () => `<p class="dek">${esc(a.dek)}</p>`)}
      <p class="byline">PropBetEdge Soccer newsroom · <time datetime="${esc(a.published_at)}">${esc(dateLong(a.published_at))}</time></p>
    </div></section>
    <section class="canvas"><div class="wrap article abody">
      ${join(sections.filter(s => s.key !== 'method'), s => `<h2>${esc(s.heading)}</h2>${join(s.paragraphs, p => `<p>${esc(p)}</p>`)}`)}
      ${when(entities.length, () => `<nav class="entities" aria-label="In this story">${join(entities, e => link(e.href, esc(e.name), 'chip'))}</nav>`)}
      <aside class="evidence"><h2>EVIDENCE AND METHOD</h2>
        ${join(sections.filter(s => s.key === 'method').flatMap(s => s.paragraphs), p => `<p>${esc(p)}</p>`)}
        <ul><li>Evidence packet: <code>${esc(String(a.packet_hash).slice(0, 16))}</code> (frozen, append-only)</li><li>Composer: ${esc(a.composer)}</li><li>Gates: ${esc(a.gate_version)}, all passed</li><li>Published ${esc(dateTime(a.published_at))}</li></ul>
      </aside>
      ${sourcePanel(d.env.meta)}
    </div></section></article>`;
  },
};
