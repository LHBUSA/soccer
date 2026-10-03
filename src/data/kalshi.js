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
import { algoVsMarketCard, algoVsMarketEvent, kalshiCard, kalshiLine, marketCloseLine, marketHistoryCard, marketModule } from '../vendor/kalshi/kalshi-market-ui.js';

export const MARKETS_BASE = '/api/markets';

// The shared client (propbetedge-workers ad6187a) keeps completed events itself: the board keeps entries
// with a market lifecycle and no live block, loadEvent keeps an event with only market_history; a failed
// read is never cached as 'no market' (last good value kept, the next poll retries at once). No
// product-side fetch wrapper is needed (the 70d92e0 workaround was removed).
export const kalshi = createKalshiClient({ sport: 'soccer', base: MARKETS_BASE });

/** Event read for the match page / PBEcast: the live entry, else a closed/settled entry with history. Never rejects. */
export function loadMatchMarket(id, opts) {
  return kalshi.loadEvent(id, opts).then(v => v || null, () => null);
}
/** Board entry for a match (live, or a closed/settled one with its market close). */
export const boardEntry = id => kalshi.forEvent(id) || null;

const CLOSED_POLL_MS = 5 * 60_000;
const lifecycle = e => e?.market?.lifecycle || e?.market_history?.lifecycle || null;

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

/** True once the venue market has CLOSED or SETTLED (the event read then carries market_history). */
export const marketDone = e => lifecycle(e) === 'CLOSED' || lifecycle(e) === 'SETTLED';

/**
 * PBEcast lifecycle label for the Market Pulse module: [phase key, text], or null without a market.
 * The match state comes from PBEcast (live mode / match status); a finished match is not a settled market.
 */
export function castMarketPhase(entry, { mode = null, status = null } = {}) {
  const e = soccerEntry(entry);
  if (!e) return null;
  if (marketDone(e)) return lifecycle(e) === 'SETTLED' ? ['settled', 'MARKET SETTLED'] : ['closed', 'MARKET CLOSED · AWAITING SETTLEMENT'];
  if (status === 'finished' || mode === 'replay') return ['final-open', 'FULL TIME · MARKET STILL TRADING'];
  if (mode === 'live' || status === 'live') return ['live', 'LIVE MARKET'];
  return ['pre', 'MARKET OPEN · PRE-MATCH'];
}

/**
 * PBEcast Market Pulse, directly under the scoreboard for the whole match lifecycle: the full shared card
 * (compact: Mid-market per outcome, Updated Ns ago, stored movement + sparkline, bid / ask, "View market on
 * Kalshi") for home / draw / away while the market trades, then "How the market closed" in the SAME slot
 * once CLOSED / SETTLED; always the lifecycle label and the 90-minute note; '' without a market.
 */
export function castKalshiHtml(entry, state = {}) {
  const e = soccerEntry(entry);
  const phase = castMarketPhase(e, state);
  if (!phase) return '';
  const body = marketDone(e)
    ? marketHistoryCard(e, { placement: 'pbecast-replay' })
    : kalshiCard(e, { placement: 'pbecast', compact: true });
  if (!body) return '';
  return `<div class="ct-mkt" data-phase="${phase[0]}"><p class="ct-mkt-phase"><span class="ct-mkt-dot" aria-hidden="true"></span>${phase[1]}</p>${body}${note()}</div>`;
}

// ---------------------------------------------------------------- score ticker market line
// Kalshi's own outcome code from the contract ticker (KXEPLGAME-26OCT10ARSCHE-ARS -> ARS); the draw reads DRAW.
const code = (o, fallback) => {
  if (o.role === 'draw') return 'DRAW';
  const s = String(o.market_ticker || '').split('-').pop();
  return /^[A-Z]{2,4}$/.test(s) && s !== 'TIE' ? s : fallback;
};

/**
 * Compact ticker market parts for one ticker item, or null (no line): only a scheduled / live match, only an
 * exact match id, only what a card line would show (kalshiLine rules: open, every Mid-market present, not
 * stale), only the 90-minute three-way market ordered home / draw / away. Finals carry no line.
 */
