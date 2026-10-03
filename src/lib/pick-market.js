// PBE PICK x KALSHI — one compact, separate line on an official PBE pick card / ledger row:
//   live or pregame  "KALSHI  TBL 64.5¢  PBE pick side"   (the pick side's Kalshi Mid-market)
//   settled pick     "KALSHI  TBL 64.5¢ before start · settled YES"   (stored market evidence only)
//   frozen AVM row   "AT PBE LOCK  PBE 71.4% · Market 80.5¢ · −9.1 pts"
//
// Product-local glue (NOT a market client and NOT a vendored file): the data is the ONE board read the
// page already makes through the vendored shared client (src/vendor/kalshi/, canonical
// propbetedge-workers ad6187a), and the vendored kalshiLine() is the truth gate for a live price (market
// open, every outcome displayable, every Mid-market present, quote not stale). Rules:
//  - same game (canonical event id) and the SAME side as the pick (outcome role), proposition matched
//    exactly (90-minute match result, home / draw / away); anything else renders nothing;
//  - a Kalshi price is a prediction-market price: never called odds, never a sportsbook, never blended into
//    the pick's own numbers;
//  - a settled pick shows only stored evidence from the API's market.close (last observation before the
//    start, else "first observed" — never "opened"; the venue's settlement, else "awaiting settlement"), and
//    never a live quote;
//  - the Algo vs Market line comes only from a FROZEN comparison (AGREEMENT / DISAGREEMENT) for the same
//    event and side; LOCKED rows reveal nothing;
//  - every price links to the Kalshi market (new tab, rel="noopener noreferrer sponsored");
//  - no usable market -> '' (no placeholder, no "no market" copy).
import { kalshiLine } from '../vendor/kalshi/kalshi-market-ui.js';

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cents = bp => `${(bp / 100).toFixed(1)}¢`;
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const REL = 'noopener noreferrer sponsored';
const SIDES = new Set(['home', 'away', 'draw']);

/** Soccer: the only Kalshi proposition comparable to a PBE match-result (1x2) pick: the 90-minute result. */
export const PICK_PROPOSITIONS = Object.freeze(['match_result_90min']);

function propositionOf(entry) {
  return entry?.kalshi?.proposition ?? entry?.market?.proposition ?? null;
}

function anchor(url, ticker, placement, title, inner, cls = '') {
  return `<a class="kx-line kx-pick${cls} mono" href="${esc(url)}" target="_blank" rel="${REL}" data-kx-click data-kx-ticker="${esc(ticker || '')}" data-kx-placement="${esc(placement)}" title="${esc(title)}">${inner}</a>`;
}

/**
 * The pick side's Kalshi line, or ''.
 * @param {object|null} entry  board entry for the pick's game (client.forEvent(id))
 * @param {'home'|'away'|'draw'} role  the side the PBE pick took
 * @param {{settled?: boolean, placement?: string, propositions?: string[]}} opts
 *        settled: the pick's game is over -> stored close evidence only, never a live quote
 */
