// LANGUAGE SELECTOR: one compact globe control in the header nav (desktop) that becomes an inline
// language row inside the mobile menu. Only READY locales are listed. Choosing one stores the
// preference (cookie for the edge redirect, localStorage as a mirror) and loads the same page in that
// language with a full page load, so the server writes the localized title, canonical and hreflang.
import { LANG_COOKIE, LOCALES, READY_LOCALES, alternateLinks, localizePath, splitLocale } from '../i18n/locales.js';
import { currentLocale } from '../i18n/current.js';

const GLOBE = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3 12h18M12 3c2.6 2.6 3.9 5.6 3.9 9s-1.3 6.4-3.9 9M12 3C9.4 5.6 8.1 8.6 8.1 12s1.3 6.4 3.9 9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

// The same page in another language: current path (without prefix) + query, re-prefixed.
export const switchHref = (code, loc = typeof location !== 'undefined' ? location : { pathname: '/', search: '' }) => localizePath(splitLocale(loc.pathname).path + (loc.search || ''), code);

export function langMenu(locale = currentLocale()) {
  const cur = LOCALES[locale];
  // translate="no": language names are always written in their own language.
  const items = READY_LOCALES.map(code => {
    const l = LOCALES[code];
    return `<a href="${switchHref(code)}" data-lang-switch="${code}" hreflang="${l.hreflang}" lang="${l.htmlLang}" translate="no"${code === locale ? ' aria-current="true" class="on"' : ''}><b>${l.short}</b><span>${l.native}</span></a>`;
  }).join('');
  return `<div class="navmenu lang"><button type="button" class="navdrop lang-btn" aria-expanded="false" aria-controls="lang-panel" data-menu-toggle data-pages="" aria-label="${cur.langLabel}: ${cur.native}" translate="no">${GLOBE}<span>${cur.short}</span></button>
    <div id="lang-panel" class="navpanel lang-panel" role="group" aria-label="${cur.langLabel}" hidden>${items}</div></div>`;
}

export function rememberLocale(code) {
  try { document.cookie = `${LANG_COOKIE}=${code}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`; } catch { /* cookies blocked: the URL still carries the language */ }
  try { localStorage.setItem(LANG_COOKIE, code); } catch { /* storage blocked */ }
}

export function mountLangMenu(root = document) {
  root.addEventListener('click', e => {
    const a = e.target.closest?.('a[data-lang-switch]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    rememberLocale(a.dataset.langSwitch);
    a.setAttribute('href', switchHref(a.dataset.langSwitch)); // the SPA path may have moved since render
  });
}

/** Keeps the selector pointing at the current page after SPA navigation. */
export function syncLangLinks() {
  for (const a of document.querySelectorAll('a[data-lang-switch]')) a.setAttribute('href', switchHref(a.dataset.langSwitch));
}

/** hreflang alternates for `path` (unprefixed), or none when the page has no translated equivalent. */
export function syncAlternates(path, codes = undefined) {
  for (const l of document.querySelectorAll('link[rel="alternate"][hreflang]')) l.remove();
  if (!path) return;
  for (const href of alternateLinks(path, undefined, codes)) {
    const l = document.createElement('link'); l.rel = 'alternate'; l.hreflang = href.hreflang; l.href = href.url;
    document.head.appendChild(l);
  }
}