export function tickerMarket(entry, m, k) {
  if (!entry || !m || (k !== 'live' && k !== 'next')) return null;
  if (String(entry.event?.canonical_event_id ?? '') !== String(m.id)) return null;
  const e = soccerEntry(entry);
  if (!e || !kalshiLine(e)) return null;
  const outs = e.kalshi?.outcomes || [];
  if (outs.length !== 3) return null;
  const by = r => outs.find(o => o.role === r);
  const rows = [[by('home'), 'H'], [by('draw'), 'D'], [by('away'), 'A']];
  if (rows.some(([o]) => !o || !Number.isFinite(o.mid_bp))) return null;
  return rows.map(([o, f]) => ({ label: code(o, f), px: `${(o.mid_bp / 100).toFixed(1)}¢` }));
}

// ---------------------------------------------------------------- ALGO vs MARKET
// GET /v1/algo-vs-market/soccer and /v1/algo-vs-market/event/soccer/:uuid on the shared market Worker, read through the
// exact same-origin rewrites (vercel.json). Both opinions are frozen at the algorithm lock by the API; this site only
// renders what the API returns, through the vendored algoVsMarketCard / algoVsMarketEvent (which state their own
// rules). Only the Bundesliga model (Soccer Algo V1, match result) has an exactly comparable market. No algo entry, no
// comparison, a failed read or a timeout -> nothing rendered.
export const AVM_ALGO_MODEL = { 'soccer:soccer-algo-v1': 'bundesliga' };
export const AVM_BOARD_PATH = `${MARKETS_BASE}/v1/algo-vs-market/soccer`;
export const avmEventPath = id => `${MARKETS_BASE}/v1/algo-vs-market/event/soccer/${encodeURIComponent(id)}`;

async function readJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}
/** Track-record payload ({ algos }) or null. Never rejects. */
export const loadAlgoVsMarket = () => readJson(AVM_BOARD_PATH).then(b => (Array.isArray(b?.algos) ? b : null), () => null);
/** Event payload ({ comparisons }) or null. Never rejects. */
export const loadAlgoVsMarketEvent = id => readJson(avmEventPath(id)).then(b => (Array.isArray(b?.comparisons) ? b : null), () => null);

/** Role -> display name from page data ({ home, away } team objects); the draw reads Draw. */
const teamNameOf = (home, away) => (_r, role) => (role === 'draw' ? 'Draw' : role === 'home' ? home?.name : role === 'away' ? away?.name : null) || null;

/**
 * Track-record module for one soccer model: the API's entry for that model's algo, rendered as the shared card.
 * `picks` (the model's official ledger rows) supply match names: rows without an event label get "Home v Away" from
 * the pick of the same match; roles resolve to team names. '' when the model has no algo entry yet.
 */
export function trackRecordAvmHtml(payload, modelKey, picks = []) {
  const algo = (payload?.algos || []).find(a => AVM_ALGO_MODEL[a.algo_id] === modelKey);
  if (!algo) return '';
  const byMatch = new Map(picks.filter(p => p?.match_id).map(p => [String(p.match_id), p]));
  const ledger = (algo.ledger || []).map(r => {
    const p = byMatch.get(String(r.canonical_event_id));
    return !r.event_label && p?.home?.name && p?.away?.name ? { ...r, event_label: `${p.home.name} v ${p.away.name}` } : r;
  });
  const nameOf = (r, role) => { const p = byMatch.get(String(r.canonical_event_id)); return p ? teamNameOf(p.home, p.away)(r, role) : role === 'draw' ? 'Draw' : null; };
  return algoVsMarketCard({ ...algo, ledger }, { nameOf, recent: 10 });
}

/** Match-page layer next to Market Pulse: PBE pick vs market at PBE lock (+ result); '' without a qualifying comparison. */
export function matchAvmHtml(payload, m) {
  return algoVsMarketEvent(payload, { nameOf: teamNameOf(m?.home, m?.away) });
}
