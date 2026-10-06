// Phase 5 (docs/COMPETITION_DESKS.md section 9): competition budget isolation control plane.
// 5A policy (floor 0, pool 100 %, no reservations, no story cap) must be behaviour-identical to phase 4; the machinery
// itself (floors, pool, priority, caps, accounting, fail-closed) is proven with tighter test-only policies.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { runCompetition, NEWS_COMPETITIONS } from '../workers/soccer-news/src/pipeline.js';
import { runIsolated, runnerRpc } from '../workers/soccer-news/src/isolation.js';
import { runTick } from '../workers/soccer-news/src/index.js';
import { leaguePhaseCfg } from '../workers/soccer-news/src/profiles.js';
import { DEFAULT_POLICY, budgetKey, budgetView, dayOf, decideAllowance, recordStory, tierOf, HOLD_ALLOWANCE, HOLD_ACCOUNTING, HOLD_STORY_CAP } from '../workers/soccer-news/src/budget.js';
import { replayStore, unpackReads } from '../scripts/news/replay-store.mjs';

const fx = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/news/runner-parity-prod.json.gz', import.meta.url))).toString('utf8'));
const toml = readFileSync(new URL('../workers/soccer-news/wrangler.toml', import.meta.url), 'utf8');
const VARS = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "([^"]*)"/gm)].map(m => [m[1], m[2]]));
const DAY = fx.runs.find(x => x.variant === 'new_desk_req' && x.at.startsWith('2026-09-21')); // BL 9, PL 5, MLS 4 new stories
const C = NEWS_COMPETITIONS;
const memKV = ({ failBudgetGet = false, failBudgetPut = false } = {}) => { const m = new Map(); return { m,
  async get(k, t) { if (failBudgetGet && k.startsWith('news:budget:')) throw new Error('kv get down'); return m.has(k) ? (t === 'json' ? JSON.parse(m.get(k)) : m.get(k)) : null; },
  async put(k, v) { if (failBudgetPut && k.startsWith('news:budget:')) throw new Error('kv put down'); m.set(k, v); } }; };
const pol = o => Object.fromEntries(C.map(c => [c, { ...DEFAULT_POLICY, ...o }]));

// Fake OpenAI transport: every call costs 1000 input + 1000 output tokens (nominal estimate recorded by the real
// recordCall); the article it returns is held by the desk gates (cost is what matters here).
function desk() {
  const calls = [];
  const f = async (_u, init) => {
    const input = JSON.parse(init.body).input; const m = input.match(/"competition":\{[^}]*"slug":"([a-z-]+)"/); calls.push(m ? m[1] : '?');
    return { ok: true, json: async () => ({ id: `r${calls.length}`, status: 'completed', model: 'gpt-5.6-sol', usage: { input_tokens: 1000, output_tokens: 1000 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ headline: 'H', dek: 'D', sections: [{ heading: 'x', paragraphs: ['y'] }], emphasis: [] }) }] }] }) };
  };
  return { f, calls };
}
async function withFetch(f, fn) { const real = globalThis.fetch; globalThis.fetch = f; try { return await fn(); } finally { globalThis.fetch = real; } }
const envOf = (kv, extra = {}) => ({ ...VARS, ...DAY.env, NEWS_ENABLED: 'on', OPENAI_API_KEY: 'k', SOCCER_STATE: kv, ...extra });
// The breaker and recordCall stamp calls with the REAL wall clock, and so does budget accounting: tests use today's UTC day.
const TODAY = () => dayOf(Date.now());
const run = (env, slug, store, o = {}) => runCompetition(store, slug, { now: DAY.opts.now, env, cfg: leaguePhaseCfg(env), ...o });
const spendPerCall = async () => { const kv = memKV(); const d = desk(); await withFetch(d.f, () => run(envOf(kv), 'mls', replayStore(unpackReads(DAY.reads, fx.blobs)), { maxPerCompetition: 1 })); return JSON.parse(kv.m.get([...kv.m.keys()].find(k => k.startsWith('openai:'))))[0].estimated_usd; };

