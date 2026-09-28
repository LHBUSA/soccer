// Official video matcher: allowlist, both-teams rule, conflicts, weak relevance, wrong competition, dates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAliasIndex, teamsInTitle, classifyVideo, scoreVideo, articleContext, allowedChannel, THRESHOLD } from '../workers/shared/video-match.js';

const T = [
  { id: 'bay', name: 'Bayern München', short_name: 'Bayern' }, { id: 'uni', name: '1. FC Union Berlin', short_name: 'Union Berlin' },
  { id: 'bvb', name: 'Borussia Dortmund', short_name: 'Dortmund' }, { id: 'stu', name: 'Stuttgart', short_name: 'Stuttgart' },
  { id: 'phi', name: 'Philadelphia Union', short_name: 'Philadelphia' }, { id: 'orl', name: 'Orlando City SC', short_name: 'Orlando City' },
  { id: 'mci', name: 'Manchester City', short_name: 'Man City' }, { id: 'mun', name: 'Manchester United', short_name: 'Man United' },
];
const idx = buildAliasIndex(T);
const BL = { channel_id: 'UC6UL29enLNe4mqwTfAyeNuw', verified: true, enabled: true, competition_id: 'c-bl', team_id: null, publisher_type: 'competition' };
const FCB = { channel_id: 'UCZkcxFIsqW5htimoUQKA0iA', verified: true, enabled: true, competition_id: null, team_id: 'bay', publisher_type: 'club' };
const ctx = { competition_slug: 'bundesliga', competition_id: 'c-bl', match: { id: 'm1', home_id: 'bay', away_id: 'uni', kickoff: '2026-09-18T18:30:00Z', score: { home: 7, away: 0 } }, player: null };
const v = (title, published_at = '2026-09-18T22:00:00Z') => ({ title, published_at, video_type: classifyVideo(title) });

test('aliases: exonyms and unique tokens, never an ambiguous token', () => {
  assert.deepEqual(teamsInTitle('Bayern Munich vs. Union Berlin | Highlights', idx).sort(), ['bay', 'uni']);
  assert.deepEqual(teamsInTitle('Man City 5-3 Sunderland', idx), ['mci']);
  assert.deepEqual(teamsInTitle('Manchester derby preview', idx), [], "'manchester' is shared by two clubs: never an alias");
  assert.deepEqual(teamsInTitle('Philadelphia Union vs. Orlando City | Full Match Highlights', idx).sort(), ['orl', 'phi']);
  assert.ok(!teamsInTitle('Union Berlin fans', idx).includes('phi'), "'union' alone is not Philadelphia Union");
});

