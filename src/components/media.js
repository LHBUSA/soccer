// Entity identity images: the ONE place a portrait or crest is drawn (docs/MEDIA.md).
// Only approved media the API exposes (url + attribution) is ever shown; everything else gets
// an owned fallback: the typographic initials mark for clubs, the neutral raster silhouette for
// players. A broken approved file is swapped for the same fallback in the browser
// (mountMediaFallbacks), so no broken image ever renders.
//
// Images are decorative next to a visible name (alt=""); the attribution rides on title.
import { esc } from '../lib/html.js';
import { compMeta } from '../lib/competitions.js';
import { COMPETITION_MEDIA } from '../lib/competition-media.js';

export const SILHOUETTE = '/brand/player-silhouette-128.webp';
export const SILHOUETTE_2X = '/brand/player-silhouette-256.webp';
const PX = { xs: 24, sm: 32, md: 44, lg: 64, xl: 96 };

const SKIP = new Set(['fc', 'cf', 'sc', 'afc', 'ac', 'cd', 'sv', 'vfl', 'vfb', 'tsg', 'fsv', '1.', 'de', 'of', 'the', 'and', '&', 'club']);
export function initials(name) {
  const words = String(name || '').replace(/[^\p{L}\p{N}\s.&-]/gu, '').split(/[\s-]+/).filter(Boolean);
  const core = words.filter(w => !SKIP.has(w.toLowerCase()) && !/^\d/.test(w));
  const use = core.length ? core : words;
  if (!use.length) return '?';
  if (use.length === 1) return use[0].slice(0, 3).toUpperCase();
  return use.slice(0, 4).map(w => w[0]).join('').toUpperCase();
}

// Club crest (approved, roster-proven) or the typographic initials mark. size: '' | xs | md | xl
// ('lg' is taken by the legend dot class).
export function crest(t, size = '') {
  const cls = `tmark${size ? ` ${size}` : ''}`;
  const mark = initials(t?.short_name || t?.name);
  if (t?.crest?.url) {
    const who = t.type === 'national' ? 'national team' : 'club';
    const credit = t.crest.attribution ? `${t.crest.attribution}. Used to identify the ${who}.` : `Used to identify the ${who}.`;
    return `<span class="${cls} img"><img src="${esc(t.crest.url)}" alt="" title="${esc(credit)}" loading="lazy" decoding="async" width="64" height="64" data-fallback="${esc(mark)}"></span>`;
  }
  return `<span class="${cls}${mark.length > 3 ? ' m4' : ''}" aria-hidden="true">${esc(mark)}</span>`;
}

// The portrait descriptor as the API ships it: lists carry `portrait` ({ url, attribution });
// the player page carries `media` (array with media_type).
export const portraitOf = p => p?.portrait || (Array.isArray(p?.media) ? p.media.find(m => m.media_type === 'portrait') : null) || null;

// Player portrait or the neutral silhouette. size: xs | sm | md | lg | xl.
export function portrait(p, size = 'sm', { alt = '' } = {}) {
  const px = PX[size] || PX.sm;
  const pic = portraitOf(p);
  if (pic?.url) {
    return `<span class="pic pic-${size}"><img src="${esc(pic.url)}" alt="${esc(alt)}"${pic.attribution ? ` title="Photo: ${esc(pic.attribution)}"` : ''} loading="lazy" decoding="async" width="${px}" height="${px}" data-fallback-portrait></span>`;
  }
  return `<span class="pic pic-${size} sil" aria-hidden="true"><img src="${SILHOUETTE}" srcset="${SILHOUETTE} 128w, ${SILHOUETTE_2X} 256w" sizes="${px}px" alt="" loading="lazy" decoding="async" width="${px}" height="${px}"></span>`;
}

// Competition identity: the approved cached logo (src/lib/competition-media.js) or the typographic mono.
// tone: 'light' = the provider's default logo for light surfaces; 'dark' = the provider's own dark-surface
// variant (no recolouring by us). size: xs | '' | lg | xl.
export function competitionMark(slug, size = '', { tone = 'light' } = {}) {
  const c = compMeta(slug);
  const cls = `cmono a-${c?.accent || 'x'}${size ? ` ${size}` : ''}`;
  const mono = c?.mono || initials(String(slug || '').replace(/-/g, ' '));
  const logo = COMPETITION_MEDIA[slug];
  if (!logo?.url) return `<span class="${esc(cls)}" aria-hidden="true">${esc(mono)}</span>`;
  const src = tone === 'dark' && logo.url_dark ? logo.url_dark : logo.url;
  return `<span class="clogo t-${tone}${size ? ` ${size}` : ''}" title="${esc(logo.attribution)}. Used to identify the competition."><img src="${esc(src)}" alt="" loading="lazy" decoding="async" width="64" height="64" data-fallback-comp="${esc(mono)}" data-fallback-class="${esc(cls)}"></span>`;
}

// A broken approved file never shows as a broken image.
export function mountMediaFallbacks(root) {
  for (const img of root.querySelectorAll('img[data-fallback]')) {
    const swap = () => { const s = document.createElement('span'); s.className = img.parentElement.className.replace(' img', ''); s.textContent = img.dataset.fallback; s.setAttribute('aria-hidden', 'true'); img.parentElement.replaceWith(s); };
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  }
  for (const img of root.querySelectorAll('img[data-fallback-comp]')) {
    const swap = () => { const s = document.createElement('span'); s.className = img.dataset.fallbackClass; s.textContent = img.dataset.fallbackComp; s.setAttribute('aria-hidden', 'true'); img.parentElement.replaceWith(s); };
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  }
  for (const img of root.querySelectorAll('img[data-fallback-portrait]')) {
    const swap = () => { img.removeAttribute('data-fallback-portrait'); img.removeAttribute('title'); img.src = SILHOUETTE; img.srcset = `${SILHOUETTE} 128w, ${SILHOUETTE_2X} 256w`; img.parentElement.classList.add('sil'); };
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  }
}
