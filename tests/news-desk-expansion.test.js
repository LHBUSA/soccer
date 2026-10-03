// Newsroom expansion: recap readiness (final evidence, not a blind delay), match previews, matchday
// briefs, verified group watch, the no-prediction gate, registry-driven enablement.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { recapReadiness } from '../workers/soccer-news/src/engine.js';
import { NEWS_COMPETITIONS, runNews } from '../workers/soccer-news/src/pipeline.js';
import { COMPETITION_PROFILES, PROFILES } from '../workers/soccer-news/src/profiles.js';
import { compose } from '../workers/soccer-news/src/compose2.js';
import { runGates2 } from '../workers/soccer-news/src/gates2.js';
import { validateEditorial } from '../workers/soccer-news/src/desk.js';
import { primaryFromPacket } from '../workers/shared/news-subject.js';

const NOW = Date.parse('2026-10-03T08:00:00Z');
const H = 3600e3;

test('recap readiness: final evidence publishes immediately, retrying evidence waits, no ledger falls back to 2 h', () => {
  const m = { kickoff_at: new Date(NOW - 110 * 60e3).toISOString() }; // FT about 15 minutes ago
  const done = ['lineup_home', 'lineup_away', 'stats_home', 'stats_away', 'plays'].map(component => ({ component, status: 'complete' }));
  assert.equal(recapReadiness(m, done, NOW), 'ready', 'complete ledger: no blind delay');
  assert.equal(recapReadiness(m, [...done.slice(0, 4), { component: 'plays', status: 'unavailable', next_retry_at: new Date(NOW + 5 * 60e3).toISOString() }], NOW), 'awaiting_enrichment');
  assert.equal(recapReadiness(m, [], NOW), 'too_soon', 'no ledger inside 2 h');
  assert.equal(recapReadiness({ kickoff_at: new Date(NOW - 3 * H).toISOString() }, [], NOW), 'ready');
  // retries still pending 7 h after kick-off: stop waiting (the gates decide on what exists)
  assert.equal(recapReadiness({ kickoff_at: new Date(NOW - 7 * H).toISOString() }, [{ status: 'unavailable', next_retry_at: new Date(NOW + H).toISOString() }], NOW), 'ready');
});

test('registry is the single source of news enablement; every enabled competition has a profile, every other a blocker', () => {
  const reg = JSON.parse(readFileSync(new URL('../data/registry/competitions.json', import.meta.url)));
  const on = reg.competitions.filter(c => c.news?.enabled).map(c => c.slug).sort();
  assert.deepEqual([...NEWS_COMPETITIONS].sort(), on);
  assert.deepEqual(on, ['bundesliga', 'mls', 'premier-league', 'uefa-champions-league', 'uefa-nations-league']);
  for (const s of on) assert.ok(COMPETITION_PROFILES[s], `${s} has a newsroom profile`);
  for (const c of reg.competitions.filter(x => !x.news?.enabled)) assert.ok(c.news?.blocker?.length > 20, `${c.slug} states its blocker`);
  assert.ok(!reg.competitions.find(c => c.slug === 'uefa-nations-league').news.stories.includes('team_trend'), 'no domestic-league runs for nations');
});