test('official allowlisted channel accepted; unknown or unverified channel rejected whatever the title', () => {
  assert.equal(allowedChannel(BL), true);
  const r = scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4'), { channel_id: 'UCxxxxxxxxxxxxxxxxxxxxxx', verified: false, enabled: false }, ctx, idx);
  assert.equal(r.status, 'rejected'); assert.match(r.reasons[0].why, /allowlist/);
  assert.equal(scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights'), {}, ctx, idx).status, 'rejected');
});

test('same match with both teams links (competition channel and club channel)', () => {
  const a = scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4 – Bundesliga 2026/27'), BL, ctx, idx);
  assert.equal(a.status, 'linked'); assert.ok(a.score >= THRESHOLD); assert.equal(a.score, 40 + 20 + 20 + 15 + 10);
  const b = scoreVideo(v('HIGHLIGHTS | FC Bayern vs. Union Berlin 7-0'), FCB, ctx, idx);
  assert.equal(b.status, 'linked');
});

test('conflicting opponent rejects; wrong competition rejects; stale / premature rejects', () => {
  assert.equal(scoreVideo(v('Bayern Munich vs. Borussia Dortmund | Highlights'), BL, ctx, idx).status, 'rejected');
  const conflict = scoreVideo(v('Bayern Munich - Union Berlin and Dortmund - Stuttgart | Highlights'), BL, ctx, idx);
  assert.equal(conflict.status, 'rejected'); assert.ok(conflict.reasons.some(r => /conflicting/.test(r.why)));
  assert.equal(scoreVideo(v('Bayern Munich vs. Union Berlin | DFB Pokal Highlights'), BL, ctx, idx).status, 'rejected', 'a cup tie between the same clubs is another game');
  assert.equal(scoreVideo(v('Bayern Munich vs. Union Berlin | Highlights', '2026-03-02T20:00:00Z'), BL, ctx, idx).status, 'rejected', 'last season’s meeting');
  assert.equal(scoreVideo(v('Bayern Munich vs. Union Berlin | Preview', '2026-09-17T10:00:00Z'), BL, ctx, idx).status, 'rejected', 'published before kickoff');
});

test('weak relevance stays unlinked: one club, or both clubs without competition/date context', () => {
  const one = scoreVideo(v('Bayern Munich training | Highlights'), BL, ctx, idx);
  assert.equal(one.status, 'rejected'); assert.ok(one.score < THRESHOLD);
  const noContext = scoreVideo(v('Bayern Munich vs. Union Berlin', '2026-10-30T20:00:00Z'), { ...BL, competition_id: 'c-other' }, ctx, idx);
  assert.equal(noContext.status, 'rejected');
});

test('player form needs the player; table stories never take a match video', () => {
  const pctx = { ...ctx, player: { id: 'p', name: 'Michael Olise' } };
  const clip = scoreVideo(v('Michael Olise scores a hat-trick | All goals vs. Union Berlin'), FCB, pctx, idx);
  assert.equal(clip.status, 'linked', JSON.stringify(clip));
  assert.equal(scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights'), BL, { competition_slug: 'bundesliga', competition_id: 'c-bl', match: null, player: null }, idx).status, 'rejected');
  assert.equal(articleContext({}, { event: { kind: 'competition_intelligence' }, competition: { slug: 'bundesliga' } }).match, null);
});

test('video types from titles', () => {
  assert.equal(classifyVideo('Bayern - Union 7-0 | Highlights'), 'highlights');
  assert.equal(classifyVideo('Every goal from Matchday 4'), 'goals');
  assert.equal(classifyVideo('Kompany press conference before Union'), 'press_conference');
  assert.equal(classifyVideo('Kane: "We were ready" | Interview'), 'interview');
});

test('regression: a club name inside another club name is not a second club (longest match wins)', () => {
  const ix = buildAliasIndex([...T, { id: 'hou', name: 'Houston Dynamo FC', short_name: 'Houston' }, { id: 'skc', name: 'Sporting Kansas City', short_name: 'Kansas City' }, { id: 'scp', name: 'Sporting CP', short_name: 'Sporting' }]);
  assert.deepEqual(teamsInTitle('Houston Dynamo vs. Sporting Kansas City | Full Match Highlights | Upset Drama!', ix).sort(), ['hou', 'skc']);
  assert.deepEqual(teamsInTitle('Sporting vs. Porto | Highlights', ix), ['scp']);
  const MLS = { channel_id: 'UCSZbXT5TLLW_i-5W8FZpFsg', verified: true, enabled: true, competition_id: 'c-mls', team_id: null };
  const c = { competition_slug: 'mls', competition_id: 'c-mls', match: { id: 'm', home_id: 'hou', away_id: 'skc', kickoff: '2026-09-27T00:30:00Z', score: { home: 0, away: 2 } }, player: null };
  assert.equal(scoreVideo({ title: 'Houston Dynamo vs. Sporting Kansas City | Full Match Highlights | Upset Drama!', published_at: '2026-09-27T03:00:12Z', video_type: 'highlights' }, MLS, c, ix).status, 'linked');
});

test('WRONG OPPONENT: Team A v Team B article never takes Team A v Team C, whatever else matches', () => {
  const stuffed = v('Bayern Munich vs. Borussia Dortmund 7-0 | Highlights | Matchday 4 – Bundesliga | Union Berlin fans watch');
  const r = scoreVideo(stuffed, BL, ctx, idx);
  assert.equal(r.status, 'rejected', JSON.stringify(r)); assert.ok(r.reasons.some(x => /conflicting opponent/.test(x.why)));
  assert.equal(scoreVideo(v('Bayern Munich vs. Borussia Dortmund | Highlights'), BL, ctx, idx).status, 'rejected');
});

test('player form requires the player named: the right match without the player stays unlinked', () => {
  const pctx = { ...ctx, player: { id: 'p', name: 'Jamal Musiala' } };
  const r = scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4'), BL, pctx, idx);
  assert.equal(r.status, 'rejected'); assert.ok(r.score >= THRESHOLD, 'score alone would pass'); assert.ok(r.reasons.some(x => /not named \(required\)/.test(x.why)));
});