// ------------------------------------------------------------------ pure decision
test('5A policy == the global breaker: allowed iff global spend < ceiling, for every competition / tier / spend mix', () => {
  const docs = { bundesliga: { spend_usd: 3, stories_attempted: 9 }, 'premier-league': { spend_usd: 1.5 }, 'uefa-champions-league': null, 'uefa-nations-league': null, mls: { spend_usd: 0.2 } };
  for (const g of [0, 1, 4.69, 4.999, 5, 7]) for (const slug of C) for (const tier of ['recap', 'preview', 'form']) {
    const d = decideAllowance({ slug, tier, competitions: C, docs, globalSpend: g, max: 5, policies: pol({}) });
    assert.equal(d.ok, g < 5, `${slug} ${tier} global ${g}`);
  }
  assert.deepEqual(DEFAULT_POLICY, { floor_pct: 0, pool_pct: 100, reserve_pct: { recap: 0, preview: 0 }, max_stories_day: null });
});

test('floors: one competition cannot consume another competition\'s floor (12 % floors x 5, 40 % pool)', () => {
  const P = pol({ floor_pct: 12, pool_pct: 40 });
  const d = (slug, docs, g) => decideAllowance({ slug, tier: 'recap', competitions: C, docs, globalSpend: g, max: 10, policies: P });
  // Bundesliga has spent its floor (1.2) + the whole pool (4.0): denied; MLS has spent nothing: still inside its floor
  const docs = { bundesliga: { spend_usd: 5.2 }, 'premier-league': null, 'uefa-champions-league': null, 'uefa-nations-league': null, mls: null };
  assert.equal(d('bundesliga', docs, 5.2).ok, false); assert.equal(d('bundesliga', docs, 5.2).reason, HOLD_ALLOWANCE);
  const m = d('mls', docs, 5.2); assert.equal(m.ok, true); assert.equal(m.state, 'floor'); assert.equal(m.floor_usd, 1.2);
  // MLS spends up to its floor; then it competes for the (exhausted) pool -> denied, Bundesliga never got MLS's floor
  assert.equal(d('mls', { ...docs, mls: { spend_usd: 1.2 } }, 6.4).ok, false);
  // pool not exhausted: anyone above its floor may use it
  assert.equal(d('premier-league', { ...docs, bundesliga: { spend_usd: 3 }, 'premier-league': { spend_usd: 1.2 } }, 4.2).state, 'pool');
});

test('the shared pool never includes anyone\'s floor: floors 5 x 12 % with pool_pct 100 leave a 40 % pool', () => {
  const P = pol({ floor_pct: 12, pool_pct: 100 });
  const d = decideAllowance({ slug: 'mls', tier: 'recap', competitions: C, docs: { bundesliga: { spend_usd: 9 } }, globalSpend: 9, max: 10, policies: P });
  assert.equal(d.pool_usd, 4);
  // Bundesliga: floor 1.2 used + 7.8 above it > pool 4 -> pool exhausted for everyone above their floor
  assert.equal(decideAllowance({ slug: 'bundesliga', tier: 'recap', competitions: C, docs: { bundesliga: { spend_usd: 9 } }, globalSpend: 9, max: 10, policies: P }).ok, false);
  assert.equal(d.ok, true, 'MLS still has its untouched floor'); assert.equal(d.state, 'floor');
});

test('priority: a constrained pool keeps its reservation for final-ready recaps, then previews, then form / trend / table', () => {
  const P = pol({ floor_pct: 0, pool_pct: 100, reserve_pct: { recap: 20, preview: 20 } });
  const d = (tier, g) => decideAllowance({ slug: 'mls', tier, competitions: C, docs: {}, globalSpend: g, max: 10, policies: P }).ok;
  assert.deepEqual(['recap', 'preview', 'form'].map(t => d(t, 5.9)), [true, true, true]);
  assert.deepEqual(['recap', 'preview', 'form'].map(t => d(t, 6.0)), [true, true, false], 'form stops at 60 %');
  assert.deepEqual(['recap', 'preview', 'form'].map(t => d(t, 8.0)), [true, false, false], 'previews stop at 80 %');
  assert.deepEqual(['recap', 'preview', 'form'].map(t => d(t, 9.99)), [true, false, false], 'recaps keep the last 20 %');
  assert.equal(tierOf({ event: { kind: 'match_recap' } }), 'recap'); assert.equal(tierOf({ event: { kind: 'match_preview' } }), 'preview');
  for (const k of ['player_form', 'team_trend', 'competition_intelligence']) assert.equal(tierOf({ event: { kind: k } }), 'form');
});

