// News engine v2: competition profiles, still-true rule, gates, optional LLM pass, idempotent pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { emptyLaneState } from '../workers/soccer-ingest/src/state.js';
import { runOpenLigaCurrent } from '../workers/soccer-ingest/src/openligadb-current.js';
import { assess } from '../workers/soccer-news/src/engine.js';
import { profileFor, PROFILES } from '../workers/soccer-news/src/profiles.js';
import { compose } from '../workers/soccer-news/src/compose2.js';
import { runGates2 } from '../workers/soccer-news/src/gates2.js';
import { editorialPass } from '../workers/soccer-news/src/editorial.js';
import { runNews } from '../workers/soccer-news/src/pipeline.js';

const REG = { competitions: [{ slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1, external_ids: [{ provider: 'wyscout', external_id: '426', method: 'founding', evidence: 't' }, { provider: 'openligadb', external_id: 'bl1', method: 'reviewed', evidence: 't' }] }] };
const olm = (id, g, t1, t2, date, s1, s2) => ({ matchID: id, matchDateTimeUTC: `${date}Z`, leagueId: 1, leagueSeason: 2026, leagueShortcut: 'bl1', group: { groupOrderID: g },
  team1: { teamId: t1, teamName: `Club ${t1}`, shortName: `C${t1}` }, team2: { teamId: t2, teamName: `Club ${t2}`, shortName: `C${t2}` }, matchIsFinished: true,
  matchResults: [{ resultTypeID: 1, pointsTeam1: 0, pointsTeam2: 0 }, { resultTypeID: 2, pointsTeam1: s1, pointsTeam2: s2 }], goals: [] });
const upstream = matches => {
  const mem = new Map();
  return { storage: { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } },
    fetcher: async url => ({ status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(url.endsWith('/getcurrentgroup/bl1') ? { groupOrderID: 1 } : url.includes('/getlastchangedate/') ? 'A' : matches)) }) };
};

test('profiles: MLS has no relegation/European language, UCL no table or top-four, knockout no aggregate', () => {
  assert.equal(profileFor('mls', '2026-09-20T00:00:00Z').key, 'mls');
  assert.equal(profileFor('uefa-champions-league', '2026-10-01T00:00:00Z').key, 'ucl_league_phase');
  assert.equal(profileFor('uefa-champions-league', '2027-03-10T00:00:00Z').key, 'knockout');
  assert.equal(PROFILES.ucl_league_phase.table, false);
  assert.ok(!('relegation_zone_move' in PROFILES.mls.angles) && !('top4_entry_exit' in PROFILES.mls.angles));
  const hit = (profile, s) => PROFILES[profile].banned.some(([, re]) => re.test(s));
  assert.ok(hit('mls', 'moved into the relegation zone') && hit('mls', 'chasing a European place') && hit('mls', 'top four'));
  assert.ok(hit('ucl_league_phase', 'moved into the top four') && hit('ucl_league_phase', 'top of the table') && hit('ucl_league_phase', 'qualify for the round of 16'));
  assert.ok(hit('knockout', 'through to the quarter-finals on aggregate'));
  // 1.2.0: the only domestic-league ban is the unsupported European-places claim; "top four" stays a table position.
  assert.deepEqual(PROFILES.domestic_european_league.banned.map(([n]) => n), ['european_places_claim']);
});

const T = id => ({ id, slug: id, name: `Team ${id}`, short_name: id });
function season(results) {
  const finished = results.map(([id, day, h, a, hs, as], i) => ({ id, kickoff_at: `2026-09-${String(day).padStart(2, '0')}T${String(12 + (i % 8)).padStart(2, '0')}:00:00Z`, stage_id: 'L', home_team_id: h, away_team_id: a, home_score: hs, away_score: as, home_score_ht: null, away_score_ht: null, status: 'finished' }));
  return { comp: { slug: 'premier-league' }, leagueStages: new Set(['L']), finished, matches: finished, teams: new Map(['a', 'b', 'c', 'd'].map(x => [x, T(x)])) };
}

