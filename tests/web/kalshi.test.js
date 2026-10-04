// Kalshi Market Intelligence on Soccer (contract market-intel/1).
// Vendored shared component (src/vendor/kalshi/, unchanged) + soccer placements: match page (full card +
// 90-minute settlement note, first paint), PBEcast strip, fixture / hub card lines, /sources section.
// The market entry below is inline and shaped exactly like GET /v1/market-intelligence/event/soccer/:uuid
// (captured 2026-10-03, Arsenal v Leeds, Premier League); it is not a committed data file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
const extraEvents = new Map(); // id -> event body (market-history tests)
const extraBoard = [];
globalThis.fetch = async (url) => {
  url = String(url); fetched.push(url);
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  if (url.startsWith('/api/markets/')) {
    if (marketMode === 'hang') return new Promise(() => {});
    if (marketMode === 'down') throw new Error('markets down');
    if (url === '/api/markets/v1/market-intelligence/sport/soccer') { const e = entry(); return ok({ contract: 'market-intel/1', sport: 'soccer', enabled: true, events: [e, ...extraBoard] }); }
    const m = url.match(/^\/api\/markets\/v1\/market-intelligence\/event\/soccer\/([0-9a-f-]{36})$/);
    if (m) return ok({ contract: 'market-intel/1', sport: 'soccer', enabled: true, event: extraEvents.has(m[1]) ? extraEvents.get(m[1]) : m[1] === ID ? { ...entry(), movement: { kalshi: {} } } : null });
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

test('PBEcast: full Market Pulse card directly under the scoreboard with a lifecycle label, from the known board entry', async () => {
  marketMode = 'up'; await kx.kalshi.loadBoard({ force: true });
  const env = { data: { ...matchData(ID), status: 'scheduled', sequence: [], live: { mode: 'pregame' } }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } };
  const html = castView(env);
  assert.match(html, /<div class="ct-kx" data-kx-cast><div class="ct-mkt" data-phase="pre"><p class="ct-mkt-phase"><span class="ct-mkt-dot" aria-hidden="true"><\/span>MARKET OPEN · PRE-MATCH<\/p><section class="ic kx kx--compact"/);
  assert.doesNotMatch(html, /kx-strip|<details[^>]*kx/, 'no collapsed strip');
  assert.ok(html.indexOf('ct-board') < html.indexOf('data-kx-cast') && html.indexOf('data-kx-cast') < html.indexOf('cast-body'), 'module sits under the scoreboard, in the cast header');
  assert.ok(html.includes(kx.SETTLEMENT_NOTE));
  const t = text(html);
  assert.match(t, /Market Pulse/); assert.match(t, /Mid-market/); assert.match(t, /Updated 2 min ago/); assert.match(t, /View market on Kalshi ↗/);
  assert.equal((html.match(/class="kx__panel"/g) || []).length, 3, 'home / draw / away panels');
  assert.ok(t.indexOf('Arsenal wins') < t.indexOf('Tie is the result') && t.indexOf('Tie is the result') < t.indexOf('Leeds United wins'), 'home, draw, away order');
  assert.match(html, /Bid<\/dt><dd>71¢/); assert.match(html, /Ask<\/dt><dd>72¢/);
  for (const a of html.match(/<a [^>]*kalshi\.com[^>]*>/g)) assert.match(a, /rel="noopener noreferrer sponsored"/);
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
    { source: '/api/markets/v1/algo-vs-market/soccer', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/algo-vs-market/soccer' },
    { source: '/api/markets/v1/algo-vs-market/event/soccer/:id([0-9a-f-]+)', destination: 'https://propsports-markets.sales-fd3.workers.dev/v1/algo-vs-market/event/soccer/:id' },
  ], 'soccer routes only, no wildcard');
  const csp = v.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;
  assert.match(csp, /connect-src 'self' /, 'same-origin reads need no new connect-src host');
  assert.doesNotMatch(csp, /kalshi|propsports-markets/);
});

