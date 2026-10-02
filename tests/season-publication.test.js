// SEASON PUBLICATION GATE (migration 20261002001400). A 'held' season (historical backfill before Pass A
// acceptance) is invisible on every public read path; a 'published' one is unchanged. History lanes create
// seasons held, current lanes create them published, and an existing season is never flipped by a lane.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import * as R from '../workers/soccer-api/src/routes.js';
import { teamHistory } from '../workers/soccer-api/src/history.js';
import { loadSeason } from '../workers/soccer-news/src/engine.js';
import { ensureCompetitionSeason } from '../workers/soccer-ingest/src/espn-lane.js';

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
async function seed() {
  const s = await openPglite(); await applyMigrations(s);
  await s.insert('soccer_competitions', [{ id: U(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }]);
  await s.insert('soccer_teams', [10, 11].map(n => ({ id: U(n), slug: `club-${n}`, name: `Club ${n}`, team_type: 'club', founding_provider: 'espn', founding_external_id: String(n) })));
  await s.insert('soccer_seasons', [{ id: U(20), competition_id: U(1), label: '2026/27', publication_state: 'published', published_at: '2026-08-01T00:00:00Z' }]);
  await s.insert('soccer_seasons', [{ id: U(21), competition_id: U(1), label: '2001/02' }]); // no state given: the column default
  await s.insert('soccer_stages', [20, 21].map(n => ({ id: U(n + 10), season_id: U(n), name: 'Regular Season', stage_type: 'league', stage_order: 1 })));
  const m = (id, season, day, hs, as) => ({ id: U(id), competition_id: U(1), season_id: U(season), stage_id: U(season + 10), kickoff_at: day, status: 'finished', home_team_id: U(10), away_team_id: U(11), home_score: hs, away_score: as, result_provider: 'espn' });
  await s.insert('soccer_matches', [m(100, 20, '2026-09-20T15:00:00Z', 2, 1), m(101, 21, '2001-09-20T15:00:00Z', 7, 0)]);
  return s;
}

test('a season without an explicit state is held (fail closed); the existing-season migration published them', async () => {
  const s = await seed();
  try {
    assert.deepEqual((await s.select('soccer_seasons', { columns: ['label', 'publication_state'], order: 'label.asc' })).map(x => `${x.label}:${x.publication_state}`), ['2001/02:held', '2026/27:published']);
    await assert.rejects(s.query("update soccer_seasons set publication_state = 'published' where id = $1", [U(21)]), /published_at/, 'published needs published_at');
  } finally { await s.close(); }
});

test('held season is invisible on every public read path', async () => {
  const s = await seed();
  try {
    const comps = (await R.competitions(s)).data;
    const pl = (comps.competitions || comps).find(c => c.slug === 'premier-league');
    assert.equal(pl.seasons, 1); assert.equal(pl.matches, 1);
    const comp = (await R.competition(s, 'premier-league')).data;
    assert.deepEqual(comp.seasons.map(x => x.label), ['2026/27']);
    await assert.rejects(R.competition(s, 'premier-league', { season: '2001/02' }));
    const list = (await R.matches(s, { competition: 'premier-league' })).data;
    assert.deepEqual((list.matches || list).map(x => x.id), [U(100)]);
    await assert.rejects(R.match(s, U(101)), /not found|404/i);
    const hist = (await teamHistory(s, 'club-10')).data;
    assert.deepEqual(hist.seasons.map(x => x.season), ['2026/27']); assert.equal(hist.summary.goals_for, 2);
    const sm = JSON.stringify((await R.sitemap(s, 'matches')).data);
    assert.ok(sm.includes(U(100)) && !sm.includes(U(101)));
    const S = await loadSeason(s, 'premier-league');
    assert.equal(S.season.label, '2026/27'); assert.ok(S.matches.every(x => x.id !== U(101)));
    // promotion is explicit and makes it appear
    await s.query("update soccer_seasons set publication_state = 'published', published_at = now(), reviewed_at = now() where id = $1", [U(21)]);
    assert.deepEqual((await R.competition(s, 'premier-league')).data.seasons.map(x => x.label).sort(), ['2001/02', '2026/27']);
  } finally { await s.close(); }
});

test('history lanes create held seasons, current lanes published; existing seasons are never flipped', async () => {
  const s = await seed();
  try {
    const comp = { slug: 'premier-league', name: 'Premier League', comp_type: 'league', gender: 'men', country_code: 'GBR', tier: 1, season_format: 'split', espn: { league: 'eng.1' }, external_ids: [{ provider: 'espn', external_id: 'eng.1', method: 'founding', evidence: 't' }] };
    await s.query('delete from soccer_matches'); await s.query('delete from soccer_stages'); await s.query('delete from soccer_seasons'); await s.query('delete from soccer_competitions');
    await ensureCompetitionSeason(s, { comp, year: 2005, history: true });
    await ensureCompetitionSeason(s, { comp, year: 2027 });
    const st = Object.fromEntries((await s.select('soccer_seasons', { columns: ['label', 'publication_state'] })).map(x => [x.label, x.publication_state]));
    assert.deepEqual(st, { '2005/06': 'held', '2027/28': 'published' });
    await ensureCompetitionSeason(s, { comp, year: 2027, history: true }); // a history run over an existing season
    assert.equal((await s.select('soccer_seasons', { columns: ['publication_state'], eq: { label: '2027/28' } }))[0].publication_state, 'published');
  } finally { await s.close(); }
});
