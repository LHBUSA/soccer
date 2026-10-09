// Locale registry for PropBetEdge Soccer. Pure: shared by the browser bundle, middleware.js and api/sitemap.js.
// English is the source language and lives at unprefixed URLs; every other locale lives under /<code>/.
// A locale is offered to readers (selector, hreflang, redirects) only when `ready` is true. Adding a language:
// add its catalog under src/i18n/catalog/, register it here with ready:false, ship + verify, then flip ready.
export const DEFAULT_LOCALE = 'en';

export const LOCALES = {
  en: { code: 'en', ready: true, native: 'English', short: 'EN', htmlLang: 'en', intl: 'en-GB', og: 'en_US', hreflang: 'en', langLabel: 'Language' },
  es: { code: 'es', ready: true, native: 'Español', short: 'ES', htmlLang: 'es', intl: 'es-ES', og: 'es_ES', hreflang: 'es', langLabel: 'Idioma' },
  pt: { code: 'pt', ready: false, native: 'Português', short: 'PT', htmlLang: 'pt-BR', intl: 'pt-BR', og: 'pt_BR', hreflang: 'pt', langLabel: 'Idioma' },
  fr: { code: 'fr', ready: false, native: 'Français', short: 'FR', htmlLang: 'fr', intl: 'fr-FR', og: 'fr_FR', hreflang: 'fr', langLabel: 'Langue' },
};

export const READY_LOCALES = Object.values(LOCALES).filter(l => l.ready).map(l => l.code);
// Cookie that remembers the reader's choice on the Soccer site (host-only, functional preference, no identity).
export const LANG_COOKIE = 'pbe_lang';
// Spanish-language entry domain: redirects to the Spanish experience once the domain is attached in Vercel.
export const LOCALE_HOSTS = { 'futbol.propbetedge.ai': 'es' };

const PREFIX = new RegExp(`^/(${Object.keys(LOCALES).filter(c => c !== DEFAULT_LOCALE).join('|')})(?=/|$)`);

/** Splits a pathname into { locale, path }. Only READY locales are honoured; an unready prefix stays in the path (-> 404). */
export function splitLocale(pathname = '/') {
  const m = pathname.match(PREFIX);
  if (!m || !LOCALES[m[1]]?.ready) return { locale: DEFAULT_LOCALE, path: pathname || '/' };
  return { locale: m[1], path: pathname.slice(m[0].length) || '/' };
}

// Paths that are files, APIs or generated assets never get a locale prefix.
const UNLOCALIZED = /^\/(api|og|assets|brand|share|src|@vite|node_modules)(\/|$)|^\/(sitemap[^/]*|robots\.txt)$|\.[a-z0-9]{2,12}$/i;
export const isLocalizable = path => typeof path === 'string' && path.startsWith('/') && !path.startsWith('//') && !UNLOCALIZED.test(path.split(/[?#]/)[0]);

/** Returns `href` (a site-relative path, optionally with ?query/#hash) in `locale`. Idempotent. */
export function localizePath(href, locale = DEFAULT_LOCALE) {
  if (!isLocalizable(href)) return href;
  const i = href.search(/[?#]/);
  const pathname = i < 0 ? href : href.slice(0, i);
  const rest = i < 0 ? '' : href.slice(i);
  const { path } = splitLocale(pathname);
  if (locale === DEFAULT_LOCALE || !LOCALES[locale]?.ready) return path + rest;
  return `/${locale}${path === '/' ? '/' : path}${rest}`;
}

export function readLangCookie(cookieHeader = '') {
  const m = String(cookieHeader).match(new RegExp(`(?:^|;\\s*)${LANG_COOKIE}=([a-z]{2})`));
  return m && LOCALES[m[1]]?.ready ? m[1] : null;
}

/** hreflang alternates for an unprefixed `path`: every ready locale (or only `codes`, e.g. the languages a translated
 * article truly exists in) plus x-default (English). */
export const alternateLinks = (path, site = 'https://soccer.propbetedge.ai', codes = READY_LOCALES) => [
  ...READY_LOCALES.filter(code => codes.includes(code)).map(code => ({ hreflang: LOCALES[code].hreflang, url: `${site}${localizePath(path, code)}` })),
  { hreflang: 'x-default', url: `${site}${localizePath(path, DEFAULT_LOCALE)}` },
];
