// Writer-side freeze of the FINAL article market packet (market-freeze.js) + the operator-forced single preview.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { runNews } from '../workers/soccer-news/src/pipeline.js';
import { ARTICLE_MARKET_ACTIVATED_AT, MARKET_FREEZE_VERSION, articleEventId, canonicalJson, freezeMarketPackets, freezeRefusal, packetVerifies, sha256Hex } from '../workers/soccer-news/src/market-freeze.js';
import { ARTICLE_MARKET_ACTIVATED_AT as WEB_ACTIVATED_AT } from '../src/data/article-market.js';

const real = JSON.parse(readFileSync(new URL('./fixtures/article-market-bvb-svw-2026-10-04.json', import.meta.url)));
const EVENT = '48fdbe3e-8dae-5710-a416-8f58b4d1d474';
const seal = async p => { const { sha256: _d, ...body } = p; return { ...body, sha256: await sha256Hex(canonicalJson(body)) }; };
const finalOf = async () => seal({ ...structuredClone(real.packet), packet_state: 'FINAL', state_reasons: [] });

test('the sealed propsports-markets packet verifies with our canonical JSON (cross-implementation), tampering does not', async () => {
  assert.equal(await packetVerifies(real.packet), true, 'real production packet sha256 reproduces');
  const t = structuredClone(real.packet); t.venues[0].outcomes[0].at_publication.mid_bp += 1;
  assert.equal(await packetVerifies(t), false);
  assert.equal(ARTICLE_MARKET_ACTIVATED_AT, WEB_ACTIVATED_AT, 'writer and page share the one activation time');
});

test('freeze only a FINAL, verified packet for this exact event', async () => {
  assert.equal(await freezeRefusal(real, EVENT), 'not_final_yet', 'LIVE_MARKET_WATCH / PROVISIONAL is never frozen');
  const fin = await finalOf();
  assert.equal(await freezeRefusal({ eligible: true, freeze: 'EMBED_THIS_PACKET', packet: fin }, EVENT), null);
  assert.equal(await freezeRefusal({ eligible: true, freeze: 'EMBED_THIS_PACKET', packet: fin }, '00000000-0000-5000-8000-000000000001'), 'packet_for_another_event');
  assert.equal(await freezeRefusal({ eligible: true, freeze: 'EMBED_THIS_PACKET', packet: { ...fin, packet_state: 'PROVISIONAL' } }, EVENT), 'packet_not_final');
  assert.equal(await freezeRefusal({ eligible: true, freeze: 'EMBED_THIS_PACKET', packet: { ...fin, venues: [] } }, EVENT), 'packet_sha256_mismatch');
  assert.equal(await freezeRefusal({ eligible: false, reason: 'PRE_ACTIVATION_ARTICLE' }, EVENT), 'not_eligible');
  assert.equal(articleEventId({ entities: [{ type: 'SportsTeam', id: 'x' }, { type: 'SportsEvent', id: EVENT, href: `/matches/${EVENT}` }] }), EVENT);
  assert.equal(articleEventId({ entities: [{ type: 'SportsTeam', id: 'x' }] }), null, 'no event link -> no market (never a title match)');
});

