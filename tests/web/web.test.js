// Frontend contract tests: pure render functions + proxy allowlist. Inputs are
// inline test objects shaped like the API envelope (not committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { isAllowedPath, upstreamUrl, UPSTREAM } from '../../api/soccer.js';
import { resolve } from '../../src/lib/router.js';
import { num, statsHeading, coverageOf, scoreline, DASH } from '../../src/lib/format.js';
import { pitchLines, pitchSvg, toPortrait, validShots, L, W } from '../../src/components/pitch.js';
import { sourcePanel, matchCard, formChips, initials } from '../../src/components/ui.js';
import { FEATURED } from '../../src/lib/competitions.js';
import { tableView } from '../../src/components/table.js';
import * as match from '../../src/pages/match.js';
import { news, tables } from '../../src/pages/lists.js';
import { player, team } from '../../src/pages/people.js';
import { API_BASE, apiPath } from '../../src/lib/api.js';

test('proxy: only the public API routes, fixed upstream, known query keys, no traversal', () => {
  assert.equal(isAllowedPath('matches/5b0c8f3e-1111-5222-8333-444455556666'), true);
  assert.equal(isAllowedPath('competitions/bundesliga'), true);
  assert.equal(isAllowedPath('matches/5b0c8f3e-1111-5222-8333-444455556666/analyzer-preview'), true);
  for (const ok of ['algo/picks', 'algo/record', 'algo/research', 'algo/v2/picks', 'algo/v2/record', 'algo/v2/research']) assert.equal(isAllowedPath(ok), true, ok);
  // V2 is exposed only through its three exact routes: nothing nested, no other version, no traversal
  for (const bad of ['algo/v2', 'algo/v2/', 'algo/v2/picks/x', 'algo/v2/picks/../record', 'algo/v2/admin', 'algo/v3/picks', 'algo/v2/record/extra', 'algo/v2//picks', 'algo/v2/picks?x=1', 'algo/picks/v2', 'algo', 'algo/v2/research/../../health']) assert.equal(isAllowedPath(bad), false, bad);
  assert.equal(upstreamUrl('https://soccer.propbetedge.ai/api/soccer?path=algo/v2/picks').href, `${UPSTREAM}algo/v2/picks`);
  assert.equal(upstreamUrl('https://soccer.propbetedge.ai/api/soccer?path=algo/v2/picks/../../admin'), null);
  for (const bad of ['', '../etc/passwd', 'matches/not-a-uuid', 'https://evil.example', 'admin', 'v1/matches', 'teams/../x', 'runs']) assert.equal(isAllowedPath(bad), false, bad);
  const u = upstreamUrl('https://soccer.propbetedge.ai/api/soccer?path=matches&competition=bundesliga&token=x&limit=5');
  assert.equal(u.href, `${UPSTREAM}matches?competition=bundesliga&limit=5`);
  assert.equal(upstreamUrl('https://x/api/soccer?path=..%2F..%2Fetc'), null);
  assert.equal(upstreamUrl('https://x/api/soccer?path=https%3A%2F%2Fevil.example'), null);
  assert.ok(UPSTREAM.startsWith('https://soccer-api.') && UPSTREAM.endsWith('/v1/'));
});

test('browser API client only targets the same-origin proxy', () => {
  assert.equal(API_BASE, '/api/soccer/');
  assert.equal(apiPath('matches', { competition: 'bundesliga', status: '', limit: 5 }), '/api/soccer/matches?competition=bundesliga&limit=5');
});

