// ALGO vs MARKET on Soccer: /track-record module (Soccer Algo V1, match result) + match-page layer next to Market Pulse.
// Fixtures are the REAL responses of GET /v1/algo-vs-market/soccer and /v1/algo-vs-market/event/soccer/c25c4136-…
// (captured 2026-10-03: Augsburg v Bayern München, one AGREEMENT, pending). Rendering is the vendored shared module.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const AVM = JSON.parse(readFileSync(new URL('./fixtures/algo-vs-market-soccer.json', import.meta.url), 'utf8'));
const AVM_EVENT = JSON.parse(readFileSync(new URL('./fixtures/algo-vs-market-event-soccer-c25c4136.json', import.meta.url), 'utf8'));
const AUG = 'c25c4136-f800-5f3a-a5de-b91c1f981bd7';
const OTHER = '5b0c8f3e-1111-5222-8333-444455556666';

const fetched = [];
let avmMode = 'up'; // 'up' | 'down' | 'empty'
globalThis.fetch = async (url) => {
  url = String(url); fetched.push(url);
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  if (url === '/api/markets/v1/algo-vs-market/soccer') {
    if (avmMode === 'down') return { ok: false, status: 502, json: async () => ({}) };
    return ok(avmMode === 'empty' ? { ...AVM, algos: [] } : AVM);
  }
  const ev = url.match(/^\/api\/markets\/v1\/algo-vs-market\/event\/soccer\/([0-9a-f-]{36})$/);
  if (ev) {
    if (avmMode === 'down') throw new Error('down');
    return ok(ev[1] === AUG && avmMode === 'up' ? AVM_EVENT : { contract: 'algo-vs-market/1', sport: 'soccer', comparisons: [] });
  }
  if (/^\/api\/markets\/v1\/market-intelligence\/event\/soccer\//.test(url)) return ok({ contract: 'market-intel/1', sport: 'soccer', enabled: true, event: null });
  const mm = url.match(/^\/api\/soccer\/matches\/([0-9a-f-]{36})$/);
  if (mm) return ok({ data: matchData(mm[1]), meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } });
  throw new Error(`unexpected fetch ${url}`);
};
const matchData = id => ({
  id, status: 'scheduled', kickoff_at: '2026-10-10T13:30:00Z', round: null, score: null, result_source: 'espn', event_source: null,
  home: { id: 'h', slug: 'augsburg', name: 'Augsburg' }, away: { id: 'a', slug: 'bayern-munchen', name: 'Bayern München' },
  competition: { slug: 'bundesliga', name: 'Bundesliga' }, season: '2026/27', timeline: [], shots: [], stats: null, lineups: null, substitutions: [],
});

const ui = await import('../../src/vendor/kalshi/kalshi-market-ui.js');
const kx = await import('../../src/data/kalshi.js');
const match = await import('../../src/pages/match.js');
const { trackRecord, MODELS } = await import('../../src/pages/algo.js');
const { summarize, policy } = await import('../../workers/soccer-api/src/algo.js');
const research = JSON.parse(readFileSync(new URL('../../workers/soccer-api/src/algo-research.json', import.meta.url), 'utf8'));
const text = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
// the official ledger row of the same match, as GET /v1/algo/picks serves it (names only matter here)
const augPick = { record_no: 2, match_id: AUG, home: { slug: 'augsburg', name: 'Augsburg' }, away: { slug: 'bayern-munchen', name: 'Bayern München' } };
const V1 = MODELS.find(m => m.key === 'bundesliga'); const V2 = MODELS.find(m => m.key === 'nations-league');
const meta = { source: 'pbe', coverage: { state: 'ok', notes: [] } };
const record = { live: true, started_at: '2026-09-29T21:00:37+00:00', policy: policy(), filter: { market: null, last: null }, totals: summarize([]), by_market: {}, windows: {}, prices: { reason: '' }, picks: [] };
const recArgs = extra => ({ rec: { data: record, meta }, res: { data: research }, model: V1, live: [V1], markets: policy().markets, ...extra });

test('fixture is the real API shape: one algo (Soccer Algo V1) with one AGREEMENT, pending', () => {
  assert.equal(AVM.contract, 'algo-vs-market/1');
  assert.equal(AVM.algos.length, 1);
  assert.equal(AVM.algos[0].algo_id, 'soccer:soccer-algo-v1');
  assert.equal(AVM.algos[0].ledger[0].status, 'AGREEMENT');
  assert.equal(AVM.algos[0].ledger[0].canonical_event_id, AUG);
});

test('nothing renders for empty algos, a null/failed payload, or a model without a comparable market', () => {
  assert.equal(kx.trackRecordAvmHtml({ ...AVM, algos: [] }, 'bundesliga'), '');
  assert.equal(kx.trackRecordAvmHtml(null, 'bundesliga'), '');
  assert.equal(kx.trackRecordAvmHtml(AVM, 'nations-league'), '', 'V2 has no comparable market: no module');
  assert.equal(kx.matchAvmHtml({ comparisons: [] }, matchData(OTHER)), '');
  assert.equal(kx.matchAvmHtml(null, matchData(OTHER)), '');
  const page = trackRecord.render(recArgs({ avm: { ...AVM, algos: [] } }));
  assert.doesNotMatch(page, /ALGO VS MARKET|Algo vs Market|data-avm/);
});

