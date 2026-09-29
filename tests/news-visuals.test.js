// Article visual contract: code-built specs from the frozen packet, validated, frozen, hashed, rendered
// deterministically. The desk may only order visuals by id; it never owns a value.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { buildVisuals, loadShotPoints, validateVisual, validateVisuals, visualIntact, VISUALS_VERSION } from '../workers/soccer-news/src/visuals.js';
import { articleBody, withVisualMenu } from '../workers/soccer-news/src/pipeline.js';
import { deskArticle } from '../workers/soccer-news/src/desk.js';
import { orderVisuals, renderVisual } from '../src/components/visuals.js';

const id = n => `00000000-0000-5000-8000-0000000d${String(n).padStart(4, '0')}`;
const H = { id: id(10), name: 'Bayern München', slug: 'bayern-munchen' }; const A = { id: id(11), name: '1. FC Union Berlin', slug: 'union' };
const P = (n, name) => ({ id: id(n), name, slug: name.toLowerCase().replace(/\W+/g, '-') });
const olise = P(20, 'Michael Olise'); const kane = P(21, 'Harry Kane'); const doekhi = P(22, 'Danilho Doekhi');
const goal = (minute, dm, team, scorer, rs, extra = {}) => ({ minute, display_minute: dm, team, scorer, assist: null, own_goal: false, penalty: false, running_score: rs, ...extra });
function packet() {
  const goals = [goal(18, "18'", 'home', olise, '1-0'), goal(47, "45+2'", 'home', kane, '2-0', { penalty: true }), goal(54, "54'", 'home', olise, '3-0'), goal(60, "60'", 'home', doekhi, '4-0', { own_goal: true }), goal(76, "76'", 'home', olise, '5-0')];
  return {
    version: 'soccer-packet/3.0.0', hash: 'c'.repeat(64), event: { kind: 'match_recap', key: 'match_recap:m', as_of: '2026-09-18T18:30:00Z', profile: 'domestic_european_league' },
    competition: { id: 'c', name: 'Bundesliga', slug: 'bundesliga', season: '2026/27' },
    match: { id: id(1), score: { home: 5, away: 0, home_ht: 2, away_ht: 0, final: '5-0' }, winner: 'home', status: 'finished' },
    teams: { home: { ...H, table_before: { position: 4, points: 7, played: 3 }, table_after: { position: 1, points: 10, played: 4 } }, away: { ...A, table_before: { position: 16, points: 1, played: 3 }, table_after: { position: 16, points: 1, played: 4 } } },
    teams_in_table: 18, goals, stats: { basis: 'source', provider: 'espn', home: { shots: 20, shots_on_target: 11, corners: 7 }, away: { shots: 3, shots_on_target: 1, corners: 1 } },
    depth: { phases: { first_half: { home: { shots: 9, shots_on_target: 5, goals: 2 }, away: { shots: 2, shots_on_target: 1, goals: 0 } }, second_half: { home: { shots: 11, shots_on_target: 6, goals: 3 }, away: { shots: 1, shots_on_target: 0, goals: 0 } }, buckets: {}, shot_events_source: 'espn' },
      player_lines: [{ player: olise, team: 'home', goals: 3, assists: 0, shots: 6, shots_on_target: 4, shots_inside_box: 4 }],
      shot_profile: { located_total: 8, home: { located_inside_box: 6, avg_located_distance_m: 14.2 }, away: { located_inside_box: 1, avg_located_distance_m: 21 } },
      table_move: { teams_in_table: 18, home: { position_before: 4, position_after: 1, points_after: 10 }, away: { position_before: 16, position_after: 16, points_after: 1 } },
      recent_league_results: { home: [{ date: '2026-09-12', result: 'W', score: '2-1', venue: 'away', opponent: { name: 'Mainz', slug: 'mainz' } }], away: [] } },
    unavailable: [], provenance: { attributions: [] },
  };
}
const shots = () => ({ source_family: 'espn', recorded: 10, points: [
  ...[18, 54, 76].map((m, i) => ({ x: 95 + i, y: 30, team: 'home', minute: m, outcome: 'goal', player: olise })),
  { x: 90, y: 40, team: 'home', minute: 30, outcome: 'off_target', player: olise }, { x: 89, y: 20, team: 'home', minute: 47, outcome: 'goal', player: kane },
  { x: 80, y: 34, team: 'home', minute: 50, outcome: 'blocked', player: kane }, { x: 20, y: 34, team: 'away', minute: 65, outcome: 'on_target', player: null }, { x: 88, y: 33, team: 'home', minute: 70, outcome: 'on_target', player: olise }] });

