// Kalshi Market Intelligence for soccer (contract market-intel/1).
//
// Kalshi is a PREDICTION MARKET: its prices are traded contract prices, not sportsbook odds and
// not a PropBetEdge model. The browser never calls Kalshi and never calls a Worker hostname: it
// reads our shared propsports-markets API through the same-origin edge rewrite /api/markets/*
// (vercel.json; exact soccer routes only), like every other read on this site (/api/soccer/*).
// The shared client + UI are vendored UNCHANGED in src/vendor/kalshi/.
//
// Canonical event id = our soccer match UUID (the same id as /matches/:uuid). Three outcomes per
// match (roles home / draw / away). Kalshi soccer game contracts settle on the 90-minute result
// incl. stoppage time, excluding extra time and penalties (API proposition `match_result_90min`).
// Only that proposition is shown: anything else renders nothing rather than a misread contract.
// No entry, a failed read or a timeout -> nothing rendered (never a placeholder).
import { createKalshiClient } from '../vendor/kalshi/kalshi-market-client.js';
import { kalshiCard, kalshiLine, kalshiStrip } from '../vendor/kalshi/kalshi-market-ui.js';

export const MARKETS_BASE = '/api/markets';
export const kalshi = createKalshiClient({ sport: 'soccer', base: MARKETS_BASE });

/** Longest the first paint may wait for the market read (it runs in parallel with the page data). */
export const KALSHI_FIRST_PAINT_MS = 800;
export const SOCCER_PROPOSITION = 'match_result_90min';
export const SETTLEMENT_NOTE = 'Settles on the result after 90 minutes plus stoppage time (no extra time or penalties).';

/** An entry we can describe exactly: the 90-minute result market, otherwise null. */
export function soccerEntry(entry) {
  return entry?.kalshi?.proposition === SOCCER_PROPOSITION ? entry : null;
}

/** Match status -> the client's poll lane: 'live' (20 s), 'pregame' (45 s), null (stop). */
export function kalshiPollState(status) {
  if (status === 'live') return 'live';
  if (status === 'scheduled') return 'pregame';
  return null;
}

const timer = ms => new Promise(r => setTimeout(() => r(undefined), Math.max(0, ms)));

/** Resolves with the promise's value or `undefined` once `deadline` (epoch ms) passes. Never rejects. */
export function byDeadline(promise, deadline) {
  return Promise.race([Promise.resolve(promise).catch(() => null), timer(deadline - Date.now())]);
}

/** Board read for card lines, bounded so a slow market API never holds the page. Never rejects. */
export function boardWithin(ms = KALSHI_FIRST_PAINT_MS) {
  return byDeadline(kalshi.loadBoard(), Date.now() + ms).then(() => null);
}

/** Restrained card line for a not-finished match (scheduled / live) with a market; else ''. */
export function kalshiLineFor(m) {
  if (!m?.id || !kalshiPollState(m.status)) return '';
  return kalshiLine(soccerEntry(kalshi.forEvent(m.id)));
}

const note = () => `<p class="kx-soccer-note">${SETTLEMENT_NOTE}</p>`;

/** Full match-page module: home / draw / away panels + the 90-minute settlement note; '' without a market. */
export function matchKalshiHtml(entry) {
  const card = kalshiCard(soccerEntry(entry), { placement: 'match-page' });
  return card ? `${card}${note()}` : '';
}

/** PBEcast one-line strip (expands to the compact card) + the settlement note; '' without a market. */
export function castKalshiHtml(entry, { open = false } = {}) {
  let strip = kalshiStrip(soccerEntry(entry), { placement: 'pbecast' });
  if (!strip) return '';
  if (open) strip = strip.replace('<details class="kx-strip"', '<details open class="kx-strip"');
  return `${strip}${note()}`;
}
