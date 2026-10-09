import './styles/main.css';
import './styles/sprint.css';
import { initAnalytics } from './analytics.js';
import { mountPreferredSource } from './components/preferred-source.js';
import './styles/preferred-source.css';
import { resolve } from './lib/router.js';
import { errorState, routeSkeleton, notFoundPage } from './components/ui.js';
import { api } from './lib/api.js';
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
import { allAccess } from './pages/all-access.js';
import './styles/account.css';
import { picks as algoPicks, trackRecord } from './pages/algo.js';
import { networkFooter, applyFooterMembership } from './components/footer.js';
import { handleVerifiedReturn, openAccount } from './components/account.js';
import { LOCAL_ALL_ACCESS_PATH, accountView, headerLabel } from './lib/account-surface.js';
import { proAccess } from './lib/pro.js';
import './styles/pbe-membership.css';
import './vendor/kalshi/kalshi-market-ui.css';
import './vendor/kalshi/article-market-ui.css';
import './styles/kalshi-soccer.css';
import { wireKalshi } from './vendor/kalshi/kalshi-market-ui.js';
import { CLUB_COMPS, FEATURED_COMPS, INTERNATIONAL_COMPS, WOMEN_COMPS } from './lib/competitions.js';
import { mountMediaFallbacks } from './components/ui.js';
import { installPlayerDrawer, close as closeDrawer } from './components/drawer.js';
import { mountScoreTicker } from './components/score-ticker.js';
import { currentLocale } from './i18n/current.js';
import { localizePath, splitLocale } from './i18n/locales.js';
import { observeLocale } from './i18n/dom.js';
import { translateText } from './i18n/translate.js';
import { langMenu, mountLangMenu, syncLangLinks, syncAlternates } from './components/lang.js';
import './styles/lang.css';

const LOCALE = currentLocale();
document.documentElement.lang = LOCALE === 'en' ? 'en' : LOCALE;
initAnalytics();
mountPreferredSource();

const PAGES = { home, competition, match, competitions, matches, news, newsDesk, article, sources, tables, team, player, players, pbecastHub, pbecast, pro, proMatch, allAccess, algoPicks, trackRecord };
// Primary navigation (Soccer Pro V1). Every existing public URL keeps working; INTELLIGENCE groups them.
const NAV = [['/', 'TODAY', 'home'], ['/matches', 'MATCHES', 'matches,match'], ['/pbecast', 'PBECAST', 'pbecastHub,pbecast'], ['/picks', 'PICKS', 'algoPicks,trackRecord']];
const INTEL = [['/track-record', 'ALGO TRACK RECORD'],['/players', 'PLAYER DNA'], ['/competitions', 'TEAM INTELLIGENCE'], ['/tables', 'TABLES'], ['/competitions', 'COMPETITIONS'], ['/pro#matchup', 'MATCHUP LAB'], ['/pro#fatigue', 'FATIGUE'], ['/pro#model-lab', 'MODEL LAB']];
const INTEL_PAGES = 'players,player,tables,competitions,competition,team';
const BOTTOM = [['/', 'TODAY', 'home'], ['/matches', 'MATCHES', 'matches,match'], ['/pbecast', 'PBECAST', 'pbecastHub,pbecast'], ['/pro', 'PRO', 'pro,proMatch']];

// The canonical PropBetEdge mark (owned network artwork, docs/BRAND.md) links to the network home.
const brandMark = () => '<a class="pbe-mark" href="https://propbetedge.ai/" aria-label="PropBetEdge home"><img src="/brand/pbe-mark-64.webp" srcset="/brand/pbe-mark-64.webp 130w, /brand/pbe-mark-96.webp 195w, /brand/pbe-mark-160.webp 325w" sizes="73px" width="73" height="36" alt="PropBetEdge"></a>';

// Competitions live in the LEAGUES menu of the main nav (club, then international), one header row instead of a
// separate rail: the page's intelligence starts higher. New competitions only need an entry in competitions.js.
const leagueLink = c => `<a href="/competitions/${c.slug}" data-link data-comp="${c.slug}" class="lg-link a-${c.accent}">${competitionMark(c.slug, 'xs', { tone: 'dark' })}<span>${c.name.toUpperCase()}</span></a>`;
const MENUS = ['intel-panel', 'leagues-panel', 'lang-panel'];
// One open menu at a time; `id = null` closes all.
function setMenuOpen(id) {
  for (const m of MENUS) {
    const p = document.getElementById(m); const b = document.querySelector(`[aria-controls="${m}"]`);
    if (!p || !b) continue;
    b.setAttribute('aria-expanded', String(m === id)); p.hidden = m !== id;
  }
}

