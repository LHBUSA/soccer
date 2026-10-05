// Competition-runner refactor (docs/COMPETITION_DESKS.md phase 1): PARITY with the released RC2.1 pipeline.
// Reference = tests/fixtures/news/legacy-pipeline.js (pipeline.js at 2e24eb9 = production c0ec2b50, verbatim).
// 1. FROZEN PRODUCTION REPLAY: tests/fixtures/news/runner-parity-prod.json.gz holds every read a real production run
//    issued (scripts/news/runner-parity-capture.mjs, read-only), at 3 tick instants x 3 variants (natural dry run; every
//    candidate NEW with the desk required -> HOLD; every candidate NEW with NEWS_DESK=off -> gated publish). The old and
//    the new orchestrator must issue the IDENTICAL read sequence and return identical summaries + writes (events, frozen
//    evidence packets, articles).
// 2. PGLITE SCENARIOS: identical seeded stores, run in lockstep: publish -> rerun (dedupe/existing) -> dry -> forced
//    preview -> review -> desk-routed publish + desk HOLD (fake transport) -> missing league-phase config -> a failing store.
// 3. NOTHING ELSE MOVED: every soccer-news module except pipeline.js is byte-identical to 2e24eb9.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import * as neu from '../workers/soccer-news/src/pipeline.js';
import * as old from './fixtures/news/legacy-pipeline.js';
import { replayStore, unpackReads } from '../scripts/news/replay-store.mjs';

const fx = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/news/runner-parity-prod.json.gz', import.meta.url))).toString('utf8'));

test('fixture covers every live competition and every publishing story class', () => {
  const comps = new Set(); const classes = new Set();
  for (const r of fx.runs) for (const [slug, c] of Object.entries(r.summary.competitions)) { if (c.candidates) comps.add(slug); for (const k of Object.keys(c.by_class || {})) classes.add(k); }
  assert.deepEqual([...comps].sort(), [...neu.NEWS_COMPETITIONS].sort(), 'every live competition yields candidates in at least one run');
  for (const k of ['match_recap', 'match_preview', 'matchday_brief', 'player_form']) assert.ok(classes.has(k), `class ${k} covered`);
  assert.ok(fx.runs.some(r => r.writes.length) && fx.runs.some(r => r.summary.competitions.mls?.duplicates), 'writes and real duplicates covered');
  assert.deepEqual(neu.NEWS_COMPETITIONS, fx.competitions, 'same enabled competitions, same order');
});

for (const run of fx.runs) {
  test(`production replay ${run.at} ${run.variant}: identical reads, summary, keys, packets and writes`, async () => {
    const reads = unpackReads(run.reads, fx.blobs);
    const a = replayStore(reads); const b = replayStore(reads);
    const sa = await old.runNews(a, { ...run.opts, env: run.env });
    const sb = await neu.runNews(b, { ...run.opts, env: run.env });
    assert.deepEqual(a.unconsumed, [], 'reference issued every recorded read'); assert.equal(a.consumed, reads.length);
    assert.deepEqual(b.unconsumed, [], 'runner orchestrator issued every recorded read'); assert.equal(b.consumed, reads.length);
    assert.deepEqual(b.issued, a.issued, 'identical read sequence (tables, filters, chunking, order)');
    assert.equal(JSON.stringify(sa), JSON.stringify(run.summary), 'reference reproduces the recorded production summary');
    assert.equal(JSON.stringify(sb), JSON.stringify(sa), 'identical summary (same key order, same counts, holds, stories)');
    assert.equal(JSON.stringify(b.writes), JSON.stringify(a.writes), 'identical writes');
    assert.equal(JSON.stringify(a.writes), JSON.stringify(run.writes));
    // keys / packets explicitly (the writes comparison already covers them; named for the evidence report)
    const ev = w => w.filter(x => x.table === 'soccer_article_evidence').flatMap(x => x.rows.map(r => [r.news_event_id, r.packet_hash, r.packet.event.key, r.packet.event.profile]));
    assert.deepEqual(ev(b.writes), ev(a.writes));
  });
}

