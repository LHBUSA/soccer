// Article Market module on soccer news (contract article-market/1). The fixture is a REAL production response
// (GET /v1/article-market/soccer/fa23ec39-… captured 2026-10-04 14:3xZ, Nottm Forest v Arsenal, Kalshi only,
// no PBE decision yet). Owner rules: prospective only (no backfill), canonical match link only, venues separate,
// nothing rendered when nothing is eligible.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { ARTICLE_MARKET_ACTIVATED_AT, articleMarketEvent, articleMarketHtml, loadArticleMarket } from '../../src/data/article-market.js';
import { articleMarketSlot } from '../../src/pages/article.js';

const payload = JSON.parse(readFileSync(new URL('./fixtures/article-market-soccer-fa23ec39.json', import.meta.url), 'utf8'));
const MATCH = 'fa23ec39-30fc-55a0-9349-d4966333396d';
const article = (over = {}) => ({ published_at: '2026-10-04T14:35:00Z', entities: [{ type: 'SportsEvent', name: 'Nottm Forest v Arsenal', href: `/matches/${MATCH}` }], ...over });

test('activation constant equals the production ARTICLE_MARKET_ACTIVATED_AT (never moved backward)', () => {
  assert.equal(ARTICLE_MARKET_ACTIVATED_AT, '2026-10-04T14:31:40Z');
  assert.equal(Date.parse(payload.activated_at), Date.parse(ARTICLE_MARKET_ACTIVATED_AT));
});

test('eligibility: canonical match link + first published at/after activation; nothing else', () => {
  assert.equal(articleMarketEvent(article()), MATCH);
  assert.equal(articleMarketEvent(article({ published_at: '2026-10-04T14:31:39Z' })), null, 'pre-activation story: no module, ever');
  assert.equal(articleMarketEvent(article({ entities: [{ type: 'SportsTeam', name: 'Arsenal', href: '/teams/arsenal' }] })), null, 'no match link: no module');
  assert.equal(articleMarketEvent(article({ entities: [{ type: 'SportsEvent', name: 'x', href: '/matches/not-a-uuid' }] })), null);
  assert.equal(articleMarketEvent(article({ published_at: null })), null);
});

test('slot: pre-activation / unlinked article renders nothing at all', () => {
  assert.equal(articleMarketSlot(article({ published_at: '2026-10-01T10:00:00Z' }), { now: payload }), '');
  assert.equal(articleMarketSlot(article({ entities: [] }), { now: payload }), '');
});

test('real payload: LIVE MARKET WATCH, Kalshi column only, "No official call", truthful freshness, no inline styles', () => {
  const html = articleMarketSlot(article(), { now: payload });
  assert.match(html, /data-art-market/);
  assert.match(html, /Live market watch/);
  assert.match(html, />Kalshi</);
  assert.doesNotMatch(html, /Polymarket/, 'no venue that was not observed');
  assert.match(html, /No official call/);
  assert.match(html, /Updated \d+ min ago|LIVE/);
  assert.match(html, /does not mean this story moved the market/);
  assert.doesNotMatch(html, /\sstyle="/, 'strict CSP');
  assert.doesNotMatch(html, /consensus|average of/i);
});

test('ineligible / failed reads render nothing (no placeholder)', async () => {
  assert.equal(articleMarketHtml(null), '');
  assert.equal(articleMarketHtml({ ...payload, eligible: false, packet: null, live: null }), '');
  assert.equal(await loadArticleMarket(MATCH, '2026-10-04T14:35:00Z', async () => ({ ok: false })), null);
  assert.equal(await loadArticleMarket(MATCH, '2026-10-04T14:35:00Z', async () => { throw new Error('net'); }), null);
  assert.equal(await loadArticleMarket(MATCH, '2026-10-04T14:35:00Z', async () => ({ ok: true, json: async () => ({ eligible: false }) })), null);
  let url = null;
  await loadArticleMarket(MATCH, '2026-10-04T14:35:00Z', async (u) => { url = u; return { ok: false }; });
  assert.equal(url, `/api/markets/v1/article-market/soccer/${MATCH}?published_at=2026-10-04T14%3A35%3A00Z`, 'same-origin rewrite, original published_at');
});

test('vercel: exact same-origin rewrite for the article-market route only', () => {
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const r = (v.rewrites || []).find((x) => x.source === '/api/markets/v1/article-market/soccer/:id([0-9a-f-]+)');
  assert.ok(r);
  assert.equal(r.destination, 'https://propsports-markets.sales-fd3.workers.dev/v1/article-market/soccer/:id');
});

test('vendored article-market client pinned byte-for-byte to propbetedge-workers 3f7345e (SHA-256)', () => {
  const pins = {
    'article-market-ui.js': createHash('sha256').update(readFileSync(join('src/vendor/kalshi', 'article-market-ui.js'), 'utf8').replace(/\r\n/g, '\n')).digest('hex'),
  };
  assert.equal(pins['article-market-ui.js'], ARTICLE_UI_SHA);
  assert.equal(createHash('sha256').update(readFileSync(join('src/vendor/kalshi', 'article-market-ui.css'), 'utf8').replace(/\r\n/g, '\n')).digest('hex'), ARTICLE_CSS_SHA);
});
const ARTICLE_UI_SHA = '2149e2854142657a554ef119533680c77657f0d2b1ea8406fe4de711e4fbe635';
const ARTICLE_CSS_SHA = '582c879d9a634caa467f31896c928bf854fc16579a1565091bb5b0093ee0505c';
