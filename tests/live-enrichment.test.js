// V3.1: Bundesliga live enrichment (shadow), ledger corrections, breaker, health isolation.
// Every provider response is a fake fetcher inside the test (no network, no committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPglite, applyMigrations } from '../workers/soccer-ingest/src/store-pglite.js';
import { runEspnLive, BREAKER, DISAGREE_AFTER_MS, enrichmentModes } from '../workers/soccer-ingest/src/espn-live.js';
import { reconcileEspnLedger, GLITCH_CONFIRM_READS } from '../workers/soccer-ingest/src/espn-lane.js';
import { canonicalHealth, enrichmentHealth } from '../workers/soccer-ingest/src/health.js';
import { SourceBlockedError } from '../workers/shared/http.js';
import { servedLive, enrichmentBlock, STALE_AFTER_MS } from '../workers/soccer-api/src/cast.js';
import { liveView, liveStatus } from '../src/lib/cast.js';

const id = n => `00000000-0000-5000-8000-0000000e${String(n).padStart(4, '0')}`;
const T0 = Date.parse('2026-10-09T19:00:00Z'); // 30 min after a 18:30 kickoff

// Two competitions: MLS (ESPN owns results) and Bundesliga (OpenLigaDB owns; ESPN shadow enrichment).
async function world({ bundesligaMode = 'shadow' } = {}) {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league' }, { id: id(2), slug: 'mls', name: 'MLS', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(3), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }, { id: id(4), competition_id: id(2), label: '2026', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  const teams = [[10, 'bay', 'openligadb', '40', '132'], [11, 'bvb', 'openligadb', '7', '124'], [12, 'mia', 'espn', '1', '1'], [13, 'nyc', 'espn', '2', '2'], [14, 'lev', 'openligadb', '6', '131'], [15, 'rbl', 'openligadb', '1635', '11420']];
  await store.insert('soccer_teams', teams.map(([n, slug, fp, fe]) => ({ id: id(n), slug, name: slug.toUpperCase(), team_type: 'club', founding_provider: fp, founding_external_id: fe })));
  await store.insert('soccer_team_external_ids', teams.map(([n, , , , espnId]) => ({ provider: 'espn', external_id: espnId, team_id: id(n), method: 'fixture_graph', evidence: 't' })));
  await store.insert('soccer_matches', [
    { id: id(20), competition_id: id(1), season_id: id(3), kickoff_at: '2026-10-09T18:30:00Z', home_team_id: id(10), away_team_id: id(11), status: 'live', result_provider: 'openligadb', home_score: 1, away_score: 0 },
    { id: id(21), competition_id: id(2), season_id: id(4), kickoff_at: '2026-10-09T18:30:00Z', home_team_id: id(12), away_team_id: id(13), status: 'live', result_provider: 'espn', home_score: 0, away_score: 0 },
    // an ambiguous Bundesliga fixture: no ESPN crosswalk row, so it must never be polled
    { id: id(22), competition_id: id(1), season_id: id(3), kickoff_at: '2026-10-09T18:30:00Z', home_team_id: id(14), away_team_id: id(15), status: 'live', result_provider: 'openligadb', home_score: 0, away_score: 0 },
  ]);
  await store.insert('soccer_match_external_ids', [{ provider: 'espn', external_id: '9001', match_id: id(20), method: 'fixture_graph', evidence: 't' }, { provider: 'espn', external_id: '9002', match_id: id(21), method: 'founding', evidence: 't' }]);
  const mem = new Map(); const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const kvm = new Map(); const kv = { async get(k) { return kvm.has(k) ? JSON.parse(kvm.get(k)) : null; }, async put(k, v) { kvm.set(k, v); } };
  const registry = { competitions: [{ slug: 'bundesliga', espn: { league: 'ger.1', enabled: true, live_enrichment: bundesligaMode } }, { slug: 'mls', espn: { league: 'usa.1', enabled: true } }] };
  return { store, storage, mem, kv, kvm, registry };
}