function shell() {
  return `<a class="skip" href="#main">Skip to content</a>
  <header class="top"><div class="wrap topbar">
    <div class="brandlock">${brandMark()}<a class="brand" href="/" data-link aria-label="PropBetEdge Soccer Intelligence home"><span class="b1">PROPBETEDGE</span><span class="b2">SOCCER INTELLIGENCE</span></a></div>
    <button class="navtoggle" aria-expanded="false" aria-controls="nav" aria-label="Menu"><span></span><span></span></button>
    <nav id="nav" class="nav" aria-label="Primary">${NAV.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}
      <div class="navmenu"><button type="button" class="navdrop" aria-expanded="false" aria-controls="leagues-panel" data-menu-toggle data-leagues-toggle data-pages="competition">LEAGUES<i aria-hidden="true"></i></button>
        <div id="leagues-panel" class="navpanel lg-panel" hidden><p class="lg-h">CLUB</p>${CLUB_COMPS.map(leagueLink).join('')}${INTERNATIONAL_COMPS.length ? `<p class="lg-h">INTERNATIONAL</p>${INTERNATIONAL_COMPS.map(leagueLink).join('')}` : ''}${WOMEN_COMPS.length ? `<p class="lg-h">WOMEN</p>${WOMEN_COMPS.map(leagueLink).join('')}` : ''}</div></div>
      <div class="navmenu"><button type="button" class="navdrop" aria-expanded="false" aria-controls="intel-panel" data-menu-toggle data-intel-toggle data-pages="${INTEL_PAGES}">INTELLIGENCE<i aria-hidden="true"></i></button>
        <div id="intel-panel" class="navpanel" hidden>${INTEL.map(([h, l]) => `<a href="${h}" data-link>${l}</a>`).join('')}</div></div>
      <a href="/news" data-link data-pages="news,newsDesk,article">NEWS</a>
      <span class="navsep" aria-hidden="true"></span>
      ${langMenu(LOCALE)}
      <a class="nav-aa" href="${LOCAL_ALL_ACCESS_PATH}" data-link data-pages="allAccess">ALL ACCESS</a>
      <button type="button" class="nav-acct" data-account-open>SIGN IN</button></nav>
  </div>
  </header>
  <div id="score-ticker"></div>
  <main id="main" tabindex="-1"></main>
  <nav class="botnav" aria-label="Primary (mobile)">${BOTTOM.map(([h, l, p]) => `<a href="${h}" data-link data-pages="${p}">${l}</a>`).join('')}<button type="button" class="bot-more" aria-controls="nav" aria-expanded="false" data-more>MORE</button></nav>
  ${networkFooter()}`;
}

const app = document.getElementById('app');
app.innerHTML = shell();
// Non-English pages: translate every rendered UI string now and on every later render (src/i18n/dom.js).
observeLocale(document.body, LOCALE);
mountLangMenu();
const main = document.getElementById('main');
mountScoreTicker(document.getElementById('score-ticker'));
let seq = 0;