test('still-true rule: a team that went top and was overtaken later is not reported as top', () => {
  const base = [['1', 1, 'a', 'b', 1, 0], ['2', 1, 'c', 'd', 1, 0], ['3', 2, 'a', 'd', 1, 0], ['4', 2, 'c', 'b', 1, 0], ['5', 3, 'b', 'a', 0, 1], ['6', 3, 'd', 'c', 0, 1]];
  // Round 4: c wins first (goes top on goals), then a wins bigger later the same day.
  const S = season([...base, ['7', 4, 'c', 'b', 1, 0], ['8', 4, 'a', 'd', 5, 0]]);
  const p = profileFor('premier-league', '2026-09-04T00:00:00Z');
  const cWin = S.finished.find(m => m.id === '7');
  assert.ok(!assess(S, cWin, p, []).angles.some(x => x.key === 'leader_change'));
  const S2 = season([...base, ['7', 4, 'c', 'b', 3, 0], ['8', 4, 'a', 'd', 1, 0]]);
  // c still top at the end of the round -> the angle stands
  assert.ok(assess(S2, S2.finished.find(m => m.id === '7'), p, []).angles.some(x => x.key === 'leader_change'));
});

const packet = () => ({
  version: 'soccer-packet/2.0.0', hash: 'f'.repeat(64), event: { kind: 'match_recap', key: 'match_recap:m', as_of: '2026-09-20T14:00:00Z', profile: 'mls' },
  competition: { id: 'c', name: 'MLS', slug: 'mls', season: '2026' }, materiality: { score: 1.2 },
  match: { id: 'm', kickoff_utc: '2026-09-20T14:00:00.000Z', venue: 'Chase Stadium', league_stage: true, status: 'finished', score: { home: 6, away: 0, home_ht: null, away_ht: null, final: '6-0' }, winner: 'home', margin: 6 },
  teams: { home: { id: 'h', name: 'Inter Miami CF', slug: 'inter-miami-cf', table_before: { position: 3, points: 50, played: 29 }, table_after: { position: 2, points: 53, played: 30 }, form_before: ['W', 'D'] },
    away: { id: 'a', name: 'Toronto FC', slug: 'toronto-fc', table_before: { position: 28, points: 25, played: 29 }, table_after: { position: 28, points: 25, played: 30 }, form_before: ['L'] } },
  teams_in_table: 30,
  goals: ['Luis Suárez', 'Lionel Messi', 'Jordi Alba', 'Sergio Busquets', 'Tadeo Allende', 'Telasco Segovia'].map((n, i) => ({ minute: 10 + i * 12, display_minute: `${10 + i * 12}'`, team: 'home', scorer: { id: `p${i + 1}`, name: n, slug: n.toLowerCase().replace(/[^a-z]+/g, '-') }, own_goal: false, penalty: false, running_score: `${i + 1}-0` })),
  angles: [{ key: 'heavy_margin', weight: 0.6, detail: { margin: 6 } }, { key: 'high_scoring', weight: 0.6, detail: { goals: 6 } }],
  stats: { basis: 'source', provider: 'espn', home: { shots: 20, shots_on_target: 11 }, away: { shots: 4, shots_on_target: 1 } }, shots_located: null,
  unavailable: ['quotes (none sourced)'], provenance: { attributions: ['Structured facts: ESPN (secondary source).'] },
});