// A scripted ESPN: per event id, status / scores / plays; `fail` / `blocked` sets per event.
function espnFake() {
  const ev = { 9001: { state: 'in', clock: "31'", h: 1, a: 0, plays: [] }, 9002: { state: 'in', clock: "30'", h: 0, a: 0, plays: [] } };
  const fail = new Set(); const blocked = new Set(); const calls = [];
  const fetcher = async url => {
    calls.push(url);
    const m = url.match(/events\/(\d+)/); const e = ev[m?.[1]];
    if (m && blocked.has(m[1])) throw new SourceBlockedError(url, 403);
    if (m && fail.has(m[1])) throw new Error(`upstream 500 for ${m[1]}`);
    let body = {};
    if (url.endsWith('/status')) body = e.state === 'post' ? { type: { state: 'post', completed: true, shortDetail: 'FT' }, displayClock: "90'+3'", period: 2 } : { type: { state: 'in', shortDetail: e.clock }, displayClock: e.clock, period: 1 };
    else if (/competitors\/(1|40|132|6|131)\/score/.test(url) || /competitors\/1\/score/.test(url)) body = { value: e.h };
    else if (/competitors\/\d+\/score/.test(url)) body = { value: /competitors\/(124|2|7)\/score/.test(url) ? e.a : e.a };
    else if (url.includes('/plays')) body = { items: e.plays, pageCount: 1 };
    return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body)) };
  };
  return { ev, fail, blocked, calls, fetcher };
}
const play = (pid, clock, text = 'Pass', extra = {}) => ({ id: String(pid), type: { text }, period: { number: 1 }, clock: { value: clock }, team: { $ref: 'x/teams/1' }, ...extra });
const tick = (w, f, t, extra = {}) => runEspnLive({ store: w.store, storage: w.storage, registry: w.registry, now: t, fetcher: f.fetcher, kv: w.kv, ...extra });
const canonicalRow = async (w, mid) => JSON.stringify((await w.store.select('soccer_matches', { columns: '*', eq: { id: mid } }))[0]);

test('registry: Bundesliga is shadow enrichment; MLS is not enriched', async () => {
  const reg = (await import('../data/registry/competitions.json', { with: { type: 'json' } })).default;
  assert.equal(enrichmentModes(reg).get('bundesliga'), 'shadow');
  assert.equal(enrichmentModes(reg).has('mls'), false);
});

test('CANONICAL ISOLATION: ESPN enrichment never mutates the OpenLigaDB result; disagreement is recorded', async () => {
  const w = await world(); const f = espnFake();
  const before = await canonicalRow(w, id(20));
  // same score as the canonical owner (1-0): enrichment state only
  const t1 = await tick(w, f, T0);
  assert.equal(await canonicalRow(w, id(20)), before, 'byte-identical canonical row');
  const s1 = JSON.parse(w.kvm.get(`live:${id(20)}`));
  assert.deepEqual([s1.role, s1.mode, s1.source, s1.canonical_result_source], ['enrichment', 'shadow', 'espn', 'openligadb']);
  assert.deepEqual(s1.score, { home: 1, away: 0 }); assert.equal(s1.display_clock, "31'"); assert.ok(s1.observed_at);
  assert.equal(s1.disagreement, null);
  assert.ok(t1.results.some(r => r.match === id(20) && r.mode === 'shadow'));
  // ESPN now differs (2-0): canonical untouched; logged only after the tolerance window
  f.ev[9001].h = 2;
  await tick(w, f, T0 + 60e3);
  assert.equal(await canonicalRow(w, id(20)), before);
  assert.equal(w.kvm.get('live:disagreements'), undefined, 'a short gap is source lag, not yet a disagreement');
  await tick(w, f, T0 + 60e3 + DISAGREE_AFTER_MS);
  assert.equal(await canonicalRow(w, id(20)), before);
  const d = JSON.parse(w.kvm.get('live:disagreements'));
  assert.equal(d.length, 1); assert.deepEqual([d[0].kind, d[0].espn.home, d[0].canonical.home, d[0].canonical_source], ['live_score', 2, 1, 'openligadb']);
  // ESPN changes again (3-0): canonical still unchanged; nothing in any canonical or public table
  f.ev[9001].h = 3;
  await tick(w, f, T0 + 120e3 + DISAGREE_AFTER_MS);
  assert.equal(await canonicalRow(w, id(20)), before);
  assert.equal((await w.store.select('soccer_match_source_results', { columns: ['provider'], eq: { match_id: id(20) } })).length, 0, 'shadow writes no source_results row');
  assert.equal((await w.store.select('soccer_match_events', { columns: ['id'], eq: { match_id: id(20) } })).length, 0, 'shadow writes no ledger event');
  // final: ESPN 3-0, the owner closes 1-0 -> reconciled to the owner, mismatch logged
  f.ev[9001].state = 'post';
  await tick(w, f, T0 + 180e3 + DISAGREE_AFTER_MS);
  await w.store.update('soccer_matches', { status: 'finished' }, { eq: { id: id(20) } });
  const t = await tick(w, f, T0 + 240e3 + DISAGREE_AFTER_MS);
  assert.ok(t.results.some(r => r.match === id(20) && r.reconciled && r.agree === false));
  const [row] = await w.store.select('soccer_matches', { columns: ['home_score', 'away_score', 'result_provider'], eq: { id: id(20) } });
  assert.deepEqual([row.home_score, row.away_score, row.result_provider], [1, 0, 'openligadb']);
  assert.equal(JSON.parse(w.kvm.get('live:disagreements')).at(-1).kind, 'final_score');
  await w.store.close();
});

