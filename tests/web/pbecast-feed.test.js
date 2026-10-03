// PBEcast live match feed contract: rich event cards show ONLY what the source carries for that event
// (missing fields are omitted, never guessed); derived context is labelled and uses only events at or
// before the moment; provider xG stays the provider's; replay can never reveal a later event.
// Inputs are inline objects shaped like /v1/matches/:id/cast sequence items (no committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline, replayView } from '../../src/lib/cast.js';
import { callLine, describe, feedCounts, filterFn, liveCursor, matchPulse, scoreSwing, shotGeometry, withShotDetail, xgOf } from '../../src/lib/castfeed.js';
import { castView, feedItem, feedList, momentPanel, pulsePanel } from '../../src/pages/pbecast.js';

const m = { id: 'x', home: { slug: 'ars', name: 'Arsenal', short_name: 'Arsenal' }, away: { slug: 'che', name: 'Chelsea', short_name: 'Chelsea' }, event_source: 'espn' };
const saka = { id: 'p1', slug: 'bukayo-saka', name: 'Bukayo Saka' };
const odegaard = { id: 'p2', slug: 'martin-odegaard', name: 'Martin Ødegaard' };
const palmer = { id: 'p3', slug: 'cole-palmer', name: 'Cole Palmer' };
const saliba = { id: 'p4', slug: 'william-saliba', name: 'William Saliba' };
const S = (minute, team, extra = {}) => ({ minute, display_minute: `${minute}'`, period: minute > 45 ? '2H' : '1H', team, type: 'shot', player: team === 'home' ? saka : palmer, outcome: 'off_target', body_part: null, provider_xg: null, score: { home: 0, away: 0 }, ...extra });

// A real-shaped match: bare shot, rich shot, blocked, goal with assist, penalty saved, own goal,
// yellow, second booking -> red, a straight red, substitution, stoppage time.
const seq = [
  S(3, 'home'),
  S(12, 'home', { outcome: 'on_target', body_part: 'left_foot', provider_xg: { provider: 'espn', value: 0.21 }, x: 92, y: 40 }),
  S(20, 'away', { outcome: 'blocked', body_part: 'right_foot', x: 18, y: 30 }),
  { minute: 30, display_minute: "30'", period: '1H', team: 'home', type: 'card_yellow', player: saliba, score: { home: 0, away: 0 } },
  S(44, 'home', { type: 'goal', outcome: 'goal', body_part: 'right_foot', provider_xg: { provider: 'espn', value: 0.34 }, assist: odegaard, x: 95, y: 30, score: { home: 1, away: 0 } }),
  { minute: 47, display_minute: "45+2'", period: '1H', team: 'away', type: 'shot', player: palmer, outcome: 'on_target', penalty: true, body_part: 'right_foot', provider_xg: null, x: 11, y: 34, score: { home: 1, away: 0 } },
  { minute: 52, display_minute: "52'", period: '2H', team: 'away', type: 'own_goal', player: saliba, score: { home: 1, away: 1 } },
  S(55, 'home', { outcome: 'post', x: 90, y: 34, score: { home: 1, away: 1 } }),
  { minute: 60, display_minute: "60'", period: '2H', team: 'home', type: 'card_red', player: saliba, score: { home: 1, away: 1 } },
  { minute: 61, display_minute: "61'", team: 'home', type: 'sub', player_in: { id: 'p5', slug: 'gabriel-martinelli', name: 'Gabriel Martinelli' }, player_out: { id: 'p6', slug: 'leandro-trossard', name: 'Leandro Trossard' }, score: { home: 1, away: 1 } },
  { minute: 70, display_minute: "70'", period: '2H', team: 'away', type: 'card_red', player: palmer, score: { home: 1, away: 1 } },
  S(93, 'away', { type: 'goal', outcome: 'goal', penalty: true, display_minute: "90+3'", x: 11, y: 34, score: { home: 1, away: 2 } }),
];
const tl = buildTimeline(seq);
const it = i => tl.items[i];
const upto = i => tl.items.slice(0, i + 1);
const strip = html => html.replace(/<[^>]+>/g, ' ').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