// Canonical = the COMMITTED shared client (HEAD of the canonical checkout), never its working tree: an owning session's
// uncommitted, in-progress edit is not a release and must not block (or be vendored by) another product's release
// (2026-10-03: every soccer push was refused while the Kalshi session had unsaved edits on top of ad6187a).
// A NEWER COMMITTED canonical still fails here until soccer re-vendors it.
test('vendored Kalshi files match the canonical shared client (committed HEAD, when the canonical checkout is present)', t => {
  const repo = 'D:/Workers/propbetedge-workers';
  if (!existsSync(join(repo, 'workers/propsports-markets/client'))) { t.skip('canonical checkout not present on this machine'); return; }
  const norm = s => s.replace(/\r\n/g, '\n');
  for (const f of ['kalshi-market-ui.js', 'kalshi-market-ui.css', 'kalshi-market-client.js', 'README.md']) {
    const committed = execFileSync('git', ['-C', repo, 'show', `HEAD:workers/propsports-markets/client/${f}`], { encoding: 'utf8' });
    assert.equal(norm(readFileSync(join('src/vendor/kalshi', f), 'utf8')), norm(committed), f);
  }
});

// ------------------------------------------------------------------ market history ("How the market closed")
// SETTLED fixture = the REAL tennis event JSON (Rybakina v Charaeva, KXWTAMATCH-26OCT01RYBCHA, captured from the
// live API 2026-10-03), reshaped ONLY for sport / ids / proposition so the soccer gate accepts it. No soccer market
// had settled when this shipped; the prices, timestamps and settlement are Kalshi's real values for that market.
const HIST_ID = '7a1c2b3d-4e5f-5a6b-8c7d-9e0f1a2b3c4d';
const CLOSED_ID = '8b2d3c4e-5f6a-5b7c-9d8e-0f1a2b3c4d5e';
const real = JSON.parse(readFileSync(new URL('./fixtures/market-history-settled-tennis.json', import.meta.url), 'utf8'));
const asSoccer = (id, mut = x => x) => {
  const e = structuredClone(real.event);
  e.event = { ...e.event, sport: 'soccer', competition: 'premier-league', canonical_event_id: id };
  for (const o of [e.kalshi, e.market, e.market_history]) if (o) o.proposition = 'match_result_90min';
  return mut(e);
};
const closedVariant = e => {
  e.market.lifecycle = 'CLOSED'; e.market.close.lifecycle = 'CLOSED';
  for (const o of e.market.close.outcomes) o.result = null;
  e.market_history.lifecycle = 'CLOSED'; e.market_history.status_label = 'Market closed';
  for (const o of e.market_history.outcomes) o.settlement = null;
  e.market_history.markers.settlement = null;
  return e;
};
const settled = () => asSoccer(HIST_ID);

test('vendored shared client is pinned byte-for-byte to propbetedge-workers e1d4284 (SHA-256)', () => {
  const pins = {
    'kalshi-market-ui.js': 'c4989c79ed3824c92363780d08d966ab752a5e65347af1693a8b22afc6fd7e29',
    'kalshi-market-ui.css': 'df81df5650cc66d0bcea37c2808eaf783522ad9f921449e954f590d4ad9a2c60',
    'kalshi-market-client.js': 'bbab54f78382f336a149b18f332bc54abe0b9c471ada3dd8ef0d67e5e5706301',
    'README.md': 'a80e4ac5d8733bde8afc0c13c281242babff8b1acd083974741f677b7af5a480',
  };
  for (const [f, sha] of Object.entries(pins)) {
    const bytes = readFileSync(join('src/vendor/kalshi', f), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, f);
  }
  for (const fn of ['marketHistoryCard', 'marketCloseLine', 'marketModule', 'algoVsMarketCard', 'algoVsMarketEvent']) assert.equal(typeof ui[fn], 'function', fn);
});

