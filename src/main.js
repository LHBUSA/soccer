import './styles/main.css';
import { resolve } from './lib/router.js';
import { errorState, loading, notFoundPage } from './components/ui.js';
import * as home from './pages/home.js';
import * as competition from './pages/competition.js';
import * as match from './pages/match.js';
import { competitions, matches, news, sources, tables } from './pages/lists.js';
import { player, team } from './pages/people.js';

const PAGES = { home, competition, match, competitions, matches, news, sources, tables, team, player };
const NAV = [['/', 'TODAY', 'home'], ['/competitions', 'COMPETITIONS', 'competitions,competition'], ['/matches', 'MATCHES', 'matches,match'], ['/tables', 'TABLES', 'tables'], ['/news', 'NEWS', 'news']];

function shell() {
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="top"><div class="wrap topbar">
    <a class="brand" href="/" data-link aria-label="PropBetEdge Soccer Intelligence home"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></a>
    <button class="navtoggle" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span></button>
    <nav id="nav" class="nav" aria-label="Primary">${NAV.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}</nav>
  </div></header>
  <main id="main" tabindex="-1"></main>
  <footer class="foot"><div class="wrap footgrid">
    <div><p class="brand small"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></p><p class="muted">Football intelligence, rebuilt on the PropBetEdge canonical soccer graph.</p></div>
    <nav aria-label="Footer"><a href="/sources" data-link>SOURCES</a><a href="/competitions" data-link>COMPETITIONS</a><a href="/matches" data-link>MATCH INTELLIGENCE</a><a href="/news" data-link>NEWS</a></nav>
    <p class="muted small">Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0 · Fixtures/results: OpenLigaDB, ODbL · Structured facts: ESPN (secondary source). Event maps show event locations, not player tracking.</p>
  </div></footer>`;
}

const app = document.getElementById('app');
app.innerHTML = shell();
const main = document.getElementById('main');
let seq = 0;

function setMeta(page, data) {
  const mod = PAGES[page];
  document.title = (mod?.title && data ? mod.title(data) : null) || 'PropBetEdge Soccer Intelligence';
  let robots = document.querySelector('meta[name="robots"]');
  if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
  robots.content = mod?.robots || 'index,follow';
  document.querySelectorAll('.nav a').forEach(a => a.classList.toggle('on', a.dataset.pages.split(',').includes(page)));
}

export async function render(url = new URL(location.href)) {
  const my = ++seq;
  const { page, params } = resolve(url.pathname);
  if (page === 'notfound') { setMeta('notfound'); main.innerHTML = notFoundPage(); return; }
  const mod = PAGES[page];
  main.innerHTML = `<div class="wrap">${loading()}</div>`;
  setMeta(page, null);
  try {
    const data = await mod.load(params, url.searchParams);
    if (my !== seq) return;
    main.innerHTML = mod.render(data);
    setMeta(page, data);
    mod.mount?.(main, data, { navigate });
  } catch (err) {
    if (my !== seq) return;
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
