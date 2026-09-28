// NEWSROOM V2 card system: ONE story object, one image resolver, four variants
// (featured | rail | standard | compact). Imagery priority: the story's approved player photo as a real
// photo panel -> an approved club crest graphic -> the competition's editorial graphic. Never a stadium
// backdrop with a floating circle; only same-origin approved media (docs/MEDIA.md).
import { esc, when } from '../lib/html.js';
import { ago, dateLong } from '../lib/format.js';
import { compByDesk } from '../lib/competitions.js';
import { storyLabel } from '../lib/news.js';
import { competitionMark } from './media.js';

// Category tone (subtle): match report, player form, team trend, table watch.
const TONE = { match_recap: 'report', player_form: 'form', team_trend: 'trend', competition_intelligence: 'table', match_preview: 'report' };
export const categoryOf = a => ({ tone: TONE[a?.story_class] || 'report', label: storyLabel(a?.story_class) });

// A dek that is only template metadata ("MLS 2026, 26 September 2026, Stadium.", "4 goals in 4
// consecutive appearances for X (2026).") is not an editorial standfirst: it is not shown as one.
const COMP = '(MLS|Major League Soccer|Premier League|Bundesliga|UEFA Champions League|Champions League)';
export function editorialDek(a) {
  const d = String(a?.dek || '').trim();
  if (!d) return null;
  if (new RegExp(`^${COMP}\\s+\\d{4}(\\/\\d{2})?\\s*[,.:]`, 'i').test(d)) return null;
  if (/^\d+ goals? in \d+ consecutive/i.test(d)) return null;
  return d;
}

const DIM = { featured: [1280, 720], standard: [640, 360], rail: [320, 240] };
export function newsImage(a, variant = 'standard', { eager = false } = {}) {
  const f = compByDesk(a.desk);
  const [w, h] = DIM[variant] || DIM.standard;
  const load = eager ? 'eager" fetchpriority="high' : 'lazy';
  const mark = f ? competitionMark(f.slug, variant === 'featured' ? 'xl' : 'lg', { tone: 'dark' }) : '';
  if (a.image?.url && a.image.kind === 'portrait') {
    return `<span class="nimg k-photo v-${variant} a-${esc(f?.accent || 'x')}"><span class="nimg-mark" aria-hidden="true">${mark}</span><img class="nimg-photo" src="${esc(a.image.url)}" alt="${esc(a.image.alt || '')}" width="${w}" height="${h}" loading="${load}" decoding="async"${a.image.attribution ? ` title="Photo: ${esc(a.image.attribution)}"` : ''} data-fallback-photo></span>`;
  }
  if (a.image?.url && a.image.kind === 'crest') {
    return `<span class="nimg k-crest v-${variant} a-${esc(f?.accent || 'x')}"><span class="nimg-mark" aria-hidden="true">${mark}</span><img class="nimg-crest" src="${esc(a.image.url)}" alt="${esc(a.image.alt || '')}" width="${Math.round(h * 0.6)}" height="${Math.round(h * 0.6)}" loading="${load}" decoding="async" data-fallback-photo></span>`;
  }
  return `<span class="nimg k-brand v-${variant} a-${esc(f?.accent || 'x')}"><span class="nimg-logo">${f ? competitionMark(f.slug, variant === 'featured' ? 'xl' : 'lg', { tone: 'dark' }) : ''}</span></span>`;
}

const href = a => `/news/${esc(a.desk)}/${esc(a.slug)}`;
const kicker = (a, { comp = true } = {}) => { const f = compByDesk(a.desk); const c = categoryOf(a); return `<span class="nk">${comp && f ? `${competitionMark(f.slug, 'xs')}<span class="nk-comp">${esc(f.name)}</span><span class="nk-dot" aria-hidden="true">·</span>` : ''}<span class="nk-cat t-${c.tone}">${esc(c.label)}</span></span>`; };
const time = a => `<time datetime="${esc(a.published_at)}" title="${esc(dateLong(a.published_at))}">${esc(ago(a.published_at))}</time>`;

export function newsCard(a, variant = 'standard', opts = {}) {
  if (!a) return '';
  const dek = editorialDek(a);
  const c = categoryOf(a);
  if (variant === 'featured') {
    return `<article class="nwc v-featured t-${c.tone}"><a class="nwc-link" href="${href(a)}" data-link>
      ${newsImage(a, 'featured', { eager: true })}
      <span class="nwc-body">${kicker(a)}<h2 class="nwc-head">${esc(a.headline)}</h2>${when(dek, () => `<p class="nwc-dek">${esc(dek)}</p>`)}
        <span class="nwc-foot">${time(a)}<span class="nwc-cta">Read story →</span></span></span></a></article>`;
  }
  if (variant === 'rail') {
    return `<article class="nwc v-rail t-${c.tone}"><a class="nwc-link" href="${href(a)}" data-link>${newsImage(a, 'rail')}
      <span class="nwc-body">${kicker(a)}<h3 class="nwc-head">${esc(a.headline)}</h3><span class="nwc-foot">${time(a)}</span></span></a></article>`;
  }
  if (variant === 'compact') {
    return `<article class="nwc v-compact t-${c.tone}"><a class="nwc-link" href="${href(a)}" data-link><span class="nwc-body">${kicker(a, opts)}<h3 class="nwc-head">${esc(a.headline)}</h3><span class="nwc-foot">${time(a)}</span></span></a></article>`;
  }
  return `<article class="nwc v-standard t-${c.tone}"><a class="nwc-link" href="${href(a)}" data-link>${newsImage(a, 'standard')}
    <span class="nwc-body">${kicker(a, opts)}<h3 class="nwc-head">${esc(a.headline)}</h3>${when(dek, () => `<p class="nwc-dek">${esc(dek)}</p>`)}<span class="nwc-foot">${time(a)}</span></span></a></article>`;
}

// A broken approved photo falls back to the competition graphic (never a broken image).
export function mountNewsImages(root) {
  for (const img of root.querySelectorAll('img[data-fallback-photo]')) {
    const swap = () => { const box = img.closest('.nimg'); if (!box) return; box.classList.remove('k-photo', 'k-crest'); box.classList.add('k-brand'); img.remove(); };
    if (img.complete && img.naturalWidth === 0) swap(); else img.addEventListener('error', swap, { once: true });
  }
}
