// PropBetEdge family registry for the Soccer network footer. Must match the vendored canonical registry
// src/lib/family.json (LHBUSA/propbetedge-workers shared/network/family.json; re-vendor, never hand-edit);
// tests/web/network-parity.test.js fails on drift. Kept apart from the membership contract
// (pbe-membership.js NETWORK / SPORT_LABELS), which is copied verbatim and lists membership sports only.
export const CURRENT_SPORT = 'soccer';

export const SPORTS = Object.freeze([
  { key: 'mlb', label: 'MLB', url: 'https://mlb.propbetedge.ai/' },
  { key: 'nfl', label: 'NFL', url: 'https://nfl.propbetedge.ai/' },
  { key: 'nba', label: 'NBA', url: 'https://nba.propbetedge.ai/' },
  { key: 'wnba', label: 'WNBA', url: 'https://wnba.propbetedge.ai/' },
  { key: 'nhl', label: 'NHL', url: 'https://nhl.propbetedge.ai/' },
  { key: 'ufc', label: 'UFC', url: 'https://ufc.propbetedge.ai/' },
  { key: 'tennis', label: 'Tennis', url: 'https://tennis.propbetedge.ai/' },
  { key: 'soccer', label: 'Soccer', url: 'https://soccer.propbetedge.ai/' },
  { key: 'golf', label: 'Golf', url: 'https://golf.propbetedge.ai/' },
  { key: 'f1', label: 'F1', url: 'https://f1.propbetedge.ai/' },
]);

/* Non-sport All Access products: never merged into SPORTS, never counted as a sport. */
export const PRODUCTS = Object.freeze([
  { key: 'members', kind: 'product', label: 'Command Center', url: 'https://members.propbetedge.ai/' },
  { key: 'compare', kind: 'product', label: 'Compare', url: 'https://compare.propbetedge.ai/' },
  { key: 'predictions', kind: 'product', label: 'Predictions', url: 'https://predictions.propbetedge.ai/' },
]);

export const NETWORK_LINKS = Object.freeze({
  hub: 'https://propbetedge.ai/',
  all_access: 'https://propbetedge.ai/pro',
  learn: 'https://learn.propbetedge.ai/',
});