test('missing source fields are omitted, never guessed', () => {
  const html = strip(feedItem(it(0), m, { seen: upto(0) }));
  assert.match(html, /ARSENAL SHOT/); assert.match(html, /off target/);
  for (const bad of [/foot/i, /header/i, /xG/, / m from goal/, /Assist/, /in the box/, /PBE derived/]) assert.doesNotMatch(html, bad, String(bad));
  const d = describe(it(0), m, upto(0));
  assert.equal(d.geo, null); assert.equal(d.xg, null);
});

test('rich shot: body part, outcome, PBE derived distance, provider xG labelled Supplied xG (never PBE xG, never the lane name)', () => {
  const html = feedItem(it(1), m, { seen: upto(1) });
  const t = strip(html);
  assert.match(t, /ARSENAL SHOT ON TARGET/); assert.match(t, /Left foot · on target/);
  assert.match(t, /14\.3 m from goal · in the box PBE derived/); // home attacks x=105: hypot(13, 6) = 14.3
  assert.match(t, /Supplied xG 0\.21/); assert.doesNotMatch(t, /PBE xG|ESPN/);
  assert.match(html, /<abbr class="pbe-d" title="PBE derived from the source event location/);
  assert.deepEqual(shotGeometry(it(2)), { distance_m: 18.4, in_box: false }, 'away attacks x=0: hypot(18, 4); 18 m out is outside the 16.5 m box');
});

test('away distance is measured to the goal the away side attacks', () => {
  assert.equal(shotGeometry(it(2)).distance_m, Math.round(Math.hypot(18, 4) * 10) / 10);
  assert.equal(shotGeometry({ type: 'shot', outcome: 'off_target', team: 'away', x: 60, y: 34 }).in_box, false);
  assert.equal(shotGeometry({ type: 'own_goal', team: 'home', x: 100, y: 34 }), null, 'an own goal location is not an attempt on goal');
  assert.equal(shotGeometry({ type: 'card_red', team: 'home', x: 100, y: 34 }), null);
  assert.equal(xgOf({ provider_xg: { provider: 'espn', value: null } }), null);
  assert.equal(xgOf({ provider_xg: { provider: 'espn', value: 0.5 } }).label, 'Supplied xG');
});

test('goal: dominant headline with score, assist chip, score swing and derived conversion', () => {
  const html = feedItem(it(4), m, { seen: upto(4) });
  const t = strip(html);
  assert.match(t, /GOAL — ARSENAL 1–0/); assert.match(t, /Right foot/); assert.match(t, /Assist Martin Ødegaard/);
  assert.match(t, /PBE Arsenal open the scoring · Arsenal: 1 goal from 3 recorded shots/);
  assert.match(html, /class="fi-score">1–0</);
  assert.equal(callLine(it(4), m, upto(4)), 'Saka scores with a right-footed finish, set up by Ødegaard. Arsenal open the scoring, 1–0.');
});

test('penalty saved, own goal, woodwork, stoppage minute', () => {
  const pen = strip(feedItem(it(5), m, { seen: upto(5) }));
  assert.match(pen, /^ ?45\+2'/); assert.match(pen, /CHELSEA PENALTY/); assert.match(pen, /on target, not scored/); assert.match(pen, /\(pen\)/);
  assert.doesNotMatch(pen, /saved by|keeper/i);
  const og = strip(feedItem(it(6), m, { seen: upto(6) }));
  assert.match(og, /OWN GOAL — CHELSEA 1–1/); assert.match(og, /William Saliba own goal/); assert.match(og, /Own goal · Arsenal player/);
  assert.equal(scoreSwing(it(6), upto(6)), 'equaliser');
  const post = strip(feedItem(it(7), m, { seen: upto(7) }));
  assert.match(post, /woodwork/);
});

test('cards: second booking stated from two recorded cards; a straight red claims nothing extra', () => {
  const second = describe(it(8), m, upto(8));
  assert.equal(second.headline, 'RED CARD'); assert.deepEqual(second.facts, ["Booked earlier at 30'"]);
  const straight = describe(it(10), m, upto(10));
  assert.equal(straight.headline, 'RED CARD'); assert.deepEqual(straight.facts, []);
  for (const i of [3, 8, 10]) assert.doesNotMatch(strip(feedItem(it(i), m, { seen: upto(i) })), /for (dissent|a foul|time-wasting)|because|reason/i);
});

test('substitution: ON / OFF only, never a reason', () => {
  const t = strip(feedItem(it(9), m, { seen: upto(9) }));
  assert.match(t, /ARSENAL SUBSTITUTION/); assert.match(t, /ON Gabriel Martinelli/); assert.match(t, /OFF Leandro Trossard/);
  assert.doesNotMatch(t, /injur|tactical|replac/i);
  assert.equal(callLine(it(9), m, upto(9)), 'Arsenal change: Gabriel Martinelli on, Leandro Trossard off.');
});

test('replay: feed, Current Moment and Match Pulse at a cursor contain nothing after it', () => {
  const rv = replayView(30, tl, { home: 1, away: 2 });
  assert.deepEqual(rv.seen.map(x => x.minute), [3, 12, 20, 30]);
  const feed = strip(feedList(rv.seen, m, { current: rv.current, seekable: true }));
  for (const later of ['GOAL', 'Ødegaard', '45+2', 'OWN GOAL', 'RED CARD', 'SUBSTITUTION', "90+3'"]) assert.ok(!feed.includes(later), `feed leaks ${later}`);
  const moment = strip(momentPanel(rv, m, { mode: 'replay' }));
  assert.match(moment, /REPLAY · 30'/); assert.match(moment, /YELLOW CARD/); assert.match(moment, /Arsenal 0–0 Chelsea/);
  assert.doesNotMatch(moment, /1–0|GOAL/);
  const p = matchPulse(rv.seen, rv.v, tl);
  assert.deepEqual([p.home.match.shots, p.away.match.shots, p.home.match.goals], [2, 1, 0]);
  assert.equal(p.home.xg, null, 'only 1 of 2 home shots has provider xG: no total');
  assert.equal(p.home.xg_partial, 1);
  const pulse = strip(pulsePanel(p, m));
  assert.match(pulse, /Last 10 min · 20'–30'/); assert.match(pulse, /provider published xG for only some shots/);
  assert.doesNotMatch(pulse, /possession \d|probability \d|momentum/i);
  // at every source minute, every derived count only covers events at or before it
  for (const v of tl.items.filter(x => x.v !== null).map(x => x.v)) {
    const r = replayView(v, tl);
    const total = matchPulse(r.seen, r.v, tl);
    assert.equal(total.home.match.shots + total.away.match.shots, r.seen.filter(x => 'outcome' in x).length, `v=${v}`);
    assert.ok(r.seen.every(x => x.v <= v));
    assert.ok(!strip(feedList(r.seen, m, { current: r.current, seekable: true })).includes("90+3'") || v >= 93);
  }
});

test('feed filters and counts are over the events the view may show', () => {
  const rv = replayView(it(9).v, tl);
  assert.deepEqual(feedCounts(rv.seen), { all: 10, shots: 6, goals: 2, cards: 2, subs: 1 });
  assert.ok(rv.seen.filter(filterFn('shots')).every(x => x.type === 'shot' || x.type === 'goal'));
  const subs = feedList(rv.seen, m, { prefs: { filter: 'subs', order: 'desc' }, seekable: true });
  assert.equal((subs.match(/<li class="fi /g) || []).length, 1);
  const none = feedList(replayView(5, tl).seen, m, { prefs: { filter: 'cards', order: 'desc' }, seekable: true });
  assert.match(none, /No cards recorded up to this point/);
  const asc = strip(feedList(rv.seen, m, { prefs: { filter: 'all', order: 'asc' }, seekable: true }));
  assert.ok(asc.indexOf(" 3' ") >= 0 && asc.indexOf(" 3' ") < asc.indexOf(" 61' "), 'match order');
});

test('live cursor follows the provider clock, never the nominal 90', () => {
  const live = buildTimeline(seq.slice(0, 9)); // through 60'
  assert.ok(live.total >= 90, 'tl.total is the nominal period end');
  const v73 = liveCursor(live, "73'");
  assert.equal(v73, 73 + live.segments.find(s => s.period === '2H').shift);
  const firstHalf = buildTimeline(seq.slice(0, 3)); // through 20'
  assert.equal(liveCursor(firstHalf, "45'+2'"), 47, 'first-half stoppage stays in the first half');
  assert.equal(liveCursor(firstHalf, "47'"), 47 + firstHalf.segments.find(s => s.period === '2H').shift);
  assert.equal(liveCursor(live, 'HT'), 60 + live.segments.find(s => s.period === '2H').shift, 'unparseable -> latest event');
  assert.equal(liveCursor(live, "10'"), 60 + live.segments.find(s => s.period === '2H').shift, 'never behind the latest event');
});

test('source situation joins only when the shot records align exactly', () => {
  const shots = seq.filter(x => 'outcome' in x);
  const st = shots.map((x, i) => ({ minute: x.minute, team: x.team, player: x.player, situation: i === 1 ? 'Fast Break' : 'Regular Play' }));
  const joined = withShotDetail(seq, st);
  assert.equal(joined[1].situation, 'Fast Break');
  assert.match(describe(joined[1], m, [joined[1]]).facts.join(' · '), /Fast break/);
  assert.doesNotMatch(describe(joined[0], m, [joined[0]]).facts.join(' · '), /Regular/i, "'Regular Play' says nothing and is omitted");
  const off = st.map((x, i) => (i === 2 ? { ...x, minute: 99 } : x));
  assert.equal(withShotDetail(seq, off), seq, 'any disagreement: nothing joined');
});

test('goals-only source: a truthful simpler cast, no shot pulse', () => {
  const goalsOnly = [{ minute: 10, display_minute: "10'", period: '1H', team: 'home', type: 'goal', player: saka, score: { home: 1, away: 0 } }];
  const t = buildTimeline(goalsOnly);
  const p = matchPulse(t.items, t.total, t);
  assert.equal(p.hasShotRecord, false);
  assert.match(strip(pulsePanel(p, { ...m, event_source: 'openligadb' })), /records goals and cards but no shots/);
  const html = strip(feedItem(t.items[0], m, { seen: t.items }));
  assert.match(html, /GOAL — ARSENAL 1–0/); assert.doesNotMatch(html, /foot|xG| m from goal|recorded shots/);
});

test('live cast view: Current Moment is the latest event; the feed is pickable, not seekable', () => {
  const env = { data: { ...m, id: '5b0c8f3e-1111-5222-8333-444455556666', status: 'live', kickoff_at: '2026-10-02T19:00:00Z', score: { home: 1, away: 1 }, competition: { slug: 'mls', name: 'MLS' }, sequence: seq.slice(0, 10), shot_timeline: [], stats: null, lineups: null, live: { mode: 'live', display_clock: "63'", provider_observed_at: new Date().toISOString(), stale: false } }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } };
  const html = castView(env);
  assert.match(strip(html), /LIVE · 63'/); assert.match(strip(html), /ARSENAL SUBSTITUTION/);
  assert.match(html, /data-pick="9"/); assert.doesNotMatch(html, /<li [^>]*data-seek/);
  assert.match(strip(html), /Last 10 min · 53'–63'/);
});
