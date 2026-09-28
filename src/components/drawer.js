// PLAYER DNA DRAWER: a plain click on a player chip (lineups, story, feed, impact, team rows) or
// a directory card opens a side sheet with the player's identity and compact Player DNA instead
// of leaving the page. The link stays a real link: modified clicks, middle clicks, no-JS and
// crawlers still reach /players/:slug. Dialog semantics: focus moves in, Esc / backdrop / close
// button dismiss, focus returns to the link that opened it.
import { api } from '../lib/api.js';
import { esc, when } from '../lib/html.js';
import { dateShort, ROLE } from '../lib/format.js';
import { link, loading, portrait, teamMark } from './ui.js';
import { mountMediaFallbacks, portraitOf } from './media.js';
import { mountDnaSwitch, playerDnaView } from './dna.js';

const TRIGGER = '.pchip a[href^="/players/"], a.pcard[href^="/players/"]';
let el = null; let opener = null; let seq = 0;

function shell() {
  const d = document.createElement('div');
  d.className = 'drawer'; d.hidden = true;
  d.innerHTML = `<div class="dr-back" data-dr-close></div>
    <aside class="dr-sheet" role="dialog" aria-modal="true" aria-labelledby="dr-title" tabindex="-1">
      <button type="button" class="dr-x" data-dr-close aria-label="Close player panel">✕</button>
      <div class="dr-body"></div>
    </aside>`;
  document.body.appendChild(d);
  d.addEventListener('click', e => { if (e.target.closest('[data-dr-close]')) close(); });
  d.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...d.querySelectorAll('a[href], button:not([disabled]), select, [tabindex="0"]')].filter(x => !x.hidden && x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
  return d;
}

export function drawerContent(p, dnaEnv) {
  const pic = portraitOf(p);
  const lt = p.observed?.latest_team;
  const dna = dnaEnv?.data?.seasons?.length ? playerDnaView(dnaEnv, { compact: true }) : '<p class="muted">No Player DNA season yet: this player has no sourced appearances in a stored competition-season.</p>';
  return `<header class="dr-head">${portrait(p, 'xl', { alt: pic ? p.name : '' })}<div class="dr-id">
      <p class="kicker gold">PLAYER DNA</p><h2 id="dr-title" tabindex="-1">${esc(p.name)}</h2>
      <p class="dr-facts">${esc(ROLE[p.role] || 'Role not stated')}${p.nationality_code ? ` · ${esc(p.nationality_code)}` : ''}</p>
      ${when(lt, () => `<p class="dr-team">${teamMark(lt, 'xs')}<span>${esc(lt.name)}</span><span class="muted">latest lineup ${esc(dateShort(lt.as_of))}</span></p>`)}
    </div></header>
    ${when(pic?.attribution, () => `<p class="credit dark">Photo: ${esc(pic.attribution)}</p>`)}
    <div class="dr-dna">${dna}</div>
    <p class="dr-cta">${link(`/players/${p.slug}`, 'FULL PLAYER PROFILE →', 'btn gold')}</p>`;
}

export async function open(slug, from) {
  el ||= shell();
  opener = from || document.activeElement;
  const my = ++seq;
  const body = el.querySelector('.dr-body');
  body.innerHTML = loading('Loading Player DNA');
  el.hidden = false; document.body.classList.add('dr-open');
  requestAnimationFrame(() => el.classList.add('on'));
  el.querySelector('.dr-sheet').focus();
  try {
    const [p, dna] = await Promise.all([api(`players/${slug}`), api(`players/${slug}/dna`).catch(() => null)]);
    if (my !== seq || el.hidden) return;
    body.innerHTML = drawerContent(p.data, dna);
    mountMediaFallbacks(body); mountDnaSwitch(body);
    el.querySelector('#dr-title')?.focus?.();
  } catch {
    if (my !== seq) return;
    body.innerHTML = `<div class="state error" role="alert"><p class="state-title">Could not load this player</p><p>${link(`/players/${esc(slug)}`, 'Open the player page', 'btn')}</p></div>`;
  }
}

export function close() {
  if (!el || el.hidden) return;
  seq++;
  el.classList.remove('on'); document.body.classList.remove('dr-open');
  el.hidden = true;
  if (opener?.isConnected) opener.focus();
  opener = null;
}

// Install once, BEFORE the router's click handler (it must win for plain clicks on triggers).
export function installPlayerDrawer() {
  document.addEventListener('click', e => {
    const a = e.target.closest(TRIGGER);
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    if (a.closest('.drawer')) return; // links inside the drawer navigate normally
    const m = a.getAttribute('href').match(/^\/players\/([a-z0-9-]+)\/?$/);
    if (!m) return;
    e.preventDefault(); e.stopImmediatePropagation();
    open(m[1], a);
  });
}
