// Newsroom V4 stage 3 — soccer-ai-router/1.0.0 + the four audit prerequisites (owner spec 2026-09-29):
//   A article_id/news_event_id on every call record · B dry = zero transport + zero writes · C withdrawn is terminal
//   D breaker fails CLOSED · router allow-list, lanes, flagship off, one automatic attempt, routed request.
// The model is a counting fake transport; end-to-end cases run the real pipeline on PGlite with global fetch trapped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { emptyLaneState } from '../workers/soccer-ingest/src/state.js';
import { runOpenLigaCurrent } from '../workers/soccer-ingest/src/openligadb-current.js';
import { compose } from '../workers/soccer-news/src/compose2.js';
import { runDesk } from '../workers/soccer-news/src/desk.js';
import { editorialStage, runNews } from '../workers/soccer-news/src/pipeline.js';
import { route, reachesTransport, LANES } from '../workers/soccer-news/src/ai-router.js';
import { ledgerRow, spentUsd, dailyMaxUsd } from '../workers/soccer-news/src/openai-cost.js';
import { reeditTrigger } from '../workers/soccer-news/src/index.js';

const packet = name => JSON.parse(readFileSync(`tests/fixtures/news/${name}-packet.json`, 'utf8'));
const B = packet('bayern');
const draft = compose(B);

// A publication-grade story written only from the Bayern packet (the shape the desk must produce).
const GOOD = {
  headline: 'Olise hat-trick powers Bayern past Union Berlin in 7-0 rout',
  dek: 'Michael Olise scored three and Harry Kane added two as Bayern München turned a 3-0 half-time lead into a 7-0 Bundesliga win that lifted them from fourth to first.',
  sections: [
    { heading: 'A first half that settled everything', paragraphs: [
      'Bayern München did not need long to make this a one-sided evening. Jamal Musiala opened the scoring in the 18th minute, and by the interval the gap had grown to three goals.',
      'Harry Kane made it 2-0 in the 39th minute and Michael Olise added a third in the 43rd, so 1. FC Union Berlin went in at half-time needing a response they never found.',
      'The pattern was already clear. Bayern kept arriving in the penalty area, and Union Berlin could barely get the ball near the other end.',
    ] },
    { heading: 'Olise and Kane turn control into a rout', paragraphs: [
      'The second half removed any doubt. Kane scored again in the 54th minute for 4-0, and Ismael Saibari made it 5-0 in the 70th.',
      'Then Olise took over. He scored in the 73rd and 76th minutes, completing a hat-trick inside a spell of barely half an hour after the break and finishing the scoring at 7-0.',
      'Kane’s brace and Olise’s three goals gave Bayern two different sources of finishing on the same night, with Musiala and Saibari also on the scoresheet. Four players scored, and none of the seven goals came from the visitors’ mistakes being gifted back to them: every one was a Bayern finish.',
    ] },
    { heading: 'Pressure that never eased', paragraphs: [
      'The shot count explains why the scoreline climbed so steadily. Bayern finished with 23 shots, 15 of them on target, while Union Berlin managed three attempts and only two that tested the goalkeeper.',
      'That imbalance meant the visiting goalkeeper was busy all night, with six saves, and still conceded seven. At the other end Bayern were asked to make just two.',
      'Bayern also won nine corners to Union Berlin’s two. The average distance of Bayern’s located shots was 17.9 metres, so this was not a night of speculative efforts from range but of repeated chances close enough to trouble the goal.',
      'The timing of the goals shaped the evening as well. Three came before the interval and four after it, with Kane’s strike in the 54th minute the first of the second half and Saibari’s in the 70th opening a closing spell in which Olise scored twice. Union Berlin, by contrast, never found a route back into the contest.',
    ] },
    { heading: 'Seven goals take Bayern to the top', paragraphs: [
      'The margin mattered in the standings as much as on the pitch. Bayern started the day fourth and finished it top of the Bundesliga table on 10 points from four matches.',
      'Their goal difference swung from plus five to plus 12, which reflects how decisive the evening was. They arrived unbeaten from three league matches, with two wins and a draw, and left with three wins from four.',
      'For Union Berlin the night deepened a difficult start. They stayed 16th of 18 on one point, now without a win in four league matches, and their goal difference fell to minus 13.',
      'It is still early in the 2026/27 season, and one result does not decide a title race. But a 7-0 win with this balance of shots and finishing is the kind of evening that moves a team from the chasing pack to the head of it, and on 18 September that is exactly what Bayern did.',
    ] },
  ],
};