// ---------- PGlite scenarios (same seed shape as tests/news-rc2-baseline.test.js, plus UCL for the config gate)
const H = 3600e3;
const NOW = Date.parse('2026-10-03T08:00:00Z');
const id = n => `00000000-0000-5000-8000-0000000e${String(n).padStart(4, '0')}`;
async function seed() {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(2), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: id(3), season_id: id(2), name: 'Regular season', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley'].map((n, i) => ({ id: id(10 + i), slug: n.toLowerCase(), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(500 + i) }));
  await store.insert('soccer_teams', teams);
  const mk = (n, h, a, hs, as, iso, status = 'finished') => ({ id: id(n), competition_id: id(1), season_id: id(2), stage_id: id(3), kickoff_at: iso, home_team_id: teams[h].id, away_team_id: teams[a].id, status, home_score: status === 'finished' ? hs : null, away_score: status === 'finished' ? as : null, result_provider: 'espn', updated_at: '2026-10-01T00:00:00Z' });
  const played = [[0, 1, 2, 0], [2, 3, 1, 1], [4, 5, 0, 1], [0, 2, 3, 0], [1, 4, 2, 1], [3, 5, 0, 2], [5, 0, 0, 2], [3, 1, 1, 2], [4, 2, 1, 1], [0, 4, 4, 0], [2, 5, 1, 0], [1, 3, 2, 2]];
  await store.insert('soccer_matches', [
    ...played.map(([h, a, hs, as], i) => mk(20 + i, h, a, hs, as, new Date(Date.parse('2026-09-12T14:00:00Z') + Math.floor(i / 3) * 7 * 86400e3 + (i % 3) * H).toISOString())),
    mk(40, 0, 3, null, null, '2026-10-03T14:00:00Z', 'scheduled'), mk(41, 1, 5, null, null, '2026-10-03T16:30:00Z', 'scheduled'), mk(42, 2, 4, null, null, '2026-10-03T19:00:00Z', 'scheduled'),
    mk(43, 5, 4, null, null, '2026-10-08T19:00:00Z', 'scheduled'),
  ]);
  return store;
}
const TABLES = { soccer_news_events: 'id', soccer_articles: 'id', soccer_article_evidence: 'packet_hash' };
const strip = r => { const o = { ...r }; for (const k of ['created_at', 'updated_at', 'detected_at', 'frozen_at']) delete o[k]; return o; }; // database defaults (now()), not written by the newsroom
const dump = async store => Object.fromEntries(await Promise.all(Object.entries(TABLES).map(async ([t, c]) => [t, (await store.select(t, { columns: '*', order: `${c}.asc` })).map(strip)])));
const same = async (A, B, label) => assert.equal(JSON.stringify(await dump(B)), JSON.stringify(await dump(A)), `${label}: identical rows`);

// Fake desk transport (counts calls): returns the deterministic draft's own text as the desk's story (held by the desk's
// thin_output / template_opening gates on this seed) or, with bad=true, an invented number (held by grounding). Same
// transport for both sides. The desk PUBLISH branch is editorialStage (asserted textually identical below).
function fakeDesk({ bad = false } = {}) {
  let calls = 0;
  const f = async (_url, init) => {
    calls += 1;
    const input = JSON.parse(init.body).input;
    const from = input.indexOf('\n', input.indexOf('MECHANICAL DRAFT')) + 1;
    const to = [input.indexOf('\n\nDATA VISUALS', from), input.indexOf('\n\nThere are no data visuals', from)].filter(i => i > 0).sort((x, y) => x - y)[0] ?? input.length;
    const draft = JSON.parse(input.slice(from, to));
    const sections = draft.sections.map(s => ({ heading: s.heading, paragraphs: bad ? ['Arsenal have now won 97 straight matches.'] : s.paragraphs }));
    const out = { headline: draft.headline, dek: draft.dek, sections, emphasis: [] };
    return new Response(JSON.stringify({ id: `resp_${calls}`, model: 'gpt-5.6-sol', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(out) }] }], usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, get calls() { return calls; } };
}
const memKV = () => { const m = new Map(); return { get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, v); }, list: async ({ prefix = '' } = {}) => ({ keys: [...m.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true }) }; };