// ---- a small Premier League season in PGlite: 6 teams, 3 rounds played, a matchday tomorrow morning
const id = n => `00000000-0000-5000-8000-0000000e${String(n).padStart(4, '0')}`;
async function seed() {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(2), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: id(3), season_id: id(2), name: 'Regular season', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley'].map((n, i) => ({ id: id(10 + i), slug: n.toLowerCase(), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(300 + i) }));
  await store.insert('soccer_teams', teams);
  const mk = (n, h, a, hs, as, iso, status = 'finished') => ({ id: id(n), competition_id: id(1), season_id: id(2), stage_id: id(3), kickoff_at: iso, home_team_id: teams[h].id, away_team_id: teams[a].id, status, home_score: status === 'finished' ? hs : null, away_score: status === 'finished' ? as : null, result_provider: 'espn' });
  const played = [[0, 1, 2, 0], [2, 3, 1, 1], [4, 5, 0, 1], [0, 2, 3, 0], [1, 4, 2, 1], [3, 5, 0, 2], [5, 0, 0, 2], [3, 1, 1, 2], [4, 2, 1, 1]];
  await store.insert('soccer_matches', [
    ...played.map(([h, a, hs, as], i) => mk(20 + i, h, a, hs, as, new Date(Date.parse('2026-09-12T14:00:00Z') + Math.floor(i / 3) * 7 * 86400e3 + (i % 3) * H).toISOString())),
    mk(40, 0, 3, null, null, '2026-10-03T14:00:00Z', 'scheduled'), mk(41, 1, 5, null, null, '2026-10-03T16:30:00Z', 'scheduled'), mk(42, 2, 4, null, null, '2026-10-03T19:00:00Z', 'scheduled'),
    mk(43, 5, 3, null, null, '2026-10-05T14:00:00Z', 'scheduled'), // 54 h away: not yet
    mk(44, 4, 0, null, null, '2026-10-03T08:30:00Z', 'scheduled'), // 30 minutes away: too late for a preview
  ]);
  return { store, teams };
}

test('previews: meaningful fixtures 1-24 h out, one per fixture, one matchday brief, no prediction language, idempotent', async () => {
  const { store, teams } = await seed();
  const r1 = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' } });
  const pl = r1.competitions['premier-league'];
  assert.equal(pl.diagnostics.preview_window_fixtures, 3, 'kick-off 1-24 h out: the 54 h and the 30-minute fixtures are excluded');
  const stories = pl.stories.filter(s => s.story_class === 'match_preview');
  const arts = await store.select('soccer_articles', { columns: ['slug', 'headline', 'status', 'hold_reasons', 'body', 'news_event_id', 'entities'], eq: { story_class: 'match_preview' } });
  assert.equal(arts.length, stories.length);
  assert.ok(arts.every(a => a.status === 'published'), JSON.stringify(arts.map(a => [a.headline, a.hold_reasons])));
  const matchday = arts.filter(a => /matchday/i.test(a.headline));
  assert.equal(matchday.length, 1, 'one matchday brief for the 3-fixture day');
  const fixtures = arts.filter(a => !/matchday/i.test(a.headline));
  assert.ok(fixtures.length >= 1 && fixtures.length <= 3, `capped fixture previews: ${fixtures.length}`);
  assert.ok(!arts.some(a => a.headline.includes('Burnley v Fulham')), 'no preview beyond 24 h');
  assert.ok(!fixtures.some(a => /Brentford v Arsenal/.test(a.headline)), 'no preview inside the last hour');
  for (const a of arts) {
    const text = JSON.stringify(a.body.sections.filter(s => s.key !== 'method')); // the method disclosure names what is NOT reported
    assert.doesNotMatch(text, /\b(will win|favourite|predict|odds|likely to)\b/i, a.headline);
    assert.equal(a.entities.filter(e => e.primary).length <= 1, true);
  }
  // every stored preview carries frozen, code-built visuals (matchup dashboard / fixtures board)
  for (const a of arts) assert.ok(a.body.visuals?.some(v => ['matchup', 'fixtures_board'].includes(v.type)), a.headline);
  const R = await import('../workers/soccer-api/src/routes.js');
  const one = fixtures[0];
  const served = (await R.article(store, one.slug)).data.body.visuals;
  assert.deepEqual(served.map(v => v.values_hash), one.body.visuals.map(v => v.values_hash), 'served exactly as frozen');
  // a published chart can never silently change: a tampered stored value is withheld, not shown
  const tampered = structuredClone(one.body); tampered.visuals[0].data.rows[0].home = 99;
  await store.update('soccer_articles', { body: tampered }, { eq: { slug: one.slug } });
  const after = (await R.article(store, one.slug)).data.body;
  assert.equal(after.visuals.length, one.body.visuals.length - 1); assert.equal(after.visuals_withheld, 1);
  // linked to its fixture (news?match= works for a preview)
  const ev = await store.select('soccer_news_events', { columns: ['match_id', 'story_class'], eq: { story_class: 'match_preview' } });
  assert.ok(ev.some(e => [id(40), id(41), id(42)].includes(e.match_id)));
  // second run in the same window: nothing new, every candidate is a known story
  const r2 = await runNews(store, { now: NOW + 30 * 60e3, competitions: ['premier-league'], env: { NEWS_DESK: 'off' } });
  const p2 = r2.competitions['premier-league'];
  assert.equal(p2.new, 0); assert.equal(p2.duplicates, p2.candidates);
  assert.equal((await store.select('soccer_articles', { columns: ['slug'], eq: { story_class: 'match_preview' } })).length, arts.length, 'no duplicate previews');
  // every "duplicate" is accounted for by what its existing story IS (published / held / other)
  assert.equal(p2.existing.published + p2.existing.held + p2.existing.other, p2.duplicates);
  // a story that was HELD is reported as held material with its reasons, never as a plain duplicate
  await store.update('soccer_articles', { status: 'held', hold_reasons: ['editorial:new_number_not_in_packet'] }, { eq: { slug: one.slug } });
  const p3 = (await runNews(store, { now: NOW + 60 * 60e3, competitions: ['premier-league'], env: { NEWS_DESK: 'off' } })).competitions['premier-league'];
  assert.equal(p3.existing.held, p2.existing.held + 1); assert.ok(p3.existing.held_reasons['editorial:new_number_not_in_packet'] >= 1);
  assert.equal(p3.new, 0, 'a held story is never re-issued by the detector');
  void teams; await store.close();
});