const REG = { competitions: [{ slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1, external_ids: [{ provider: 'wyscout', external_id: '426', method: 'founding', evidence: 't' }, { provider: 'openligadb', external_id: 'bl1', method: 'reviewed', evidence: 't' }] }] };
const olm = (id, g, t1, t2, date, s1, s2) => ({ matchID: id, matchDateTimeUTC: `${date}Z`, leagueId: 1, leagueSeason: 2026, leagueShortcut: 'bl1', group: { groupOrderID: g },
  team1: { teamId: t1, teamName: `Club ${t1}`, shortName: `C${t1}` }, team2: { teamId: t2, teamName: `Club ${t2}`, shortName: `C${t2}` }, matchIsFinished: true,
  matchResults: [{ resultTypeID: 1, pointsTeam1: 0, pointsTeam2: 0 }, { resultTypeID: 2, pointsTeam1: s1, pointsTeam2: s2 }], goals: [] });
const upstream = matches => {
  const mem = new Map();
  return { storage: { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } },
    fetcher: async url => ({ status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(url.endsWith('/getcurrentgroup/bl1') ? { groupOrderID: 1 } : url.includes('/getlastchangedate/') ? 'A' : matches)) }) };
};

const USAGE = { input_tokens: 9000, input_tokens_details: { cached_tokens: 1000 }, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 700 } };
const envelope = (content, extra = {}) => ({ id: 'resp_stage3', object: 'response', status: 'completed', model: 'gpt-5.6-sol', usage: USAGE, output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content }], ...extra });
const reply = obj => async () => ({ ok: true, json: async () => envelope([{ type: 'output_text', text: JSON.stringify(obj), annotations: [] }]) });
const memKV = (seed = null) => { const m = new Map(); if (seed) m.set(`openai:v1:calls:${new Date().toISOString().slice(0, 10)}`, JSON.stringify(seed)); return { m, get: async (k, t) => (m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null), put: async (k, v) => { m.set(k, typeof v === 'string' ? v : JSON.stringify(v)); } }; };
const counting = (impl = reply(GOOD)) => { const f = async (...a) => { f.calls += 1; return impl(...a); }; f.calls = 0; return f; };
const dayLog = kv => JSON.parse([...kv.m.entries()].find(([k]) => k.startsWith('openai:v1:calls:'))?.[1] || '[]');
const BAD = () => { const bad = { ...GOOD, sections: GOOD.sections.map(s => ({ ...s, paragraphs: [...s.paragraphs] })) }; bad.sections[0].paragraphs[0] += ' Bayern had 31 shots before half-time.'; return bad; };

// ------------------------------------------------------------------ A. article_id / news_event_id + full telemetry
test('A: a real call record carries article_id, news_event_id and every V4 telemetry field', async () => {
  const kv = memKV(); const f = counting();
  const r = await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: kv }, { fetcher: f, trigger: 'new_story', articleId: '11111111-2222-4333-8444-555555555555' });
  assert.ok(r.article); assert.equal(f.calls, 1);
  const [c] = dayLog(kv);
  assert.equal(c.article_id, '11111111-2222-4333-8444-555555555555');
  assert.equal(c.news_event_id, B.event.event_id); assert.ok(c.news_event_id);
  for (const k of ['sport', 'worker', 'slug', 'story_class', 'routing_lane', 'routing_reason', 'model', 'pool', 'trigger', 'attempt', 'response_id', 'input_tokens', 'cached_input_tokens', 'output_tokens', 'reasoning_tokens', 'latency_ms', 'status', 'nominal_standard_cost', 'at']) assert.ok(c[k] !== undefined && c[k] !== null, `missing ${k}`);
  assert.deepEqual([c.sport, c.worker, c.routing_lane, c.pool, c.trigger, c.attempt, c.response_id, c.status], ['soccer', 'soccer-news', 'STANDARD_EDITORIAL', 'premium', 'cron_new_story', 1, 'resp_stage3', 'completed']);
  assert.deepEqual([c.input_tokens, c.cached_input_tokens, c.output_tokens, c.reasoning_tokens, c.total_eligible_tokens], [9000, 1000, 2000, 700, 11000]);
  // nominal = 8000 x 1.25 + 1000 x 0.125 + 2000 x 10 per 1M (cached input at the cached rate)
  assert.equal(c.nominal_standard_cost, 0.030125);
});