test('PGlite lockstep: publish, rerun, dry, forced preview, review — identical summaries and rows', async () => {
  const A = await seed(); const B = await seed();
  const env = { NEWS_DESK: 'off' };
  const step = async (label, opts) => {
    const ra = await old.runNews(A, opts); const rb = await neu.runNews(B, opts);
    assert.equal(JSON.stringify(rb), JSON.stringify(ra), `${label}: identical summary`);
    await same(A, B, label);
    return ra;
  };
  const r1 = await step('first run', { now: NOW, competitions: ['premier-league'], env });
  assert.ok(r1.competitions['premier-league'].published > 0, 'the seed publishes stories');
  const r2 = await step('rerun 30 min later', { now: NOW + 30 * 60e3, competitions: ['premier-league'], env });
  assert.equal(r2.competitions['premier-league'].new, 0); assert.ok(r2.competitions['premier-league'].duplicates > 0);
  await step('dry run', { now: NOW + 60 * 60e3, competitions: ['premier-league'], env, dry: true });
  await step('cap 1 per competition', { now: NOW + 5 * 86400e3, competitions: ['premier-league'], env, maxPerCompetition: 1 });
  await step('forced preview', { now: NOW, competitions: ['premier-league'], env, previewMatch: id(43) });
  await step('review', { now: NOW, competitions: ['premier-league'], env, previewMatch: id(43), review: true });
  await step('forced preview of a fixture in no season (no entry)', { now: NOW, competitions: ['premier-league'], env, previewMatch: id(999) });
  await step('competition with no season', { now: NOW, competitions: ['mls', 'premier-league'], env: { ...env } , windowDays: 9 });
  await assert.rejects(neu.runNews(B, { now: NOW, env, review: true }), /review needs previewMatch/);
  await A.close(); await B.close();
});

test('PGlite lockstep: desk-routed runs through a fake transport (two different desk-gate HOLDs) — identical stories, routing and rows', async () => {
  const realFetch = globalThis.fetch;
  try {
    for (const bad of [false, true]) {
      const A = await seed(); const B = await seed();
      const fa = fakeDesk({ bad }); const fb = fakeDesk({ bad });
      const envA = { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV(), NEWS_ENABLED: 'on' };
      const envB = { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV(), NEWS_ENABLED: 'on' };
      globalThis.fetch = fa.f; const ra = await old.runNews(A, { now: NOW, competitions: ['premier-league'], env: envA });
      globalThis.fetch = fb.f; const rb = await neu.runNews(B, { now: NOW, competitions: ['premier-league'], env: envB });
      assert.ok(fa.calls > 0, 'the desk transport was reached'); assert.equal(fb.calls, fa.calls, 'same number of paid calls');
      assert.equal(JSON.stringify(rb), JSON.stringify(ra), `bad=${bad}: identical summary incl. routing lanes/reasons`);
      assert.ok(Object.keys(ra.routing.lanes).length, 'routing counted');
      // published_at / visual observedAt derive from `now`; desk ids/latency live in KV, compared by shape only
      await same(A, B, `desk bad=${bad}`);
      await A.close(); await B.close();
    }
  } finally { globalThis.fetch = realFetch; }
});

test('fail closed and failure semantics are unchanged', async () => {
  const throwing = { select: () => { throw new Error('must not read'); } };
  const o = { now: NOW, competitions: ['uefa-champions-league'], env: { NEWS_DESK: 'off' }, cfg: {} };
  assert.equal(JSON.stringify(await neu.runNews(throwing, o)), JSON.stringify(await old.runNews(throwing, o)), 'missing UCL boundary: skipped, zero reads');
  // a store failure in the second competition still fails the whole tick (isolation is a later, separate release)
  const failing = await seed(); let n = 0;
  const flaky = { select: async (t, x) => { if (t === 'soccer_competitions' && ++n > 1) throw new Error('boom'); return failing.select(t, x); }, insert: (...a) => failing.insert(...a) };
  const opts = { now: NOW, competitions: ['premier-league', 'premier-league'], env: { NEWS_DESK: 'off' }, dry: true };
  await assert.rejects(old.runNews(flaky, opts), /boom/); n = 0;
  await assert.rejects(neu.runNews(flaky, opts), /boom/);
  await failing.close();
});

