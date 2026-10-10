// Browser localization pass. Pages keep rendering their English templates; this module translates the rendered
// UI strings in place (catalog, whole strings only) and keeps internal links inside the reader's language.
// A MutationObserver covers everything rendered later: live PBEcast/match refreshes, the score ticker, the
// account sheet, the player drawer and late data loads.
//
// Never translated (left byte-for-byte as sourced):
//   - article bodies (.art-body): newsroom translation is a separately verified editorial release;
//   - Kalshi / article-market modules: market names, prices and settlement rules stay exactly as published; the
//     article-market module (.am) renders its own copy natively in the page locale (shared component opts.locale);
//   - anything marked translate="no" or data-i18n-skip.
import { translateHtml, translateText } from './translate.js';
import { isLocalizable, localizePath } from './locales.js';

export const SKIP = '.art-body, [data-kx-impression], .kx, .kx-strip, .kx-line, .avm, .am, [data-art-market], script, style, noscript, code, pre, textarea, [translate="no"], [data-i18n-skip]';
const ATTRS = ['aria-label', 'title', 'placeholder', 'alt'];
const written = new WeakMap(); // node -> value we wrote (so our own writes are not re-processed)

function textNode(n, locale) {
  const v = n.nodeValue;
  if (!v || written.get(n) === v || !/[A-Za-z]/.test(v)) return;
  const p = n.parentElement;
  if (!p || p.closest(SKIP)) return;
  const t = translateText(v, locale);
  if (t !== v) { n.nodeValue = t; written.set(n, t); }
}

function element(el, locale) {
  if (el.closest(SKIP)) {
    // Protected English content inside a localized page is announced as English.
    if (el.matches('.art-body') && !el.hasAttribute('lang')) el.setAttribute('lang', 'en');
    return;
  }
  if (/^H[1-3]$/.test(el.tagName) && el.childElementCount) {
    const h = translateHtml(el.innerHTML, locale);
    if (h !== null) { el.innerHTML = h; return; }
  }
  for (const a of ATTRS) {
    const v = el.getAttribute(a);
    if (v && /[A-Za-z]/.test(v)) { const t = translateText(v, locale); if (t !== v) el.setAttribute(a, t); }
  }
  if (el.tagName === 'A') {
    const h = el.getAttribute('href');
    if (h && isLocalizable(h) && !el.hasAttribute('data-lang-switch')) { const l = localizePath(h, locale); if (l !== h) el.setAttribute('href', l); }
  }
}

/** Localizes a subtree in place. */
export function localizeTree(root, locale) {
  if (!root || locale === 'en') return;
  if (root.nodeType === 3) { textNode(root, locale); return; }
  if (root.nodeType !== 1) return;
  element(root, locale);
  for (const el of root.querySelectorAll('*')) element(el, locale);
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) textNode(n, locale);
}

/** Starts localizing everything rendered under `root` from now on. Returns the observer. */
export function observeLocale(root, locale) {
  if (locale === 'en' || typeof MutationObserver === 'undefined') return null;
  localizeTree(root, locale);
  const mo = new MutationObserver(records => {
    for (const r of records) {
      if (r.type === 'childList') for (const n of r.addedNodes) localizeTree(n, locale);
      else if (r.type === 'characterData') textNode(r.target, locale);
      else if (r.type === 'attributes') element(r.target, locale);
    }
  });
  mo.observe(root, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: [...ATTRS, 'href'] });
  return mo;
}
