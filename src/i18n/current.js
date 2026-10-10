// The page's locale, read once from the URL prefix (browser) and 'en' everywhere else (Node tests, middleware).
import { DEFAULT_LOCALE, LOCALES, splitLocale } from './locales.js';

let active = typeof location !== 'undefined' ? splitLocale(location.pathname).locale : DEFAULT_LOCALE;

export const currentLocale = () => active;
// News reads carry the page locale: the API serves a verified translation when one exists, else English.
export const newsLocale = (params = {}) => (active !== DEFAULT_LOCALE ? { ...params, locale: active } : params);
// A news card is listed natively on this page only when it IS in the page language: English pages list everything;
// a localized page lists only stories the API served as a verified current translation (card.locale, set by
// soccer-api localizeCards; English fallbacks carry locale 'en' or none). Never a browser-translated headline, never
// an unlabeled English headline under a Spanish rail, never a localized URL for a story that has no translation.
export const servedInLocale = (card, locale = active) => locale === DEFAULT_LOCALE || (!!card && card.locale === locale);
export const intlTag = () => LOCALES[active]?.intl || 'en-GB';
/** Tests only. */
export const setCurrentLocale = l => { active = LOCALES[l] ? l : DEFAULT_LOCALE; };
