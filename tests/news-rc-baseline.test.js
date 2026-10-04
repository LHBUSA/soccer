// soccer-news baseline release candidate (2026-10-04): explicit league-phase config (fail closed), conservative
// domestic-league claim bans, the article-market freeze behind NEWS_MARKET_FREEZE, the owner blind-review mode (desk
// runs, nothing written, dedupe ignored), and the enablement freeze (exactly the five live competitions).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { NEWS_COMPETITIONS, runNews } from '../workers/soccer-news/src/pipeline.js';
import { PROFILES, LEAGUE_PHASE_CONFIG, leaguePhaseCfg, missingPhaseConfig, profileFor } from '../workers/soccer-news/src/profiles.js';

const NOW = Date.parse('2026-10-03T08:00:00Z');
const H = 3600e3;
const toml = readFileSync(new URL('../workers/soccer-news/wrangler.toml', import.meta.url), 'utf8');

test('enablement freeze: exactly the five live competitions publish; the nine new lanes and FIFA stay off', () => {
  assert.deepEqual([...NEWS_COMPETITIONS].sort(), ['bundesliga', 'mls', 'premier-league', 'uefa-champions-league', 'uefa-nations-league']);
  const reg = JSON.parse(readFileSync(new URL('../data/registry/competitions.json', import.meta.url)));
  for (const s of ['la-liga', 'serie-a', 'ligue-1', 'uefa-europa-league', 'nwsl', 'womens-super-league', 'uefa-womens-champions-league', 'liga-f', 'premiere-ligue', 'fifa-world-cup']) {
    assert.equal(reg.competitions.find(c => c.slug === s).news.enabled, false, `${s} stays off`);
  }
});