test('MLS recap: composes with MLS wording and passes every gate; tampering is caught', () => {
  const p = packet(); const a = compose(p);
  assert.equal(a.desk, 'mls');
  assert.equal(a.headline, 'Inter Miami CF beat Toronto FC 6-0');
  const g = runGates2(a, p);
  assert.deepEqual(g.failed, []);
  assert.ok(a.sections.some(s => s.paragraphs.join(' ').includes('overall MLS standings')));
  const bad = { ...a, sections: a.sections.map(s => (s.key === 'angle' ? { ...s, paragraphs: ['Toronto FC are now in the relegation zone after 7 defeats.'] } : s)) };
  const gb = runGates2(bad, p);
  assert.ok(gb.failed.includes('mls_relegation') && gb.failed.includes('numeric_grounding'));
  const wrongTable = { ...a, sections: a.sections.map(s => (s.key === 'table' ? { ...s, paragraphs: ['Inter Miami CF moved from 3rd to 1st in the overall MLS standings after the match, on 53 points from 30 matches.'] } : s)) };
  assert.ok(runGates2(wrongTable, p).failed.includes('claims_consistency'));
  const quote = { ...a, sections: a.sections.map(s => (s.key === 'result' ? { ...s, paragraphs: ['The coach said it was historic.'] } : s)) };
  const gq = runGates2(quote, p);
  assert.ok(gq.failed.includes('unsupported_quote') && gq.failed.includes('unsupported_record'));
});

test('optional LLM pass: off by default; an edit that invents a fact fails the same gates', async () => {
  const p = packet(); const a = compose(p);
  assert.equal(await editorialPass(a, p, {}), null);
  const fake = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({ headline: 'Inter Miami CF beat Toronto FC 6-0 after 9 straight wins', dek: a.dek, sections: a.sections }) }] }) });
  const edited = await editorialPass(a, p, { NEWS_LLM: 'on', ANTHROPIC_API_KEY: 'k' }, { fetcher: fake });
  assert.ok(edited && edited.composer.includes('llm-editor'));
  assert.ok(runGates2(edited, p).failed.includes('numeric_grounding')); // 9 is only a month number in the packet
  const restructured = async () => ({ ok: true, json: async () => ({ content: [{ text: JSON.stringify({ headline: a.headline, sections: [a.sections[0]] }) }] }) });
  assert.equal(await editorialPass(a, p, { NEWS_LLM: 'on', ANTHROPIC_API_KEY: 'k' }, { fetcher: restructured }), null);
});

test('pipeline: detects, freezes, publishes gated stories once (idempotent), evidence append-only', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const games = [olm(1, 1, 10, 20, '2026-09-19T13:30:00', 6, 0), olm(2, 1, 30, 40, '2026-09-19T13:30:00', 1, 1), olm(3, 1, 50, 60, '2026-09-19T15:30:00', 2, 1), olm(4, 1, 70, 80, '2026-09-19T15:30:00', 0, 1), olm(5, 1, 90, 11, '2026-09-20T13:30:00', 1, 0), olm(6, 1, 12, 13, '2026-09-20T15:30:00', 2, 2)];
  const up = upstream(games);
  await runOpenLigaCurrent({ store, storage: up.storage, registry: REG, state: emptyLaneState('x'), now: Date.parse('2026-09-27T00:00:00Z'), fetcher: up.fetcher, force: true });
  const now = Date.parse('2026-09-21T12:00:00Z');
  const r1 = await runNews(store, { now, competitions: ['bundesliga'], env: { NEWS_DESK: 'off' } });
  const b = r1.competitions.bundesliga;
  assert.ok(b.published >= 1, JSON.stringify(b));
  assert.ok(b.stories.some(s => s.story_class === 'match_recap' && s.headline === 'Club 10 beat Club 20 6-0'));
  const r2 = await runNews(store, { now, competitions: ['bundesliga'], env: { NEWS_DESK: 'off' } });
  assert.equal(r2.competitions.bundesliga.new, 0); // written once
  const arts = await store.select('soccer_articles', { columns: ['status', 'packet_hash', 'desk'] });
  assert.ok(arts.every(x => x.desk === 'bundesliga'));
  await assert.rejects(store.query('delete from public.soccer_article_evidence'), /append-only/);
  await store.close();
});

