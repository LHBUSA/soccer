// Google Preferred Sources — shared PropBetEdge control (network reference: propbetedge-news-site
// src/components/preferred-source.js). Our own markup, visible on first paint; the href is the
// documented preferences deeplink, so the control works with no SDK and before any JS binds.
//
// Source policy (google.com/preferences/source, checked 2026-09-30):
//   eligible:   propbetedge.ai, mlb.propbetedge.ai, ufc.propbetedge.ai -> Google SDK, own host
//   not listed: nfl/nba/wnba/nhl/tennis/soccer.propbetedge.ai        -> deeplink to propbetedge.ai
// soccer.propbetedge.ai is not listed (and the CSP does not allow news.google.com scripts), so
// this site never loads publisher.js: every click is the deeplink to the parent source.
import { esc } from '../lib/html.js';

const PARENT_SOURCE = 'propbetedge.ai';
const ELIGIBLE_SOURCES = new Set(['propbetedge.ai', 'mlb.propbetedge.ai', 'ufc.propbetedge.ai']);
const SPORT = 'soccer';

let installed = false;

export function preferredSourceTarget(host = typeof location === 'undefined' ? '' : location.hostname) {
  const h = String(host || '').toLowerCase().replace(/^www\./, '');
  if (ELIGIBLE_SOURCES.has(h)) return { source: h, sdk: true };
  return { source: PARENT_SOURCE, sdk: false };
}

export const preferredSourceDeeplink = (source = preferredSourceTarget().source) =>
  `https://www.google.com/preferences/source?q=${encodeURIComponent(source)}`;

// surface: 'footer' | 'article'
export function renderPreferredSource({ surface = 'footer' } = {}) {
  const attrs = `href="${esc(preferredSourceDeeplink())}" target="_blank" rel="noopener" data-pbe-preferred-source data-surface="${esc(surface)}" data-sport="${SPORT}" aria-label="Add PropBetEdge as a preferred source in Google Search (opens Google)"`;
  if (surface === 'article') {
    return `<aside class="psrc psrc--article" aria-labelledby="psrc-article-h">
      <div class="psrc-copy"><b id="psrc-article-h">Enjoy PropBetEdge reporting?</b><span>Make us a preferred source in Google.</span></div>
      <a class="psrc-btn" ${attrs}>Add PropBetEdge</a>
    </aside>`;
  }
  return `<div class="psrc psrc--${esc(surface)}">
      <div class="psrc-copy"><span class="psrc-eyebrow">GOOGLE SEARCH</span><b>Make PropBetEdge a preferred source</b><span>See more PropBetEdge reporting in Google.</span></div>
      <a class="psrc-btn" ${attrs}>Add as preferred source</a>
    </div>`;
}

// Idempotent: one delegated listener covers every control rendered now or by later route renders.
export function mountPreferredSource({ win = window, doc = document } = {}) {
  if (installed || !doc) return false;
  installed = true;
  doc.addEventListener('click', (event) => {
    const el = event.target?.closest?.('[data-pbe-preferred-source]');
    if (!el || typeof win.gtag !== 'function') return;
    win.gtag('event', 'preferred_source_click', {
      surface: el.dataset.surface || 'footer',
      sport: el.dataset.sport || SPORT,
      method: 'deeplink_fallback'
    });
  });
  return true;
}

export const __test = { reset() { installed = false; } };