test('daily story cap (registry news.allowance.max_stories_day; none set in 5A)', () => {
  const P = pol({ max_stories_day: 3 });
  const d = n => decideAllowance({ slug: 'mls', tier: 'recap', competitions: C, docs: { mls: { spend_usd: 0, stories_attempted: n } }, globalSpend: 0, max: 5, policies: P });
  assert.equal(d(2).ok, true); assert.equal(d(3).ok, false); assert.equal(d(3).reason, HOLD_STORY_CAP);
  const reg = JSON.parse(readFileSync(new URL('../data/registry/competitions.json', import.meta.url)));
  assert.ok(reg.competitions.every(c => !c.news?.allowance), '5A: no allowance in the registry (non-restrictive)');
});

// ------------------------------------------------------------------ end to end (real runner, real desk routing, frozen production data)
test('5A is behaviour-identical to phase 4 on a real multi-league news day: same stories, statuses, holds, desk calls and writes', async () => {
  for (const slug of ['bundesliga', 'premier-league', 'mls']) {
    const a = replayStore(unpackReads(DAY.reads, fx.blobs)); const b = replayStore(unpackReads(DAY.reads, fx.blobs));
    const da = desk(); const db = desk(); const kva = memKV(); const kvb = memKV();
    const ra = await withFetch(da.f, () => run(envOf(kva), slug, a));                                  // phase 4 runner
    const rb = await withFetch(db.f, () => run(envOf(kvb), slug, b, { budget: { competitions: C } })); // phase 5A runner
    assert.equal(JSON.stringify(rb.out), JSON.stringify(ra.out), `${slug}: identical summary`);
    assert.equal(JSON.stringify(b.writes), JSON.stringify(a.writes), `${slug}: identical event / evidence / article writes`);
    assert.deepEqual(db.calls, da.calls, `${slug}: identical paid desk calls`);
    assert.ok(da.calls.length > 0, 'paid calls happened');
    const doc = JSON.parse(kvb.m.get(budgetKey(TODAY(), slug)));
    assert.equal(doc.desk_calls, db.calls.length, 'every paid call accounted to its competition');
    assert.equal(doc.stories_attempted, ra.out.new); assert.equal(doc.budget_holds, 0, 'no budget holds under 5A');
  }
});

test('global accounting reconciles: sum of competition spend == global spend (all calls through runners), skipped competitions get nothing', async () => {
  const kv = memKV(); const d = desk(); const env = envOf(kv);
  const store = replayStore(unpackReads(DAY.reads, fx.blobs));
  await withFetch(d.f, () => runIsolated(env, { now: DAY.opts.now, dispatch: (slug, o) => runnerRpc(env, slug, structuredClone(o), { store }) }));
  const v = await budgetView(env, { competitions: C, now: Date.now() });
  const sum = C.reduce((s, c) => s + (v.competitions[c].spend_today_usd || 0), 0);
  assert.ok(v.global.spend_today_usd > 0);
  assert.equal(Math.round(sum * 1e6), Math.round(v.global.spend_today_usd * 1e6), 'competition totals == global');
  assert.equal(v.global.unattributed_usd, 0); assert.equal(v.basis, 'nominal_standard_rate_estimate');
  assert.equal(v.competitions['uefa-champions-league'].spend_today_usd, 0); assert.equal(v.competitions['uefa-champions-league'].desk_calls_today, 0, 'no fake spend for a competition with no paid story');
  assert.equal(v.competitions.mls.desk_calls_today, d.calls.filter(x => x === 'mls').length);
});

