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
import { pro, proMatch } from './pages/pro.js';
import { networkFooter, applyFooterMembership } from './components/footer.js';
import { accountButtonLabel, handleVerifiedReturn, openAccount } from './components/account.js';
import { proAccess } from './lib/pro.js';
import './styles/pbe-membership.css';
import { CLUB_COMPS, FEATURED_COMPS, INTERNATIONAL_COMPS } from './lib/competitions.js';
import { mountMediaFallbacks } from './components/ui.js';
import { installPlayerDrawer, close as closeDrawer } from './components/drawer.js';
import { mountScoreTicker } from './components/score-ticker.js';

initAnalytics();

const PAGES = { home, competition, match, competitions, matches, news, newsDesk, article, sources, tables, team, player, players, pbecastHub, pbecast, pro, proMatch };
// Primary navigation (Soccer Pro V1). Every existing public URL keeps working; INTELLIGENCE groups them.
const NAV = [['/', 'TODAY', 'home'], ['/matches', 'MATCHES', 'matches,match'], ['/pbecast', 'PBECAST', 'pbecastHub,pbecast']];
const INTEL = [['/players', 'PLAYER DNA'], ['/competitions', 'TEAM INTELLIGENCE'], ['/tables', 'TABLES'], ['/competitions', 'COMPETITIONS'], ['/pro#matchup', 'MATCHUP LAB'], ['/pro#fatigue', 'FATIGUE'], ['/pro#model-lab', 'MODEL LAB']];
const INTEL_PAGES = 'players,player,tables,competitions,competition,team';
const BOTTOM = [['/', 'TODAY', 'home'], ['/matches', 'MATCHES', 'matches,match'], ['/pbecast', 'PBECAST', 'pbecastHub,pbecast'], ['/pro', 'PRO', 'pro,proMatch']];

// The canonical PropBetEdge mark (owned network artwork, docs/BRAND.md) links to the network home.
const brandMark = () => '<a class="pbe-mark" href="https://propbetedge.ai/" aria-label="PropBetEdge home"><img src="/brand/pbe-mark-64.webp" srcset="/brand/pbe-mark-64.webp 130w, /brand/pbe-mark-96.webp 195w, /brand/pbe-mark-160.webp 325w" sizes="73px" width="73" height="36" alt="PropBetEdge"></a>';

// Club competitions are chips in the rail; national-team competitions live in the INTERNATIONAL panel
// (one place to add World Cup / EURO / Copa America / Gold Cup without another navigation rewrite).
const railChip = c => `<a href="/competitions/${c.slug}" data-link data-comp="${c.slug}" class="a-${c.accent}">${competitionMark(c.slug, 'xs', { tone: 'dark' })}<span>${c.name.toUpperCase()}</span></a>`;
const setIntl = open => {
  const b = document.querySelector('[data-intl-toggle]'); const p = document.getElementById('rail-intl-panel');
  if (!b || !p) return;
  b.setAttribute('aria-expanded', String(open)); p.hidden = !open;
};