test('derived counts printed in a story are carried in the packet (no coincidental grounding)', () => {
  const p = packet(); p.teams.home.form_before = ['W', 'D', 'L', 'W', 'W']; // 5 results, and no bare 5 elsewhere
  p.goals = []; p.angles = [{ key: 'high_scoring', weight: 1, detail: { goals: 6 } }]; p.stats = null;
  assert.ok(runGates2(compose(p), p).failed.includes('numeric_grounding'));
  p.teams.home.form_before_count = 5;
  assert.ok(!runGates2(compose(p), p).failed.includes('numeric_grounding'));
});

test('own goals: per-provider convention; the goal sequence must reproduce the final score', async () => {
  const { ownGoalBeneficiary, ownGoalPlayerTeam } = await import('../workers/shared/own-goals.js');
  assert.equal(ownGoalBeneficiary({ source_family: 'espn', team_id: 'A' }, 'H', 'A'), 'A'); // ESPN tags the benefiting team
  assert.equal(ownGoalBeneficiary({ source_family: 'wyscout_figshare', team_id: 'A' }, 'H', 'A'), 'H'); // Wyscout tags the player's team
  assert.equal(ownGoalBeneficiary({ source_family: 'openligadb', team_id: 'H' }, 'H', 'A'), 'A');
  assert.equal(ownGoalPlayerTeam({ source_family: 'espn', team_id: 'A' }, 'H', 'A'), 'H');
  const p = packet(); p.goals = p.goals.slice(0, 1); // 6-0 with one listed goal -> incomplete sequence
  assert.ok(runGates2(compose(p), p).failed.includes('goal_sequence_matches_score'));
  const p2 = packet(); p2.goals = p2.goals.slice(0, 1); p2.match.score = { home: 1, away: 0, home_ht: null, away_ht: null, final: '1-0' }; p2.match.margin = 1; p2.angles = [{ key: 'comeback_from_ht', weight: 1, detail: {} }].slice(0, 0).concat([{ key: 'high_scoring', weight: 1, detail: { goals: 1 } }]);
  assert.ok(!runGates2(compose(p2), p2).failed.includes('goal_sequence_matches_score'));
  p2.goals = [{ ...p2.goals[0], own_goal: true, team: 'away', running_score: '0-1' }];
  assert.ok(runGates2(compose(p2), p2).failed.includes('goal_sequence_matches_score')); // own goal on the wrong side
});