test('A: the durable ledger row gains routing columns only when SOCCER_LEDGER_ROUTING=on (after migration 1300)', () => {
  const e = { trigger: 'canary', attempt: 1, started_at: '2026-09-29T00:00:00Z', model: 'gpt-5.6-sol', input_tokens: 10, output_tokens: 5, status: 'completed', desk_version: 'd', article_id: 'a', news_event_id: 'n', latency_ms: 42, routing: route({ packet: B, trigger: 'canary' }) };
  const off = ledgerRow(e); assert.ok(!('routing_lane' in off)); assert.equal(off.article_id, 'a'); assert.equal(off.news_event_id, 'n');
  const on = ledgerRow(e, { routingColumns: true });
  assert.deepEqual([on.sport, on.worker, on.routing_lane, on.pool, on.story_class, on.latency_ms, on.router_version], ['soccer', 'soccer-news', 'STANDARD_EDITORIAL', 'premium', 'match_recap', 42, 'soccer-ai-router/1.0.0']);
  assert.equal(on.nominal_standard_cost, on.estimated_usd);
});

// ------------------------------------------------------------------ B. dry = zero transport + zero writes
test('B: dry_run never reaches the transport (desk required, key present)', async () => {
  const f = counting(); const kv = memKV();
  const r = await editorialStage(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: kv }, { fetcher: f, trigger: 'dry_run' });
  assert.equal(f.calls, 0); assert.equal(r.status, 'held'); assert.deepEqual(r.holdReasons, ['routing:trigger_not_eligible:dry_run']);
  assert.equal(kv.m.size, 0, 'no telemetry write: nothing was called');
  assert.equal(reeditTrigger(new URL('https://x/v1/admin/reedit?slug=s&dry=1')), 'dry_run');
  assert.equal(reeditTrigger(new URL('https://x/v1/admin/reedit?slug=s&dry=1&canary=1')), 'canary');
});

// ------------------------------------------------------------------ D. breaker fails closed
test('D1: neither ledger nor KV can establish usage -> 0 calls, hold editorial_budget_state_unavailable', async () => {
  const f = counting();
  const r1 = await runDesk(draft, B, { OPENAI_API_KEY: 'k' }, { fetcher: f });
  const r2 = await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: { get: async () => { throw new Error('kv down'); }, put: async () => {} } }, { fetcher: f });
  assert.equal(f.calls, 0);
  assert.deepEqual(r1.held, ['editorial_budget_state_unavailable']); assert.deepEqual(r2.held, ['editorial_budget_state_unavailable']);
});
test('D2: ledger down, KV readable and under the cap -> the call is allowed', async () => {
  const f = counting();
  const r = await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV([{ estimated_usd: 1.5 }]) }, { fetcher: f });
  assert.equal(f.calls, 1); assert.ok(r.article);
});
test('D3: above the cap -> 0 calls, hold editorial_daily_budget_reached', async () => {
  const f = counting();
  const r = await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV([{ estimated_usd: 5.2 }]) }, { fetcher: f });
  assert.equal(f.calls, 0); assert.deepEqual(r.held, ['editorial_daily_budget_reached']);
});
test('D4: below the cap -> eligible; an unpriced model still counts at the standard constant; bad ceilings fail closed', async () => {
  const f = counting();
  await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV([{ estimated_usd: 4.99 }]) }, { fetcher: f });
  assert.equal(f.calls, 1);
  assert.equal(spentUsd([{ estimated_usd: null, input_tokens: 1e6, output_tokens: 0 }]), 1.25);
  assert.equal(dailyMaxUsd({ SOCCER_OPENAI_DAILY_MAX_USD: 'nope' }), 5); assert.equal(dailyMaxUsd({}), 5); assert.equal(dailyMaxUsd({ SOCCER_OPENAI_DAILY_MAX_USD: '0' }), 0);
  const g = counting();
  const r = await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV(), SOCCER_OPENAI_DAILY_MAX_USD: '0' }, { fetcher: g });
  assert.equal(g.calls, 0); assert.deepEqual(r.held, ['editorial_daily_budget_reached']);
});