test('ambiguous fixture (no proven crosswalk) is never polled', async () => {
  const w = await world(); const f = espnFake();
  const t = await tick(w, f, T0);
  assert.ok(t.results.some(r => r.match === id(22) && /never polled/.test(r.skipped)));
  assert.ok(f.calls.every(u => /events\/(9001|9002)\//.test(u)), 'only crosswalked events requested');
  await w.store.close();
});

test('one failing match does not abort the tick; enrichment-only failure never fails the lane', async () => {
  const w = await world(); const f = espnFake();
  f.fail.add('9001');
  const t = await tick(w, f, T0);
  assert.ok(t.results.some(r => r.match === id(20) && r.error));
  assert.ok(t.results.some(r => r.match === id(21) && r.status === 'live'), 'the MLS match was still processed');
  f.fail.add('9002'); f.fail.delete('9001');
  const t2 = await tick(w, f, T0 + 60e3);
  assert.ok(t2.results.some(r => r.match === id(20) && r.mode === 'shadow'));
  // only the shadow match fails in every tick: breaker counts it, the lane itself does not fail
  f.fail.clear(); f.fail.add('9001'); w.kvm.delete(`live:${id(21)}`);
  await w.store.update('soccer_matches', { status: 'finished' }, { eq: { id: id(21) } });
  const t3 = await tick(w, f, T0 + 120e3);
  assert.equal(t3.metric.failed, 1); assert.equal(t3.metric.polled, 1);
  assert.equal(JSON.parse(w.kvm.get(BREAKER.key)).failed_ticks, 1);
  await w.store.close();
});

test('breaker: 3 failed ticks open it for 5 minutes; it recovers and resets after', async () => {
  const w = await world(); const f = espnFake();
  f.fail.add('9001'); f.fail.add('9002');
  for (let i = 0; i < 3; i++) await assert.rejects(tick(w, f, T0 + i * 60e3), /every polled match failed/);
  const b = JSON.parse(w.kvm.get(BREAKER.key));
  assert.equal(b.failed_ticks, 3); assert.equal(Date.parse(b.open_until), T0 + 120e3 + BREAKER.open_ms);
  f.calls.length = 0;
  const open = await tick(w, f, T0 + 180e3);
  assert.match(open.skipped, /circuit open/); assert.equal(f.calls.length, 0, 'nothing fetched while open');
  f.fail.clear();
  const ok = await tick(w, f, T0 + 120e3 + BREAKER.open_ms + 1);
  assert.equal(ok.metric.failed, 0);
  assert.deepEqual(JSON.parse(w.kvm.get(BREAKER.key)), { failed_ticks: 0, open_until: null, reason: null });
  await w.store.close();
});

test('breaker: a source block opens it for 60 minutes and is never retried', async () => {
  const w = await world(); const f = espnFake();
  f.blocked.add('9001'); f.blocked.add('9002');
  await assert.rejects(tick(w, f, T0), SourceBlockedError);
  const b = JSON.parse(w.kvm.get(BREAKER.key));
  assert.equal(Date.parse(b.open_until), T0 + BREAKER.blocked_ms); assert.match(b.reason, /source blocked/);
  const polls = f.calls.length;
  assert.match((await tick(w, f, T0 + 30 * 60e3)).skipped, /circuit open/);
  assert.equal(f.calls.length, polls);
  await w.store.close();
});

// ---- ledger corrections (MLS: ESPN owns the match, the ledger is public) ----
async function ledger(w, f, plays, t) { f.ev[9002].plays = plays; w.kvm.delete('live:lock'); await tick(w, f, t); return (await w.store.select('soccer_match_events', { columns: ['source_event_id', 'sequence', 'is_goal'], eq: { match_id: id(21) }, order: 'sequence.asc' })); }

test('withdrawn / VAR-cancelled goal: archived with full provenance, then removed from the active ledger', async () => {
  const w = await world(); const f = espnFake();
  const base = [play(1, 0, 'Kickoff'), play(2, 300), play(3, 600, 'Goal', { scoringPlay: true }), play(4, 900), play(5, 1200)];
  const l1 = await ledger(w, f, base, T0);
  assert.deepEqual(l1.map(x => x.source_event_id), ['1', '2', '3', '4', '5']); assert.equal(l1.find(x => x.source_event_id === '3').is_goal, true);
  // the goal is published as invalid (deleted after review)
  const l2 = await ledger(w, f, [...base.slice(0, 2), { ...base[2], valid: false }, ...base.slice(3)], T0 + 60e3);
  assert.deepEqual(l2.map(x => x.source_event_id), ['1', '2', '4', '5'], 'withdrawn goal no longer active');
  assert.deepEqual(l2.map(x => x.sequence), [1, 2, 3, 4], 're-sequenced without collision');
  const keys = [...w.mem.keys()].filter(k => k.startsWith(`soccer-source/espn/retractions/${id(21)}/3-`));
  assert.equal(keys.length, 1, 'archived before removal');
  const a = JSON.parse(w.mem.get(keys[0]));
  for (const k of ['source', 'source_event_id', 'match_id', 'provider_event_id', 'first_seen_at', 'last_seen_at', 'withdrawn_at', 'reason', 'source_status', 'prior_payload', 'prior_capture_id', 'prior_raw_payload_hash']) assert.ok(k in a, k);
  assert.equal(a.provider_event_id, '9002'); assert.equal(a.prior_payload.is_goal, true); assert.match(a.source_status, /valid:false/);
  assert.equal(a.last_seen_at, new Date(T0).toISOString());
  assert.equal(JSON.parse(w.kvm.get('live:corrections')).at(-1).retracted[0].goal, true);
  await w.store.close();
});

test('play order change: re-sequenced safely, no duplicate, no failed tick', async () => {
  const w = await world(); const f = espnFake();
  const base = [play(1, 0, 'Kickoff'), play(2, 300), play(4, 900), play(5, 1200)];
  await ledger(w, f, base, T0);
  // a late-entered play lands in the middle: every later play moves one slot
  const l = await ledger(w, f, [...base.slice(0, 2), play(3, 600, 'Foul'), ...base.slice(2)], T0 + 60e3);
  assert.deepEqual(l.map(x => [x.source_event_id, x.sequence]), [['1', 1], ['2', 2], ['3', 3], ['4', 4], ['5', 5]]);
  assert.equal(new Set(l.map(x => x.source_event_id)).size, l.length, 'no duplicates');
  assert.equal(JSON.parse(w.kvm.get(`live:${id(21)}`)).status, 'live');
  await w.store.close();
});

test('provider glitch: >50% disappearance keeps the previous ledger, logs, and other matches continue', async () => {
  const w = await world(); const f = espnFake();
  const base = [1, 2, 3, 4, 5, 6].map(n => play(n, n * 100));
  await ledger(w, f, base, T0);
  const held = await ledger(w, f, base.slice(0, 2), T0 + 60e3);
  assert.equal(held.length, 6, 'previous ledger preserved');
  assert.equal(JSON.parse(w.kvm.get('live:glitches')).length, 1);
  assert.equal(JSON.parse(w.kvm.get(`live:${id(20)}`)).role, 'enrichment', 'the Bundesliga match was still processed');
  // the same disappearance on consecutive reads is a genuine withdrawal
  for (let i = 2; i < GLITCH_CONFIRM_READS; i++) assert.equal((await ledger(w, f, base.slice(0, 2), T0 + i * 60e3)).length, 6);
  const confirmed = await ledger(w, f, base.slice(0, 2), T0 + GLITCH_CONFIRM_READS * 60e3);
  assert.equal(confirmed.length, 2);
  assert.equal(JSON.parse(w.kvm.get('live:corrections')).at(-1).reason, 'withdrawn_confirmed_after_hold');
  await w.store.close();
});

test('reconcile never removes without an archive (fail closed)', async () => {
  const w = await world(); const f = espnFake();
  await ledger(w, f, [play(1, 0), play(2, 100), play(3, 200)], T0);
  const r = await reconcileEspnLedger(w.store, { matchId: id(21), rows: [{ source_event_id: '1', sequence: 1 }, { source_event_id: '2', sequence: 2 }], storage: null });
  assert.equal(r.held, 'no_archive_available');
  assert.equal((await w.store.select('soccer_match_events', { columns: ['id'], eq: { match_id: id(21) } })).length, 3);
  await w.store.close();
});

// ---- API contract + frontend fallback ----
test('API: owner / legacy state served as before; shadow never; public only behind the rights switch', () => {
  const owner = { status: 'live', display_clock: "12'", observed_at: new Date().toISOString() };
  assert.equal(servedLive(owner, {}).owner, owner, 'legacy state without a role is the owner lane (unchanged)');
  assert.equal(servedLive({ ...owner, role: 'owner' }, {}).owner.display_clock, "12'");
  const shadow = { ...owner, role: 'enrichment', mode: 'shadow', source: 'espn', score: { home: 1, away: 0 } };
  assert.deepEqual(servedLive(shadow, { LIVE_ENRICHMENT_PUBLIC: 'on' }), { owner: null, enrichment: null }, 'shadow is never served');
  const pub = { ...shadow, mode: 'public' };
  assert.deepEqual(servedLive(pub, {}), { owner: null, enrichment: null }, 'public mode still needs the Worker switch');
  assert.equal(servedLive(pub, { LIVE_ENRICHMENT_PUBLIC: 'on' }).enrichment, pub);
  assert.deepEqual(servedLive(null, {}), { owner: null, enrichment: null });
});

test('API: enrichment block shape; stale when old or never fetched', () => {
  const now = Date.parse('2026-10-09T19:00:00Z');
  const e = enrichmentBlock({ source: 'espn', status: 'live', score: { home: 2, away: 1 }, display_clock: "63'", period: 2, observed_at: '2026-10-09T18:59:20Z', changed_at: '2026-10-09T18:58:00Z' }, now);
  assert.deepEqual(Object.keys(e), ['source_role', 'source', 'fetched_at', 'status', 'score', 'clock', 'freshness']);
  assert.equal(e.source_role, 'secondary_enrichment'); assert.deepEqual(e.score, { home: 2, away: 1 }); assert.equal(e.clock.display, "63'");
  assert.deepEqual([e.freshness.age_seconds, e.freshness.stale], [40, false]);
  assert.equal(enrichmentBlock({ source: 'espn', observed_at: new Date(now - STALE_AFTER_MS - 1000).toISOString() }, now).freshness.stale, true);
  assert.equal(enrichmentBlock({ source: 'espn' }, now).freshness.stale, true);
  assert.equal(enrichmentBlock(null), null);
});

test('frontend: fresh enrichment wins; stale or missing falls back to the canonical score, labelled delayed', () => {
  const canon = { score: { home: 1, away: 0 }, live: { mode: 'live', display_clock: null, provider_observed_at: null } };
  assert.deepEqual(liveView(canon).score, { home: 1, away: 0 }); assert.equal(liveView(canon).from, 'canonical');
  assert.equal(liveStatus(canon.live).tone, 'noclock', 'no enrichment: the existing no-live-clock wording');
  const fresh = { ...canon, live: { ...canon.live, enrichment: { score: { home: 2, away: 0 }, clock: { display: "64'" }, fetched_at: new Date().toISOString(), freshness: { stale: false } } } };
  assert.deepEqual([liveView(fresh).score.home, liveView(fresh).clock, liveView(fresh).from], [2, "64'", 'enrichment']);
  assert.equal(liveStatus(fresh.live).label, 'LIVE');
  const stale = { ...canon, live: { ...canon.live, enrichment: { ...fresh.live.enrichment, freshness: { stale: true } } } };
  assert.deepEqual([liveView(stale).score.home, liveView(stale).clock, liveView(stale).from], [1, null, 'canonical'], 'stale enrichment score is never shown as current');
  assert.equal(liveStatus(stale.live).label, 'LIVE · DELAYED');
});

// ---- health isolation ----
test('health: canonical and enrichment are separate; a failing enrichment source never makes canonical unhealthy', () => {
  const lanes = [{ lane: 'openligadb_bl1_current', health: 'ok', last_success_at: '2026-10-09T18:55:00Z', last_change_at: '2026-10-09T18:50:00Z' }, { lane: 'espn_live', health: 'ok' }];
  const c = canonicalHealth(lanes, { bundesliga: { fixtures: 306, owned_by_openligadb: 306 } });
  assert.deepEqual([c[0].source, c[0].health, c[0].fixture_coverage.owned_by_openligadb], ['openligadb', 'ok', 306]);
  const reg = { competitions: [{ slug: 'bundesliga', espn: { enabled: true, live_enrichment: 'shadow' } }, { slug: 'mls', espn: { enabled: true } }] };
  const metrics = Array.from({ length: 6 }, (_, i) => ({ at: `2026-10-09T18:5${i}:00Z`, polled: 1, ok: 0, failed: 1, max_age_s: 60 + i * 60, started_lag_ms: 400 + i, duration_ms: 1500 }));
  const e = enrichmentHealth({ registry: reg, lane: lanes[1], metrics, breaker: { failed_ticks: 3, open_until: '2026-10-09T19:05:00Z', reason: 'every polled match failed' }, disagreements: [{}], glitches: [{}, {}], corrections: [{ retracted: [{}, {}] }], now: Date.parse('2026-10-09T19:00:00Z') });
  assert.deepEqual(e.competitions, [{ competition: 'bundesliga', mode: 'shadow' }]); assert.equal(e.public, false);
  assert.deepEqual([e.breaker.state, e.failed_polls, e.successful_polls], ['open', 6, 0]);
  assert.equal(e.poll_age_seconds.median, 240); assert.equal(e.poll_age_seconds.p95, 360);
  assert.deepEqual([e.score_disagreements, e.provider_glitches, e.event_retractions], [1, 2, 2]);
  assert.equal(c[0].health, 'ok', 'canonical health is computed without the enrichment block');
  assert.equal(enrichmentHealth({ registry: reg, metrics: metrics.slice(0, 2) }).poll_age_seconds.median, null, 'no percentile below 5 samples');
});
