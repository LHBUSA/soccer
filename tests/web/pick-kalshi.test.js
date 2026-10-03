// PBE Picks x Kalshi on soccer: an Official Pick carries the Kalshi line for the SAME match and the SAME side
// (home / draw / away), only for the match-result market (Kalshi 90-minute result); home-to-score gets none.
// A settled / kicked-off pick shows stored close evidence only, never a live quote; the frozen Algo vs Market line
// comes only from a frozen comparison of the same side. Fixtures: REAL board entries (GET
// /v1/market-intelligence/sport/soccer, captured 2026-10-03, Dortmund v Bremen + Augsburg v Bayern) and the REAL
// /v1/algo-vs-market/soccer response (Augsburg v Bayern, AGREEMENT).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const BOARD = JSON.parse(readFileSync(new URL('./fixtures/market-board-soccer-picks.json', import.meta.url), 'utf8'));
const AVM = JSON.parse(readFileSync(new URL('./fixtures/algo-vs-market-soccer.json', import.meta.url), 'utf8'));
const AUG = 'c25c4136-f800-5f3a-a5de-b91c1f981bd7';
const BVB = '48fdbe3e-8dae-5710-a416-8f58b4d1d474';

const fetched = [];
globalThis.fetch = async (url) => {
  url = String(url); fetched.push(url);
  if (url === '/api/markets/v1/market-intelligence/sport/soccer') return { ok: true, status: 200, json: async () => BOARD };
  throw new Error(`unexpected fetch ${url}`);
};

const { kalshi } = await import('../../src/data/kalshi.js');
const { pickKalshi } = await import('../../src/pages/algo.js');
const { pickMarketLine } = await import('../../src/lib/pick-market.js');
await kalshi.loadBoard();
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const REL = 'rel="noopener noreferrer sponsored"';
const FUTURE = Date.parse('2026-10-05T00:00:00Z');
const pick = extra => ({ record_no: 1, match_id: BVB, market: '1x2', selection: 'home', status: 'pending', kickoff_at: '2026-10-09T18:30:00+00:00', ...extra });

test('one board read; the pick side only, linked to Kalshi', () => {
  const html = pickKalshi(pick(), null, FUTURE);
  assert.equal(text(html), 'KALSHI Borussia Dortmund 70.0¢ PBE pick side');
  assert.ok(html.includes(REL) && html.includes('href="https://kalshi.com/markets/'));
  assert.equal(text(pickKalshi(pick({ selection: 'draw' }), null, FUTURE)), 'KALSHI Draw 16.5¢ PBE pick side');
  assert.equal(fetched.filter(u => u.includes('/sport/soccer')).length, 1);
});

test('home-to-score and unknown matches get nothing; a kicked-off pick never shows a live quote', () => {
  assert.equal(pickKalshi(pick({ market: 'home_to_score', selection: 'yes' }), null, FUTURE), '');
  assert.equal(pickKalshi(pick({ match_id: '6bae8740-e07c-5808-8f3d-e85a2396d058' }), null, FUTURE), '');
  assert.equal(pickKalshi(pick({ status: 'win' }), null, FUTURE), '', 'settled pick + open market without a recorded close');
  assert.equal(pickKalshi(pick(), null, Date.parse('2026-10-09T19:00:00Z')), '', 'kicked off');
});

test('frozen Algo vs Market: same side only, real fixture', () => {
  const aug = pickKalshi(pick({ match_id: AUG, selection: 'away', kickoff_at: '2026-10-10T13:30:00+00:00' }), AVM, FUTURE);
  assert.match(text(aug), /KALSHI Bayern München 80\.5¢ PBE pick side AT PBE LOCK PBE 71\.4% · Market 80\.5¢ · −9\.1 pts/);
  const other = pickKalshi(pick({ match_id: AUG, selection: 'home', kickoff_at: '2026-10-10T13:30:00+00:00' }), AVM, FUTURE);
  assert.doesNotMatch(other, /AT PBE LOCK/);
});

test('stored close evidence wording', () => {
  const e = { event: { canonical_event_id: BVB }, kalshi: null, market: { lifecycle: 'CLOSED', market_url: 'https://kalshi.com/markets/x', proposition: 'match_result_90min',
    close: { lifecycle: 'CLOSED', outcomes: [{ role: 'home', abbr: 'Borussia Dortmund', first_bp: 6900, before_start_bp: null, result: null }] } } };
  assert.equal(text(pickMarketLine(e, 'home', { settled: true })), 'KALSHI Borussia Dortmund first observed 69.0¢ · awaiting settlement');
});
