// PropBetEdge Soccer analytics — consent-gated by the shared network privacy runtime.
export const GA_ID = 'G-BRS48R8PG9';
export const GA_SURFACE = 'soccer';
export const PROD_HOST = 'soccer.propbetedge.ai';

export const isProductionHost = (hostname = '') => String(hostname).toLowerCase() === PROD_HOST;

export function initAnalytics({ win = window } = {}) {
  if (!isProductionHost(win?.location?.hostname)) return false;
  const privacy = win?.PBEPrivacy;
  if (!privacy) return false;
  privacy.initAnalytics({ surface: GA_SURFACE, analytics: true, sendPageView: true });
  return privacy.analyticsAllowed();
}

export const __test = { reset() {} };