// ---- packet-level checks for national teams and the prediction gate
const nlGroup = (pos, pts, zone = null) => ({ group: 'Group B2', group_type: 'group', tier: 'League B', position: pos, teams_in_group: 4, points: pts, played: 3, zone, verified: true });
const nlPreview = () => ({
  version: 'soccer-packet-preview/1.0.0', hash: 'a'.repeat(64), engine: 'soccer-news-engine/2.0.0',
  event: { kind: 'match_preview', key: 'match_preview:x', as_of: '2026-10-10T18:45:00.000Z', profile: 'nations_league' },
  competition: { id: 'c', name: 'UEFA Nations League', slug: 'uefa-nations-league', season: '2026/27', team_kind: 'national', format: 'National teams, not clubs.' }, materiality: { score: 1 },
  preview_kind: 'fixture',
  fixture: { id: 'f1', kickoff_utc: '2026-10-10T18:45:00.000Z', kickoff_date: '2026-10-10', kickoff_time_utc: '18:45', timezone: 'UTC', venue: 'Stadion Letná', league_stage: true, status: 'scheduled' },
  teams: {
    home: { id: 'cz', name: 'Czechia', slug: 'czechia', table_now: null, group: nlGroup(1, 7), recent_form: { results: [{ match_id: 'r1', date: '2026-09-28', opponent: { id: 'al', name: 'Albania', slug: 'albania' }, venue: 'home', goals_for: 2, goals_against: 0, score: '2-0', result: 'W' }], played: 1, won: 1, drawn: 0, lost: 0, goals_for: 2, goals_against: 0, goals: '2-0' }, league_run: null },
    away: { id: 'ua', name: 'Ukraine', slug: 'ukraine', table_now: null, group: nlGroup(2, 6), recent_form: { results: [{ match_id: 'r2', date: '2026-09-28', opponent: { id: 'ge', name: 'Georgia', slug: 'georgia' }, venue: 'away', goals_for: 1, goals_against: 1, score: '1-1', result: 'D' }], played: 1, won: 0, drawn: 1, lost: 0, goals_for: 1, goals_against: 1, goals: '1-1' }, league_run: null },
  },
  teams_in_table: null, players_in_form: [], meetings_this_season: [],
  angles: [{ key: 'group_top_meeting', weight: 1, detail: { group: 'Group B2' } }], subject: { id: 'cz', type: 'SportsTeam', reason: 'preview_home' },
  unavailable: ['lineups (not sourced before kick-off)'], provenance: { attributions: ['Structured facts: ESPN (secondary source).'] },
});