// ------------------------------------------------------------------ router
test('router: only new_story / admin re-edit / canary reach a transport; everything else is DETERMINISTIC', () => {
  for (const t of ['new_story', 'manual_reedit', 'admin_reedit', 'canary']) assert.equal(route({ packet: B, trigger: t }).lane, LANES.STANDARD, t);
  for (const t of ['revision', 'correction', 'withdrawn', 'backfill', 'legacy_upgrade', 'dry_run', 'existing_revision', 'whatever']) {
    const r = route({ packet: B, trigger: t });
    assert.equal(r.lane, LANES.DETERMINISTIC, t); assert.equal(r.reason, `trigger_not_eligible:${t}`); assert.equal(reachesTransport(r), false);
  }
  assert.equal(route({ packet: B, trigger: 'repair', attempt: 2, parentTrigger: 'canary' }).lane, LANES.STANDARD);
  assert.equal(route({ packet: B, trigger: 'repair', attempt: 2, parentTrigger: 'new_story' }).lane, LANES.DETERMINISTIC);
  assert.equal(route({ packet: B, trigger: 'repair', attempt: 1, parentTrigger: 'canary' }).lane, LANES.DETERMINISTIC);
  // kill switch beats admin; no key -> deterministic
  assert.equal(route({ packet: B, trigger: 'manual_reedit', env: { SOCCER_AI: 'off' } }).lane, LANES.DETERMINISTIC);
  assert.equal(route({ packet: B, trigger: 'new_story', hasKey: false }).lane, LANES.DETERMINISTIC);
});

test('router: flagship OFF by default with an empty class list; only enabled + released class uses Astra', () => {
  const rich = route({ packet: B, trigger: 'new_story', richness: 'rich' });
  assert.equal(rich.lane, LANES.STANDARD); assert.equal(rich.model, 'gpt-5.6-sol'); assert.equal(rich.flagship_eligible, true); assert.match(rich.reason, /FLAGSHIP_ENABLED is off/);
  assert.equal(route({ packet: B, trigger: 'new_story', richness: 'rich', env: { SOCCER_AI_FLAGSHIP_ENABLED: 'true' } }).lane, LANES.STANDARD);
  const fl = route({ packet: B, trigger: 'new_story', richness: 'rich', env: { SOCCER_AI_FLAGSHIP_ENABLED: 'true', SOCCER_AI_FLAGSHIP_CLASSES: 'rich_match_report' } });
  assert.deepEqual([fl.lane, fl.model, fl.max_output_tokens], [LANES.FLAGSHIP, 'gpt-6-astra', 8000]);
  // the standard lane carries the governed desk cap and effort into the request
  assert.equal(route({ packet: B, trigger: 'new_story', env: { NEWS_DESK_MAX_OUTPUT_TOKENS: '4000' } }).max_output_tokens, 4000);
});

test('one automatic attempt: new_story never buys a repair, even when attempts: 2 is passed', async () => {
  const f = counting(async () => reply(BAD())());
  const r = await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV(), NEWS_DESK_ATTEMPTS: '2' }, { fetcher: f, attempts: 2, trigger: 'new_story' });
  assert.equal(f.calls, 1); assert.ok(r.held.includes('editorial:new_number_not_in_packet'));
  // explicit admin: the repair is allowed and logged as attempt 2 under the parent trigger
  const kv = memKV(); const g = counting(async () => reply(BAD())());
  await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: kv }, { fetcher: g, attempts: 2, trigger: 'manual_reedit' });
  assert.equal(g.calls, 2); assert.deepEqual(dayLog(kv).map(c => [c.trigger, c.attempt]), [['admin_reedit', 1], ['admin_reedit', 2]]);
});

