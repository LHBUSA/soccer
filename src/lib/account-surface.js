// SOCCER PREMIUM ACCOUNT SURFACE: presentation model (owner decisions 2026-10-05, network
// account standard; NFL is the benchmark). Renders FROM the server verdict that /api/soccer/pro/access
// returns ({ pro, membership, check }); it never decides or widens access.
//
// Three link jobs, three constants (never one constant for all three):
//   LOCAL_ALL_ACCESS_PATH    the native /all-access page on this site: informational links only
//   NETWORK_ALL_ACCESS_URL   propbetedge.ai/pro, reference only
//   ALL_ACCESS_CHECKOUT_URL  the canonical All Access Stripe Payment Link: every explicit purchase action
// Owner link policy: the All Access purchase path is DIRECT STRIPE. A purchase action keeps the Stripe link;
// only informational links (WHAT'S INCLUDED, the network) open the local page.
// Soccer has no single-sport plan: All Access and owner are the only grants. "Platinum" is presentation for
// the all_access state only; the backend state, the Stripe product and the vendored contract are unchanged.
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL } from './pbe-membership.js';
import { SPORTS, PRODUCTS, CURRENT_SPORT } from './network.js';

export const LOCAL_ALL_ACCESS_PATH = '/all-access';
export const NETWORK_ALL_ACCESS_URL = ALL_ACCESS_URL;
export const ALL_ACCESS_CHECKOUT_URL = ALL_ACCESS_OFFER.checkoutUrl;
export const PRICE = ALL_ACCESS_OFFER.price;
export const PROMO_CODE = ALL_ACCESS_OFFER.promoCode;
export const PROMO_LINE = ALL_ACCESS_OFFER.promoLine;
export const PLATINUM_TRUTH = 'PropBetEdge All Access · 10 sports + Predictions';

/** The signed-in reader's verified email rides on the Stripe link (owner-approved); the URL itself never changes. */
export const checkoutFor = email => (email ? `${ALL_ACCESS_CHECKOUT_URL}?prefilled_email=${encodeURIComponent(email)}` : ALL_ACCESS_CHECKOUT_URL);

// The network, from the vendored family registry (network.js is parity-tested against family.json).
export const sportName = s => (s.key === 'f1' ? 'F1 Intelligence' : s.label);
export const NETWORK_SPORTS = SPORTS.map(s => ({ ...s, name: sportName(s), here: s.key === CURRENT_SPORT }));
export const PREDICTIONS = PRODUCTS.find(p => p.key === 'predictions');
export const OFFER_LINE = `${SPORTS.length} sports + ${PREDICTIONS.label}`;
export const SPORTS_LINE = NETWORK_SPORTS.map(s => s.name).join(' · ');
export const PREDICTIONS_BLURB = 'Independent, source-backed forecasts with model probability, market comparison and a scored record.';

/** Member designation. FREE has none: a reader who is not a member is never labelled FREE. */
export function designation(state) {
  if (state === 'all_access') return { badge: '◆ PLATINUM', eyebrow: 'SOCCER · PLATINUM MEMBER', status: 'PLATINUM ACCESS ACTIVE', truth: PLATINUM_TRUTH, tone: 'platinum' };
  if (state === 'owner') return { badge: 'VERIFIED OWNER', eyebrow: 'SOCCER · VERIFIED OWNER', status: 'OWNER ACCESS ACTIVE', truth: null, tone: 'owner' };
  return null;
}

/** One view per server verdict. A failed check is the access-check state: never sales, never FREE. */
export function accountView(a) {
  const m = a?.membership || {};
  if (a?.pro === true) return m.state === 'owner' ? 'owner' : 'all_access';
  if (a?.check === 'unavailable') return 'check';
  return m.email ? 'signed_in' : 'signed_out';
}

/** Header account button: designation for members, ACCESS CHECK while unverified, never FREE. */
export function headerLabel(a) {
  const v = accountView(a);
  if (v === 'all_access' || v === 'owner') return designation(v).badge;
  if (v === 'check') return 'ACCESS CHECK';
  return v === 'signed_in' ? 'ACCOUNT' : 'SIGN IN';
}

// What All Access actually unlocks on Soccer (server-gated, 403 without values otherwise), the research that is
// NOT a product yet, and what every reader already has. Model Lab publishes no probabilities.
export const PRO_UNLOCKS = Object.freeze([
  { key: 'match-center', label: 'Pro Match Center', sub: 'Both sides’ load, every upcoming match', href: '/pro#match-center' },
  { key: 'fatigue', label: 'Fatigue Intelligence', sub: 'Team Fatigue Index · XI Load', href: '/pro#fatigue' },
  { key: 'rotation', label: 'Rotation / XI Stability', sub: 'XI continuity · rest differential', href: '/pro#rotation' },
  { key: 'matchup', label: 'Matchup Analyzer', sub: 'Descriptive, not a prediction', href: '/pro#matchup' },
]);
export const RESEARCH = Object.freeze([
  { key: 'model-lab', label: 'Model Lab', sub: 'Research in progress · no probabilities published', href: '/pro#model-lab' },
]);
export const FREE_FEATURES = Object.freeze(['Match intelligence', 'PBEcast', 'Player DNA', 'Verified tables', 'Team & competition hubs', 'News', 'Official video']);