test('a scheduled tick that skips competitions writes no budget doc for them (no fake spend or desk calls)', async () => {
  const kv = memKV(); const d = desk(); const env = envOf(kv);
  const store = replayStore(unpackReads(DAY.reads, fx.blobs));
  // pretend every competition already ran 10 min ago and is quiet: only Bundesliga has pending work (deferred)
  for (const c of C) kv.m.set(`news:comp:${c}:state`, JSON.stringify({ slug: c, state_version: 'soccer-news-comp-state/1.1.0', activity: 'quiet', last_run_at: new Date(DAY.opts.now - 10 * 60e3).toISOString(), last_run_outcome: 'ran', deferred: c === 'bundesliga' ? 2 : 0, recaps: {}, new_recaps: 0 }));
  const empty = { select: async (t) => (t === 'soccer_competitions' ? C.map((s, i) => ({ id: `c${i}`, slug: s })) : []) };
  const s = await withFetch(d.f, () => runTick(env, null, { now: DAY.opts.now, store: empty, dispatch: (slug, o) => runnerRpc(env, slug, structuredClone(o), { store }) }));
  assert.deepEqual(Object.keys(s.dispatch.runners), ['bundesliga']);
  const docs = [...kv.m.keys()].filter(k => k.startsWith('news:budget:'));
  assert.deepEqual(docs, [budgetKey(TODAY(), 'bundesliga')]);
  assert.ok(d.calls.every(x => x === 'bundesliga'));
});

test('global breaker still stops everybody: no paid call, the existing hold reason, no competition hold', async () => {
  const kv = memKV(); const d = desk();
  kv.m.set(`openai:v1:calls:${TODAY()}`, JSON.stringify([{ estimated_usd: 5.01 }]));
  const r = await withFetch(d.f, () => run(envOf(kv), 'bundesliga', replayStore(unpackReads(DAY.reads, fx.blobs)), { budget: { competitions: C } }));
  assert.equal(d.calls.length, 0);
  assert.ok(r.out.held > 0 && r.out.holds.editorial_daily_budget_reached === r.out.held, JSON.stringify(r.out.holds));
  assert.equal(r.out.holds[HOLD_ALLOWANCE], undefined);
});

test('a budget-held story cannot publish: HOLD budget_competition_allowance, packet and evidence preserved, zero paid calls', async () => {
  const kv = memKV(); const d = desk();
  // floors on: a 0.1 % floor of $5 = $0.005 and no pool -> the first story fits the floor, the rest are held
  const P = pol({ floor_pct: 0.1, pool_pct: 0 });
  const st = replayStore(unpackReads(DAY.reads, fx.blobs));
  const r = await withFetch(d.f, () => run(envOf(kv), 'bundesliga', st, { budget: { competitions: C, policies: P } }));
  const per = await spendPerCall();
  assert.ok(per > 0.005, `one call ($${per}) exceeds the floor`);
  assert.equal(d.calls.length, 1, 'one paid call (inside the floor), then held');
  assert.equal(r.out.holds[HOLD_ALLOWANCE], r.out.new - 1);
  const arts = st.writes.filter(w => w.table === 'soccer_articles').flatMap(w => w.rows);
  const held = arts.filter(a => (a.hold_reasons || []).includes(HOLD_ALLOWANCE));
  assert.equal(held.length, r.out.new - 1); assert.ok(held.every(a => a.status === 'held' && a.published_at === null));
  const ev = st.writes.filter(w => w.table === 'soccer_article_evidence').flatMap(w => w.rows);
  for (const a of held) assert.ok(ev.some(e => e.packet_hash === a.packet_hash), 'frozen packet stored for the held story');
  const doc = JSON.parse(kv.m.get(budgetKey(TODAY(), 'bundesliga')));
  assert.equal(doc.budget_holds, r.out.new - 1); assert.equal(doc.desk_calls, 1);
});

test('accounting failure fails closed for that competition (read and write side); the global breaker is still first', async () => {
  const d1 = desk();
  const r1 = await withFetch(d1.f, () => run(envOf(memKV({ failBudgetGet: true })), 'mls', replayStore(unpackReads(DAY.reads, fx.blobs)), { budget: { competitions: C } }));
  assert.equal(d1.calls.length, 0); assert.equal(r1.out.holds[HOLD_ACCOUNTING], r1.out.new, 'unreadable accounting: nothing paid');
  const d2 = desk();
  const r2 = await withFetch(d2.f, () => run(envOf(memKV({ failBudgetPut: true })), 'mls', replayStore(unpackReads(DAY.reads, fx.blobs)), { budget: { competitions: C } }));
  assert.equal(d2.calls.length, 1, 'the first story was paid, its accounting write failed, the rest held');
  assert.equal(r2.out.budget_accounting_errors, r2.out.new, 'every record attempt failed and was counted (the paid one and the held ones)'); assert.equal(r2.out.holds[HOLD_ACCOUNTING], r2.out.new - 1);
  const kv3 = memKV({ failBudgetGet: true }); kv3.m.set(`openai:v1:calls:${TODAY()}`, JSON.stringify([{ estimated_usd: 9 }]));
  const r3 = await withFetch(desk().f, () => run(envOf(kv3), 'mls', replayStore(unpackReads(DAY.reads, fx.blobs)), { budget: { competitions: C } }));
  assert.equal(r3.out.holds[HOLD_ACCOUNTING], undefined, 'global ceiling decides first'); assert.equal(r3.out.holds.editorial_daily_budget_reached, r3.out.new);
});

