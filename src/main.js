import './styles/main.css';
import { initAnalytics } from './analytics.js';
import { resolve } from './lib/router.js';
import { errorState, loading, notFoundPage } from './components/ui.js';
import { competitionMark } from './components/media.js';
import * as home from './pages/home.js';
import * as competition from './pages/competition.js';
import * as match from './pages/match.js';
import { competitions, matches, sources, tables } from './pages/lists.js';
import { news, newsDesk, article } from './pages/news.js';
import { player, team } from './pages/people.js';
import * as players from './pages/players.js';
import { hub as pbecastHub, cast as pbecast } from './pages/pbecast.js';
import { FEATURED_COMPS } from './lib/competitions.js';
import { mountMediaFallbacks } from './components/ui.js';
import { installPlayerDrawer, close as closeDrawer } from './components/drawer.js';
import { mountScoreTicker } from './components/score-ticker.js';

initAnalytics();

const PAGES = { home, competition, match, competitions, matches, news, newsDesk, article, sources, tables, team, player, players, pbecastHub, pbecast };
const NAV = [['/', 'TODAY', 'home'], ['/matches', 'MATCHES', 'matches,match'], ['/pbecast', 'PBECAST', 'pbecastHub,pbecast'], ['/tables', 'TABLES', 'tables'], ['/players', 'PLAYERS', 'players,player'], ['/competitions', 'COMPETITIONS', 'competitions'], ['/news', 'NEWS', 'news,newsDesk,article']];

// The canonical PropBetEdge mark (owned network artwork, docs/BRAND.md) links to the network home.
const brandMark = () => '<a class="pbe-mark" href="https://propbetedge.ai/" aria-label="PropBetEdge home"><img src="/brand/pbe-mark-64.webp" srcset="/brand/pbe-mark-64.webp 130w, /brand/pbe-mark-96.webp 195w, /brand/pbe-mark-160.webp 325w" sizes="73px" width="73" height="36" alt="PropBetEdge"></a>';

function shell() {
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="top"><div class="wrap topbar">
    <div class="brandlock">${brandMark()}<a class="brand" href="/" data-link aria-label="PropBetEdge Soccer Intelligence home"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></a></div>
    <button class="navtoggle" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span></button>
    <nav id="nav" class="nav" aria-label="Primary">${NAV.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}</nav>
  </div>
  <nav class="rail" aria-label="Competitions"><div class="wrap railrow">${FEATURED_COMPS.map(c => `<a href="/competitions/${c.slug}" data-link data-comp="${c.slug}" class="a-${c.accent}">${competitionMark(c.slug, 'xs', { tone: 'dark' })}<span>${c.name.toUpperCase()}</span></a>`).join('')}</div></nav>
  </header>
  <div id="score-ticker"></div>
  <main id="main" tabindex="-1"></main>
  <footer class="foot"><div class="wrap footgrid">
    <div><div class="brandlock foot-brand">${brandMark()}<p class="brand small"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></p></div><p class="muted">Football intelligence, rebuilt on the PropBetEdge canonical soccer graph.</p></div>
    <nav aria-label="Footer">${FEATURED_COMPS.map(c => `<a href="/competitions/${c.slug}" data-link>${c.name.toUpperCase()}</a>`).join('')}<a href="/matches" data-link>MATCH INTELLIGENCE</a><a href="/pbecast" data-link>PBECAST</a><a href="/tables" data-link>TABLES</a><a href="/players" data-link>PLAYER DNA</a><a href="/news" data-link>NEWS</a><a href="/sources" data-link>SOURCES</a></nav>
    <p class="muted small">Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0 · Fixtures/results: OpenLigaDB, ODbL · Structured facts: ESPN (secondary source). Event maps show event locations, not player tracking.</p>
  </div></footer>`;
}

const app = document.getElementById('app');
app.innerHTML = shell();
const main = document.getElementById('main');
mountScoreTicker(document.getElementById('score-ticker'));
let seq = 0;

let firstLoad = true; // the server already wrote title/canonical/robots for the first response
function setMeta(page, data, params = []) {
  const mod = PAGES[page];
  if (!firstLoad) {
    document.title = (mod?.title && data ? mod.title(data) : null) || 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge';
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
    robots.content = page === 'notfound' ? 'noindex, follow' : (typeof mod?.robots === 'function' ? mod.robots(data) : mod?.robots) || 'index, follow, max-image-preview:large';
    const canon = document.querySelector('link[rel="canonical"]');
    const own = typeof mod?.canonical === 'function' && data ? mod.canonical(data) : null; // e.g. a PBEcast page canonicalises to its match page
    if (canon && page !== 'notfound') canon.href = `https://soccer.propbetedge.ai${own || (location.pathname === '/' ? '/' : location.pathname.replace(/\/+$/, ''))}`;
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
  closeDrawer();
  history.pushState({}, '', url.pathname + url.search);
  document.body.classList.remove('menu-open');
  document.querySelector('.navtoggle')?.setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  render(url);
}

installPlayerDrawer(); // before the router: plain clicks on player chips open the drawer
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
window.addEventListener('popstate', () => { closeDrawer(); render(); });
render();
