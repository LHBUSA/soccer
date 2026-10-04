// Network P0 2026-10-04: a Kalshi market one-sided at the $0/$1 boundary must keep its full Market Pulse card. Vendored
// shared client (propbetedge-workers 64ca257): renderable (one real side) gates the card; the Mid-market still needs both
// sides; compact line / strip stay absent without a mid. Production shape of the case that exposed it (Muchova vs
// Samsonova 99/1), relabelled as a soccer home/away market; the semantics are network-wide.
import test from 'node:test';
import assert from 'node:assert/strict';
import { kalshiCard, kalshiLine, kalshiStrip } from '../../src/vendor/kalshi/kalshi-market-ui.js';

const URL_ = 'https://kalshi.com/markets/kxeplgame/epl-game/kxeplgame-26oct04arsche';
const o = (role, abbr, ticker, bid, ask, last) => ({ role, abbr, kalshi_name: abbr, contract: `${abbr} wins`, market_ticker: ticker, state: 'open', result: null, best_yes_bid_bp: bid, best_yes_ask_bp: ask, last_price_bp: last, mid_bp: null, volume: 2602928.95, open_interest: 1267498.06, spread_bp: null, displayable: false, renderable: true, one_sided: true });
const entry = {
  event: { sport: 'soccer', canonical_event_id: 'ars-che' },
  kalshi: { source: 'kalshi', market_url: URL_, event_ticker: 'KXEPLGAME-26OCT04ARSCHE', state: 'open', freshness: 'live', age_seconds: 20, mid_available: false, book: 'one_sided',
    outcomes: [o('home', 'ARS', 'KXEPLGAME-26OCT04ARSCHE-ARS', 9900, null, 9900), o('away', 'CHE', 'KXEPLGAME-26OCT04ARSCHE-CHE', null, 100, 100)] },
};

test('99/1 one-sided book keeps the full Kalshi card: Bid/Ask/Last truthful, "—" for the missing side, no Mid-market, link kept', () => {
  const html = kalshiCard(entry, { placement: 'soccer-match' });
  assert.ok(html.includes('Market Pulse') && html.includes(URL_));
  const panels = html.split('class="kx__panel"').slice(1);
  assert.equal(panels.length, 2);
  assert.match(panels[0], /<dt>Bid<\/dt><dd>99¢<\/dd>[\s\S]*<dt>Ask<\/dt><dd>—<\/dd>[\s\S]*<dt>Last<\/dt><dd>99¢<\/dd>/);
  assert.match(panels[1], /<dt>Bid<\/dt><dd>—<\/dd>[\s\S]*<dt>Ask<\/dt><dd>1¢<\/dd>[\s\S]*<dt>Last<\/dt><dd>1¢<\/dd>/);
  assert.ok(html.includes('Mid-market unavailable at this observation · one-sided book'));
  assert.ok(!/kx__pxl">Mid-market</.test(html) && !/99\.5¢|0\.5¢/.test(html), 'no invented midpoint');
});

test('compact line and strip stay absent without a valid Mid-market', () => {
  assert.equal(kalshiLine(entry), '');
  assert.ok(!String(kalshiStrip(entry, {})).includes('kx__sp'));
});

test('settled behaviour unchanged; an older API block without `renderable` fails closed', () => {
  const settled = { ...entry, kalshi: { ...entry.kalshi, state: 'settled', freshness: 'settled', outcomes: entry.kalshi.outcomes.map((x, i) => ({ ...x, state: 'settled', result: i ? 'no' : 'yes' })) } };
  assert.ok(kalshiCard(settled, { placement: 't' }).includes('Settled YES'));
  const old = { ...entry, kalshi: { ...entry.kalshi, outcomes: entry.kalshi.outcomes.map(({ renderable, ...x }) => x) } };
  assert.equal(kalshiCard(old, { placement: 't' }), '');
});
