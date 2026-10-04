// Live-first discovery + one competition identity (soccer UI pass 2026-10-04).
// Regression case = production /matches?view=today at 2026-10-04 17:15Z: Tottenham Women v London City FINAL
// rendered ABOVE five LIVE matches because the list was kickoff-ordered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupByState, liveFirst, stateCounts, liveByCompetition, uniqueMatches } from '../../src/lib/match-order.js';
import { ALL_COMPS, FEATURED_COMPS, resolveComp, foldLabel } from '../../src/lib/competitions.js';
import { COMPETITION_MEDIA } from '../../src/lib/competition-media.js';
import { competitionMark } from '../../src/components/media.js';
import { matchCard } from '../../src/components/ui.js';
import { matches } from '../../src/pages/lists.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/matches-today-2026-10-04.json', import.meta.url), 'utf8')).data;
const name = m => `${m.home.name} v ${m.away.name}`;
const LIVE5 = ['Manchester City Women v Arsenal Women', 'Malta v Andorra', 'Kosovo v Austria', 'Gotham FC v Angel City FC', 'Barcelona Women v Real Madrid Women'];

test('screenshot regression: all five live matches lead, above Tottenham v London City FINAL', () => {
  // The fixture really is kickoff-ordered with the final first (the bug's input).
  assert.ok(fx.findIndex(m => name(m).startsWith('Tottenham')) < fx.findIndex(m => m.status === 'live'));
  const order = liveFirst(fx);
  assert.deepEqual(order.slice(0, 5).map(name).sort(), [...LIVE5].sort());
  const lastLive = order.findLastIndex(m => m.status === 'live');
  const firstOther = order.findIndex(m => m.status !== 'live');
  assert.ok(lastLive < firstOther, 'no non-live match above a live one');
  const g = groupByState(fx);
  assert.deepEqual(g.map(x => x.key), ['live', 'upcoming', 'final']);
  assert.equal(g[0].matches.length, 5);
  // Within LIVE: kickoff ascending (the longest-running match first).
  assert.equal(name(g[0].matches[0]), 'Manchester City Women v Arsenal Women');
  // FINAL: most recent first.
  assert.ok(Date.parse(g[2].matches[0].kickoff_at) >= Date.parse(g[2].matches.at(-1).kickoff_at));
  assert.deepEqual(stateCounts(fx), { all: 23, live: 5, upcoming: 8, final: 10, other: 0 });
});

test('every input order gives the same live-first result (no position bias)', () => {
  const ref = liveFirst(fx).map(m => m.id);
  for (let i = 0; i < 20; i++) {
    const shuffled = [...fx].sort(() => Math.random() - 0.5);
    assert.deepEqual(liveFirst(shuffled).map(m => m.id), ref);
  }
});

test('no duplicates: a match present in both the live feed and the day list is shown once', () => {
  const live = fx.filter(m => m.status === 'live');
  const merged = uniqueMatches(live, fx);
  assert.equal(merged.length, fx.length);
  assert.equal(liveFirst([...fx, ...live]).length, fx.length);
});

test('a live update regroups the match, never duplicates it', () => {
  const before = groupByState(fx);
  const kickoffSoon = before.find(g => g.key === 'upcoming').matches[0];
  const liveNow = before.find(g => g.key === 'live').matches[0];
  const next = fx.map(m => m.id === kickoffSoon.id ? { ...m, status: 'live' } : m.id === liveNow.id ? { ...m, status: 'finished' } : m);
  const after = groupByState(next);
  const where = id => after.filter(g => g.matches.some(m => m.id === id)).map(g => g.key);
  assert.deepEqual(where(kickoffSoon.id), ['live']);
  assert.deepEqual(where(liveNow.id), ['final']);
  assert.equal(after.reduce((n, g) => n + g.matches.length, 0), fx.length);
});

test('non-standard states are kept (after FINAL), never dropped', () => {
  const g = groupByState([...fx, { id: 'p1', status: 'postponed', kickoff_at: fx[0].kickoff_at }, { id: 'u1', status: null, kickoff_at: null }]);
  assert.equal(g.at(-1).key, 'other'); assert.equal(g.at(-1).matches.length, 2);
});