let firstLoad = true; // the server already wrote title/canonical/robots for the first response
function setMeta(page, data, params = []) {
  const mod = PAGES[page];
  if (!firstLoad) {
    document.title = translateText((mod?.title && data ? mod.title(data) : null) || 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge', LOCALE);
    let robots = document.querySelector('meta[name="robots"]');
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.appendChild(robots); }
    robots.content = page === 'notfound' ? 'noindex, follow' : (typeof mod?.robots === 'function' ? mod.robots(data) : mod?.robots) || 'index, follow, max-image-preview:large';
    const canon = document.querySelector('link[rel="canonical"]');
    const own = typeof mod?.canonical === 'function' && data ? mod.canonical(data) : null; // e.g. a PBEcast page canonicalises to its match page
    // Localized pages are self-canonical (/es/...), except article pages: the story body is English only until a
    // verified translation ships, so the English URL stays canonical and no alternates are claimed.
    const here = splitLocale(location.pathname).path;
    const path = own || (here === '/' ? '/' : here.replace(/\/+$/, ''));
    if (canon && page !== 'notfound') canon.href = `https://soccer.propbetedge.ai${page === 'article' ? path : localizePath(path, LOCALE)}`;
    syncAlternates(page === 'notfound' || page === 'article' || robots.content.startsWith('noindex') ? null : path);
  }
  syncLangLinks();
  document.querySelectorAll('.nav a[data-pages], .nav [data-menu-toggle], .botnav a').forEach(a => a.classList.toggle('on', a.dataset.pages.split(',').includes(page)));
  setMenuOpen(null);
  const comp = page === 'competition' ? params[0] : null;
  document.querySelectorAll('#leagues-panel a[data-comp]').forEach(a => { const on = a.dataset.comp === comp; a.classList.toggle('on', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
}

export async function render(url = new URL(location.href)) {
  const my = ++seq;
  const { page, params } = resolve(splitLocale(url.pathname).path);
  if (page === 'notfound') { setMeta('notfound'); firstLoad = false; main.removeAttribute('aria-busy'); main.classList.remove('route-pending'); main.innerHTML = notFoundPage(); return; }
  const mod = PAGES[page];
  const wasEmpty = !main.innerHTML;
  main.setAttribute('aria-busy', 'true');
  if (mod.initial) main.innerHTML = mod.initial();
  else if (wasEmpty) main.innerHTML = routeSkeleton(page);
  const delay = setTimeout(() => { if (my === seq) main.classList.add('route-pending'); }, 300);
  setMeta(page, null, params);
  try {
    const data = await mod.load(params, url.searchParams);
    if (my !== seq) return;
    main.innerHTML = mod.render(data);
    main.dataset.routeSeq = String(my);
    main.removeAttribute('aria-busy');
    main.classList.remove('route-pending');
    setMeta(page, data, params);
    firstLoad = false;
    mountMediaFallbacks(main);
    mod.mount?.(main, data, { navigate, isCurrent: () => my === seq });
    wireKalshi(main); // Kalshi impressions/clicks on any market UI this page rendered (idempotent)
  } catch (err) {
    if (my !== seq) return;
    firstLoad = false;
    main.removeAttribute('aria-busy'); main.classList.remove('route-pending');
    main.innerHTML = `<section class="canvas"><div class="wrap narrow">${errorState(err)}</div></section>`;
    main.querySelector('[data-retry]')?.addEventListener('click', () => render(url));
    if (err?.status !== 404) console.warn('load failed', page, err?.message);
  } finally { clearTimeout(delay); }
}

export function navigate(href) {
  const url = new URL(localizePath(href, LOCALE), location.origin);
  if (url.origin !== location.origin) { location.href = href; return; }
  closeDrawer();
  // Remember where the reader was, so Back (e.g. Match Intelligence -> the filtered /matches list) lands there again.
  history.replaceState({ ...(history.state || {}), y: Math.round(window.scrollY) }, '');
  history.pushState({}, '', url.pathname + url.search);
  document.body.classList.remove('menu-open');
  for (const b of document.querySelectorAll('.navtoggle, [data-more]')) b.setAttribute('aria-expanded', 'false');
  window.scrollTo(0, 0);
  render(url);
}

installPlayerDrawer(); // before the router: plain clicks on player chips open the drawer
// Bounded, inexpensive reads only: never entitlement, DNA computation or a full match ledger.
const prefetch = e => {
  const a = e.target.closest('a[data-link]'); if (!a || navigator.connection?.saveData) return;
  const u = new URL(a.href, location.origin); if (u.origin !== location.origin) return;
  const { page, params } = resolve(splitLocale(u.pathname).path);
  const path = page === 'competition' ? `competitions/${params[0]}` : page === 'team' ? `teams/${params[0]}` : page === 'competitions' ? 'competitions' : page === 'pbecastHub' || page === 'home' ? 'live' : null;
  if (path) api(path).catch(() => {});
};
document.addEventListener('pointerover', prefetch);
document.addEventListener('focusin', prefetch);
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});
const setMenu = open => { document.body.classList.toggle('menu-open', open); for (const b of document.querySelectorAll('.navtoggle, [data-more]')) b.setAttribute('aria-expanded', String(open)); };
document.querySelector('.navtoggle').addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
document.querySelector('[data-more]')?.addEventListener('click', () => setMenu(!document.body.classList.contains('menu-open')));
for (const b of document.querySelectorAll('[data-menu-toggle]')) b.addEventListener('click', e => { const id = e.currentTarget.getAttribute('aria-controls'); setMenuOpen(e.currentTarget.getAttribute('aria-expanded') === 'true' ? null : id); });
document.addEventListener('click', e => { if (!e.target.closest('.navmenu')) setMenuOpen(null); const acct = e.target.closest('[data-account-open]'); if (acct) { e.preventDefault(); openAccount(); } });
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = MENUS.find(m => document.getElementById(m) && !document.getElementById(m).hidden);
  setMenuOpen(null);
  if (open) document.querySelector(`[aria-controls="${open}"]`)?.focus();
});
// Membership comes from the server only (never inferred in the browser): label the account button,
// then the footer card (no purchase CTA for All Access / owner; manage only where the contract says).
handleVerifiedReturn();
proAccess().then(a => {
  // The header reads the server verdict: ◆ PLATINUM / VERIFIED OWNER for members, ACCESS CHECK while
  // unverified, never FREE. The ALL ACCESS nav item stays navigation to the local page.
  for (const b of document.querySelectorAll('.nav-acct')) { b.textContent = headerLabel(a); b.dataset.view = accountView(a); }
  if (a.pro) document.querySelector('.nav-aa')?.classList.add('is-member');
  applyFooterMembership(document, a.membership);
});
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // content renders async; we restore after it
window.addEventListener('popstate', () => { closeDrawer(); const y = history.state?.y; render().then(() => { if (y) window.scrollTo(0, y); }); });
render();