export function pickMarketLine(entry, role, { settled = false, placement = 'pbe-pick', propositions = PICK_PROPOSITIONS } = {}) {
  if (!entry || !SIDES.has(role)) return '';
  if (!propositions.includes(propositionOf(entry))) return '';
  const lifecycle = entry.market?.lifecycle || null;
  const done = lifecycle === 'CLOSED' || lifecycle === 'SETTLED';

  if (!settled && !done) {
    // Live / pregame: exactly what the shared compact line would show, reduced to the pick side.
    if (!kalshiLine(entry)) return '';
    const k = entry.kalshi;
    const o = k.outcomes.find(x => x.role === role);
    if (!o || !isNum(o.mid_bp) || !k.market_url) return '';
    const live = k.freshness === 'live';
    return anchor(k.market_url, o.market_ticker, placement,
      `Kalshi Mid-market for the PBE pick side · prediction market, not sportsbook odds${isNum(k.age_seconds) ? ` · updated ${Math.round(k.age_seconds)}s ago` : ''}`,
      `<span class="kx-line__b">KALSHI</span><b class="kx-pick__px">${esc(o.abbr || '')} ${esc(cents(o.mid_bp))}</b><span class="kx-pick__tag">PBE pick side</span>${live ? '<span class="kx__pulse" aria-hidden="true"></span>' : ''}`);
  }

  // Closed / settled market, or a settled pick: stored evidence from market.close only.
  const close = entry.market?.close;
  const url = entry.market?.market_url;
  if (!close || !Array.isArray(close.outcomes) || !url) return '';
  const o = close.outcomes.find(x => x.role === role);
  if (!o) return '';
  const price = isNum(o.before_start_bp)
    ? `${cents(o.before_start_bp)} before start`
    : isNum(o.first_bp) ? `first observed ${cents(o.first_bp)}` : '';
  const state = close.lifecycle === 'SETTLED' || lifecycle === 'SETTLED'
    ? (o.result === 'yes' ? 'settled YES' : o.result === 'no' ? 'settled NO' : '')
    : 'awaiting settlement';
  if (!price && !state) return '';
  return anchor(url, entry.kalshi?.event_ticker || '', placement,
    'Stored Kalshi market history for the PBE pick side (last price we observed before the start; settlement is Kalshi\'s) · prediction market, not sportsbook odds',
    `<span class="kx-line__b">KALSHI</span><span>${esc(o.abbr || '')}${price ? ` ${esc(price)}` : ''}${price && state ? ' · ' : ''}${esc(state)}</span>`,
    ' kx-line--closed');
}

/** The frozen Algo vs Market comparison for one event + side (from /v1/algo-vs-market/:sport ledgers), or null. */
export function findAvmRow(payload, eventId, role) {
  const id = String(eventId ?? '');
  if (!id || !SIDES.has(role)) return null;
  for (const algo of payload?.algos || []) {
    for (const r of algo?.ledger || []) {
      if (String(r?.canonical_event_id) === id && (r.status === 'AGREEMENT' || r.status === 'DISAGREEMENT') && r.algo_selection === role) return r;
    }
  }
  return null;
}

/** "AT PBE LOCK  PBE 71.4% · Market 80.5¢ · −9.1 pts" from a frozen comparison row, or ''. */
export function pickAvmLine(row, { placement = 'pbe-pick-avm' } = {}) {
  if (!row || (row.status !== 'AGREEMENT' && row.status !== 'DISAGREEMENT')) return '';
  const p = row.algo_probability;
  const px = row.market?.prices?.[row.algo_selection]?.mid_bp;
  const url = row.market?.market_url;
  if (!isNum(p) || p < 0 || p > 1 || !isNum(px) || !url) return '';
  const gap = p * 100 - px / 100;
  const gapText = `${gap > 0 ? '+' : gap < 0 ? '−' : '±'}${Math.abs(gap).toFixed(1)} pts`;
  return `<span class="kx-avm mono" title="Frozen at the PBE lock: PBE probability for the pick side vs the Kalshi Mid-market for the same side recorded at or before the lock. Prediction market, not sportsbook odds. Never changes."><span class="kx-line__b">AT PBE LOCK</span>PBE ${esc((p * 100).toFixed(1))}% · <a href="${esc(url)}" target="_blank" rel="${REL}" data-kx-click data-kx-placement="${esc(placement)}">Market ${esc(cents(px))}</a> · ${esc(gapText)}</span>`;
}

/** Both lines for one pick (market line first), wrapped in one slot; '' when neither has a value. */
export function pickMarketSlot(entry, role, { settled = false, avmRow = null, placement } = {}) {
  const line = pickMarketLine(entry, role, { settled, placement });
  const avm = pickAvmLine(avmRow);
  return line || avm ? `<div class="pick-kx">${line}${avm}</div>` : '';
}