test('SETTLED (real Kalshi history): match page shows "How the market closed" with the 90-minute note, never an opening price', () => {
  const html = kx.matchKalshiHtml(settled());
  assert.match(html, /data-kx-history/);
  const t = text(html);
  assert.match(t, /How the market closed/);
  assert.match(t, /Market settled/);
  assert.match(t, /First observed/);
  assert.match(t, /Final trade/);
  assert.match(t, /Kalshi settlement: Alina Charaeva — YES/);
  assert.match(t, /Settled YES/); assert.match(t, /Settled NO/);
  assert.match(t, /is our first record, not the opening price/);
  assert.match(t, /Settlement is the market venue's, not our result/);
  assert.ok(t.includes(kx.SETTLEMENT_NOTE), '90-minute note kept with the history');
  assert.doesNotMatch(t.replace('not the opening price', ''), /opening price|opened at/i);
  assert.doesNotMatch(html, /\sstyle="/, 'no inline styles (strict CSP)');
  assert.doesNotMatch(t, /earlier than|more accurate|sportsbooks? (?:are|is) stale/i);
  const anchors = html.match(/<a [^>]*>/g) || [];
  assert.ok(anchors.length >= 1);
  for (const a of anchors) { assert.match(a, /href="https:\/\/kalshi\.com\/markets\//); assert.match(a, /rel="noopener noreferrer sponsored"/); }
});

test('CLOSED: history says "Market closed · awaiting settlement" (a finished match is not a settled market)', () => {
  const e = asSoccer(CLOSED_ID, closedVariant);
  const t = text(kx.matchKalshiHtml(e));
  assert.match(t, /Market closed · awaiting settlement/);
  assert.match(t, /Awaiting settlement/);
  assert.doesNotMatch(t, /Settled YES|Settled NO|settlement: .* — YES/);
  assert.equal(kx.marketPollMs('finished', e), 5 * 60_000, 'CLOSED polls every 5 min until settled');
  assert.equal(kx.marketPollMs('finished', settled()), null, 'SETTLED: no polling');
  assert.equal(kx.marketPollMs('live', entry()), 20_000);
  assert.equal(kx.marketPollMs('scheduled', entry()), 45_000);
  assert.equal(kx.marketPollMs('finished', null), null, 'no market: no polling');
});

test('three-way history keeps home / draw / away rows', () => {
  const e = asSoccer(HIST_ID, x => {
    const h = x.market_history; h.shape = 'three_way';
    const draw = structuredClone(h.outcomes[0]); Object.assign(draw, { role: 'draw', abbr: 'Draw', kalshi_name: 'Tie', contract: 'Tie is the result' });
    h.outcomes = [h.outcomes[0], draw, h.outcomes[1]];
    return x;
  });
  const html = kx.matchKalshiHtml(e);
  assert.equal((html.match(/<li class="kx-h__row/g) || []).length, 3);
  const t = text(html);
  assert.ok(t.indexOf('Elena Rybakina') < t.indexOf('Tie is the result') && t.indexOf('Tie is the result') < t.indexOf('Alina Charaeva'));
});

test('no entry -> no history, no close line, no poll', () => {
  assert.equal(kx.matchKalshiHtml(null), '');
  assert.equal(kx.castKalshiHtml(null), '');
  assert.equal(kx.kalshiLineFor({ id: NO_MARKET_ID, status: 'finished' }), '');
  assert.equal(ui.marketCloseLine(null), '');
  assert.equal(ui.marketHistoryCard({ market_history: null }), '');
});

test('completed match: page load keeps the market (history), mounts the slot and the PBEcast replay shows the history card', async () => {
  marketMode = 'up';
  extraEvents.set(HIST_ID, settled());
  const d = await match.load([HIST_ID]);
  assert.ok(d.kx?.market_history, 'completed-match read keeps the history entry');
  const html = match.render({ ...d, env: { ...d.env, data: { ...d.env.data, status: 'finished', score: { home: 2, away: 1 } } } });
  assert.match(html, /<section class="canvas kx-sec" data-kx-match><div class="wrap mid"><section class="ic kx kx-h" data-kx-history/);
  // a settled market whose event body has no live kalshi block still renders (the vendored loadEvent drops it)
  const noLive = settled(); noLive.kalshi = null; extraEvents.set(CLOSED_ID, noLive);
  const d2 = await match.load([CLOSED_ID]);
  assert.ok(d2.kx?.market_history, 'history kept when kalshi is null');
  assert.match(kx.matchKalshiHtml(d2.kx), /data-kx-history/);
  // PBEcast replay: history card, not the live strip
  const cast = kx.castKalshiHtml(settled());
  assert.match(cast, /data-kx-history/); assert.doesNotMatch(cast, /kx-strip/);
  assert.ok(cast.includes(kx.SETTLEMENT_NOTE));
  assert.match(kx.castKalshiHtml(entry()), /^<div class="ct-mkt" data-phase="pre">.*<section class="ic kx kx--compact"/s, 'live card while trading');
  assert.match(cast, /data-phase="settled"[^>]*><p class="ct-mkt-phase">.*MARKET SETTLED<\/p>/s, 'settled label, same slot');
  extraEvents.clear();
});

test('result cards: subtle market close line from the board for a finished match, only when it has content', async () => {
  marketMode = 'up';
  const s = settled(); const none = asSoccer(CLOSED_ID, x => { x.market.close = null; x.kalshi = null; return x; });
  extraBoard.push(s, none);
  await kx.kalshi.loadBoard({ force: true });
  const base = { kickoff_at: '2026-10-03T14:00:00Z', home: { name: 'A', slug: 'a' }, away: { name: 'B', slug: 'b' }, competition: { slug: 'premier-league', name: 'Premier League' }, score: { home: 1, away: 2 } };
  const card = matchCard({ ...base, id: HIST_ID, status: 'finished' });
  assert.match(card, /<div class="mc-kx"><span class="kx-line kx-line--closed mono"/);
  assert.match(text(card), /MARKET Alina Charaeva first 5\.5¢ · settled YES/);
  assert.doesNotMatch(matchCard({ ...base, id: CLOSED_ID, status: 'finished' }), /mc-kx|kx-line/, 'nothing recorded -> nothing');
  assert.doesNotMatch(matchCard({ ...base, id: NO_MARKET_ID, status: 'finished' }), /mc-kx|kx-line/);
  extraBoard.length = 0;
});

// ------------------------------------------------------------------ MLB standard: lifecycle labels + score ticker line
test('PBEcast lifecycle labels: pre-match / live / full time still trading / closed awaiting settlement / settled', () => {
  const label = (e, st) => kx.castMarketPhase(e, st)?.[1] ?? null;
  assert.equal(label(null, { status: 'scheduled' }), null);
  assert.equal(label(entry(), { mode: 'pregame', status: 'scheduled' }), 'MARKET OPEN · PRE-MATCH');
  assert.equal(label(entry(), { mode: 'live', status: 'live' }), 'LIVE MARKET');
  assert.equal(label(entry(), { mode: 'replay', status: 'finished' }), 'FULL TIME · MARKET STILL TRADING');
  assert.equal(label(asSoccer(CLOSED_ID, closedVariant), { status: 'finished' }), 'MARKET CLOSED · AWAITING SETTLEMENT');
  assert.equal(label(settled(), { status: 'finished' }), 'MARKET SETTLED');
  const live = kx.castKalshiHtml(entry(), { mode: 'live', status: 'live' });
  assert.match(live, /data-phase="live"/); assert.match(text(live), /LIVE MARKET Market Pulse/);
  const closed = kx.castKalshiHtml(asSoccer(CLOSED_ID, closedVariant), { status: 'finished' });
  assert.match(closed, /data-phase="closed"/); assert.match(closed, /data-kx-history/); assert.match(text(closed), /MARKET CLOSED · AWAITING SETTLEMENT How the market closed/);
  // a closed board entry with no history yet: nothing until the event read brings market_history (no empty box)
  const bare = asSoccer(CLOSED_ID, closedVariant); bare.market_history = null; bare.kalshi = null;
  assert.equal(kx.castKalshiHtml(bare, { status: 'finished' }), '');
});

test('the 70d92e0 product-side fetch wrapper is gone: the shared client keeps completed events itself', async () => {
  const src = readFileSync('src/data/kalshi.js', 'utf8');
  assert.doesNotMatch(src, /teeFetch|rawBoard|rawEvents|fetchImpl/);
  marketMode = 'up';
  const s = settled(); s.kalshi = null; extraBoard.push(s); extraEvents.set(HIST_ID, s);
  await kx.kalshi.loadBoard({ force: true });
  assert.ok(kx.boardEntry(HIST_ID)?.market?.lifecycle, 'board keeps a completed entry with no live block');
  const ev = await kx.loadMatchMarket(HIST_ID, { force: true });
  assert.ok(ev?.market_history, 'event read keeps market_history with kalshi null');
  extraBoard.length = 0; extraEvents.clear();
  await kx.kalshi.loadBoard({ force: true });
});

const { tickerItem, tickerMarketHtml } = await import('../../src/components/score-ticker.js');
test('score ticker: compact "MKT ARS 71.5¢ · DRAW 17.5¢ · LEE 11.5¢" segment only for an exact, live-or-next, displayable market', () => {
  const m = { id: ID, kickoff_at: '2026-10-03T14:00:00Z', home: { name: 'Arsenal', short_name: 'Arsenal' }, away: { name: 'Leeds United', short_name: 'Leeds' }, competition: null, score: null };
  const parts = kx.tickerMarket(entry(), m, 'next');
  assert.deepEqual(parts, [{ label: 'ARS', px: '71.5¢' }, { label: 'DRAW', px: '17.5¢' }, { label: 'LEE', px: '11.5¢' }]);
  assert.deepEqual(kx.tickerMarket(entry(), m, 'live'), parts);
  assert.equal(kx.tickerMarket(entry(), m, 'ft'), null, 'finals carry no line');
  assert.equal(kx.tickerMarket(entry(), { ...m, id: NO_MARKET_ID }, 'next'), null, 'exact match id only');
  assert.equal(kx.tickerMarket(entry({ freshness: 'stale' }), m, 'live'), null, 'no stale quote');
  assert.equal(kx.tickerMarket(entry({ proposition: 'match_result_incl_extra_time' }), m, 'next'), null);
  assert.equal(kx.tickerMarket(null, m, 'next'), null);
  const e2 = entry(); e2.kalshi.outcomes[1].displayable = false;
  assert.equal(kx.tickerMarket(e2, m, 'next'), null, 'undisplayable contract -> no line');
  const odd = entry(); odd.kalshi.outcomes[0].market_ticker = 'X-weird'; odd.kalshi.outcomes[2].market_ticker = 'X';
  assert.deepEqual(kx.tickerMarket(odd, m, 'next').map(p => p.label), ['H', 'DRAW', 'A'], 'fallback labels');
  const chip = tickerItem({ m, k: 'next' }, { market: parts });
  assert.match(chip, /href="\/pbecast\/dd8264d9-a90f-54bd-8da8-da17d6d41ef7"/, 'chip still opens PBEcast, never Kalshi');
  assert.doesNotMatch(chip, /kalshi\.com/);
  assert.match(text(chip), /MKT ARS 71\.5¢ · DRAW 17\.5¢ · LEE 11\.5¢/);
  assert.doesNotMatch(chip, /sstyle="/, 'no inline styles');
  const plain = tickerItem({ m, k: 'next' });
  assert.doesNotMatch(plain, /stk-mkt/, 'no market -> chip unchanged');
  assert.equal(tickerMarketHtml(null), '');
});

// ------------------------------------------------------------------ shared client ad6187a behaviour
test('ad6187a: the card subtitle says "Live prediction market" only for a live-fresh quote; stale says "quote not current"', () => {
  assert.match(text(kx.matchKalshiHtml(entry())), /Market Pulse Live prediction market · Kalshi/);
  const stale = text(kx.matchKalshiHtml(entry({ freshness: 'stale', age_seconds: 3600 })));
  assert.match(stale, /Market Pulse Prediction market · quote not current · Kalshi/);
  assert.doesNotMatch(stale, /Live prediction market ·/);
  const delayed = text(kx.matchKalshiHtml(entry({ freshness: 'delayed' })));
  assert.match(delayed, /Market Pulse Prediction market · Kalshi/);
});

test('ad6187a: a failed event read is never cached as "no market": the last good value is kept and the next call retries', async () => {
  const { createKalshiClient } = await import('../../src/vendor/kalshi/kalshi-market-client.js');
  let mode = 'up'; const calls = [];
  const c = createKalshiClient({ sport: 'soccer', base: '/api/markets', fetchImpl: async url => { calls.push(url); if (mode === 'down') return { ok: false, status: 503, json: async () => ({}) }; return { ok: true, status: 200, json: async () => ({ enabled: true, event: entry() }) }; } });
  const good = await c.loadEvent(ID);
  assert.equal(good?.event?.canonical_event_id, ID);
  mode = 'down';
  const kept = await c.loadEvent(ID, { force: true });
  assert.equal(kept, good, 'a 503 keeps the last good entry (no "no market")');
  mode = 'up';
  const n = calls.length;
  const again = await c.loadEvent(ID); // no force: a failure is not cached for the TTL, so this reads again at once
  assert.equal(calls.length, n + 1, 'retried immediately');
  assert.equal(again?.event?.canonical_event_id, ID);
  // a never-good id that fails reads as nothing, and the next call retries rather than serving a cached null
  mode = 'down';
  assert.equal(await c.loadEvent(NO_MARKET_ID), null);
  const m = calls.length; await c.loadEvent(NO_MARKET_ID);
  assert.equal(calls.length, m + 1);
});