test('national-team preview: nations never clubs, verified group language, gates pass, subject set', () => {
  const p = nlPreview();
  const a = compose(p);
  const g = runGates2(a, p);
  assert.ok(g.pass, JSON.stringify(g.results.filter(r => !r.pass)));
  const text = JSON.stringify(a.sections);
  assert.doesNotMatch(text, /\bclubs?\b/i);
  assert.match(a.headline, /Czechia v Ukraine: the top two in Group B2 meet/);
  assert.match(text, /Czechia sit 1st of 4 in the Group B2 on 7 points from 3 matches/);
  assert.equal(a.desk, 'international');
  assert.equal(a.entities.find(e => e.primary)?.id, 'cz');
  assert.equal(primaryFromPacket(p).reason, 'preview_home');
  // an unverified group cannot carry group language
  const q = nlPreview(); q.teams.home.group = { ...q.teams.home.group, verified: false }; q.teams.away.group = { ...q.teams.away.group, verified: false };
  const g2 = runGates2({ ...compose(q), sections: [{ key: 's', heading: 'x', paragraphs: ['Czechia lead the group.'] }, ...compose(q).sections] }, q);
  assert.ok(g2.failed.includes('nl_group_position_claim'));
});

test('preview gate: predictions, favourites and team news are held (fact gates and desk validation)', () => {
  const p = nlPreview();
  for (const bad of ['Czechia will win this one.', 'Ukraine are favourites on the road.', 'Czechia are expected to take the points.', 'Team news: two doubts for Ukraine.', 'Ukraine have selection doubts.', 'Czechia will miss the match without their captain.']) {
    const a = compose(p); a.sections = [{ key: 's1', heading: 'The meeting', paragraphs: [bad] }, ...a.sections];
    const failed = runGates2(a, p).failed;
    assert.ok(failed.some(f => /^preview_/.test(f)), `${bad} -> ${failed}`);
    assert.ok(validateEditorial(a, p).some(r => !r.pass && /^preview_/.test(r.gate)), `desk: ${bad}`);
  }
  // ordinary English is not team news (production false positive 2026-09-29: "return from")
  for (const ok of ['Scotland return from a goalless opening round.', 'There is no doubt about the stakes in Group B2.']) {
    const a = compose(p); a.sections = [{ key: 's1', heading: 'The meeting', paragraphs: [ok] }, ...a.sections];
    assert.ok(!runGates2(a, p).failed.some(f => /^preview_/.test(f)), ok);
  }
  // recaps are untouched by the preview gate
  assert.ok(!PROFILES.domestic_european_league.banned.some(([n]) => /^preview_/.test(n)));
});

test('group watch (Nations League): verified groups only, group leaders, no club language, no single face', () => {
  const row = (pos, name, pts, zone = null) => ({ position: pos, team: { id: name.toLowerCase(), name, slug: name.toLowerCase() }, played: 3, won: 2, drawn: 1, lost: 0, points: pts, goal_difference: 3, zone });
  const grp = (name, tier, rows) => ({ name, group_type: 'group', tier, verified: true, teams: rows.length, rows, leader: rows[0], gap_top_two: rows[0].points - rows[1].points });
  const p = { version: 'soccer-packet/2.0.0', hash: 'b'.repeat(64), engine: 'x', event: { kind: 'competition_intelligence', key: 'group_watch:c:2026-W40', as_of: '2026-09-29T18:45:00.000Z', profile: 'nations_league' },
    competition: { id: 'c', name: 'UEFA Nations League', slug: 'uefa-nations-league', season: '2026/27', team_kind: 'national' }, materiality: { score: 1 }, brief: 'group_watch',
    groups: [grp('Group A1', 'League A', [row(1, 'France', 7, 'Qualifies for QFs'), row(2, 'Italy', 7)]), grp('Group C1', 'League C', [row(1, 'Finland', 9), row(2, 'Estonia', 4)])],
    round: { results_counted: 2, results: [{ match_id: 'm1', date: '2026-09-28', home: row(1, 'France', 0).team, away: row(1, 'Italy', 0).team, score: '1-1' }, { match_id: 'm2', date: '2026-09-26', home: row(1, 'San Marino', 0).team, away: row(1, 'Finland', 0).team, score: '0-7' }] },
    unavailable: ['x'], provenance: { attributions: ['Structured facts: ESPN (secondary source).'] } };
  const a = compose(p);
  const g = runGates2(a, p);
  assert.ok(g.pass, JSON.stringify(g.results.filter(r => !r.pass)));
  assert.match(a.headline, /UEFA Nations League: the group leaders after 2 results this week/);
  assert.match(JSON.stringify(a.sections), /Group A1 \(League A\): France and Italy level on 7 points/);
  assert.doesNotMatch(JSON.stringify(a.sections), /\bclubs?\b/i);
  assert.equal(primaryFromPacket(p), null, 'many groups: the competition graphic, not one nation');
  assert.equal(a.desk, 'international');
});