test('/track-record: real module after CALIBRATION — PropBetEdge 0 — 0 Market, Agreed 1, Pending 1, Augsburg v Bayern München', () => {
  const html = trackRecord.render(recArgs({ avm: AVM, avmPicks: [augPick] }));
  const at = html.indexOf('data-avm="soccer:soccer-algo-v1"');
  const cal = html.indexOf('Model probability vs outcome'); const ledger = html.indexOf('Every Official Pick', cal);
  assert.ok(cal > 0 && at > cal, 'after the CALIBRATION section');
  assert.ok(at < ledger, 'before the ledger');
  const t = text(html.slice(html.indexOf('ALGO VS MARKET'), ledger));
  assert.match(t, /PropBetEdge 0 — Market 0/);
  assert.match(t, /0 decided disagreements/);
  assert.match(t, /Agreed 1/); assert.match(t, /Neither \/ void 0/); assert.match(t, /Pending 1/);
  assert.match(t, /2026-10-03 Augsburg v Bayern München Bayern München Bayern München · 80\.5¢ Agree Pending/);
  assert.doesNotMatch(t, /c25c4136/, 'the match is named, never shown as a raw id');
  assert.match(t, /Both opinions are frozen at the algorithm's lock/);
  assert.doesNotMatch(t, /beats? the market|outperform/i, 'no marketing claims');
});

test('soccer AGREEMENT names Bayern München on both sides (event layer); the module resolves roles without page data too', () => {
  const t = text(kx.matchAvmHtml(AVM_EVENT, matchData(AUG)));
  assert.match(t, /Algo vs Market Agreement · frozen 2026-10-03/);
  assert.match(t, /PBE Soccer Algo V1 Bayern München 71\.4% vs Market at PBE lock Bayern München 80\.5¢/);
  assert.match(t, /Market price recorded 2 min before the algorithm locked/);
  assert.doesNotMatch(t, /\baway\b/i, 'no raw role word');
  // without page names the frozen market price labels still resolve the role
  assert.match(text(ui.algoVsMarketEvent(AVM_EVENT)), /Bayern München 71\.4% vs .*Bayern München 80\.5¢/);
});

test('LOCKED (Pro-gated, pending) rows show no selections', () => {
  const base = AVM.algos[0].ledger[0];
  const locked = { ...base, status: 'LOCKED', algo_selection: null, algo_selection_label: null, algo_probability: null, market: { ...base.market, selection: null, selection_label: null, selection_price_bp: null } };
  const card = text(kx.trackRecordAvmHtml({ algos: [{ ...AVM.algos[0], ledger: [locked] }] }, 'bundesliga', [augPick]));
  assert.match(card, /Augsburg v Bayern München Locked — — Locked · pending/);
  assert.doesNotMatch(card, /71\.4%|80\.5¢|Bayern München Bayern München/);
  const ev = text(ui.algoVsMarketEvent({ comparisons: [locked] }));
  assert.match(ev, /Locked — revealed after the result/);
  assert.doesNotMatch(ev, /Bayern|Augsburg|71\.4%|80\.5¢/);
});

test('track-record load reads the same-origin route once, in parallel; a failed read renders nothing', async () => {
  const restore = globalThis.fetch;
  const stubSoccer = async url => {
    url = String(url);
    if (url.startsWith('/api/soccer/algo/v2/')) return { ok: true, status: 200, json: async () => ({ data: { live: false }, meta }) };
    if (url.startsWith('/api/soccer/algo/picks')) return { ok: true, status: 200, json: async () => ({ data: { live: true, policy: policy(), official_picks: { open: [augPick], recent: [] }, game_best: [] }, meta }) };
    if (url.startsWith('/api/soccer/algo/record')) return { ok: true, status: 200, json: async () => ({ data: record, meta }) };
    if (url.startsWith('/api/soccer/algo/research')) return { ok: true, status: 200, json: async () => ({ data: research, meta }) };
    return restore(url);
  };
  globalThis.fetch = stubSoccer;
  try {
    avmMode = 'up'; fetched.length = 0;
    const d = await trackRecord.load([], new URLSearchParams());
    assert.equal(fetched.filter(u => u === '/api/markets/v1/algo-vs-market/soccer').length, 1);
    assert.match(text(trackRecord.render(d)), /Augsburg v Bayern München/);
    avmMode = 'down';
    const down = await trackRecord.load([], new URLSearchParams('model=bundesliga&market=home_to_score'));
    assert.equal(down.avm, null);
    const failed = await trackRecord.load([], new URLSearchParams('model=bundesliga'));
    assert.equal(failed.avm, null);
    assert.doesNotMatch(trackRecord.render(failed), /Algo vs Market/);
  } finally { globalThis.fetch = restore; avmMode = 'up'; }
});

test('match page: the event layer sits directly after Market Pulse in the first paint; nothing for a match without a comparison', async () => {
  avmMode = 'up';
  const d = await match.load([AUG]);
  const html = match.render(d);
  const at = html.indexOf('data-avm-match');
  assert.ok(at > html.indexOf('data-kx-match') && at < html.indexOf('data-analyzer-preview'), 'right after the Market Pulse slot');
  assert.match(html, /<section class="canvas kx-sec avm-sec" data-avm-match><div class="wrap mid"><section class="ic kx avm avm--event"/);
  const none = match.render(await match.load([OTHER]));
  assert.match(none, /data-avm-match hidden><div class="wrap mid"><\/div>/);
  avmMode = 'down';
  const down = match.render(await match.load([AUG]));
  assert.match(down, /data-avm-match hidden>/);
  avmMode = 'up';
});

test('vercel.json routes the two exact algo-vs-market reads; CSP connect-src stays self', () => {
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const r = v.rewrites.filter(x => x.source.includes('algo-vs-market'));
  assert.deepEqual(r.map(x => x.source), ['/api/markets/v1/algo-vs-market/soccer', '/api/markets/v1/algo-vs-market/event/soccer/:id([0-9a-f-]+)']);
  const csp = v.headers.flatMap(h => h.headers).find(h => h.key === 'Content-Security-Policy').value;
  assert.doesNotMatch(csp, /propsports-markets/);
});
