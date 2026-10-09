// The page's locale, read once from the URL prefix (browser) and 'en' everywhere else (Node tests, middleware).
import { DEFAULT_LOCALE, LOCALES, splitLocale } from './locales.js';

let active = typeof location !== 'undefined' ? splitLocale(location.pathname).locale : DEFAULT_LOCALE;

export const currentLocale = () => active;
// News reads carry the page locale: the API serves a verified translation when one exists, else English.
export const newsLocale = (params = {}) => (active !== DEFAULT_LOCALE ? { ...params, locale: active } : params);
export const intlTag = () => LOCALES[active]?.intl || 'en-GB';
/** Tests only. */
export const setCurrentLocale = l => { active = LOCALES[l] ? l : DEFAULT_LOCALE; };