test('desk judge: a well-written preview passes the grounded validation and quality gates', async () => {
  const { judge, deskArticle } = await import('../workers/soccer-news/src/desk.js');
  const p = nlPreview();
  const draft = compose(p);
  const edited = {
    headline: 'Czechia and Ukraine meet with first place in Group B2 on the line',
    dek: 'Only a point separates the top two in League B before the meeting at Stadion Letná, with Czechia on seven and Ukraine on six.',
    sections: [
      { key: 's1', heading: 'A meeting of the top two in Group B2', paragraphs: [
        'Czechia go into the evening at Stadion Letná as the leaders of Group B2, a single point ahead of Ukraine after three matches each. The kick-off on 10 October is at 18:45 UTC, and it is the only fixture in the group that pairs its top two sides.',
        'The published standings put Czechia on seven points and Ukraine on six, so the order at the top of the group is set by this meeting rather than by anything happening elsewhere.'] },
      { key: 's2', heading: 'How both sides arrive', paragraphs: [
        'Czechia come in off a 2-0 win at home to Albania on 28 September, their most recent outing in the competition, and that result is what lifted them above Ukraine.',
        'Ukraine were held 1-1 away to Georgia on the same day. That draw is the reason they trail by a point rather than sharing first place, and it means they travel as the side in second place.'] },
      { key: 's3', heading: 'What the evening decides in League B', paragraphs: [
        'Group B2 has four teams, and both nations have played three times. A win for either side would leave it alone in first place, while a draw would keep the single-point gap exactly as it is now.',
        'Lineups and squad information are not part of what is known before kick-off, so this preview stays with the positions, the points and the most recent results of both teams.'] },
    ],
  };
  const art = deskArticle(edited, draft);
  const j = judge(art, p);
  assert.ok(j.pass, JSON.stringify(j.results.filter(r => !r.pass)));
});

test('newsroom health: one diagnostic with cron/desk/switch state and per-competition run detail', async () => {
  const R = await import('../workers/soccer-api/src/routes.js');
  const { store } = await seed();
  const summary = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off', NEWS_ENABLED: 'on' } });
  const h = await R.newsroomHealth(store, summary, { at: summary.at, news_enabled: true, outcome: 'ran' }, NOW + 10 * 60e3);
  assert.equal(h.cron.fresh, true); assert.equal(h.cron.last_tick_outcome, 'ran'); assert.equal(h.news_enabled, true);
  assert.equal(h.editorial_desk.required, false);
  assert.ok(h.published_24h >= 1 && h.published_72h >= h.published_24h);
  const pl = h.competitions.find(c => c.competition === 'premier-league');
  assert.equal(pl.season, '2026/27');
  assert.ok(pl.last_run.detection.preview_window_fixtures === 3 && pl.last_run.by_class.match_preview >= 1);
  assert.ok(pl.newest_story.age_hours <= 0.2); assert.equal(pl.fixtures_next_24h, 4);
  const stale = await R.newsroomHealth(store, summary, { at: new Date(NOW + 3 * 3600e3).toISOString(), news_enabled: false, outcome: 'disabled' }, NOW + 3 * 3600e3);
  assert.equal(stale.cron.fresh, false); assert.equal(stale.news_enabled, false); assert.equal(stale.cron.last_tick_outcome, 'disabled');
  await store.close();
});