test('a retried runner cannot double-charge (entries keyed by news event id); the UTC day rolls the ledger over', async () => {
  const kv = memKV(); const env = envOf(kv);
  kv.m.set('openai:v1:calls:2026-09-21', JSON.stringify([{ news_event_id: 'e1', estimated_usd: 0.03 }, { news_event_id: 'e2', estimated_usd: 0.04 }]));
  const at = Date.parse('2026-09-21T23:59:00Z');
  await recordStory(env, { slug: 'mls', eventId: 'e1', status: 'published', storyClass: 'match_recap', tier: 'recap', now: at });
  await recordStory(env, { slug: 'mls', eventId: 'e1', status: 'published', storyClass: 'match_recap', tier: 'recap', now: at }); // retry
  await recordStory(env, { slug: 'mls', eventId: 'e2', status: 'held', holdReasons: ['editorial:thin_output'], storyClass: 'player_form', tier: 'form', now: at });
  const doc = JSON.parse(kv.m.get(budgetKey('2026-09-21', 'mls')));
  assert.equal(doc.spend_usd, 0.07); assert.equal(doc.desk_calls, 2); assert.equal(doc.stories_attempted, 2); assert.equal(doc.stories_published, 1); assert.equal(doc.stories_held, 1);
  assert.equal(dayOf(Date.parse('2026-09-22T00:00:30Z')), '2026-09-22');
  const v = await budgetView(env, { competitions: C, now: Date.parse('2026-09-22T00:00:30Z') });
  assert.equal(v.day, '2026-09-22'); assert.equal(v.competitions.mls.spend_today_usd, 0, 'a new UTC day starts at zero'); assert.equal(v.global.spend_today_usd, 0);
});

test('health fields per competition and global; estimates labelled; unreadable accounting reported, never guessed', async () => {
  const kv = memKV(); const env = envOf(kv);
  const now = Date.now();
  kv.m.set(`openai:v1:calls:${TODAY()}`, JSON.stringify([{ news_event_id: 'e1', estimated_usd: 0.05 }, { news_event_id: 'x', estimated_usd: 0.01 }]));
  await recordStory(env, { slug: 'mls', eventId: 'e1', status: 'published', storyClass: 'match_recap', tier: 'recap', now });
  const v = await budgetView(env, { competitions: C, now });
  for (const k of ['spend_today_usd', 'allowance_today_usd', 'desk_calls_today', 'shared_pool_today_usd', 'stories_today', 'budget_state']) assert.ok(k in v.competitions.mls, k);
  assert.deepEqual([v.global.ceiling_usd, v.global.spend_today_usd, v.global.remaining_usd, v.global.attributed_to_competitions_usd, v.global.unattributed_usd], [5, 0.06, 4.94, 0.05, 0.01]);
  assert.equal(v.competitions.mls.allowance_today_usd, 5, '5A: floor 0 + the whole pool'); assert.equal(v.competitions.mls.budget_state, 'pool');
  const bad = await budgetView(envOf(memKV({ failBudgetGet: true })), { competitions: C, now });
  assert.equal(bad.competitions.mls.budget_state, 'accounting_unavailable'); assert.equal(bad.competitions.mls.spend_today_usd, null);
});

test('dry and review runs never touch the budget', async () => {
  const kv = memKV();
  await withFetch(desk().f, () => run(envOf(kv), 'mls', replayStore(unpackReads(DAY.reads, fx.blobs)), { dry: true, budget: { competitions: C } }));
  assert.equal([...kv.m.keys()].filter(k => k.startsWith('news:budget:')).length, 0);
});