test('the request carries the routed model, effort and output cap', async () => {
  let body = null;
  await runDesk(draft, B, { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV(), NEWS_DESK_MAX_OUTPUT_TOKENS: '4000', SOCCER_AI_STANDARD_EFFORT: 'low' }, { fetcher: async (_u, init) => { body = JSON.parse(init.body); return reply(GOOD)(); } });
  assert.deepEqual([body.model, body.reasoning.effort, body.max_output_tokens], ['gpt-5.6-sol', 'low', 4000]);
});

test('admin trigger mapping: canary > dry_run > scope sweep (backfill, model-free) > named slug', () => {
  const t = q => reeditTrigger(new URL(`https://x/v1/admin/reedit?${q}`));
  assert.equal(t('slug=a'), 'manual_reedit'); assert.equal(t('scope=template'), 'backfill'); assert.equal(t('scope=template&slug=a'), 'manual_reedit');
  assert.equal(route({ packet: B, trigger: t('scope=held_desk') }).lane, LANES.DETERMINISTIC);
});

// ------------------------------------------------------------------ B + C end to end (PGlite store)
async function seasonStore() {
  const store = await openPglite(); await applyMigrations(store);
  const games = [olm(1, 1, 10, 20, '2026-09-19T13:30:00', 6, 0), olm(2, 1, 30, 40, '2026-09-19T13:30:00', 1, 1), olm(3, 1, 50, 60, '2026-09-19T15:30:00', 2, 1), olm(4, 1, 70, 80, '2026-09-19T15:30:00', 0, 1), olm(5, 1, 90, 11, '2026-09-20T13:30:00', 1, 0), olm(6, 1, 12, 13, '2026-09-20T15:30:00', 2, 2)];
  const up = upstream(games);
  await runOpenLigaCurrent({ store, storage: up.storage, registry: REG, state: emptyLaneState('x'), now: Date.parse('2026-09-27T00:00:00Z'), fetcher: up.fetcher, force: true });
  return store;
}
const counts = async store => Object.fromEntries(await Promise.all(['soccer_news_events', 'soccer_articles', 'soccer_article_evidence', 'soccer_news_openai_usage'].map(async t => [t, (await store.query(`select count(*)::int as n from public.${t}`)).rows[0].n])));

test('B (end to end): /v1/run?dry=1 with the desk ON and a key -> zero model transport and zero writes', async () => {
  const store = await seasonStore();
  const realFetch = globalThis.fetch; let transport = 0;
  globalThis.fetch = async () => { transport += 1; throw new Error('transport must not be reached in a dry run'); };
  try {
    const before = await counts(store);
    const now = Date.parse('2026-09-21T12:00:00Z');
    const s = await runNews(store, { now, dry: true, competitions: ['bundesliga'], env: { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV() } });
    assert.equal(transport, 0);
    assert.deepEqual(await counts(store), before);
    assert.ok(s.competitions.bundesliga.new >= 1);
    assert.ok((s.routing.reasons['trigger_not_eligible:dry_run'] || 0) >= 1, JSON.stringify(s.routing));
  } finally { globalThis.fetch = realFetch; await store.close(); }
});

test('C (end to end): a WITHDRAWN story is terminal — no :correction re-key, no new event, no model call', async () => {
  const store = await seasonStore();
  const now = Date.parse('2026-09-21T12:00:00Z');
  await runNews(store, { now, competitions: ['bundesliga'], env: { NEWS_DESK: 'off' } });
  const [a] = await store.select('soccer_articles', { columns: ['id', 'slug'], eq: { status: 'published' }, limit: 1 });
  await store.update('soccer_articles', { status: 'withdrawn', hold_reasons: ['own goal attributed to the wrong team'] }, { eq: { id: a.id } });
  const before = await counts(store);
  const realFetch = globalThis.fetch; let transport = 0;
  globalThis.fetch = async () => { transport += 1; throw new Error('no transport'); };
  try {
    const s = await runNews(store, { now: now + 3600e3, competitions: ['bundesliga'], env: { OPENAI_API_KEY: 'k', SOCCER_STATE: memKV() } });
    assert.equal(transport, 0); assert.equal(s.competitions.bundesliga.new, 0);
    assert.deepEqual(await counts(store), before);
    const [w] = await store.select('soccer_articles', { columns: ['status'], eq: { id: a.id }, limit: 1 });
    assert.equal(w.status, 'withdrawn');
  } finally { globalThis.fetch = realFetch; await store.close(); }
});