test('runCompetition is the per-competition primitive: runNews == mergeRun over runCompetition results', async () => {
  const A = await seed();
  const opts = { now: NOW, env: { NEWS_DESK: 'off' }, dry: true };
  const viaRunner = neu.newRunSummary(opts.env, NOW);
  for (const slug of ['premier-league', 'mls']) neu.mergeRun(viaRunner, await neu.runCompetition(A, slug, opts));
  const viaRun = await neu.runNews(A, { ...opts, competitions: ['premier-league', 'mls'] });
  assert.equal(JSON.stringify(viaRunner), JSON.stringify(viaRun));
  const r = await neu.runCompetition(A, 'premier-league', opts);
  assert.equal(r.slug, 'premier-league'); assert.ok(r.out && r.routing && 'lanes' in r.routing);
  await A.close();
});

test('shared stage helpers are textually identical to the released ones', () => {
  for (const k of ['articleBody', 'articleVisuals', 'withVisualMenu', 'editorialStage', 'richerPacket', 'reeditArticle', 'storiesFor']) assert.equal(String(neu[k]), String(old[k]), k);
  assert.deepEqual(neu.NEWS_REGISTRY, old.NEWS_REGISTRY);
});

// git blob ids at 2e24eb9 (production c0ec2b50): this phase moves ONLY pipeline.js.
const PINNED = {
  'workers/soccer-news/src/ai-router.js': '942a657a0d0c46185910ee99e6133b5dabb14224', 'workers/soccer-news/src/compose.js': 'd71bdacaa9d48fec0add6ff2e4068a5ed2ce3a65',
  'workers/soccer-news/src/compose2.js': '0f7dd3a666800785442bbf533db7105a0888a077', 'workers/soccer-news/src/depth.js': 'e39ff7552da87062072b5858cc5b9f27cb50a9a9',
  'workers/soccer-news/src/desk.js': '94f33e30a99a2e478adeac8aaebf6830b1efe63b', 'workers/soccer-news/src/editorial.js': '836505f7fd856a298de4912db8d85ced1ea2886c',
  'workers/soccer-news/src/engine.js': '508d0afe0765378c869d8d412895f584025769e9', 'workers/soccer-news/src/gates.js': 'ef1ea6d93465a20a0c9e4dcf2a7145fa541cb522',
  'workers/soccer-news/src/gates2.js': '1c9d11f8cb8d9fb02160b11eded3d1d54d6607d3', 'workers/soccer-news/src/materiality.js': '98d1489375ed2e6089856d5146650515313cac7e',
  'workers/soccer-news/src/openai-cost.js': 'eab07777075b5760d93f8d285e11bf3b565d43a8', 'workers/soccer-news/src/packet.js': '297641b6cd8663eea2a6e88bf6f68fa3b6716163',
  'workers/soccer-news/src/previews.js': '8ed51f5c6995fb2a08d9cbef85cc410d67f9471e', 'workers/soccer-news/src/profiles.js': '879cf90e294f2d838037c202183450cdde53f364',
  'workers/soccer-news/src/visuals.js': '70c39517325da15ef868cc90104c89cf81cd7749', 'data/registry/competitions.json': 'b8e151bf14ac7a32b5b3314314a54776a45d0c4a',
};
const blobId = path => { const b = Buffer.from(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n'), 'utf8'); return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); };
test('decision path is byte-identical to production RC2.1 (detectors, packets, profiles, gates, desk, router, registry)', () => {
  for (const [p, want] of Object.entries(PINNED)) assert.equal(blobId(p), want, `${p} unchanged since 2e24eb9`);
});