const id = n => `00000000-0000-5000-8000-0000000f${String(n).padStart(4, '0')}`;
async function seedArticles() {
  const store = await openPglite(); await applyMigrations(store);
  const mkArt = async (n, publishedAt, entities, status = 'published') => {
    const ev = id(100 + n); const hash = (await sha256Hex(`p${n}`));
    await store.insert('soccer_news_events', [{ id: ev, story_class: 'match_preview', desk: 'bundesliga', materiality: 1, as_of: '2026-10-09T18:30:00Z', status }]);
    await store.insert('soccer_article_evidence', [{ packet_hash: hash, news_event_id: ev, packet_version: 'soccer-packet-preview/1.0.0', packet: { n }, capture_ids: [] }]);
    await store.insert('soccer_articles', [{ id: id(200 + n), slug: `a-${n}`, news_event_id: ev, packet_hash: hash, story_class: 'match_preview', desk: 'bundesliga', headline: `H${n}`, dek: null, body: { sections: [{ key: 'lede', text: 'prose' }] }, entities, composer: 'x', gate_version: 'g', gate_results: {}, status, hold_reasons: status === 'published' ? [] : ['h'], published_at: status === 'published' ? publishedAt : null }]);
    return { ev, slug: `a-${n}` };
  };
  const link = [{ type: 'SportsEvent', id: EVENT, name: 'Borussia Dortmund v VfL Wolfsburg', href: `/matches/${EVENT}` }];
  const after = await mkArt(1, '2026-10-04T16:07:00Z', link);
  const before = await mkArt(2, '2026-10-04T14:31:39Z', link); // one second before activation: never eligible
  const unlinked = await mkArt(3, '2026-10-04T16:07:00Z', [{ type: 'SportsTeam', id: 'x' }]);
  return { store, after, before, unlinked };
}

test('writer freeze: FINAL packet stored once into article evidence; pre-activation, unlinked and provisional articles untouched', async () => {
  const { store, after } = await seedArticles();
  const NOW = Date.parse('2026-10-10T00:00:00Z');
  const calls = [];
  let answer = real; // provisional first
  const fetcher = async url => { calls.push(url); return new Response(JSON.stringify(answer), { status: 200 }); };
  const r1 = await freezeMarketPackets(store, {}, { now: NOW, fetcher });
  assert.equal(calls.length, 1, 'only the eligible linked article is read');
  assert.match(calls[0], new RegExp(`/v1/article-market/soccer/${EVENT}\\?published_at=2026-10-04T16%3A07%3A00.000Z$`), 'original first publication time');
  assert.equal(r1.frozen, 0); assert.equal(r1.waiting.not_final_yet, 1);
  const fin = await finalOf();
  answer = { ...real, mode: 'MARKET_RESULT', freeze: 'EMBED_THIS_PACKET', packet: fin };
  const r2 = await freezeMarketPackets(store, {}, { now: NOW, fetcher });
  assert.equal(r2.frozen, 1, JSON.stringify(r2));
  const rows = await store.select('soccer_article_evidence', { columns: ['packet_hash', 'news_event_id', 'packet_version', 'packet', 'capture_ids'], eq: { packet_version: MARKET_FREEZE_VERSION } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].news_event_id, after.ev);
  assert.equal(rows[0].packet.market_packet_sha256, fin.sha256);
  assert.equal(rows[0].packet.published_at, '2026-10-04T16:07:00.000Z');
  assert.equal(await packetVerifies(rows[0].packet.packet), true, 'stored packet still verifies');
  assert.equal(rows[0].packet_hash, await sha256Hex(canonicalJson(rows[0].packet)));
  // third pass: already frozen -> no read at all
  const n = calls.length;
  const r3 = await freezeMarketPackets(store, {}, { now: NOW, fetcher });
  assert.equal(calls.length, n); assert.equal(r3.already_frozen, 1); assert.equal(r3.frozen, 0);
  // the article itself is never touched
  const [art] = await store.select('soccer_articles', { columns: ['body', 'published_at'], eq: { slug: after.slug } });
  assert.deepEqual(art.body, { sections: [{ key: 'lede', text: 'prose' }] });
  await store.close();
});

test('writer freeze: no binding -> skipped; a failing read is counted, never thrown', async () => {
  const { store } = await seedArticles();
  assert.equal((await freezeMarketPackets(store, {}, { now: Date.parse('2026-10-05T00:00:00Z') })).skipped, 'no_markets_binding');
  const r = await freezeMarketPackets(store, {}, { now: Date.parse('2026-10-05T00:00:00Z'), fetcher: async () => { throw new Error('boom'); } });
  assert.equal(r.errors, 1); assert.equal(r.frozen, 0);
  await store.close();
});