function shell() {
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="top"><div class="wrap topbar">
    <div class="brandlock">${brandMark()}<a class="brand" href="/" data-link aria-label="PropBetEdge Soccer Intelligence home"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></a></div>
    <button class="navtoggle" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span></button>
    <nav id="nav" class="nav" aria-label="Primary">${NAV.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}
      <div class="navmenu"><button type="button" class="navdrop" aria-expanded="false" aria-controls="intel-panel" data-intel-toggle data-pages="${INTEL_PAGES}">INTELLIGENCE<i aria-hidden="true"></i></button>
        <div id="intel-panel" class="navpanel" hidden>${INTEL.map(([h, l]) => `<a href="${h}" data-link>${l}</a>`).join('')}</div></div>
      <a href="/news" data-link data-pages="news,newsDesk,article">NEWS</a>
      <span class="navsep" aria-hidden="true"></span>
      <a class="nav-aa" href="/pro" data-link data-pages="pro,proMatch">ALL ACCESS</a>
      <button type="button" class="nav-acct" data-account-open>SIGN IN</button></nav>
  </div>
  <nav class="rail" aria-label="Competitions"><div class="wrap railrow"><span class="rail-label" aria-hidden="true">CLUB</span>${CLUB_COMPS.map(railChip).join('')}${INTERNATIONAL_COMPS.length ? `<button type="button" class="rail-intl" aria-expanded="false" aria-controls="rail-intl-panel" data-intl-toggle><span>INTERNATIONAL</span><i aria-hidden="true"></i></button>` : ''}</div>
    ${INTERNATIONAL_COMPS.length ? `<div id="rail-intl-panel" class="rail-panel" hidden><div class="wrap"><p class="rail-panel-h">INTERNATIONAL FOOTBALL</p><div class="railrow rail-panel-row">${INTERNATIONAL_COMPS.map(railChip).join('')}</div></div></div>` : ''}
  </nav>
  </header>
  <div id="score-ticker"></div>
  <main id="main" tabindex="-1"></main>
  <nav class="botnav" aria-label="Primary (mobile)">${BOTTOM.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}<button type="button" class="bot-more" aria-controls="nav" aria-expanded="false" data-more>MORE</button></nav>
  ${networkFooter()}`;
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
  document.querySelectorAll('.nav a[data-pages], .nav [data-intel-toggle], .botnav a').forEach(a => a.classList.toggle('on', a.dataset.pages.split(',').includes(page)));
  setIntel(false);
  const comp = page === 'competition' ? params[0] : null;
  document.querySelectorAll('.rail a').forEach(a => { const on = a.dataset.comp === comp; a.classList.toggle('on', on); if (on) { a.setAttribute('aria-current', 'page'); a.parentElement.scrollLeft = Math.max(0, a.offsetLeft - 16); } else a.removeAttribute('aria-current'); });
  const intl = INTERNATIONAL_COMPS.some(c => c.slug === comp);
  document.querySelector('[data-intl-toggle]')?.classList.toggle('on', intl);
  setIntl(false);
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
  for (const b of document.querySelectorAll('.navtoggle, [data-more]')) b.setAttribute('aria-expanded', 'false');
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
const setMenu = open => { document.body.classList.toggle('menu-open', open); for (const b of document.querySelectorAll('.navtoggle, [data-more]')) b.setAttribute('aria-expanded', String(open)); };
document.querySelector('.navtoggle').addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
document.querySelector('[data-more]')?.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
function setIntel(open) { const b = document.querySelector('[data-intel-toggle]'); const p = document.getElementById('intel-panel'); if (!b || !p) return; b.setAttribute('aria-expanded', String(open)); p.hidden = !open; }
document.querySelector('[data-intel-toggle]')?.addEventListener('click', e => setIntel(e.currentTarget.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('click', e => { if (!e.target.closest('.navmenu')) setIntel(false); const acct = e.target.closest('[data-account-open]'); if (acct) { e.preventDefault(); openAccount(); } });
document.addEventListener('keydown', e => { if (e.key === 'Escape') setIntel(false); });
// Membership comes from the server only (never inferred in the browser): label the account button,
// then the footer card (no purchase CTA for All Access / owner; manage only where the contract says).
handleVerifiedReturn();
proAccess().then(a => {
  for (const b of document.querySelectorAll('.nav-acct')) b.textContent = accountButtonLabel(a.membership);
  if (a.pro) document.querySelector('.nav-aa')?.classList.add('is-member');
  applyFooterMembership(document, a.membership);
});
document.querySelector('[data-intl-toggle]')?.addEventListener('click', e => setIntl(e.currentTarget.getAttribute('aria-expanded') !== 'true'));
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !document.getElementById('rail-intl-panel')?.hidden) { setIntl(false); document.querySelector('[data-intl-toggle]')?.focus(); } });
document.addEventListener('click', e => { if (!e.target.closest('.rail')) setIntl(false); });
window.addEventListener('popstate', () => { closeDrawer(); render(); });
render();
