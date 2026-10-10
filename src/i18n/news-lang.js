// Story language on a localized page (LHBUSA/soccer#16). A news card or story link shows the headline the API
// served: the verified translation (card.locale === page locale) or the English original (card.locale 'en', or no
// locale at all, e.g. a video's linked story). An English headline on a Spanish page is announced as English
// (lang="en"), never touched by the DOM localizer (data-i18n-skip) and labelled "En inglés" in the page's own
// language. Its link stays /es/news/<slug>, whose canonical is the English article (no Spanish SEO copy).
// Never a browser-side translation of the headline.
import { currentLocale } from './current.js';

export const IN_ENGLISH = { es: 'En inglés', pt: 'Em inglês', fr: 'En anglais' };

/** True when this story's headline is not in the page language. */
export const foreignStory = (a, page = currentLocale()) => page !== 'en' && (a?.locale || 'en') !== page;

/** Attributes for the element holding the headline. */
export const storyLangAttrs = (a, page = currentLocale()) => (foreignStory(a, page) ? ' lang="en" data-i18n-skip' : '');

/** The "En inglés" tag (empty on English pages and for stories in the page language). */
export const storyLangTag = (a, page = currentLocale()) => (foreignStory(a, page) && IN_ENGLISH[page] ? `<span class="lang-tag" lang="${page}" data-i18n-skip>${IN_ENGLISH[page]}</span>` : '');

/** Stories in the page language only (rails / related coverage on a localized page). English pages: all. */
export const inPageLanguage = (items, page = currentLocale()) => (page === 'en' ? items || [] : (items || []).filter(a => (a?.locale || 'en') === page));
