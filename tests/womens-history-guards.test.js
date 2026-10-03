// WOMEN'S FULL-HISTORY SPRINT GUARDS (2026-10-03).
// 1. Model impact: no live model reads a women's competition, so women's historical backfill cannot change any live
//    model input. A spec that adds one must fail here and become a new, separately validated model version.
// 2. Newsroom: women's historical rows written today never create a current-news story (same gate as the men's
//    history program); a match finished inside the newsroom window still does (control).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { runNews } from '../workers/soccer-news/src/pipeline.js';
import { v2Member } from '../workers/soccer-ingest/src/algo-v2-lane.js';

const registry = JSON.parse(readFileSync('data/registry/competitions.json', 'utf8'));
const genderOf = slug => registry.competitions.find(c => c.slug === slug)?.gender;
const json = p => JSON.parse(readFileSync(p, 'utf8'));
const WOMEN = registry.competitions.filter(c => c.gender === 'women').map(c => c.slug).concat(['fifa-womens-world-cup', 'frauen-bundesliga', 'serie-a-women']);

test('model impact: every live model reads only men\'s competitions (V1, shadow, V2.1); none reads a women\'s slug', () => {
  const specs = {
    'algo-v1': json('workers/soccer-ingest/src/algo-v1.json'),
    'algo-v2': json('workers/soccer-ingest/src/algo-v2.json'),
    'shadow': json('workers/soccer-ingest/src/shadow-model.json'),
  };
  const inputs = {
    'algo-v1': [specs['algo-v1'].competition_scope.competition_slug],
    'algo-v2': [...specs['algo-v2'].input_competitions, specs['algo-v2'].competition_scope.competition_slug],
    'shadow': [specs.shadow.scope.competition_slug],
  };
  assert.deepEqual(inputs['algo-v2'].sort(), ['fifa-world-cup', 'uefa-nations-league', 'uefa-nations-league']);
  for (const [model, slugs] of Object.entries(inputs)) for (const s of slugs) {
    assert.ok(!WOMEN.includes(s), `${model} reads women's competition ${s}`);
    assert.equal(genderOf(s), 'men', `${model}: ${s} must be a registered men's competition`);
  }
});

test('model impact: V2.1 frozen membership excludes any match backfilled today with an old kickoff', () => {
  const frozen = { ids: new Set(['frozen-1']), at: Date.parse('2026-10-02T21:51:00Z') };
  assert.equal(v2Member({ id: 'hist-2019', kickoff_at: '2019-07-07T15:00:00Z' }, frozen), false);
  assert.equal(v2Member({ id: 'frozen-1', kickoff_at: '2019-07-07T15:00:00Z' }, frozen), true);
});

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
const NOW = Date.parse('2026-10-03T20:00:00Z');

for (const [slug, labels] of [['nwsl', ['2016', '2021', '2026']], ['womens-super-league', ['2017/18', '2021/22', '2026/27']]]) {
  test(`newsroom: ${slug} history written today creates no story; a match inside the window still does`, async () => {
    const store = await openPglite(); await applyMigrations(store);
    try {
      await store.insert('soccer_competitions', [{ id: U(1), slug, name: slug, comp_type: 'league', gender: 'women' }]);
      await store.insert('soccer_teams', [10, 11, 12, 13].map(n => ({ id: U(n), slug: `w-${n}`, name: `Club ${n} Women`, short_name: `W${n}`, team_type: 'club', gender: 'women', founding_provider: 'espn', founding_external_id: String(n) })));
      const seasons = labels.map((label, i) => [20 + i, label]);
      await store.insert('soccer_seasons', seasons.map(([n, label]) => ({ id: U(n), competition_id: U(1), label, publication_state: 'published', published_at: '2026-01-01T00:00:00Z' })));
      await store.insert('soccer_stages', seasons.map(([n]) => ({ id: U(n + 10), season_id: U(n), name: 'Regular Season', stage_type: 'league', stage_order: 1 })));
      const m = (id, season, day, h, a, hs, as) => ({ id: U(id), competition_id: U(1), season_id: U(season), stage_id: U(season + 10), kickoff_at: day, status: 'finished', home_team_id: U(h), away_team_id: U(a), home_score: hs, away_score: as, result_provider: 'espn' });
      const rows = []; let id = 100;
      for (const [season, year] of [[20, 2016], [21, 2021]]) for (const [h, a, hs, as] of [[10, 11, 5, 0], [12, 13, 4, 4], [11, 12, 0, 6], [13, 10, 3, 2]]) rows.push(m(id++, season, `${year}-09-${String(10 + (id % 9)).padStart(2, '0')}T15:00:00Z`, h, a, hs, as));
      rows.push(m(200, 22, '2026-08-16T14:00:00Z', 10, 11, 6, 0)); // current season, long before the window
      await store.insert('soccer_matches', rows);
      const hist = await runNews(store, { now: NOW, competitions: [slug], env: { NEWS_DESK: 'off' } });
      assert.equal(hist.competitions[slug]?.new || 0, 0, JSON.stringify(hist.competitions[slug]));
      assert.equal((await store.select('soccer_news_events', { columns: ['id'] })).length, 0, 'no news event for any historical match');
      // control: a current-season match finished inside the window is still detected
      await store.insert('soccer_matches', [m(300, 22, '2026-10-02T14:00:00Z', 12, 13, 6, 0)]);
      await runNews(store, { now: NOW, competitions: [slug], env: { NEWS_DESK: 'off' } });
      const ev = await store.select('soccer_news_events', { columns: ['match_id'] });
      assert.ok(ev.length >= 1 && ev.every(e => e.match_id === U(300)), JSON.stringify(ev));
    } finally { await store.close(); }
  });
}