test('UCL readiness: league-phase recap with a verified table publishes on the champions-league desk, sitemap + article API', async () => {
  const R = await import('../workers/soccer-api/src/routes.js');
  const store = await openPglite(); await applyMigrations(store);
  const id = n => `00000000-0000-5000-8000-0000000f${String(n).padStart(4, '0')}`;
  await store.insert('soccer_competitions', [{ id: id(1), slug: 'uefa-champions-league', name: 'UEFA Champions League', comp_type: 'cup' }]);
  await store.insert('soccer_seasons', [{ id: id(2), competition_id: id(1), label: '2026/27', publication_state: 'published', published_at: '2026-01-01T00:00:00Z' }]);
  await store.insert('soccer_stages', [{ id: id(3), season_id: id(2), name: 'League phase', stage_type: 'league', stage_order: 1 }]);
  const teams = ['Alpha FC', 'Beta SC', 'Gamma AC', 'Delta CF'].map((n, i) => ({ id: id(10 + i), slug: n.toLowerCase().replace(/ /g, '-'), name: n, team_type: 'club', founding_provider: 'espn', founding_external_id: String(100 + i) }));
  await store.insert('soccer_teams', teams);
  const mk = (n, h, a, hs, as, day) => ({ id: id(n), competition_id: id(1), season_id: id(2), stage_id: id(3), kickoff_at: `2026-10-${day}T19:00:00Z`, home_team_id: teams[h].id, away_team_id: teams[a].id, status: 'finished', home_score: hs, away_score: as, result_provider: 'espn' });
  await store.insert('soccer_matches', [mk(20, 0, 1, 6, 0, '01'), mk(21, 2, 3, 1, 1, '01'), { ...mk(22, 0, 2, null, null, '21'), status: 'scheduled' }]);
  // 6 goal events for the 6-0 (ESPN family), so the goal sequence reproduces the score
  await store.insert('soccer_match_events', Array.from({ length: 6 }, (_, i) => ({ id: id(100 + i), match_id: id(20), sequence: i + 1, period: '1H', minute: 5 + i * 7, team_id: teams[0].id, event_type: 'shot', outcome: 'goal', is_goal: true, is_own_goal: false, source_family: 'espn', source_event_id: `g${i}`, source_coordinate_system: 'none', qualifiers: {}, observed_at: '2026-10-01T21:00:00Z', raw_payload_hash: 'a'.repeat(64), parser_version: 't' })));
  await store.insert('soccer_season_groups', [{ id: id(30), season_id: id(2), group_key: 'league-phase', name: 'League phase', group_type: 'league_phase', provider: 'espn', external_id: '1' }]);
  const srow = (t, rank, p, w, d, l, gf, ga, pts, note) => ({ group_id: id(30), team_id: teams[t].id, provider: 'espn', rank, played: p, won: w, drawn: d, lost: l, goals_for: gf, goals_against: ga, goal_difference: gf - ga, points: pts, note, observed_at: '2026-10-02T00:00:00Z' });
  await store.insert('soccer_source_standings', [srow(0, 1, 1, 1, 0, 0, 6, 0, 3, 'Qualifies for round of 16'), srow(2, 2, 1, 0, 1, 0, 1, 1, 1, 'Qualifies for round of 16'), srow(3, 3, 1, 0, 1, 0, 1, 1, 1, 'Knockout phase playoffs - seeded'), srow(1, 4, 1, 0, 0, 1, 0, 6, 0, 'Eliminated')]);
  const out = await runNews(store, { now: Date.parse('2026-10-02T12:00:00Z'), competitions: ['uefa-champions-league'], env: { NEWS_DESK: 'off' }, cfg: { ucl_league_phase_end: '2027-02-01T00:00:00Z' } }); // explicit boundary (no hidden default since RC 2026-10-04)
  const u = out.competitions['uefa-champions-league'];
  const recap = u.stories.find(s => s.story_class === 'match_recap');
  assert.ok(recap && recap.status === 'published', JSON.stringify(u));
  const [art] = await store.select('soccer_articles', { columns: ['slug', 'desk', 'body', 'status'], eq: { slug: recap.slug } });
  assert.equal(art.desk, 'champions-league');
  const text = JSON.stringify(art.body);
  assert.ok(text.includes('1st of 4 in the league phase') && text.includes('Qualifies for round of 16'), text.slice(0, 400));
  assert.ok(!/top[ -]four/i.test(text));
  assert.ok(text.includes('What comes next')); // the scheduled league-phase match
  const sm = await R.sitemap(store, 'news');
  assert.ok(sm.data.some(r => r.key === `champions-league/${art.slug}`));
  assert.equal((await R.news(store, { desk: 'champions-league' })).data.length >= 1, true);
  assert.equal((await R.article(store, art.slug)).data.desk, 'champions-league');
  // One subject rule: the newsroom marked the winner (no resolved scorers) and list + article agree.
  const listed = (await R.news(store, { desk: 'champions-league' })).data.find(r => r.slug === art.slug);
  const page = (await R.article(store, art.slug)).data;
  assert.deepEqual(listed.subject, page.subject);
  assert.equal(page.subject.name, 'Alpha FC'); assert.equal(page.subject.reason, 'primary:match_winner');
  assert.equal(listed.image?.url ?? null, page.hero?.url ?? null);
  assert.equal(page.entities.filter(e => e.primary).length, 1);
  const tbl = await R.table(store, { competition: 'uefa-champions-league' });
  assert.equal(tbl.data.verification.verified, true); assert.equal(tbl.data.rows[0].zone.label, 'Qualifies for round of 16');
  await store.close();
});
