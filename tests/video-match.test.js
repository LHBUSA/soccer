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

test('player form: the right match without the player named stays unlinked unless the player scored in it', () => {
  const noGoal = { ...ctx, player: { id: 'p', name: 'Jamal Musiala', goals_in_match: 0 } };
  const r = scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4'), BL, noGoal, idx);
  assert.equal(r.status, 'rejected'); assert.ok(r.score >= THRESHOLD, 'score alone would pass'); assert.ok(r.reasons.some(x => /not named and did not score in that match \(required\)/.test(x.why)));
  assert.equal(scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4'), BL, { ...ctx, player: { id: 'p', name: 'Jamal Musiala' } }, idx).status, 'rejected', 'unknown goals = did not score');
  // scored in that exact match: its official highlights show the goal the story is about
  const scored = { ...ctx, player: { id: 'p', name: 'Jamal Musiala', goals_in_match: 2 } };
  const ok = scoreVideo(v('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4'), BL, scored, idx);
  assert.equal(ok.status, 'linked', JSON.stringify(ok)); assert.ok(ok.reasons.some(x => /highlights of the match in which Jamal Musiala scored \(2 goals/.test(x.why)));
  // ...but only highlight-type video: an interview or press conference about the match does not attach unnamed
  assert.equal(scoreVideo(v('Bayern Munich - Union Berlin | Kompany press conference'), BL, scored, idx).status, 'rejected');
  // a different match stays rejected whoever scored
  assert.equal(scoreVideo(v('Bayern Munich vs. Borussia Dortmund | Highlights'), BL, scored, idx).status, 'rejected');
});

test('live shows are never highlights ("Matchday Live | FIVE GOALS ...")', () => {
  assert.equal(classifyVideo('Matchday Live | FIVE GOALS, FIVE LEAGUE WINS, CITY ARE TOP! Man City 5-3 Sunderland'), 'other');
  assert.equal(classifyVideo('LIVE STREAM | Bayern Munich v Union Berlin'), 'other');
  assert.equal(classifyVideo('Bayern Munich - Union Berlin 7-0 | Highlights | Matchday 4'), 'highlights');
});

test('match preview: pre-match preview / press conference within 7 days before kickoff; never highlights or post-match video', () => {
  const pre = { ...ctx, preview: true, match: { ...ctx.match, score: null } };
  const at = (title, when) => ({ title, published_at: when, video_type: classifyVideo(title) });
  const conf = scoreVideo(at('Bayern Munich v Union Berlin | Press conference with Vincent Kompany', '2026-09-17T11:00:00Z'), BL, pre, idx);
  assert.equal(conf.status, 'linked', JSON.stringify(conf)); assert.ok(conf.reasons.some(x => /within 7 days before kickoff/.test(x.why)));
  assert.equal(scoreVideo(at('Bayern Munich v Union Berlin | Matchday 4 Preview', '2026-09-16T09:00:00Z'), BL, pre, idx).status, 'linked');
  // highlights never attach to a preview, even of the same fixture and in the window
  const hl = scoreVideo(at('Bayern Munich - Union Berlin 7-0 | Highlights', '2026-09-17T11:00:00Z'), BL, pre, idx);
  assert.equal(hl.status, 'rejected'); assert.ok(hl.reasons.some(x => /cannot attach to a preview/.test(x.why)));
  // post-kickoff and stale pre-match videos are rejected
  assert.equal(scoreVideo(at('Bayern Munich v Union Berlin | Press conference', '2026-09-18T21:00:00Z'), BL, pre, idx).status, 'rejected');
  assert.equal(scoreVideo(at('Bayern Munich v Union Berlin | Press conference', '2026-09-05T11:00:00Z'), BL, pre, idx).status, 'rejected');
  // a preview of a different fixture is rejected
  assert.equal(scoreVideo(at('Bayern Munich v Borussia Dortmund | Press conference', '2026-09-17T11:00:00Z'), BL, pre, idx).status, 'rejected');
});

test('articleContext: preview packet -> fixture context; player form carries the canonical goals of the latest appearance', () => {
  const preview = articleContext({}, { event: { kind: 'match_preview' }, competition: { slug: 'uefa-nations-league', id: 'c-unl' }, fixture: { id: 'f1', kickoff_utc: '2026-09-29T18:45:00Z' }, teams: { home: { id: 'esp' }, away: { id: 'cro' } } });
  assert.deepEqual([preview.preview, preview.match.id, preview.match.home_id, preview.match.away_id, preview.match.kickoff, preview.match.score], [true, 'f1', 'esp', 'cro', '2026-09-29T18:45:00Z', null]);
  const form = articleContext({}, { event: { kind: 'player_form' }, competition: {}, player: { id: 'p', name: 'A' }, form: { appearances: [{ match_id: 'm0', team: { id: 't' }, opponent: { id: 'o' }, date: '2026-09-20', score: '1-0', goals: 0 }, { match_id: 'm1', team: { id: 't' }, opponent: { id: 'o' }, date: '2026-09-27', score: '2-0', goals: 1 }] } });
  assert.equal(form.match.id, 'm1'); assert.equal(form.player.goals_in_match, 1);
});

test('governing body scope (UEFA): serves Champions League AND Nations League, never the wrong one', () => {
  const N = buildAliasIndex([{ id: 'fra', name: 'France', short_name: 'France' }, { id: 'ita', name: 'Italy', short_name: 'Italy' }, { id: 'rma', name: 'Real Madrid', short_name: 'Real Madrid' }, { id: 'bay', name: 'Bayern München', short_name: 'Bayern' }]);
  const UEFA = { channel_id: 'UCyGa1YEx9ST66rYrJTGIKOw', verified: true, enabled: true, competition_id: 'c-ucl', scope_competition_ids: ['c-ucl', 'c-unl'], team_id: null, publisher_type: 'governing_body' };
  const unl = { competition_slug: 'uefa-nations-league', competition_id: 'c-unl', match: { id: 'n1', home_id: 'fra', away_id: 'ita', kickoff: '2026-10-10T18:45:00Z', score: { home: 2, away: 1 } }, player: null };
  const ucl = { competition_slug: 'uefa-champions-league', competition_id: 'c-ucl', match: { id: 'u1', home_id: 'rma', away_id: 'bay', kickoff: '2026-10-21T19:00:00Z', score: { home: 2, away: 1 } }, player: null };
  const at = (title, when) => ({ title, published_at: when, video_type: classifyVideo(title) });
  // validated Nations League match video
  const ok = scoreVideo(at('France 2-1 Italy | Highlights | UEFA Nations League 2026/27', '2026-10-10T22:30:00Z'), UEFA, unl, N);
  assert.equal(ok.status, 'linked'); assert.ok(ok.reasons.some(r => /governing body channel; title names this competition/.test(r.why)));
  // Champions League highlights never appear on a Nations League article because the publisher is UEFA
  const wrong = scoreVideo(at('Real Madrid 2-1 Bayern | Highlights | UEFA Champions League', '2026-10-10T22:30:00Z'), UEFA, unl, N);
  assert.equal(wrong.status, 'rejected');
  // same nations, wrong UEFA competition named -> reject; a qualifier / friendly between them -> reject
  assert.equal(scoreVideo(at('France 2-1 Italy | Highlights | Champions League', '2026-10-10T22:30:00Z'), UEFA, unl, N).status, 'rejected');
  assert.equal(scoreVideo(at('France 2-1 Italy | World Cup Qualifier Highlights', '2026-10-10T22:30:00Z'), UEFA, unl, N).status, 'rejected');
  assert.equal(scoreVideo(at('France v Italy friendly highlights', '2026-10-10T22:30:00Z'), UEFA, unl, N).status, 'rejected');
  // a multi-competition publisher earns no competition credit when the title names no competition;
  // the exact match can still be identified by both nations + final score + publish time (40+20+15+10)
  const bare = scoreVideo(at('France 2-1 Italy | Highlights', '2026-10-10T22:30:00Z'), UEFA, unl, N);
  assert.ok(bare.reasons.some(r => /serves several competitions/.test(r.why))); assert.equal(bare.score, 85);
  // ...but without the score it is weak and stays unlinked
  assert.equal(scoreVideo(at('France v Italy | Highlights', '2026-10-10T22:30:00Z'), UEFA, unl, N).status, 'rejected');
  // and a Nations League video never lands on a Champions League article
  assert.equal(scoreVideo(at('Real Madrid v Bayern | Nations League?', '2026-10-21T22:30:00Z'), UEFA, ucl, N).status, 'rejected');
  assert.equal(scoreVideo(at('Real Madrid 2-1 Bayern | Highlights | UEFA Champions League', '2026-10-21T22:30:00Z'), UEFA, ucl, N).status, 'linked');
  // a single-competition channel keeps its credit without naming itself (unchanged behaviour)
  assert.equal(scoreVideo(at('France 2-1 Italy | Highlights', '2026-10-10T22:30:00Z'), { ...UEFA, scope_competition_ids: ['c-unl'] }, unl, N).status, 'linked');
});
