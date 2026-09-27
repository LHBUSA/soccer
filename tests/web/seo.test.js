// Server-first SEO contract tests (inline API-shaped inputs, not committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMeta, metaPlan, injectMeta, headTags, NOINDEX, SITE, canonicalFor } from '../../src/seo/meta.js';
import { urlset, sitemapIndex, STATIC_PATHS, KINDS } from '../../api/sitemap.js';
import middleware from '../../middleware.js';

const MATCH = { data: { id: '5b0c8f3e-1111-5222-8333-444455556666', status: 'finished', kickoff_at: '2026-09-20T15:30:00Z', season: '2026/27',
  home: { slug: 'fulham', name: 'Fulham' }, away: { slug: 'manchester-united', name: 'Manchester United' }, score: { home: 1, away: 1 },
  competition: { slug: 'premier-league', name: 'Premier League' }, venue: null, timeline: [{}], shots: [{}, {}], stats: { basis: 'source' }, lineups: { home: {} } }, meta: {} };
const HTML = '<!doctype html><html><head><meta charset="utf-8"><title>PropBetEdge Soccer Intelligence</title><meta name="description" content="x"></head><body><div id="app"></div></body></html>';

test('metaPlan: API calls only for entity routes; unknown routes are notfound', () => {
  assert.deepEqual(metaPlan('/matches/5b0c8f3e-1111-5222-8333-444455556666').calls, ['matches/5b0c8f3e-1111-5222-8333-444455556666']);
  assert.deepEqual(metaPlan('/competitions/bundesliga').calls, ['competitions/bundesliga', 'table?competition=bundesliga']);
  assert.equal(metaPlan('/sources').calls, undefined);
  assert.equal(metaPlan('/random/thing').page, 'notfound');
});

test('match meta: sourced facts only, SportsEvent without fabricated fields', () => {
  const m = buildMeta(`/matches/${MATCH.data.id}`, 'match', [MATCH]);
  assert.equal(m.status, 200);
  assert.equal(m.title, 'Fulham vs Manchester United — Match Intelligence | PropBetEdge Soccer');
  assert.equal(m.description, 'Fulham 1–1 Manchester United · Premier League 2026/27 · 20 September 2026. Full time. Match Intelligence: event map (2 shots), source stats, lineups, timeline.');
  assert.equal(m.canonical, `${SITE}/matches/${MATCH.data.id}`);
  const ev = m.jsonld.find(j => j['@type'] === 'SportsEvent');
  assert.equal(ev.name, 'Fulham vs Manchester United'); assert.equal(ev.startDate, '2026-09-20T15:30:00Z');
  assert.equal(ev.homeTeam.name, 'Fulham'); assert.equal(ev.superEvent.name, 'Premier League 2026/27');
  for (const k of ['location', 'performer', 'offers', 'image', 'organizer', 'attendee']) assert.equal(ev[k], undefined, k); // venue null -> no location
  const withVenue = buildMeta('/matches/x', 'match', [{ data: { ...MATCH.data, venue: { name: 'Craven Cottage', city: 'London' } } }]);
  assert.equal(withVenue.jsonld[0].location.name, 'Craven Cottage');
});

test('competition meta claims a table only when one exists', () => {
  const comp = { data: { slug: 'uefa-champions-league', name: 'UEFA Champions League', seasons: [{ label: '2026/27', matches: 144 }] } };
  const noTable = buildMeta('/competitions/uefa-champions-league', 'competition', [comp, { data: { rows: [] } }]);
  assert.ok(!/table/i.test(noTable.title) && !/table/i.test(noTable.description));
  const withTable = buildMeta('/competitions/uefa-champions-league', 'competition', [comp, { data: { rows: [{}] } }]);
  assert.match(withTable.title, /Table, Results & Fixtures/);
  assert.match(withTable.description, /1 stored season, 144 canonical matches/);
});

