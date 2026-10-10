// PropBetEdge Soccer GA4 — one network property, production only.
// Bundled locally so the site's strict CSP does not require unsafe-inline.
// GA4 Enhanced Measurement owns browser-history page views for this path-based SPA.

export const GA_ID = 'G-BRS48R8PG9';
export const GA_SURFACE = 'soccer';
export const PROD_HOST = 'soccer.propbetedge.ai';

let enabled = false;
let clickInstalled = false;

export const isProductionHost = (hostname = '') => String(hostname).toLowerCase() === PROD_HOST;

export function initAnalytics({ win = window, doc = document } = {}) {
  if (enabled || !isProductionHost(win?.location?.hostname)) return false;

  win.dataLayer = win.dataLayer || [];
  win.gtag = win.gtag || function () { win.dataLayer.push(arguments); };
  win.gtag('js', new Date());
  win.gtag('set', { pbe_surface: GA_SURFACE });
  win.gtag('config', GA_ID, {
    cookie_domain: '.propbetedge.ai',
    cookie_flags: 'SameSite=Lax;Secure'
  });

  if (!doc.querySelector(`script[data-pbe-ga4="${GA_ID}"]`)) {
    const tag = doc.createElement('script');
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(GA_ID)}`;
    tag.dataset.pbeGa4 = GA_ID;
    tag.crossOrigin = 'anonymous';
    doc.head.appendChild(tag);
  }

  if (!clickInstalled) {
    clickInstalled = true;
    doc.addEventListener('click', (event) => {
      const target = event.target?.closest?.('a[href]');
      if (!target) return;
      try {
        const url = new URL(target.href, win.location.href);
        const host = url.hostname.toLowerCase();
        if (host !== PROD_HOST && (host === 'propbetedge.ai' || host.endsWith('.propbetedge.ai'))) {
          win.gtag('event', 'pbe_network_click', {
            pbe_surface: GA_SURFACE,
            source_host: PROD_HOST,
            target_host: host,
            link_url: `${url.origin}${url.pathname}`,
            // Global #67: the page language and the via/lang the link carries (never personal data).
            page_locale: doc.documentElement?.lang || 'en',
            via: url.searchParams.get('via') || ''
          });
        }
      } catch { /* ignore non-http hrefs */ }
    }, { capture: true });
  }

  enabled = true;
  return true;
}

export const __test = { reset() { enabled = false; clickInstalled = false; } };
