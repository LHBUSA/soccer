// PBEcast contract: virtual timeline (stoppage never collides with the next period), replay state
// at a cursor, honest live wording, and the render modes. Inputs are inline objects shaped like
// /v1/matches/:id/cast (not committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, clockAt, keyMoments, liveStatus, periodOf, stateAt } from '../../src/lib/cast.js';
import { castView, hub } from '../../src/pages/pbecast.js';
import { resolve } from '../../src/lib/router.js';
import { buildMeta, metaPlan } from '../../src/seo/meta.js';

const P = { id: 'p1', slug: 'preston-judd', name: 'Preston Judd' };
const seq = [
  { minute: 4, display_minute: "4'", period: '1H', team: 'home', type: 'goal', player: P, outcome: 'goal', x: 96.7, y: 30, score: { home: 1, away: 0 } },
  { minute: 30, display_minute: "30'", period: '1H', team: 'home', type: 'card_yellow', player: P, score: { home: 1, away: 0 } },
  { minute: 46, display_minute: "45+1'", period: '1H', team: 'away', type: 'shot', player: { name: 'Src', resolved: false }, outcome: 'off_target', x: 20, y: 30, score: { home: 1, away: 0 } },
  { minute: 46, display_minute: "46'", team: 'home', type: 'sub', player_in: P, player_out: { slug: 'x', name: 'X' }, score: { home: 1, away: 0 } },
  { minute: 91, display_minute: "90+1'", period: '2H', team: 'away', type: 'goal', player: { slug: 'y', name: 'Y' }, outcome: 'goal', x: 10, y: 34, score: { home: 1, away: 1 } },
];

test('periods: stated wins, a 46th-minute substitution without a period is a half-time change', () => {
  assert.equal(periodOf(seq[2]), '1H');
  assert.equal(periodOf(seq[3]), '2H');
  assert.equal(periodOf({ minute: 100 }), 'E1');
  assert.equal(periodOf({}), null);
});

test('timeline: first-half stoppage sits before the second half; clock reads like the source', () => {
  const tl = buildTimeline(seq);
  assert.deepEqual(tl.segments.map(s => [s.period, s.start, s.end]), [['1H', 0, 46], ['2H', 46, 92]]);
  const v = tl.items.map(x => x.v);
  assert.deepEqual(v, [4, 30, 46, 47, 92]);
  for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1], 'monotonic in source order');
  assert.equal(clockAt(46, tl), "45+1'");
  assert.equal(clockAt(47, tl), "46'");
  assert.equal(clockAt(92, tl), "90+1'");
  assert.equal(tl.total, 92);
});

test('state at cursor: score and visible events', () => {
  const tl = buildTimeline(seq);
  assert.deepEqual(stateAt(0, tl).score, { home: 0, away: 0 });
  assert.deepEqual(stateAt(10, tl).score, { home: 1, away: 0 });
  assert.equal(stateAt(46, tl).seen.length, 3);
  assert.deepEqual(stateAt(tl.total, tl).score, { home: 1, away: 1 });
  assert.deepEqual(keyMoments(tl).map(x => x.display_minute), ["4'", "90+1'"]);
});

test('live wording never implies real time', () => {
  const now = Date.parse('2026-10-01T00:10:00Z');
  assert.equal(liveStatus({ mode: 'replay' }), null);
  assert.equal(liveStatus({ mode: 'live', provider_observed_at: null }, now).tone, 'noclock');
  const fresh = liveStatus({ mode: 'live', provider_observed_at: '2026-10-01T00:09:20Z', stale: false }, now);
  assert.equal(fresh.label, 'LIVE'); assert.match(fresh.note, /40s ago/); assert.match(fresh.note, /provider's own delay/);
  assert.equal(liveStatus({ mode: 'live', provider_observed_at: '2026-10-01T00:01:00Z', stale: true }, now).label, 'LIVE · DELAYED');
});

const env = (live, extra = {}) => ({ data: { id: '5b0c8f3e-1111-5222-8333-444455556666', status: live.mode === 'live' ? 'live' : live.mode === 'pregame' ? 'scheduled' : 'finished', kickoff_at: '2026-09-27T02:30:00Z', home: { slug: 'h', name: 'Home FC', short_name: 'Home' }, away: { slug: 'a', name: 'Away FC', short_name: 'Away' }, score: live.mode === 'pregame' ? null : { home: 1, away: 1 }, competition: { slug: 'mls', name: 'MLS' }, sequence: seq, stats: null, lineups: null, live, ...extra }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } });

