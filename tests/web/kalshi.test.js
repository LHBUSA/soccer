// Kalshi Market Intelligence on Soccer (contract market-intel/1).
// Vendored shared component (src/vendor/kalshi/, unchanged) + soccer placements: match page (full card +
// 90-minute settlement note, first paint), PBEcast strip, fixture / hub card lines, /sources section.
// The market entry below is inline and shaped exactly like GET /v1/market-intelligence/event/soccer/:uuid
// (captured 2026-10-03, Arsenal v Leeds, Premier League); it is not a committed data file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ID = 'dd8264d9-a90f-54bd-8da8-da17d6d41ef7';
const NO_MARKET_ID = '5b0c8f3e-1111-5222-8333-444455556666';
const outcome = (role, abbr, kalshiName, contract, suffix, bid, ask) => ({
  role, team_id: role === 'draw' ? null : `${role}-team`, abbr, kalshi_name: kalshiName, contract, market_ticker: `KXEPLGAME-26OCT03ARSLEE-${suffix}`,
  state: 'open', result: null, best_yes_bid_bp: bid, best_yes_ask_bp: ask, last_price_bp: ask, mid_bp: (bid + ask) / 2,
  volume: 12000.5, volume_24h: 900, open_interest: 8000.25, spread_bp: ask - bid, displayable: true,
});
const entry = (over = {}) => ({
  event: { sport: 'soccer', competition: 'premier-league', canonical_event_id: ID, start_at: '2026-10-03T14:00:00+00:00', state: 'pre' },
  kalshi: {
    source: 'kalshi', source_type: 'prediction_market', label: 'Kalshi', attribution: 'Prediction market data', link_text: 'View on Kalshi',
    market_url: 'https://kalshi.com/markets/kxeplgame/english-premier-league-game/kxeplgame-26oct03arslee',
    event_ticker: 'KXEPLGAME-26OCT03ARSLEE', proposition: 'match_result_90min', state: 'open', freshness: 'live', age_seconds: 120,
    outcomes: [
      outcome('home', 'Arsenal', 'Arsenal', 'Arsenal wins', 'ARS', 7100, 7200),
      outcome('draw', 'Draw', 'Tie', 'Tie is the result', 'TIE', 1700, 1800),
      outcome('away', 'Leeds', 'Leeds United', 'Leeds United wins', 'LEE', 1100, 1200),
    ],
    ...over,
  },
  sportsbooks: null, pbe: null, comparisons: [],
});

// Browser fetch stand-in: the same-origin market routes + the soccer API envelope for the match page.
const fetched = [];
let marketMode = 'up'; // 'up' | 'hang' | 'down'
globalThis.fetch = async (url) => {
  url = String(url); fetched.push(url);
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  if (url.startsWith('/api/markets/')) {
    if (marketMode === 'hang') return new Promise(() => {});
    if (marketMode === 'down') throw new Error('markets down');
    if (url === '/api/markets/v1/market-intelligence/sport/soccer') { const e = entry(); return ok({ contract: 'market-intel/1', sport: 'soccer', enabled: true, events: [e] }); }
    const m = url.match(/^\/api\/markets\/v1\/market-intelligence\/event\/soccer\/([0-9a-f-]{36})$/);
    if (m) return ok({ contract: 'market-intel/1', sport: 'soccer', enabled: true, event: m[1] === ID ? { ...entry(), movement: { kalshi: {} } } : null });
  }
  const mm = url.match(/^\/api\/soccer\/matches\/([0-9a-f-]{36})$/);
  if (mm) return ok({ data: matchData(mm[1]), meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } });
  throw new Error(`unexpected fetch ${url}`);
};
const matchData = id => ({
  id, status: 'scheduled', kickoff_at: '2026-10-03T14:00:00Z', round: null, score: null, result_source: 'espn', event_source: null,
  home: { id: 'h', slug: 'arsenal', name: 'Arsenal' }, away: { id: 'a', slug: 'leeds-united', name: 'Leeds United', short_name: 'Leeds' },
  competition: { slug: 'premier-league', name: 'Premier League' }, season: '2026/27', timeline: [], shots: [], stats: null, lineups: null, substitutions: [],
});

const ui = await import('../../src/vendor/kalshi/kalshi-market-ui.js');
const kx = await import('../../src/data/kalshi.js');
const match = await import('../../src/pages/match.js');
const { matchCard } = await import('../../src/components/ui.js');
const { castView } = await import('../../src/pages/pbecast.js');
const { sources } = await import('../../src/pages/lists.js');
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();

test('no entry -> nothing at every soccer placement (no placeholder)', () => {
  assert.equal(kx.matchKalshiHtml(null), '');
  assert.equal(kx.castKalshiHtml(null), '');
  assert.equal(kx.kalshiLineFor({ id: NO_MARKET_ID, status: 'scheduled' }), '');
  assert.equal(ui.kalshiCard({ event: {}, kalshi: null }, { placement: 'match-page' }), '');
  // a market we cannot describe exactly (not the 90-minute result) is not shown
  assert.equal(kx.matchKalshiHtml(entry({ proposition: 'match_result_incl_extra_time' })), '');
  assert.equal(kx.castKalshiHtml(entry({ proposition: undefined })), '');
});