test('team and player meta: only graph-supported JSON-LD fields', () => {
  const t = buildMeta('/teams/fulham', 'team', [{ data: { slug: 'fulham', name: 'Fulham', official_name: null, city: null, form: ['W', 'D'], recent: [{ id: 'x', home: { name: 'Fulham' }, away: { name: 'B' }, competition: { name: 'Premier League' } }], upcoming: [] } }]);
  assert.equal(t.title, 'Fulham — Soccer Intelligence | PropBetEdge');
  const st = t.jsonld.find(j => j['@type'] === 'SportsTeam');
  assert.deepEqual(Object.keys(st).sort(), ['@context', '@type', 'name', 'sport', 'url']);
  const p = buildMeta('/players/x', 'player', [{ data: { slug: 'x', name: 'Test Player', first_name: 'Test', last_name: 'Player', birth_date: null, role: null, seasons: [] } }]);
  const person = p.jsonld.find(j => j['@type'] === 'Person');
  for (const k of ['birthDate', 'nationality', 'image', 'jobTitle', 'memberOf', 'height']) assert.equal(person[k], undefined, k);
  assert.equal(p.title, 'Test Player — Player Intelligence | PropBetEdge Soccer');
  const full = buildMeta('/players/y', 'player', [{ data: { slug: 'y', name: 'Y', birth_date: '1988-08-21', nationality_code: 'POL', height_cm: 185, seasons: [{ season: '2017/18' }] } }]);
  const pf = full.jsonld[0];
  assert.equal(pf.birthDate, '1988-08-21'); assert.equal(pf.nationality.identifier, 'POL'); assert.equal(pf.height.value, 185);
});

test('missing entity and unknown route -> 404 noindex, no canonical', () => {
  const miss = buildMeta('/matches/x', 'match', [{ notFound: true }]);
  assert.equal(miss.status, 404); assert.equal(miss.robots, NOINDEX); assert.equal(miss.canonical, null);
  assert.equal(buildMeta('/nope', 'notfound').status, 404);
  assert.equal(buildMeta('/news', 'news').robots, NOINDEX);
});

test('injected head: exactly one canonical/title/description/robots, OG + Twitter, SSR h1', () => {
  const m = buildMeta(`/matches/${MATCH.data.id}`, 'match', [MATCH]);
  const out = injectMeta(HTML, m);
  for (const [re, n] of [[/<link rel="canonical"/g, 1], [/<title>/g, 1], [/<meta name="description"/g, 1], [/<meta name="robots"/g, 1]]) assert.equal((out.match(re) || []).length, n, String(re));
  for (const s of ['og:title', 'og:description', 'og:url', 'og:image', 'twitter:card" content="summary_large_image', 'twitter:title', 'application/ld+json', '<h1>Fulham 1–1 Manchester United</h1>']) assert.ok(out.includes(s), s);
  assert.ok(!out.includes('vercel.app') && !out.includes('workers.dev'));
  assert.ok(!headTags({ ...m, title: '</script><script>x' }).includes('</script><script>x'));
  assert.equal(canonicalFor('/teams/fulham/'), `${SITE}/teams/fulham`);
});

test('sitemap builders emit canonical URLs and lastmod only when given', () => {
  const xml = urlset([{ loc: `${SITE}/teams/a` }, { loc: `${SITE}/teams/b`, lastmod: '2026-09-27T16:00:00.000Z' }]);
  assert.equal((xml.match(/<url>/g) || []).length, 2);
  assert.equal((xml.match(/<lastmod>/g) || []).length, 1);
  assert.ok(sitemapIndex(KINDS.map(k => ({ loc: `${SITE}/sitemap-${k}.xml` }))).includes('sitemap-players.xml'));
  assert.ok(!STATIC_PATHS.includes('/news'));
});

