// The page's locale, read once from the URL prefix (browser) and 'en' everywhere else (Node tests, middleware).
import { DEFAULT_LOCALE, LOCALES, splitLocale } from './locales.js';

let active = typeof location !== 'undefined' ? splitLocale(location.pathname).locale : DEFAULT_LOCALE;

export const currentLocale = () => active;
export const intlTag = () => LOCALES[active]?.intl || 'en-GB';
/** Tests only. */
export const setCurrentLocale = l => { active = LOCALES[l] ? l : DEFAULT_LOCALE; };