test('league-phase boundaries are explicit Worker vars; a missing var skips the competition (no hidden default)', async () => {
  for (const [slug, x] of Object.entries(LEAGUE_PHASE_CONFIG)) {
    const m = toml.match(new RegExp(`^${x.env} = "([^"]+)"`, 'm'));
    assert.ok(m && Number.isFinite(Date.parse(m[1])), `${x.env} set in wrangler.toml for ${slug}`);
  }
  const vars = Object.fromEntries([...toml.matchAll(/^([A-Z_]+) = "([^"]*)"/gm)].map(m => [m[1], m[2]]));
  const cfg = leaguePhaseCfg(vars);
  assert.deepEqual(Object.keys(cfg).sort(), ['ucl_league_phase_end', 'uel_league_phase_end', 'uwcl_league_phase_end']);
  for (const slug of Object.keys(LEAGUE_PHASE_CONFIG)) assert.equal(missingPhaseConfig(slug, cfg), null);
  assert.equal(missingPhaseConfig('uefa-champions-league', {}), 'UCL_LEAGUE_PHASE_END');
  assert.equal(missingPhaseConfig('uefa-champions-league', { ucl_league_phase_end: 'not a date' }), 'UCL_LEAGUE_PHASE_END');
  assert.equal(missingPhaseConfig('premier-league', {}), null, 'no boundary needed for a domestic league');
  // Rules unchanged by this release: same profile selection on both sides of each boundary.
  assert.equal(profileFor('uefa-champions-league', '2026-10-21T19:00:00Z', cfg).key, 'ucl_league_phase');
  assert.equal(profileFor('uefa-champions-league', '2027-02-17T20:00:00Z', cfg).key, 'knockout');
  assert.equal(profileFor('uefa-europa-league', '2027-01-28T20:00:00Z', cfg).key, 'ucl_league_phase');
  assert.equal(profileFor('uefa-womens-champions-league', '2026-12-17T20:00:00Z', cfg).key, 'ucl_league_phase');
  assert.equal(profileFor('uefa-womens-champions-league', '2027-03-17T20:00:00Z', cfg).key, 'knockout');
  // The runner skips UCL with no config without reading the database (store would throw).
  const throwing = { select: () => { throw new Error('must not read'); } };
  const r = await runNews(throwing, { now: NOW, competitions: ['uefa-champions-league'], env: { NEWS_DESK: 'off' }, cfg: {}, marketFreeze: false });
  assert.equal(r.competitions['uefa-champions-league'].skipped, 'config_missing:UCL_LEAGUE_PHASE_END');
});

test('UCL table-language restrictions are unchanged in this release', () => {
  const hit = (p, s) => PROFILES[p].banned.some(([, re]) => re.test(s));
  assert.equal(PROFILES.ucl_league_phase.table, false);
  for (const s of ['top of the table', 'moved into the top four', 'qualify for the round of 16', 'the league-phase table']) assert.ok(hit('ucl_league_phase', s), s);
});

test('domestic claims: top four stays a table position, European places and Bundesliga relegation claims hold', () => {
  const hit = (p, s) => PROFILES[p].banned.some(([, re]) => re.test(s));
  for (const p of ['domestic_european_league', 'domestic_league_relegation_playoff']) {
    for (const s of ['into the Champions League places', 'a European place', 'qualify for Europe', 'Europa League spots']) assert.ok(hit(p, s), `${p}: ${s}`);
    for (const s of ['moved into the top four', 'out of the bottom three', 'top of the table', 'the title race']) assert.ok(!hit(p, s), `${p} allows: ${s}`);
  }
  assert.ok(!hit('domestic_european_league', 'relegation zone'), 'Premier League: the bottom three go down (stored rule unchanged)');
  for (const s of ['into the relegation zone', 'were relegated', 'the drop zone', 'could go down']) assert.ok(hit('domestic_league_relegation_playoff', s), `Bundesliga: ${s}`);
  assert.equal(profileFor('bundesliga', '2026-10-04T13:30:00Z').key, 'domestic_league_relegation_playoff');
  assert.equal(profileFor('premier-league', '2026-10-04T13:30:00Z').key, 'domestic_european_league');
  // Same table angles and zones as before: only language is restricted.
  assert.deepEqual(PROFILES.domestic_league_relegation_playoff.angles, PROFILES.domestic_european_league.angles);
  assert.deepEqual(PROFILES.domestic_league_relegation_playoff.zones, PROFILES.domestic_european_league.zones);
});

test('article-market freeze is off unless NEWS_MARKET_FREEZE=on (separate owner decision)', () => {
  assert.match(toml, /^NEWS_MARKET_FREEZE = "off"$/m);
  const index = readFileSync(new URL('../workers/soccer-news/src/index.js', import.meta.url), 'utf8');
  assert.match(index, /marketFreeze: env\.NEWS_MARKET_FREEZE === 'on'/);
});

// ---- blind-review mode on a small Premier League season (same shape as news-desk-expansion)
const id = n => `00000000-0000-5000-8000-0000000f${String(n).padStart(4, '0')}`;
async function seed() {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'premier-league', name: 'Premier League', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(2), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: id(3), season_id: id(2), name: 'Regular season', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Arsenal', 'Chelsea', 'Everton', 'Fulham', 'Brentford', 'Burnley'].map((n, i) => ({ id: id(10 + i), slug: n.toLowerCase(), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(400 + i) }));
  await store.insert('soccer_teams', teams);
  const mk = (n, h, a, hs, as, iso, status = 'finished') => ({ id: id(n), competition_id: id(1), season_id: id(2), stage_id: id(3), kickoff_at: iso, home_team_id: teams[h].id, away_team_id: teams[a].id, status, home_score: status === 'finished' ? hs : null, away_score: status === 'finished' ? as : null, result_provider: 'espn' });
  const played = [[0, 1, 2, 0], [2, 3, 1, 1], [4, 5, 0, 1], [0, 2, 3, 0], [1, 4, 2, 1], [3, 5, 0, 2], [5, 0, 0, 2], [3, 1, 1, 2], [4, 2, 1, 1]];
  await store.insert('soccer_matches', [
    ...played.map(([h, a, hs, as], i) => mk(20 + i, h, a, hs, as, new Date(Date.parse('2026-09-12T14:00:00Z') + Math.floor(i / 3) * 7 * 86400e3 + (i % 3) * H).toISOString())),
    mk(40, 0, 3, null, null, '2026-10-03T14:00:00Z', 'scheduled'), mk(41, 1, 5, null, null, '2026-10-03T16:30:00Z', 'scheduled'), mk(42, 2, 4, null, null, '2026-10-03T19:00:00Z', 'scheduled'),
  ]);
  return { store };
}
const COUNT_COLS = { soccer_news_events: 'id', soccer_articles: 'id', soccer_article_evidence: 'packet_hash' };
const counts = async store => Object.fromEntries(await Promise.all(Object.entries(COUNT_COLS).map(async ([t, c]) => [t, (await store.select(t, { columns: [c] })).length])));

test('review mode: the story is written by the desk path but NOTHING is stored, and an existing story does not hide it', async () => {
  const { store } = await seed();
  const env = { NEWS_DESK: 'off' };
  await assert.rejects(runNews(store, { now: NOW, competitions: ['premier-league'], env, review: true }), /review needs previewMatch/);
  const before = await counts(store);
  const r1 = await runNews(store, { now: NOW, competitions: ['premier-league'], env, previewMatch: id(40), review: true, marketFreeze: false });
  const s1 = r1.competitions['premier-league'].stories;
  assert.equal(s1.length, 1); assert.equal(s1[0].story_class, 'match_preview');
  assert.ok(s1[0].review?.sections?.length && /^[0-9a-f]{64}$/.test(s1[0].review.packet_hash), 'review carries the full story + packet hash');
  assert.deepEqual(await counts(store), before, 'review wrote nothing');
  // a real (forced) run stores the preview; a later review of the same fixture still returns the candidate
  await runNews(store, { now: NOW, competitions: ['premier-league'], env, previewMatch: id(40), marketFreeze: false });
  const stored = await counts(store);
  assert.equal(stored.soccer_articles, before.soccer_articles + 1);
  const r2 = await runNews(store, { now: NOW, competitions: ['premier-league'], env, previewMatch: id(40), review: true, marketFreeze: false });
  assert.equal(r2.competitions['premier-league'].stories.length, 1, 'dedupe ignored in review');
  assert.equal(r2.competitions['premier-league'].stories[0].review.packet_hash, s1[0].review.packet_hash, 'same as-of packet, same hash');
  assert.deepEqual(await counts(store), stored, 'still nothing written');
  // a normal run treats it as a duplicate (story keys unchanged)
  const r3 = await runNews(store, { now: NOW, competitions: ['premier-league'], env, previewMatch: id(40), marketFreeze: false });
  assert.equal(r3.competitions['premier-league'].new, 0);
  assert.equal(r3.competitions['premier-league'].duplicates, 1);
});