test('recap visuals: flow, timeline, profile, map, player focus, table move, form; all validate and hash', () => {
  const p = packet();
  const { visuals, rejected } = validateVisuals(buildVisuals(p, { shots: shots(), observedAt: '2026-09-18T21:00:00Z' }), p);
  assert.deepEqual(rejected, []);
  assert.deepEqual(visuals.map(v => v.type), ['match_flow', 'goal_timeline', 'shot_profile', 'shot_map', 'player_focus', 'table_move', 'form_strip']);
  for (const v of visuals) { assert.ok(visualIntact(v)); assert.equal(v.provenance.packet_hash, p.hash); assert.equal(v.provenance.builder, VISUALS_VERSION); assert.equal(v.observed_at, '2026-09-18T21:00:00Z'); }
  const tl = visuals.find(v => v.type === 'goal_timeline').data;
  assert.equal(tl.axis.halftime, 47, 'first-half stoppage extends the first half');
  assert.equal(tl.goals[1].at, 47); assert.equal(tl.goals[1].penalty, true); assert.equal(tl.goals[3].own_goal, true); assert.ok(!('assist' in tl.goals[0]), 'no invented assist');
  const prof = Object.fromEntries(visuals.find(v => v.type === 'shot_profile').data.rows.map(r => [r.key, [r.home, r.away]]));
  assert.deepEqual(prof.on_target_pct, [55, 33.3]); assert.deepEqual(prof.goals, [5, 0]); assert.deepEqual(prof.goals_per_shot_pct, [25, 0]);
  const map = visuals.find(v => v.type === 'shot_map');
  assert.equal(map.subtitle, '8 of 10 recorded shots have location data'); assert.equal(map.data.full_coverage, false);
  const pf = visuals.find(v => v.type === 'player_focus');
  assert.equal(pf.data.player.name, 'Michael Olise'); assert.equal(pf.data.points.length, 5); assert.ok(pf.data.points.every(x => x.player.id === olise.id));
});

test('validator: tampered values, count drift, coverage overclaim and another player\'s shots are rejected', () => {
  const p = packet();
  const vis = buildVisuals(p, { shots: shots(), observedAt: '2026-09-18T21:00:00Z' });
  const tampered = structuredClone(vis.find(v => v.type === 'shot_profile')); tampered.data.rows[0].home = 99;
  assert.ok(validateVisual(tampered, p).includes('values_hash mismatch'));
  assert.ok(!visualIntact(tampered), 'the API would withhold it');
  const p2 = packet(); p2.stats.home.shots = 21; // the packet says 21, the visual says 20
  assert.ok(validateVisual(vis.find(v => v.type === 'shot_profile'), p2).some(e => /shots differs/.test(e)));
  const p3 = packet(); p3.goals = p3.goals.slice(0, 4);
  assert.ok(validateVisual(vis.find(v => v.type === 'goal_timeline'), p3).length > 0);
  const map = structuredClone(vis.find(v => v.type === 'shot_map')); map.subtitle = 'All shots'; map.values_hash = null;
  assert.ok(validateVisual(map, p).some(e => /coverage label/.test(e)));
  const pf = buildVisuals(p, { shots: { ...shots(), points: shots().points.map(x => ({ ...x, player: olise })) } }).find(v => v.type === 'player_focus');
  assert.equal(pf.data.points.length, 7, 'builder filters by player id');
  const bad = structuredClone(pf); bad.data.points[0].player = kane;
  assert.ok(validateVisual(bad, p).some(e => /another player/.test(e)));
});

test('no located shots / too few: no map; partial coverage is stated, never implied full', () => {
  const p = packet();
  assert.ok(!buildVisuals(p, { shots: { source_family: 'espn', recorded: 20, points: shots().points.slice(0, 3) } }).some(v => v.type === 'shot_map'));
  assert.ok(!buildVisuals(p, { shots: null }).some(v => v.type === 'shot_map'));
});

test('desk emphasis: only ids from the code-built menu survive; values never come from the model', () => {
  const p = packet();
  const vis = validateVisuals(buildVisuals(p, { shots: shots() }), p);
  const draft = withVisualMenu({ headline: 'x', dek: 'y', sections: [{ key: 'method', heading: 'M', paragraphs: ['m'] }], entities: [], composer: 't' }, vis);
  assert.ok(draft.visual_menu.every(m => Object.keys(m).join() === 'id,type,title'), 'menu carries no values');
  const art = deskArticle({ headline: 'H', dek: 'D', sections: [], emphasis: ['player_focus', 'invented_chart', 'shot_map'] }, draft);
  assert.deepEqual(art.emphasis, ['player_focus', 'shot_map']);
  const body = articleBody(art, null, vis);
  assert.deepEqual(body.visual_emphasis, ['player_focus', 'shot_map']);
  assert.equal(body.visuals_version, VISUALS_VERSION);
  assert.deepEqual(orderVisuals(body).slice(0, 2).map(v => v.id), ['player_focus', 'shot_map']);
});