test('a soccer entry renders home / draw / away with prediction-market wording and the 90-minute note', () => {
  const html = kx.matchKalshiHtml(entry());
  assert.equal((html.match(/class="kx__panel"/g) || []).length, 3, 'three outcome panels');
  assert.match(html, /--kx-cols:3/);
  const t = text(html);
  for (const s of ['Arsenal wins', 'Tie is the result', 'Leeds United wins', 'Draw']) assert.ok(t.includes(s), s);
  assert.ok(t.indexOf('Arsenal') < t.indexOf('Draw') && t.indexOf('Draw') < t.indexOf('Leeds'), 'home, draw, away order');
  assert.match(t, /Market Pulse Live prediction market · Kalshi/);
  assert.match(t, /Live prediction-market pricing — no sportsbook line required./);
  assert.match(t, /not sportsbook odds and not a PropBetEdge model/);
  assert.match(t, /Mid-market/);
  assert.ok(t.includes(kx.SETTLEMENT_NOTE), 'settlement note next to the card');
  assert.equal(kx.SETTLEMENT_NOTE, 'Settles on the result after 90 minutes plus stoppage time (no extra time or penalties).');
  assert.doesNotMatch(t, /win probability|chance to win|PBE prediction/i);
  assert.doesNotMatch(html, /--kx-team:/, 'no invented team colours');
});

test('every Kalshi link goes to the verified kalshi.com market, new tab, rel sponsored', () => {
  for (const html of [kx.matchKalshiHtml(entry()), kx.castKalshiHtml(entry())]) {
    const anchors = html.match(/<a [^>]*>/g) || [];
    assert.ok(anchors.length >= 4, 'three prices + footer');
    for (const a of anchors) {
      assert.match(a, /href="https:\/\/kalshi\.com\/markets\//);
      assert.match(a, /target="_blank"/);
      assert.match(a, /rel="noopener noreferrer sponsored"/);
    }
  }
});

test('data client reads the same-origin /api/markets routes for sport soccer; poll lanes', async () => {
  marketMode = 'up'; fetched.length = 0;
  const board = await kx.kalshi.loadBoard({ force: true });
  assert.ok(board.get(ID), 'board keyed by our match UUID');
  assert.deepEqual(fetched, ['/api/markets/v1/market-intelligence/sport/soccer']);
  assert.equal(kx.MARKETS_BASE, '/api/markets');
  assert.equal(kx.kalshi.pollMsFor(kx.kalshiPollState('live')), 20_000);
  assert.equal(kx.kalshi.pollMsFor(kx.kalshiPollState('scheduled')), 45_000);
  assert.equal(kx.kalshiPollState('finished'), null);
});

test('fixture cards: one restrained line for a not-finished match with a market; none when finished or unmatched', async () => {
  marketMode = 'up'; await kx.kalshi.loadBoard({ force: true });
  const base = { id: ID, kickoff_at: '2026-10-03T14:00:00Z', home: { name: 'Arsenal', slug: 'arsenal' }, away: { name: 'Leeds United', slug: 'leeds-united' }, competition: { slug: 'premier-league', name: 'Premier League' } };
  const pre = matchCard({ ...base, status: 'scheduled', score: null });
  assert.match(pre, /<div class="mc-kx"><span class="kx-line mono"/);
  assert.ok(text(pre).includes('KALSHI Arsenal 71.5¢ · Draw 17.5¢ · Leeds 11.5¢'), text(pre));
  assert.match(matchCard({ ...base, status: 'live', score: { home: 0, away: 0 } }), /kx-line/);
  assert.doesNotMatch(matchCard({ ...base, status: 'finished', score: { home: 2, away: 0 } }), /kx-line|mc-kx/);
  assert.doesNotMatch(matchCard({ ...base, id: NO_MARKET_ID, status: 'scheduled', score: null }), /kx-line|mc-kx/);
});

test('match page: card is in the FIRST paint as its own block, with a bounded wait', async () => {
  marketMode = 'up';
  const d = await match.load([ID]);
  assert.ok(d.kx, 'market loaded with the match');
  const html = match.render(d);
  const at = html.indexOf('data-kx-match');
  assert.ok(at > html.indexOf('class="mhero"') && at < html.indexOf('data-analyzer-preview'), 'own block between hero and match intelligence');
  assert.match(html, /<section class="canvas kx-sec" data-kx-match><div class="wrap mid"><section class="ic kx"/);
  assert.ok(html.includes(kx.SETTLEMENT_NOTE));

  // no market for the match -> hidden empty slot, no Kalshi text
  const none = match.render(await match.load([NO_MARKET_ID]));
  assert.match(none, /data-kx-match hidden><div class="wrap mid"><\/div>/);
  assert.doesNotMatch(text(none), /Kalshi/);

  // a market API that never answers holds the page for at most the first-paint budget
  marketMode = 'hang';
  const t0 = Date.now();
  const slow = await match.load([NO_MARKET_ID]);
  const waited = Date.now() - t0;
  assert.ok(waited < kx.KALSHI_FIRST_PAINT_MS + 400, `waited ${waited} ms`);
  assert.equal(slow.kx, null);
  assert.doesNotMatch(text(match.render(slow)), /Kalshi/);

  // a market API that fails renders the page without a card
  marketMode = 'down';
  const down = await match.load([NO_MARKET_ID]);
  assert.equal(down.kx, null);
  marketMode = 'up';
});

test('PBEcast: the strip renders from the known board entry, never blocks the cast, keeps its open state', async () => {
  marketMode = 'up'; await kx.kalshi.loadBoard({ force: true });
  const env = { data: { ...matchData(ID), status: 'scheduled', sequence: [], live: { mode: 'pregame' } }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } };
  const html = castView(env);
  assert.match(html, /<div class="ct-kx" data-kx-cast><details class="kx-strip"/);
  assert.ok(html.indexOf('data-kx-cast') < html.indexOf('cast-body'), 'strip sits in the cast header');
  assert.ok(html.includes(kx.SETTLEMENT_NOTE));
  assert.match(kx.castKalshiHtml(entry(), { open: true }), /^<details open class="kx-strip"/);
  const other = castView({ ...env, data: { ...env.data, id: NO_MARKET_ID } });
  assert.match(other, /<div class="ct-kx" data-kx-cast hidden><\/div>/);
});

