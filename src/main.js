import './styles/main.css';
import { resolve } from './lib/router.js';
import { errorState, loading, notFoundPage } from './components/ui.js';
import * as home from './pages/home.js';
import * as competition from './pages/competition.js';
import * as match from './pages/match.js';
import { competitions, matches, sources, tables } from './pages/lists.js';
import { news, newsDesk, article } from './pages/news.js';
import { player, team } from './pages/people.js';
import { FEATURED_COMPS } from './lib/competitions.js';
import { mountMediaFallbacks } from './components/ui.js';

const PAGES = { home, competition, match, competitions, matches, news, newsDesk, article, sources, tables, team, player };
const NAV = [['/', 'TODAY', 'home'], ['/matches', 'MATCHES', 'matches,match'], ['/tables', 'TABLES', 'tables'], ['/competitions', 'COMPETITIONS', 'competitions'], ['/news', 'NEWS', 'news,newsDesk,article']];

function shell() {
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="top"><div class="wrap topbar">
    <a class="brand" href="/" data-link aria-label="PropBetEdge Soccer Intelligence home"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></a>
    <button class="navtoggle" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span></button>
    <nav id="nav" class="nav" aria-label="Primary">${NAV.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}</nav>
  </div>
  <nav class="rail" aria-label="Competitions"><div class="wrap railrow">${FEATURED_COMPS.map(c => `<a href="/competitions/${c.slug}" data-link data-comp="${c.slug}" class="a-${c.accent}"><span class="cmono xs a-${c.accent}" aria-hidden="true">${c.mono}</span><span>${c.name.toUpperCase()}</span></a>`).join('')}</div></nav>
  </header>
  <main id="main" tabindex="-1"></main>
  <footer class="foot"><div class="wrap footgrid">
    <div><p class="brand small"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></p><p class="muted">Football intelligence, rebuilt on the PropBetEdge canonical soccer graph.</p></div>
    <nav aria-label="Footer">${FEATURED_COMPS.map(c => `<a href="/competitions/${c.slug}" data-link>${c.name.toUpperCase()}</a>`).join('')}<a href="/matches" data-link>MATCH INTELLIGENCE</a><a href="/tables" data-link>TABLES</a><a href="/news" data-link>NEWS</a><a href="/sources" data-link>SOURCES</a></nav>
    <p class="muted small">Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0 · Fixtures/results: OpenLigaDB, ODbL · Structured facts: ESPN (secondary source). Event maps show event locations, not player tracking.</p>
  </div></footer>`;
}

const app = document.getElementById('app');
app.innerHTML = shell();
const main = document.getElementById('main');
let seq = 0;

let firstLoad = true; // the server already wrote title/canonical/robots for the first response
function setMeta(page, data, params = []) {
  const mod = PAGES[page];
  if (!firstLoad) {
    document.title = (mod?.title && data ? mod.title(data) : null) || 'PropBetEdge Soccer Intelligence';
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
    robots.content = page === 'notfound' ? 'noindex, follow' : (typeof mod?.robots === 'function' ? mod.robots(data) : mod?.robots) || 'index, follow, max-image-preview:large';
    const canon = document.querySelector('link[rel="canonical"]');
    if (canon && page !== 'notfound') canon.href = `https://soccer.propbetedge.ai${location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, '')}`;
  }
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.pages.split(',').includes(page)));
  const comp = page === 'competition' ? params[0] : null;
  document.querySelectorAll('.rail a').forEach(a => { const on = a.dataset.comp === comp; a.classList.toggle('on', on); if (on) { a.setAttribute('aria-current', 'page'); a.parentElement.scrollLeft = Math.max(0, a.offsetLeft - 16); } else a.removeAttribute('aria-current'); });
}

export async function render(url = new URL(location.href)) {
  const my = ++seq;
  const { page, params } = resolve(url.pathname);
  if (page === 'notfound') { setMeta('notfound'); firstLoad = false; main.innerHTML = notFoundPage(); return; }
  const mod = PAGES[page];
  main.innerHTML = `<div class="wrap">${loading()}</div>`;
  setMeta(page, null, params);
  try {
    const data = await mod.load(params, url.searchParams);
    if (my !== seq) return;
    main.innerHTML = mod.render(data);
    setMeta(page, data, params);
    firstLoad = false;
    mountMediaFallbacks(main);
    mod.mount?.(main, data, { navigate });
  } catch (err) {
    if (my !== seq) return;
    firstLoad = false;
    main.innerHTML = `<section class="canvas"><div class="wrap narrow">${errorState(err)}</div></section>`;
    main.querySelector('[data-retry]')?.addEventListener('click', () => render(url));
    if (err?.status !== 404) console.warn('load failed', page, err?.message);
  }
}

export function navigate(href) {
  const url = new URL(href, location.origin);
  if (url.origin !== location.origin) { location.href = href; return; }
  history.pushState({}, '', url.pathname + url.search);
  document.body.classList.remove('menu-open');
  document.querySelector('.navtoggle')?.setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  render(url);
}

document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
document.querySelector('.navtoggle').addEventListener('click', e => {
  const open = document.body.classList.toggle('menu-open');
  e.currentTarget.setAttribute('aria-expanded', String(open));
});
window.addEventListener('popstate', () => render());
render();