test('public soccer reads bypass the Vercel function; authenticated Pro stays private', () => {
  const v = JSON.parse(readFileSync('vercel.json', 'utf8'));
  const rw = v.rewrites || [];
  const bySource = source => rw.find(x => x.source === source);
  assert.equal(bySource('/api/soccer/matches')?.destination, 'https://soccer-api.sales-fd3.workers.dev/v1/matches');
  assert.equal(bySource('/api/soccer/news')?.destination, 'https://soccer-api.sales-fd3.workers.dev/v1/news');
  assert.equal(bySource('/api/soccer/live')?.destination, 'https://soccer-api.sales-fd3.workers.dev/v1/live');
  assert.equal(bySource('/api/soccer/media/:sha')?.destination, 'https://soccer-api.sales-fd3.workers.dev/v1/media/:sha');
  assert.equal(bySource('/api/soccer/pro/:path*')?.destination, '/api/soccer?path=pro/:path*');
  // Soccer PBE Picks: V1 and V2 each reach the Worker through their own exact routes; no algo wildcard exists
  assert.equal(bySource('/api/soccer/algo/:kind(picks|record|research)')?.destination, 'https://soccer-api.sales-fd3.workers.dev/v1/algo/:kind');
  assert.equal(bySource('/api/soccer/algo/v2/:kind(picks|record|research)')?.destination, 'https://soccer-api.sales-fd3.workers.dev/v1/algo/v2/:kind');
  assert.ok(!rw.some(x => /^\/api\/soccer\/algo\/.*(:path|\*)/.test(x.source)), 'no wildcard algo rewrite');
  const anon = bySource('/api/soccer/pro/access');
  assert.equal(anon?.destination, '/soccer-free-access.json');
  assert.deepEqual(anon?.missing, [{ type: 'cookie', key: 'pbe_session' }]);
  const cacheHeader = (v.headers || []).find(x => x.source === '/api/soccer/:path*')?.headers?.find(h => h.key === 'x-vercel-enable-rewrite-caching');
  assert.equal(cacheHeader?.value, '1');
  const free = JSON.parse(readFileSync('public/soccer-free-access.json', 'utf8'));
  assert.deepEqual([free.data.pro, free.data.membership.state, free.data.check], [false, 'free', 'ok']);
});

// Allow-list (exact file + exact host, nothing else): the vendored shared Kalshi client is kept byte-identical to the
// canonical copy, and its DEFAULT base names the markets Worker. Soccer always passes the same-origin base
// (/api/markets, src/data/kalshi.js), so the default is never used; tests/web/kalshi.test.js proves both.
const VENDOR_WORKER_DEFAULT = { file: join('src', 'vendor', 'kalshi', 'kalshi-market-client.js'), host: "base = 'https://propsports-markets.sales-fd3.workers.dev'" };