test('renderer: every type renders deterministically; own goal, penalty and partial coverage are labelled', () => {
  const p = packet();
  const vis = buildVisuals(p, { shots: shots(), observedAt: '2026-09-18T21:00:00Z' });
  for (const v of vis) { const h = renderVisual(v); assert.match(h, /^<figure class="viz t-/); assert.equal(h, renderVisual(v)); assert.match(h, /Frozen at publication/); }
  const tl = renderVisual(vis.find(v => v.type === 'goal_timeline'));
  assert.match(tl, /Own goal \(Danilho Doekhi\)/); assert.match(tl, /<em>pen<\/em>/); assert.match(tl, /HT 2-0/); assert.match(tl, /FT 5-0/);
  assert.match(renderVisual(vis.find(v => v.type === 'shot_map')), /8 of 10 recorded shots have location data; the rest are counted but not plotted/);
  assert.doesNotMatch(renderVisual(vis.find(v => v.type === 'shot_map')), /cpulse|class="pulse"|live|replay/i, 'static: no animation, no live/replay concept');
  assert.equal(renderVisual({ type: 'arbitrary_svg', data: {} }), '');
  assert.equal(renderVisual(null), '');
});

test('shot points: shots only (a card with coordinates is not a shot), one source family, match frame', async () => {
  const store = await openPglite(); await applyMigrations(store);
  await store.insert('soccer_competitions', [{ id: id(90), slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(91), competition_id: id(90), label: '2026/27' }]);
  await store.insert('soccer_teams', [H, A].map((t, i) => ({ ...t, team_type: 'club', founding_provider: 'espn', founding_external_id: String(700 + i) })));
  await store.insert('soccer_players', [olise].map(x => ({ id: x.id, slug: x.slug, display_name: x.name, status: 'active', founding_provider: 'espn', founding_external_id: '9' })));
  await store.insert('soccer_matches', [{ id: id(1), competition_id: id(90), season_id: id(91), kickoff_at: '2026-09-18T18:30:00Z', home_team_id: H.id, away_team_id: A.id, status: 'finished', home_score: 1, away_score: 0, result_provider: 'espn' }]);
  const ev = (n, type, team, x, y, extra = {}) => ({ id: id(100 + n), match_id: id(1), sequence: n, period: '1H', minute: 10 + n, team_id: team, event_type: type, is_goal: false, is_own_goal: false, x_m: x, y_m: y, source_family: 'espn', source_event_id: `e${n}`, source_coordinate_system: 'none', qualifiers: {}, observed_at: '2026-09-18T21:00:00Z', raw_payload_hash: 'a'.repeat(64), parser_version: 't', ...extra });
  await store.insert('soccer_match_events', [ev(1, 'shot', H.id, 95, 30, { outcome: 'goal', is_goal: true, player_id: olise.id }), ev(2, 'shot', A.id, 90, 34, { outcome: 'off_target' }), ev(3, 'card', H.id, 50, 20, { card: 'yellow' }), ev(4, 'shot', H.id, null, null, { outcome: 'blocked' }), ev(5, 'shot', H.id, 80, 10, { outcome: 'on_target', source_family: 'wyscout_figshare', source_event_id: 'w5' })]);
  const pts = await loadShotPoints(store, { match: { id: id(1) }, teams: { home: H, away: A } });
  assert.equal(pts.source_family, 'wyscout_figshare', 'one family, richest first (same rule as PBEcast)');
  const espnOnly = await store.query("delete from public.soccer_match_events where source_family = 'wyscout_figshare'").then(() => loadShotPoints(store, { match: { id: id(1) }, teams: { home: H, away: A } }));
  assert.equal(espnOnly.recorded, 3, 'three shot events; the card is not one');
  assert.equal(espnOnly.points.length, 2, 'the unlocated shot is counted but not plotted');
  const away = espnOnly.points.find(x => x.team === 'away');
  assert.deepEqual([away.x, away.y], [15, 34], 'away shots mirrored into the match frame (away attacks left)');
  assert.equal(espnOnly.points.find(x => x.team === 'home').player.name, 'Michael Olise');
  await store.close();
});
