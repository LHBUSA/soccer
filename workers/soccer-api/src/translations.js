// Reader side of the newsroom translations (soccer-news translate.js; contract workers/shared/article-i18n.js).
// A translation is SERVED only when ALL hold: its locale is public (ARTICLE_LOCALES[l].enabled), its version is the one
// published version, the English article is published with the same evidence packet, and - on the article page - its
// source revision hash equals the live English text's. Lists / sitemaps use the cheap equivalent (the English row's
// updated_at equals the one the translation was verified against; the newsroom's lifecycle sweep keeps that true).
// Anything else -> English, with no translation claimed (no hreflang, no Spanish canonical, no sitemap entry).
import { ARTICLE_LOCALES, servedLocale, sourceRevision, applyTranslation } from '../../shared/article-i18n.js';

export const PUBLIC_LOCALES = Object.keys(ARTICLE_LOCALES).filter(servedLocale);

/** Published translations (public locales only) for these English article ids: Map article_id -> rows. */
export async function liveTranslations(store, ids, { columns = ['article_id', 'locale', 'version', 'source_revision', 'source_updated_at', 'packet_hash', 'headline', 'dek', 'published_at'] } = {}) {
  const out = new Map();
  if (!ids.length || !PUBLIC_LOCALES.length) return out;
  for (let i = 0; i < ids.length; i += 150) {
    for (const r of await store.select('soccer_article_translations', { columns, eq: { status: 'published' }, in: { article_id: ids.slice(i, i + 150), locale: PUBLIC_LOCALES } })) {
      if (!out.has(r.article_id)) out.set(r.article_id, []);
      out.get(r.article_id).push(r);
    }
  }
  return out;
}

/** Cheap currency check for lists and sitemaps (no body needed). */
export const currentCheap = (a, t) => !!t && a.packet_hash === t.packet_hash && new Date(a.updated_at).getTime() === new Date(t.source_updated_at).getTime();

/**
 * Article page: { article (localized when served), translations: { es: true, ... }, translation: {...} | null }.
 * `a` must still carry its id, packet_hash and full English body (before any visual filtering).
 */
export async function localizeArticle(store, a, locale) {
  const rows = (await liveTranslations(store, [a.id], { columns: ['article_id', 'locale', 'version', 'source_revision', 'source_updated_at', 'packet_hash', 'segments', 'published_at'] })).get(a.id) || [];
  const rev = rows.length ? sourceRevision(a) : null;
  const current = rows.filter(t => t.packet_hash === a.packet_hash && t.source_revision === rev);
  const translations = Object.fromEntries(current.map(t => [t.locale, true]));
  const t = locale && locale !== 'en' ? current.find(x => x.locale === locale) : null;
  const applied = t ? applyTranslation(a, t.segments, locale) : null;
  if (!applied) return { article: { ...a, locale: 'en', translations }, translated: false };
  return { article: { ...applied, translations, translation: { locale, version: t.version, verified_at: t.published_at, source_locale: 'en' } }, translated: true };
}

/** News cards: headline/dek in `locale` where a current translation exists; `translations` on every card. */
export async function localizeCards(store, rows, locale) {
  const live = await liveTranslations(store, rows.map(r => r.id).filter(Boolean));
  for (const r of rows) {
    const cur = (live.get(r.id) || []).filter(t => currentCheap(r, t));
    r.translations = Object.fromEntries(cur.map(t => [t.locale, true]));
    const t = locale ? cur.find(x => x.locale === locale) : null;
    if (t) { r.headline = t.headline; r.dek = t.dek ?? r.dek; r.locale = locale; } else r.locale = 'en';
  }
  return rows;
}