test('browser source never calls a provider, the Worker host or Supabase directly', () => {
  const walk = d => readdirSync(d).flatMap(f => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
  for (const f of walk('src')) {
    let t = readFileSync(f, 'utf8');
    if (f === VENDOR_WORKER_DEFAULT.file) { assert.equal(t.split(VENDOR_WORKER_DEFAULT.host).length, 2, 'vendored default base appears exactly once'); t = t.replace(VENDOR_WORKER_DEFAULT.host, ''); }
    assert.ok(!/workers\.dev|supabase\.co|espn\.com|openligadb\.de|figshare\.com|ndownloader|service_role/i.test(t), `${f} references an upstream`);
    assert.ok(!/fetch\(\s*['"`]https?:/.test(t), `${f} fetches an absolute URL`);
  }
});

test('router resolves every shipped route and 404s the rest', () => {
  assert.equal(resolve('/').page, 'home');
  assert.deepEqual(resolve('/competitions/premier-league'), { page: 'competition', params: ['premier-league'] });
  assert.equal(resolve('/matches/5b0c8f3e-1111-5222-8333-444455556666').page, 'match');
  assert.equal(resolve('/teams/bayern-munchen').page, 'team');
  assert.equal(resolve('/players/robert-lewandowski').page, 'player');
  for (const p of ['/tables', '/news', '/sources', '/matches', '/competitions']) assert.notEqual(resolve(p).page, 'notfound', p);
  assert.equal(resolve('/matches/abc').page, 'notfound');
  assert.equal(resolve('/predictions').page, 'notfound');
  assert.equal(resolve('/dna').page, 'notfound');
});

test('missing values render as missing, never as zero', () => {
  assert.equal(num(null), DASH); assert.equal(num(undefined), DASH); assert.equal(num(''), DASH);
  assert.equal(num(0), '0'); assert.equal(num(57.2, { dp: 1, suffix: '%' }), '57.2%');
  assert.equal(scoreline(null), null); assert.equal(scoreline({ home: 0, away: 0 }), '0–0');
  assert.equal(formChips([]).includes('No finished matches'), true);
});

test('stats basis labels are never blurred', () => {
  assert.equal(statsHeading({ basis: 'derived', derivation: 'pbe-counts/1.0.0' }).title, 'PBE DERIVED COUNTS');
  assert.equal(statsHeading({ basis: 'source', provider: 'espn' }).title, 'SOURCE MATCH STATISTICS');
  assert.match(statsHeading({ basis: 'source', provider: 'espn' }).note, /DATA · PropSports/);
  assert.doesNotMatch(statsHeading({ basis: 'source', provider: 'espn' }).note, /ESPN/);
  assert.equal(statsHeading(null), null);
  assert.deepEqual(['ok', 'partial', 'unavailable', 'degraded'].map(s => coverageOf({ coverage: { state: s } }).label), ['FULL', 'PARTIAL', 'UNAVAILABLE', 'DEGRADED']);
});

test('pitch: real 105x68 geometry, portrait rotation keeps home attacking up', () => {
  const lines = pitchLines();
  assert.match(lines, /width="105" height="68"/);
  assert.match(lines, /width="16.5" height="40.32"/); // penalty area
  assert.match(lines, /width="5.5" height="18.32"/); // goal area
  assert.match(lines, /r="9.15"/);
  assert.deepEqual(toPortrait(105, 34), { x: 34, y: 0 });   // home goal line -> top
  assert.deepEqual(toPortrait(0, 0), { x: 0, y: L });        // away goal line, top touchline -> bottom-left
  const shots = [{ x: 90, y: 30, team: 'home', outcome: 'goal', minute: 12 }, { x: 200, y: 30 }, { x: null, y: 1 }];
  assert.equal(validShots(shots).length, 1);
  assert.equal((pitchSvg(shots).match(/class="mark"/g) || []).length, 1);
  assert.equal((pitchSvg(shots, { portrait: true }).match(/class="mark"/g) || []).length, 1);
  assert.equal(W, 68);
});

// An API-shaped match (ESPN-backed) for render tests.
const espnMatch = () => ({
  data: {
    id: '5b0c8f3e-1111-5222-8333-444455556666', status: 'finished', kickoff_at: '2026-09-20T15:30:00Z', round: null,
    home: { id: 'h', slug: 'fulham', name: 'Fulham' }, away: { id: 'a', slug: 'manchester-united', name: 'Manchester United', short_name: 'Man United' },
    score: { home: 1, away: 1, home_ht: null, away_ht: null }, result_source: 'espn', event_source: 'espn',
    competition: { slug: 'premier-league', name: 'Premier League' }, season: '2026/27', venue: { name: 'Craven Cottage', city: 'London' },
    timeline: [{ minute: 63, display_minute: "63'", team: 'home', type: 'own_goal', player: { slug: 'x', name: 'Lisandro Martínez' } }, { minute: 89, display_minute: "89'", team: 'away', type: 'goal', player: { slug: 'y', name: 'Matheus Cunha' } }],
    shots: [{ minute: 89, team: 'away', player: { slug: 'y', name: 'Matheus Cunha' }, outcome: 'goal', x: 20, y: 30 }, { minute: 10, team: 'home', player: null, outcome: 'off_target', x: 90, y: 40 }],
    stats: { basis: 'source', provider: 'espn', derivation: null, home: { possession_pct: 43, shots: 12, provider_xg_espn: 1.57 }, away: { possession_pct: 57, shots: 28 } },
    lineups: { home: { formation: '4-2-3-1', manager: null, starters: [{ slug: 'b', name: 'Bernd Leno' }], bench: [] }, away: { formation: null, manager: null, starters: [{ slug: 'o', name: 'Onana' }], bench: [] } },
    substitutions: [{ minute: 71, team: 'home', in: { slug: 'c', name: 'César Palacios' }, out: { slug: 'i', name: 'Alex Iwobi' } }],
    coordinates: { system: '105x68 m, match frame: home attacks toward x=105', note: 'Event locations, not player tracking.' },
  },
  meta: { source: 'pbe', source_updated_at: '2026-09-27T17:36:23Z', semantics: 'Canonical match assembled by PropBetEdge.', coverage: { state: 'ok', notes: [] }, attribution: ['Structured facts: ESPN (secondary source)'] },
});

test('match page: truthful labels, event map, stats basis, lineups, provenance', () => {
  const html = match.render({ env: espnMatch() });
  for (const s of ['MATCH INTELLIGENCE', 'EVENT LOCATIONS — NOT PLAYER TRACKING', 'SOURCE MATCH STATISTICS', 'xG (supplied)', 'STARTING XI', 'Formation <b>4-2-3-1</b>', 'Formation not stated by the source', 'SOURCE &amp; FRESHNESS', 'PropSports', 'Craven Cottage', 'César Palacios']) assert.ok(html.includes(s), s);
  assert.ok(!html.replace(/Image: ESPN/g, '').includes('ESPN'), 'no upstream lane name on the match page (logo image credits stay)');
  assert.ok(!html.includes('PBE DERIVED COUNTS'));
  assert.ok(html.includes('class="pitchwrap land"') && html.includes('class="pitchwrap port"'));
  // a stat present for one side only is shown as missing on the other, not 0
  assert.ok(/1\.57<\/span>[\s\S]*?—<\/span>/.test(html));
});

test('match page without located events says so instead of plotting anything', () => {
  const env = espnMatch(); env.data.shots = []; env.data.event_source = 'openligadb'; env.data.stats = null; env.data.lineups = null;
  const html = match.render({ env });
  assert.ok(html.includes('No event map for this match'));
  assert.ok(html.includes('reports goals only'));
  assert.ok(html.includes('Absent statistics are not zeros'));
  assert.ok(html.includes('Lineups are not available'));
  assert.ok(!html.includes('class="mark"'));
});

test('news empty state, unavailable table, player page honesty', () => {
  const n = news.render({ env: { data: [], meta: { coverage: { state: 'unavailable' } } } });
  assert.ok(n.includes('PROPBETEDGE SOCCER NEWSROOM') && n.includes('Evidence-backed soccer reporting is coming online.'));
  const t = tableView({ data: { rows: [] }, meta: { coverage: { state: 'unavailable', notes: [] } } });
  assert.ok(t.includes('Table not available'));
  const tb = tables.render({ comp: 'uefa-champions-league', comps: { status: 'fulfilled', value: { data: [{ slug: 'uefa-champions-league', name: 'UEFA Champions League' }] } }, table: { status: 'fulfilled', value: { data: { rows: [] }, meta: { semantics: 'x', coverage: { state: 'unavailable', notes: [] } } } } });
  assert.ok(tb.includes('Table not available'));
  const p = player.render({ env: { data: { name: 'Test Player', role: null, seasons: [], reported_goals_other_seasons: 0 }, meta: { source: 'pbe', coverage: { state: 'unavailable', notes: ['Event-level statistics exist only for seasons with a legitimate event ledger.'] } } } });
  assert.ok(p.includes('PLAYER INTELLIGENCE') && p.includes('Player DNA is descriptive') && p.includes('No event-level season history') && p.includes('data-player-dna'));
  assert.ok(!/Soccer DNA<\/h|SOCCER DNA/.test(p));
});

test('source panel renders every envelope field and escapes content', () => {
  const html = sourcePanel({ source: 'pbe', source_updated_at: '2026-09-27T00:00:00Z', semantics: '<script>x</script>', coverage: { state: 'partial', notes: ['Lineups missing'] }, attribution: ['A'] });
  assert.ok(html.includes('PARTIAL') && html.includes('Lineups missing') && html.includes('&lt;script&gt;') && !html.includes('<script>'));
  const card = matchCard({ id: 'x', status: 'scheduled', kickoff_at: '2026-10-10T13:30:00Z', home: { name: 'A', slug: 'a' }, away: { name: 'B', slug: 'b' }, score: null, competition: { slug: 'bundesliga', name: 'Bundesliga' } });
  assert.ok(card.includes('>v<') && card.includes('UPCOMING') && card.includes('Bundesliga'));
});

test('V2: status badges, intel indicators, initials marks (no crests)', () => {
  const base = { id: 'x', kickoff_at: '2026-10-10T13:30:00Z', home: { name: 'Inter Miami CF', slug: 'inter-miami-cf' }, away: { name: 'LA Galaxy', slug: 'la-galaxy' }, competition: { slug: 'mls', name: 'MLS' } };
  const live = matchCard({ ...base, status: 'live', score: { home: 1, away: 0 }, intel: { lineups: true, stats: true, event_map: false } });
  assert.ok(live.includes('LIVE') && live.includes('LINEUPS') && live.includes('STATS') && !live.includes('EVENT MAP'));
  const fin = matchCard({ ...base, status: 'finished', score: { home: 2, away: 2 }, intel: { lineups: false, stats: false, event_map: false } });
  assert.ok(fin.includes('FINAL') && fin.includes('RESULT ONLY'));
  assert.ok(!/class="tmark[^"]* img"/.test(fin)); // no crest image without approved media (the competition logo is separate)
  assert.equal(initials('Inter Miami CF'), 'IM'); assert.equal(initials('FC Bayern München'), 'BM'); assert.equal(initials('Arsenal'), 'ARS');
  assert.ok(matchCard({ ...base, status: 'scheduled', score: null }).includes('UPCOMING'));
});

test('V2 table: POS CLUB P W D L GD PTS, form dots only when real', () => {
  const env = { data: { matches_counted: 2, rows: [{ position: 1, team: { slug: 'a', name: 'A' }, played: 1, won: 1, drawn: 0, lost: 0, points: 3, goals_for: 2, goals_against: 0, goal_difference: 2, form: ['W'] }] }, meta: { semantics: 's' } };
  const html = tableView(env);
  for (const h of ['>Pos<', '>Club<', '>P<', '>W<', '>D<', '>L<', '>GD<', '>PTS<', 'class="dots"', '+2']) assert.ok(html.includes(h), h);
  const noForm = tableView({ ...env, data: { ...env.data, rows: [{ ...env.data.rows[0], form: null }] } });
  assert.ok(!noForm.includes('class="dots"') && !noForm.includes('>Form<'));
  const ucl = tableView({ data: { rows: [] }, meta: { coverage: { notes: [] } } }, { reason: 'Champions League table not available.' });
  assert.ok(ucl.includes('Champions League table not available.'));
});

test('V2: MLS is in the rail, filters and selectors; team observed players are sourced only', () => {
  assert.deepEqual(FEATURED, ['mls', 'premier-league', 'la-liga', 'serie-a', 'ligue-1', 'bundesliga', 'uefa-champions-league', 'uefa-europa-league', 'uefa-nations-league', 'fifa-world-cup', 'womens-super-league', 'uefa-womens-champions-league', 'liga-f', 'premiere-ligue']);
  const t = team.render({ env: { data: { name: 'A', form: [], recent: [], upcoming: [], records: [], players_observed: { lineups_counted: 0, players: [] } }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } } });
  assert.ok(t.includes('PLAYERS OBSERVED IN SOURCE DATA') && t.includes('Squad lists are never guessed'));
  const t2 = team.render({ env: { data: { name: 'A', form: ['W'], recent: [], upcoming: [], records: [{ competition: { slug: 'mls', name: 'MLS' }, season: '2026', position: 3, teams_in_table: 30, record: { played: 30, won: 15, drawn: 5, lost: 10, goal_difference: 8, points: 50, form: ['W'] } }], players_observed: { lineups_counted: 2, players: [{ slug: 'p', name: 'P', role: 'forward', appearances: 2, starts: 1, named: 2 }] } }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } } });
  assert.ok(t2.includes('of 30') && t2.includes('+8') && t2.includes('/players/p'));
  const tb = tables.render({ comp: 'mls', comps: { status: 'fulfilled', value: { data: FEATURED.map(slug => ({ slug })) } }, table: { status: 'fulfilled', value: { data: { rows: [] }, meta: { coverage: { notes: [] } } } } });
  assert.ok(tb.includes('Major League Soccer') && tb.indexOf('>MLS<') < tb.indexOf('Premier League'));
});

test('match page, spatial:false competition (Liga F): one neutral no-map panel, never a pitch promise or empty map', () => {
  const e = espnMatch();
  const html = match.render({ env: { ...e, data: { ...e.data, competition: { slug: 'liga-f', name: 'Liga F' }, shots: [], coordinates: null } } });
  assert.ok(html.includes('SHOT MAP NOT AVAILABLE') && html.includes('without pitch locations'));
  assert.ok(!html.includes('class="pitchwrap'), 'no pitch drawn');
  assert.ok(!html.includes('Every shot on the canonical 105 × 68 m pitch'), 'no map promise');
  assert.ok(!html.includes('No event map for this match'), 'no generic missing-data state');
  assert.ok(html.includes('STARTING XI') && html.includes('SOURCE MATCH STATISTICS'), 'the rest of the match renders');
});