test('/sources explains Kalshi prices: prediction market, links, Mid-market, observed movement, 90-minute settlement', () => {
  const t = text(sources.render());
  assert.match(t, /Kalshi prediction-market prices/);
  assert.match(t, /not sportsbook odds and not a PropBetEdge model/);
  assert.match(t, /Every price links to that market on Kalshi/);
  assert.match(t, /Mid-market is the midpoint of the best YES bid and the best YES ask/);
  assert.match(t, /Movement is drawn only from prices we observed and stored/);
  assert.match(t, /90 minutes plus stoppage time, with no extra time or penalties/);
});

test('copy never promises "no odds": only "no sportsbook odds" (Kalshi is a prediction market)', () => {
  const algo = readFileSync('src/pages/algo.js', 'utf8'); const news = readFileSync('src/pages/news.js', 'utf8');
  assert.ok(algo.includes('No default sportsbook odds are ever assumed.'));
  assert.ok(news.includes('No invented quotes, injuries or sportsbook odds.'));
  assert.ok(news.includes('no quotes, injuries, rumours or sportsbook odds.'));
  const walk = d => readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of [...walk('src'), 'index.html'].filter(f => /\.(js|html)$/.test(f) && !f.includes('vendor'))) {
    const t = readFileSync(f, 'utf8');
    assert.doesNotMatch(t, /\b(?:no|or|never|without)\s+(?:default\s+|invented\s+)?odds\b/i, `${f}: bare "odds" promise`);
  }
});

test('browser code never names a Kalshi API host; the market Worker is reached only through exact same-origin rewrites', () => {
  const KALSHI_API = /(?:api\.elections\.kalshi\.com|trading-api\.kalshi\.com|external-api\.kalshi\.com|demo-api\.kalshi\.co|api\.kalshi\.com)/i;
  const walk = d => (existsSync(d) ? readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)])) : []);
  const files = [...walk('src'), ...walk('public'), 'index.html'].filter(f => /\.(m?js|html|css|json|txt)$/.test(f));
  assert.ok(files.length > 50);
  assert.deepEqual(files.filter(f => KALSHI_API.test(readFileSync(f, 'utf8'))), []);
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const markets = v.rewrites.filter(r => r.source.startsWith('/api/markets'));
  assert.deepEqual(markets, [
    { source: '/api/markets/v1/market-intelligence/sport/soccer', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/market-intelligence/sport/soccer' },
    { source: '/api/markets/v1/market-intelligence/event/soccer/:id([0-9a-f-]+)', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/market-intelligence/event/soccer/:id' },
  ], 'soccer routes only, no wildcard');
  const csp = v.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /connect-src 'self' /, 'same-origin reads need no new connect-src host');
  assert.doesNotMatch(csp, /kalshi|propsports-markets/);
});

test('vendored Kalshi files match the canonical shared client (when the canonical checkout is present)', t => {
  const canon = 'D:/Workers/propbetedge-workers/workers/propsports-markets/client';
  if (!existsSync(canon)) { t.skip('canonical checkout not present on this machine'); return; }
  const norm = s => s.replace(/\r\n/g, '\n');
  for (const f of ['kalshi-market-ui.js', 'kalshi-market-ui.css', 'kalshi-market-client.js', 'README.md']) {
    assert.equal(norm(readFileSync(join('src/vendor/kalshi', f), 'utf8')), norm(readFileSync(join(canon, f), 'utf8')), f);
  }
});