test('live counts per competition', () => {
  assert.deepEqual(liveByCompetition(fx), { 'womens-super-league': 1, 'uefa-nations-league': 2, nwsl: 1, 'liga-f': 1 });
});

test('/matches today: LIVE NOW · 5 section first, state filter, live-first competition filter', () => {
  const d = { view: 'today', comp: '', state: '', team: '', list: { status: 'fulfilled', value: { data: fx, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } } },
    comps: { status: 'fulfilled', value: { data: FEATURED_COMPS.map(c => ({ slug: c.slug })) } }, live: { status: 'fulfilled', value: { data: fx.filter(m => m.status === 'live') } } };
  const html = matches.render(d);
  const sections = [...html.matchAll(/data-mgroup="(\w+)"/g)].map(x => x[1]);
  assert.deepEqual(sections, ['live', 'upcoming', 'final']);
  assert.match(html, /LIVE NOW <span class="mg-n">· 5<\/span>/);
  // Every live card sits before the first non-live card in document order.
  const cards = [...html.matchAll(/<article class="mcard st-(\w+)"/g)].map(x => x[1]);
  assert.ok(cards.lastIndexOf('live') < cards.findIndex(s => s !== 'live'));
  assert.equal(cards.length, fx.length, 'no duplicates from merging the live feed');
  assert.match(html, /class="statebar"/); assert.match(html, /state=live/);
  // Competition filter: Nations League (2 live) leads, every enabled competition is present (none hidden).
  const chips = [...html.matchAll(/competition=([a-z0-9-]+)&amp;state=|competition=([a-z0-9-]+)"/g)].map(x => x[1] || x[2]);
  const order = [...new Set(chips)];
  assert.equal(order[0], 'uefa-nations-league');
  for (const c of FEATURED_COMPS) assert.ok(order.includes(c.slug), `${c.slug} in the filter`);
  // State filter view keeps only that group; competition filter keeps a way back to other live matches.
  const onlyLive = matches.render({ ...d, state: 'live' });
  assert.deepEqual([...onlyLive.matchAll(/data-mgroup="(\w+)"/g)].map(x => x[1]), ['live']);
  const nwslOnly = matches.render({ ...d, comp: 'nwsl', list: { ...d.list, value: { ...d.list.value, data: fx.filter(m => m.competition.slug === 'nwsl') } } });
  assert.match(nwslOnly, /4 more live in other competitions/);
  assert.match(nwslOnly, /LIVE NOW <span class="mg-n">· 1<\/span>/);
});

test('/matches recent view: live matches still lead under LIVE NOW', () => {
  const finals = fx.filter(m => m.status === 'finished');
  const html = matches.render({ view: 'recent', comp: '', state: '', team: '', list: { status: 'fulfilled', value: { data: finals, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } } },
    comps: { status: 'fulfilled', value: { data: [] } }, live: { status: 'fulfilled', value: { data: fx.filter(m => m.status === 'live') } } });
  assert.deepEqual([...html.matchAll(/data-mgroup="(\w+)"/g)].map(x => x[1]), ['live', 'final']);
  assert.doesNotMatch(html, /class="statebar"/, 'state filter is a Today control');
});

test('competition identity: aliases fold to ONE identity; unknown labels resolve to nothing', () => {
  for (const [label, slug] of [['NWSL', 'nwsl'], ['usa.nwsl', 'nwsl'], ["National Women's Soccer League", 'nwsl'], ['national womens soccer league', 'nwsl'],
    ["Women’s Super League", 'womens-super-league'], ['eng.w.1', 'womens-super-league'], ['Première Ligue', 'premiere-ligue'], ['Premiere Ligue', 'premiere-ligue'],
    ['UEFA Nations League', 'uefa-nations-league'], ['EPL', 'premier-league'], ['La Liga', 'la-liga'], ['ger.1', 'bundesliga']]) assert.equal(resolveComp(label)?.slug, slug, label);
  for (const bad of ['', null, 'Arsenal', 'Premier', 'international', 'Women', 'Bundesliga 2', 'Frauen-Bundesliga', 'copa-libertadores']) assert.equal(resolveComp(bad), null, String(bad));
  // No label belongs to two competitions (a collision would be resolved to null above, i.e. fail a slug test).
  const owners = new Map();
  for (const c of ALL_COMPS) for (const l of [c.slug, c.name, c.long, c.mono, c.espn, ...(c.aliases || [])]) { const k = foldLabel(l); if (!k) continue; assert.ok(!owners.has(k) || owners.get(k) === c.slug, `${l}: ${owners.get(k)} and ${c.slug}`); owners.set(k, c.slug); }
  for (const c of ALL_COMPS) assert.equal(resolveComp({ slug: c.slug, name: 'anything' })?.slug, c.slug);
});