test('render modes: replay has controls; live shows the provider clock; pregame has neither', () => {
  const r = castView(env({ mode: 'replay' }));
  assert.match(r, /data-replay/); assert.match(r, /REPLAY FROM KICK-OFF/); assert.match(r, /EVENT LOCATIONS, NOT PLAYER TRACKING/);
  assert.match(r, /identity pending/, 'unresolved source names keep their tag');
  const l = castView(env({ mode: 'live', display_clock: "63'", provider_observed_at: new Date().toISOString(), stale: false }));
  assert.doesNotMatch(l, /data-replay/); assert.match(l, /63&#39;|63'/); assert.match(l, /aria-live="polite"/);
  const p = castView(env({ mode: 'pregame' }, { sequence: [] }));
  assert.match(p, /PBEcast goes live at kick-off/); assert.doesNotMatch(p, /data-replay/);
  const none = castView(env({ mode: 'replay' }, { sequence: [], event_source: 'openligadb' }));
  assert.match(none, /Nothing is plotted rather than something invented/);
});

test('routes + meta: hub is static; a cast page canonicalises to its match page', () => {
  assert.equal(resolve('/pbecast').page, 'pbecastHub');
  assert.equal(resolve('/pbecast/5b0c8f3e-1111-5222-8333-444455556666').page, 'pbecast');
  assert.equal(resolve('/pbecast/abc').page, 'notfound');
  assert.deepEqual(metaPlan('/pbecast/5b0c8f3e-1111-5222-8333-444455556666').calls, ['matches/5b0c8f3e-1111-5222-8333-444455556666']);
  const m = buildMeta('/pbecast/5b0c8f3e-1111-5222-8333-444455556666', 'pbecast', [{ data: { ...env({ mode: 'replay' }).data, shots: [] } }]);
  assert.equal(m.canonical, 'https://soccer.propbetedge.ai/matches/5b0c8f3e-1111-5222-8333-444455556666');
  assert.match(m.title, /Home FC vs Away FC PBEcast/);
  assert.equal(buildMeta('/pbecast', 'pbecastHub').status, 200);
  const h = hub.render({ env: { data: { live: [], recent: [], upcoming: [], lane: null }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } } });
  assert.match(h, /No covered match is in play right now/);
});

// ---- replay contract: one replayView (stateAt) feeds every component; nothing after the cursor exists
import { replayView } from '../../src/lib/cast.js';
import { castPitch, feedItem, nowLine } from '../../src/pages/pbecast.js';

test('replayView: score, clock, current event, caption through the cursor only', () => {
  const tl = buildTimeline(seq);
  const at0 = replayView(0, tl, { home: 1, away: 1 });
  assert.equal(at0.seen.length, 0); assert.deepEqual(at0.score, { home: 0, away: 0 }); assert.equal(at0.current, null);
  assert.equal(at0.caption, "0 LOCATED SHOTS THROUGH 0'");
  const at30 = replayView(30, tl, { home: 1, away: 1 });
  assert.deepEqual(at30.seen.map(x => x.minute), [4, 30]); assert.equal(at30.current.type, 'card_yellow'); assert.equal(at30.clock, "30'");
  assert.equal(at30.caption, "1 LOCATED SHOT THROUGH 30'");
  assert.ok(at30.seen.every(x => x.v <= 30), 'no future event');
  const end = replayView(tl.total, tl, { home: 1, away: 1 });
  assert.equal(end.seen.length, seq.length); assert.equal(end.clock, 'FT'); assert.equal(end.caption, '3 LOCATED SHOTS · EVENT LOCATIONS, NOT PLAYER TRACKING');
  assert.equal(replayView(999, tl).v, tl.total, 'clamped'); assert.equal(replayView(-5, tl).v, 0);
});

test('replay pitch + feed markup contain only the events through the cursor', () => {
  const tl = buildTimeline(seq); const m = { home: { short_name: 'H' }, away: { short_name: 'A' } };
  const rv = replayView(30, tl);
  const pitch = castPitch(tl, m, { items: rv.seen });
  assert.equal((pitch.match(/class="cmark"/g) || []).length, 1, 'only the 4th-minute located goal');
  assert.doesNotMatch(pitch, /data-v="92"/);
  const feed = [...rv.seen].reverse().map(x => feedItem(x, m, { current: x === rv.current, seekable: true })).join('');
  assert.equal((feed.match(/<li /g) || []).length, 2); assert.match(feed, /class="fi t-card_yellow home cur"/); assert.match(feed, /data-seek="30"/);
  assert.doesNotMatch(feed, /90\+1/);
  assert.match(nowLine(rv, m), /^30' Yellow card · Preston Judd · H · H 1–0 A$/);
  assert.match(nowLine(replayView(tl.total, tl, { home: 1, away: 1 }), m), /^Full time · H 1–1 A$/);
  assert.match(nowLine(replayView(0, tl), m), /^Kick-off/);
});
