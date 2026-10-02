// HISTORICAL BACKFILL NEVER FEEDS THE NEWSROOM. Rows ingested today for seasons long finished (written
// minutes ago: fresh updated_at, finished status, real scores) must not create a single story, while the
// same newsroom still writes about a match that really finished inside its window (control).
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { runNews } from '../workers/soccer-news/src/pipeline.js';

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-02T12:00:00Z');

async function seed(store, { currentKickoffs }) {
  await store.insert('soccer_competitions', [{ id: U(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }]);
  await store.insert('soccer_teams', [10, 11, 12, 13].map(n => ({ id: U(n), slug: `club-${n}`, name: `Club ${n}`, short_name: `C${n}`, team_type: 'club', founding_provider: 'espn', founding_external_id: String(n) })));
  // two historical seasons backfilled today + the current season
  const seasons = [[20, '2001/02'], [21, '2012/13'], [22, '2026/27']];
  await store.insert('soccer_seasons', seasons.map(([n, label]) => ({ id: U(n), competition_id: U(1), label })));
  await store.insert('soccer_stages', seasons.map(([n]) => ({ id: U(n + 10), season_id: U(n), name: 'Regular Season', stage_type: 'league', stage_order: 1 })));
  const m = (id, season, day, h, a, hs, as) => ({ id: U(id), competition_id: U(1), season_id: U(season), stage_id: U(season + 10), kickoff_at: day, status: 'finished', home_team_id: U(h), away_team_id: U(a), home_score: hs, away_score: as, result_provider: 'espn' });
  const rows = [];
  let id = 100;
  for (const [season, year] of [[20, 2001], [21, 2012]]) for (const [h, a, hs, as] of [[10, 11, 5, 0], [12, 13, 4, 4], [11, 12, 0, 6], [13, 10, 3, 2]]) rows.push(m(id++, season, `${year}-09-${String(10 + (id % 9)).padStart(2, '0')}T15:00:00Z`, h, a, hs, as));
  currentKickoffs.forEach((k, i) => rows.push(m(200 + i, 22, k, [10, 12][i % 2], [11, 13][i % 2], 6, 0)));
  await store.insert('soccer_matches', rows);
}

test('historical rows written today create no newsroom story; a match inside the window still does', async () => {
  const store = await openPglite(); await applyMigrations(store);
  try {
    // Current season played long before the window (nothing new) + 8 historical matches ingested now.
    await seed(store, { currentKickoffs: ['2026-08-16T14:00:00Z'] });
    const hist = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' } });
    const pl = hist.competitions['premier-league'];
    assert.equal(pl.new || 0, 0, JSON.stringify(pl));
    assert.equal((await store.select('soccer_articles', { columns: ['id'] })).length, 0, 'no article for any historical match');
    assert.equal((await store.select('soccer_news_events', { columns: ['id'] })).length, 0, 'no news event detected');
    // Control: one current-season match that finished inside the 4-day window is still a story.
    await store.insert('soccer_matches', [{ id: U(300), competition_id: U(1), season_id: U(22), stage_id: U(32), kickoff_at: '2026-10-01T14:00:00Z', status: 'finished', home_team_id: U(12), away_team_id: U(13), home_score: 6, away_score: 0, result_provider: 'espn' }]);
    const live = await runNews(store, { now: NOW, competitions: ['premier-league'], env: { NEWS_DESK: 'off' } });
    const events = await store.select('soccer_news_events', { columns: ['match_id', 'as_of'] });
    assert.ok(events.length >= 1, JSON.stringify(live.competitions['premier-league']));
    assert.ok(events.every(e => Date.parse(e.as_of) >= Date.parse('2026-09-28T00:00:00Z')), 'every story is about the in-window match');
    assert.ok(events.filter(e => e.match_id).every(e => e.match_id === U(300)));
  } finally { await store.close(); }
});