test('competition logos: every enabled competition is a real logo or a deliberate mono fallback', () => {
  const FALLBACK = new Set(['liga-f', 'premiere-ligue']); // provider publishes no current logo (docs/evidence/media/competition-logos-2026-10-04.json)
  for (const c of FEATURED_COMPS) {
    const html = competitionMark(c.slug, 'xs');
    if (FALLBACK.has(c.slug)) { assert.equal(COMPETITION_MEDIA[c.slug], undefined); assert.match(html, new RegExp(`class="cmono a-${c.accent} xs"[^>]*>${c.mono}<`)); continue; }
    const l = COMPETITION_MEDIA[c.slug]; assert.ok(l?.url, `${c.slug}: approved logo`);
    assert.match(l.url, /^\/api\/soccer\/media\/[0-9a-f]{64}$/); assert.equal(l.basis, 'owner_approved_identification');
    assert.ok(html.includes(`src="${l.url}"`)); assert.ok(l.attribution.length > 5);
    assert.match(html, new RegExp(`data-fallback-comp="${c.mono}"`), 'a broken file falls back to its own mono');
  }
  // No two competitions share a logo file (no cross-league logo).
  const urls = Object.values(COMPETITION_MEDIA).map(l => l.url);
  assert.equal(new Set(urls).size, urls.length);
  // Aliases reach the same logo; an unknown competition never borrows one.
  assert.equal(competitionMark('NWSL', 'xs'), competitionMark('nwsl', 'xs'));
  assert.match(competitionMark('Frauen-Bundesliga', 'xs'), /class="cmono a-x xs"/);
  // A logo without its own dark variant sits on a light plate on dark surfaces; one with its own variant uses it.
  assert.match(competitionMark('uefa-womens-champions-league', 'xs', { tone: 'dark' }), /class="clogo t-dark plate xs"/);
  assert.match(competitionMark('premier-league', 'xs', { tone: 'dark' }), /class="clogo t-dark xs"/);
});

test('match card: competition identity is separate from club crests / national flags', () => {
  const m = fx.find(x => x.competition.slug === 'uefa-nations-league');
  const html = matchCard({ ...m, competition: { slug: 'uefa-nations-league', name: 'UEFA Nations League' }, home: { ...m.home, crest: { url: '/api/soccer/media/' + 'a'.repeat(64), attribution: 'x' } } });
  assert.match(html, /class="mc-comp"[^>]*>.*class="clogo t-light xs"/s);
  assert.ok(html.includes(COMPETITION_MEDIA['uefa-nations-league'].url));
  assert.match(html, /class="tmark img"/, 'national team mark is its own element');
  assert.doesNotMatch(html.match(/<span class="tmark img">.*?<\/span>/s)[0], new RegExp(COMPETITION_MEDIA['uefa-nations-league'].url));
  // A feed spelling the league out lands on the same identity, label and link.
  const spelled = matchCard({ ...fx.find(x => x.competition.slug === 'nwsl'), competition: { slug: null, name: "National Women's Soccer League" } });
  assert.match(spelled, /href="\/competitions\/nwsl"/); assert.match(spelled, /<span>NWSL<\/span>/);
});

test('the matches page never implies model coverage', () => {
  const src = readFileSync('src/pages/lists.js', 'utf8');
  const block = src.slice(src.indexOf('// ---- /matches'), src.indexOf('// ---- /tables'));
  assert.doesNotMatch(block, /algo|model|pick|forecast/i);
});