// ---- operator-forced single preview (POST /v1/run?preview_match=)
const pid = n => `00000000-0000-5000-8000-0000000e${String(n).padStart(4, '0')}`;
async function seedSeason() {
  const store = await openPglite(); await applyMigrations(store);
  const H = 3600e3;
  await store.insert('soccer_competitions', [{ id: pid(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: pid(2), competition_id: pid(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: pid(3), season_id: pid(2), name: 'Regular season', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley'].map((n, i) => ({ id: pid(10 + i), slug: n.toLowerCase(), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(300 + i) }));
  await store.insert('soccer_teams', teams);
  const mk = (n, h, a, hs, as, iso, status = 'finished') => ({ id: pid(n), competition_id: pid(1), season_id: pid(2), stage_id: pid(3), kickoff_at: iso, home_team_id: teams[h].id, away_team_id: teams[a].id, status, home_score: status === 'finished' ? hs : null, away_score: status === 'finished' ? as : null, result_provider: 'espn' });
  const played = [[0, 1, 2, 0], [2, 3, 1, 1], [4, 5, 0, 1], [0, 2, 3, 0], [1, 4, 2, 1], [3, 5, 0, 2], [5, 0, 0, 2], [3, 1, 1, 2], [4, 2, 1, 1]];
  await store.insert('soccer_matches', [
    ...played.map(([h, a, hs, as], i) => mk(20 + i, h, a, hs, as, new Date(Date.parse('2026-09-12T14:00:00Z') + Math.floor(i / 3) * 7 * 86400e3 + (i % 3) * H).toISOString())),
    mk(40, 0, 3, null, null, '2026-10-03T14:00:00Z', 'scheduled'), mk(41, 1, 5, null, null, '2026-10-03T16:30:00Z', 'scheduled'), mk(42, 2, 4, null, null, '2026-10-03T19:00:00Z', 'scheduled'),
    mk(45, 0, 1, null, null, '2026-10-06T14:00:00Z', 'scheduled'), // 78 h out: top-of-table meeting, outside the 24 h window
    mk(46, 0, 2, null, null, '2026-10-20T14:00:00Z', 'scheduled'), // > 7 days out: never, even forced
  ]);
  return store;
}

test('forced preview: only that fixture, up to 7 days out, same materiality + gates, one story, then a duplicate', async () => {
  const store = await seedSeason();
  const NOW = Date.parse('2026-10-03T08:00:00Z');
  const natural = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' }, dry: true });
  assert.ok(!natural.competitions['premier-league'].stories.some(s => /Arsenal v Chelsea/.test(s.headline)), 'not in the natural 24 h window');
  const r = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' }, previewMatch: pid(45) });
  assert.equal(r.preview_match, pid(45));
  const pl = r.competitions['premier-league'];
  assert.equal(pl.candidates, 1, JSON.stringify(pl));
  assert.equal(pl.stories.length, 1); assert.equal(pl.stories[0].story_class, 'match_preview'); assert.equal(pl.stories[0].status, 'published', JSON.stringify(pl.stories));
  const arts = await store.select('soccer_articles', { columns: ['slug', 'entities', 'published_at'], eq: { story_class: 'match_preview' } });
  assert.equal(arts.length, 1, 'no other story is written by a forced run');
  assert.equal(articleEventId(arts[0]), pid(45), 'linked to the forced fixture');
  // the natural run at 24 h finds the same story key: a duplicate, never a second article
  const later = await runNews(store, { now: Date.parse('2026-10-05T15:00:00Z'), competitions: ['premier-league'], env: { NEWS_DESK: 'off' } });
  assert.equal((await store.select('soccer_articles', { columns: ['slug'], eq: { story_class: 'match_preview' } })).filter(a => a.slug === arts[0].slug).length, 1);
  assert.ok(later.competitions['premier-league'].duplicates >= 1);
  // beyond 7 days: nothing, even forced
  const far = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' }, previewMatch: pid(46) });
  assert.equal(far.competitions['premier-league'].candidates, 0);
  // a match in no loaded season: no competition touched
  const none = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' }, previewMatch: pid(99) });
  assert.deepEqual(none.competitions, {});
  await store.close();
});
