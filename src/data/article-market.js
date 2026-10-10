// Article Market module for soccer news (contract article-market/1; propbetedge-workers
// docs/POST_EVENT_MARKET_RESULT.md). ONE module with a lifecycle on an article linked to ONE match:
// LIVE MARKET WATCH while the market trades -> THE MARKET RESULT once the match is over.
//
// - Link = the article's SportsEvent entity (our soccer match UUID = the canonical event id). Never a title match.
// - Prospective only (owner 2026-10-04, NO BACKFILL): the shared API refuses articles first published before its
//   activation time. ACTIVATED_AT below only saves a request for older stories; the API stays the authority.
// - published_at = the ORIGINAL publication time (corrections never move the market baseline).
// - Read through the same-origin rewrite /api/markets/* (vercel.json, exact route). Never Kalshi or Polymarket.
// - Nothing eligible / nothing observed / a failed read -> nothing rendered (never a placeholder).
// - Language: the shared component renders its own copy natively in the page locale (opts.locale; LHBUSA/soccer#16).
//   The DOM localizer never touches it (src/i18n/dom.js SKIP has .am): no half-translated market sentence.
import { articleMarketModule, mountArticleMarket } from '../vendor/kalshi/article-market-ui.js';
import { byDeadline, KALSHI_FIRST_PAINT_MS, MARKETS_BASE } from './kalshi.js';
import { currentLocale } from '../i18n/current.js';

export const ARTICLE_MARKET_ACTIVATED_AT = '2026-10-04T14:31:40Z';
export const ARTICLE_MARKET_REFRESH_MS = 30_000;

/** The canonical match id of an eligible article, else null. */
export function articleMarketEvent(a) {
  const pub = Date.parse(a?.published_at || '');
  if (!Number.isFinite(pub) || pub < Date.parse(ARTICLE_MARKET_ACTIVATED_AT)) return null;
  const match = (a?.entities || []).find(e => e.type === 'SportsEvent' && e.href);
  const id = match ? match.href.split('/').pop() : null;
  return id && /^[0-9a-f-]{36}$/.test(id) ? id : null;
}

export async function loadArticleMarket(id, publishedAt, fetchImpl = (...x) => globalThis.fetch(...x)) {
  try {
    const r = await fetchImpl(`${MARKETS_BASE}/v1/article-market/soccer/${encodeURIComponent(id)}?published_at=${encodeURIComponent(publishedAt)}`);
    if (!r.ok) return null;
    const body = await r.json();
    return body?.eligible ? body : null;
  } catch { return null; }
}

/** Load-time read: waits at most until `deadline` (shared first-paint budget). undefined = still pending. */
export function articleMarketWithin(a, deadline = Date.now() + KALSHI_FIRST_PAINT_MS) {
  const id = articleMarketEvent(a);
  if (!id) return { now: null, pending: null };
  const p = loadArticleMarket(id, a.published_at);
  return byDeadline(p, deadline).then(now => ({ now: now === undefined ? null : now, pending: now === undefined ? p : null }));
}

export const articleMarketHtml = (payload, locale = currentLocale()) => (payload ? articleMarketModule(payload, { placement: 'soccer-article', locale }) : '');

/**
 * Mount on the rendered article. First paint already holds the module when the read beat the budget; a late answer
 * is inserted only while its slot is below the viewport (no visible layout shift), then refreshes ~30 s while visible.
 */
export function mountArticleMarketSlot(root, a, { now = null, pending = null } = {}) {
  const slot = root.querySelector('[data-art-market]');
  const id = articleMarketEvent(a);
  if (!slot || !id) return () => {};
  const start = initial => mountArticleMarket(slot, { base: MARKETS_BASE, sport: 'soccer', eventId: id, publishedAt: a.published_at, initial, refreshMs: ARTICLE_MARKET_REFRESH_MS, locale: currentLocale() });
  if (now) return start(now);
  if (!pending) return () => {};
  let stop = () => {};
  pending.then(late => {
    if (!late || !slot.isConnected) return;
    if (slot.getBoundingClientRect().top < window.innerHeight) return; // would shift what the reader sees: skip
    stop = start(late);
  });
  return () => stop();
}
