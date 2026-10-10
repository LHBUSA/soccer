// Global #67 (measurement M1): All Access acquisition attribution for localized pages.
// Uses only the approved, existing mechanism: the SAME canonical Stripe Payment Link gains two Payment Link URL
// parameters on a non-English page, and the network /pro page gains ?lang=&via= so its checkout keeps the tag.
//   locale=<lang>                          Stripe Checkout opens in the reader's language
//   client_reference_id=pbe-<lang>-pro-soccer  non-personal tag, reported only in aggregate (news-site
//                                          docs/global/sigma/08_locale_attribution.sql)
// No price, product, tax, billing or membership change. English pages are left byte-for-byte unchanged.
// Pure: no DOM, no network.
import { DEFAULT_LOCALE } from './locales.js';
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL } from '../lib/pbe-membership.js';

export const VIA = 'soccer';
export const PAYMENT_LINK = ALL_ACCESS_OFFER.checkoutUrl;
export const NETWORK_PRO = ALL_ACCESS_URL;
// Languages measured at checkout. The tag format is pbe-<lang>-pro-<via> (Stripe allows [A-Za-z0-9_-], <=200).
export const ATTRIBUTED_LOCALES = Object.freeze(['es']);

export const clientReferenceId = locale => `pbe-${locale}-pro-${VIA}`;

/** `href` with the locale + attribution tag when it is the All Access Payment Link on an attributed locale; any
 *  existing parameters (e.g. the owner-approved prefilled_email) are kept. Idempotent; never touches other links. */
export function attributeCheckout(href, locale = DEFAULT_LOCALE) {
  if (!ATTRIBUTED_LOCALES.includes(locale) || typeof href !== 'string' || !href.startsWith(PAYMENT_LINK)) return href;
  let url;
  try { url = new URL(href); } catch { return href; }
  if (`${url.origin}${url.pathname}` !== PAYMENT_LINK || url.searchParams.has('client_reference_id')) return href;
  url.searchParams.set('locale', locale);
  url.searchParams.set('client_reference_id', clientReferenceId(locale));
  return url.toString();
}

/** The network All Access page for a localized reader: English /pro tagged ?lang=<locale>&via=soccer, so the
 *  checkout button there carries the same tag (news-site src/global/attribution.js). Idempotent. */
export function attributeNetworkPro(href, locale = DEFAULT_LOCALE) {
  if (!ATTRIBUTED_LOCALES.includes(locale) || typeof href !== 'string') return href;
  const bare = href.replace(/\/$/, '');
  if (bare !== NETWORK_PRO) return href;
  return `${NETWORK_PRO}?lang=${locale}&via=${VIA}`;
}

/** Both rules, for the DOM pass. */
export const attributeHref = (href, locale) => attributeNetworkPro(attributeCheckout(href, locale), locale);