test('middleware: real statuses and first-response tags (stubbed network)', async () => {
  const realFetch = globalThis.fetch;
  const upstreamBody = { current: null };
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (/\/v1\//.test(String(url))) {
      if (upstreamBody.current === 'down') return new Response('x', { status: 500 });
      if (upstreamBody.current === 'missing') return new Response('{"error":"not found"}', { status: 404 });
      return new Response(JSON.stringify(MATCH), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(HTML, { status: String(url).includes('/nope') ? 404 : 200, headers: { 'content-type': 'text/html' } });
  };
  try {
    const ok = await middleware(new Request(`${SITE}/matches/${MATCH.data.id}`));
    assert.equal(ok.status, 200);
    const body = await ok.text();
    assert.ok(body.includes('<link rel="canonical" href="https://soccer.propbetedge.ai/matches/'));
    upstreamBody.current = 'missing';
    const miss = await middleware(new Request(`${SITE}/matches/${MATCH.data.id}`));
    assert.equal(miss.status, 404); assert.equal(miss.headers.get('x-robots-tag'), NOINDEX);
    assert.ok((await miss.text()).includes('content="noindex, follow"'));
    const unknown = await middleware(new Request(`${SITE}/nope`));
    assert.equal(unknown.status, 404);
    upstreamBody.current = 'down';
    const down = await middleware(new Request(`${SITE}/teams/fulham`));
    assert.equal(down.status, 503); assert.equal(down.headers.get('retry-after'), '120');
    assert.equal(await middleware(new Request(`${SITE}/assets/app.js`)), undefined);
  } finally { globalThis.fetch = realFetch; }
});

test('newsroom SEO: index only with published stories, NewsArticle for articles, wrong desk is 404', async () => {
  const { resolve } = await import('../../src/lib/router.js');
  assert.equal(resolve('/news/mls').page, 'newsDesk');
  assert.deepEqual(resolve('/news/champions-league/some-story-abc123').params, ['champions-league', 'some-story-abc123']);
  assert.equal(resolve('/news/la-liga').page, 'notfound');
  assert.deepEqual(metaPlan('/news/bundesliga/x-story').calls, ['news/x-story']);
  const empty = buildMeta('/news', 'news', [{ data: [] }]);
  assert.equal(empty.robots, NOINDEX); assert.equal(empty.status, 200);
  const items = [{ desk: 'mls', slug: 'a-story', headline: 'Inter Miami CF beat Toronto FC 6-0' }];
  const full = buildMeta('/news', 'news', [{ data: items }]);
  assert.match(full.robots, /^index/); assert.ok(full.jsonld.some(j => j['@type'] === 'ItemList'));
  assert.equal(buildMeta('/news/mls', 'newsDesk', [{ data: [] }]).robots, NOINDEX);
  const art = { data: { desk: 'mls', slug: 'a-story', headline: 'Inter Miami CF beat Toronto FC 6-0', dek: 'MLS 2026.', published_at: '2026-09-21T12:00:00Z', updated_at: '2026-09-21T12:00:00Z', entities: [{ type: 'SportsTeam', name: 'Inter Miami CF', slug: 'inter-miami-cf', href: '/teams/inter-miami-cf' }] } };
  const m = buildMeta('/news/mls/a-story', 'article', [art]);
  const na = m.jsonld.find(j => j['@type'] === 'NewsArticle');
  assert.equal(m.status, 200); assert.equal(m.ogType, 'article'); assert.equal(na.datePublished, '2026-09-21T12:00:00Z'); assert.equal(na.articleSection, 'MLS');
  assert.equal(na.about[0].name, 'Inter Miami CF'); assert.equal(m.canonical, `${SITE}/news/mls/a-story`);
  assert.equal(buildMeta('/news/bundesliga/a-story', 'article', [art]).status, 404); // desk mismatch
  assert.equal(buildMeta('/news/mls/nope', 'article', [{ notFound: true }]).status, 404);
  assert.ok(KINDS.includes('news'));
});
