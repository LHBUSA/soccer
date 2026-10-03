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
//
// Market history: once the market has CLOSED or SETTLED the same slots show "How the market closed"
// (vendored marketModule / marketHistoryCard) and finished result cards get one marketCloseLine. The
// page follows the market's own lifecycle from the API (UPCOMING -> ACTIVE -> CLOSED -> SETTLED) with
// no release; a finished match is not a settled market (CLOSED reads "awaiting settlement").
import { createKalshiClient } from '../vendor/kalshi/kalshi-market-client.js';
import { kalshiLine, kalshiStrip, marketCloseLine, marketHistoryCard, marketModule } from '../vendor/kalshi/kalshi-market-ui.js';

export const MARKETS_BASE = '/api/markets';

// The vendored client keeps only entries that still carry a live `kalshi` block. A closed/settled market
// may come back without one, so the raw bodies are also kept here (same single request, nothing extra):
// board entries for result-card lines, event entries for the history card.
const rawBoard = new Map();
const rawEvents = new Map();
async function teeFetch(url, init) {
  const res = await globalThis.fetch(url, init);
  if (!res?.ok) return res;
  const body = await res.json();
  const u = String(url);
  if (/\/sport\/soccer$/.test(u)) {
    rawBoard.clear();
    if (body?.enabled && Array.isArray(body.events)) for (const e of body.events) if (e?.event?.canonical_event_id) rawBoard.set(String(e.event.canonical_event_id), e);
  } else {
    const m = u.match(/\/event\/soccer\/([^/?#]+)$/);
    if (m) rawEvents.set(decodeURIComponent(m[1]), body?.enabled && body.event && (body.event.kalshi || body.event.market_history) ? body.event : null);
  }
  return { ok: true, status: res.status, json: async () => body };
}
export const kalshi = createKalshiClient({ sport: 'soccer', base: MARKETS_BASE, fetchImpl: teeFetch });

/** Event read for the match page / PBEcast: the live entry, else a closed/settled entry with history. Never rejects. */
export function loadMatchMarket(id, opts) {
  return kalshi.loadEvent(id, opts).then(v => v || rawEvents.get(String(id)) || null, () => null);
}
/** Board entry for a match (including a closed/settled one the vendored board drops). */
export const boardEntry = id => kalshi.forEvent(id) || rawBoard.get(String(id)) || null;

const CLOSED_POLL_MS = 5 * 60_000;
const lifecycle = e => e?.market?.lifecycle || e?.market_history?.lifecycle || null;
export const isHistory = e => (lifecycle(e) === 'CLOSED' || lifecycle(e) === 'SETTLED') && !!e?.market_history;

/**
 * Next poll for a mounted match page / cast, or null to stop: SETTLED -> none; CLOSED -> 5 min until it
 * settles; otherwise live 20 s / pregame 45 s; a finished match whose market still trades -> 5 min until it closes.
 */
export function marketPollMs(status, entry) {
  const lc = lifecycle(entry);
  if (lc === 'SETTLED') return null;
  if (lc === 'CLOSED') return CLOSED_POLL_MS;
  const lane = kalshiPollState(status);
  if (lane) return kalshi.pollMsFor(lane);
  return entry ? CLOSED_POLL_MS : null;
}

/** Longest the first paint may wait for the market read (it runs in parallel with the page data). */
export const KALSHI_FIRST_PAINT_MS = 800;
export const SOCCER_PROPOSITION = 'match_result_90min';
export const SETTLEMENT_NOTE = 'Settles on the result after 90 minutes plus stoppage time (no extra time or penalties).';

/** An entry we can describe exactly: the 90-minute result market, otherwise null. */
export function soccerEntry(entry) {
  const prop = entry?.kalshi?.proposition ?? entry?.market?.proposition ?? entry?.market_history?.proposition;
  return prop === SOCCER_PROPOSITION ? entry : null;
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

/**
 * Restrained card line: scheduled / live -> the live Kalshi line; finished -> the subtle market close line
 * (only when the board recorded one); else ''.
 */
export function kalshiLineFor(m) {
  if (!m?.id) return '';
  if (kalshiPollState(m.status)) return kalshiLine(soccerEntry(kalshi.forEvent(m.id)));
  if (m.status === 'finished') return marketCloseLine(soccerEntry(boardEntry(m.id)));
  return '';
}

const note = () => `<p class="kx-soccer-note">${SETTLEMENT_NOTE}</p>`;

/**
 * Full match-page module (vendored marketModule): home / draw / away live panels while trading, "How the
 * market closed" once CLOSED / SETTLED; always with the 90-minute settlement note; '' without a market.
 */
export function matchKalshiHtml(entry) {
  const card = marketModule(soccerEntry(entry), { placement: 'match-page' });
  return card ? `${card}${note()}` : '';
}

/** PBEcast one-line strip (expands to the compact card) + the settlement note; '' without a market. */
export function castKalshiHtml(entry, { open = false } = {}) {
  const e = soccerEntry(entry);
  if (isHistory(e)) { const h = marketHistoryCard(e, { placement: 'pbecast' }); return h ? `${h}${note()}` : ''; }
  let strip = kalshiStrip(soccerEntry(entry), { placement: 'pbecast' });
  if (!strip) return '';
  if (open) strip = strip.replace('<details class="kx-strip"', '<details open class="kx-strip"');
  return `${strip}${note()}`;
}
