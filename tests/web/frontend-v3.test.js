// Frontend V3 product pass: score ticker, news desk curation + imagery, key players, Player DNA
// radar, team/player helpers. Inputs are inline objects shaped like the API (no mock data files).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tickerItems, tickerItem } from '../../src/components/score-ticker.js';
import { materiality, selectHomepageLead, latestNews, leadScore } from '../../src/lib/news.js';
import { newsMedia, newsDesk, pickFeatured } from '../../src/pages/home.js';
import { keyPlayerRows, todayLine, keyPlayers } from '../../src/components/keyplayers.js';
import { dnaRadar } from '../../src/components/dna.js';
import { ageOn, squadCard } from '../../src/pages/people.js';
import { quickGA } from '../../src/pages/players.js';
import { crest, initials } from '../../src/components/media.js';

const NOW = Date.parse('2026-09-28T16:00:00Z');
const mm = (id, extra = {}) => ({ id: `5b0c8f3e-1111-5222-8333-44445555${id}`, competition: { slug: 'mls', name: 'MLS' }, home: { name: 'Columbus Crew', short_name: 'Columbus' }, away: { name: 'Inter Miami CF', short_name: 'Miami' }, kickoff_at: new Date(NOW + 3600e3).toISOString(), score: null, ...extra });

test('ticker: live first, then kick-offs within 36 h, then finals; each item opens PBEcast', () => {
  const x = { live: [mm('0001', { score: { home: 2, away: 1 }, live: { display_clock: "67'" } })], upcoming: [mm('0002'), mm('0003', { kickoff_at: new Date(NOW + 72 * 3600e3).toISOString() })], recent: [mm('0004', { score: { home: 2, away: 1 } })] };
  const items = tickerItems(x, NOW);
  assert.deepEqual(items.map(i => i.k), ['live', 'next', 'ft']);
  const live = tickerItem(items[0]);
  assert.match(live, /href="\/pbecast\/5b0c8f3e-/); assert.match(live, />LIVE</); assert.match(live, /67&#39;|67'/);
  assert.match(live, /<b>Columbus<\/b><i>2<\/i>/);
  assert.match(tickerItem(items[2]), /FINAL/);
  assert.doesNotMatch(tickerItem(items[1]), /<i>/, 'no score before kick-off');
  assert.match(tickerItem(items[0], { stale: true }), /LIVE · DELAYED/, 'old data never shows an unqualified LIVE');
});

test('ticker CSS: no native scrollbar, no page overflow, reduced motion respected', () => {
  const css = readFileSync('src/styles/main.css', 'utf8');
  assert.match(css, /\.stk-viewport \{[^}]*scrollbar-width: none/);
  assert.match(css, /\.stk-viewport::-webkit-scrollbar \{ display: none; \}/);
  assert.match(css, /\.stk \{[^}]*overflow: hidden/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{ \.stk-track\.marquee \{ animation: none/);
  const main = readFileSync('src/main.js', 'utf8');
  assert.match(main, /mountScoreTicker\(document\.getElementById\('score-ticker'\)\)/, 'mounted once, in the shell');
});

const art = (slug, story_class, headline, hoursAgo, image = null) => ({ slug, desk: 'premier-league', story_class, headline, published_at: new Date(NOW - hoursAgo * 3600e3).toISOString(), image });

test('news: lead = materiality x freshness (deterministic); latest is chronological without the lead', () => {
  const items = [
    art('a', 'team_trend', 'Arsenal make it 3 Premier League wins in a row', 1),
    art('b', 'match_recap', 'Bayern München beat 1. FC Union Berlin 7-0: Michael Olise hat-trick', 19, { kind: 'portrait', url: '/api/soccer/media/x' }),
    art('c', 'match_recap', 'Chicago Fire FC win 1-0 at Charlotte FC', 2),
    art('d', 'match_recap', 'Big old result 6-0: someone hat-trick', 200),
  ];
  assert.ok(materiality(items[1]) > materiality(items[2]));
  assert.equal(selectHomepageLead(items, NOW).slug, 'b', 'a big, fresh, illustrated result beats a generic trend');
  assert.equal(selectHomepageLead([...items].reverse(), NOW).slug, 'b', 'order-independent');
  assert.ok(leadScore(items[3], NOW) < leadScore(items[2], NOW), 'a stale recap loses to a fresh one');
  assert.deepEqual(latestNews(items, items[1]).map(a => a.slug), ['a', 'c', 'd']);
  assert.equal(selectHomepageLead([], NOW), null);
});

test('news imagery: approved portrait -> approved crest -> branded owned fallback; never a remote hotlink', () => {
  const p = newsMedia({ desk: 'premier-league', image: { kind: 'portrait', url: '/api/soccer/media/ab', attribution: 'X' } }, 'lead');
  assert.match(p, /k-portrait/); assert.match(p, /\/api\/soccer\/media\/ab/);
  assert.match(newsMedia({ desk: 'bundesliga', image: { kind: 'crest', url: '/api/soccer/media/cd', alt: 'Bayern' } }), /k-crest/);
  const fb = newsMedia({ desk: 'mls', image: null });
  assert.match(fb, /k-brand/); assert.match(fb, /\/brand\/soccer-stadium-1600\.webp/); assert.match(fb, /class="clogo t-dark lg"/, 'the branded fallback carries the real competition logo');
  for (const h of [p, fb]) assert.doesNotMatch(h, /https?:\/\//, 'same-origin only');
  const desk = newsDesk({ data: [art('a', 'team_trend', 'A', 1), art('b', 'match_recap', 'B beat C 5-0', 2)] });
  assert.match(desk, /class="nlead"/); assert.match(desk, /LATEST/);
});

test('featured match: live first, else the biggest recent event-mapped result', () => {
  assert.equal(pickFeatured({ live: [mm('0001')], recent: [] }).kind, 'live');
  const r = pickFeatured({ live: [], recent: [mm('0002', { score: { home: 1, away: 0 }, intel: { event_map: true } }), mm('0003', { score: { home: 3, away: 3 }, intel: { event_map: true } }), mm('0004', { score: { home: 5, away: 5 }, intel: { event_map: false } })] });
  assert.equal(r.m.id.endsWith('0003'), true);
  assert.equal(pickFeatured({ live: [], recent: [] }), null);
});

test('key players: sourced counts only, deterministic order, drawer carries the match context', () => {
  const m = { id: 'm1', home: { short_name: 'H' }, away: { short_name: 'A' }, players: { rows: [
    { player: { slug: 'a', name: 'A' }, team: 'home', goals: 1, shots: 3, minutes_nominal: 90 },
    { player: { slug: 'b', name: 'B' }, team: 'away', goals: 2, minutes_nominal: 90 },
    { player: { slug: 'c', name: 'C' }, team: 'home', minutes_nominal: 90 },
    { player: { name: 'No page' }, team: 'home', goals: 3 },
  ] } };
  assert.deepEqual(keyPlayerRows(m).map(r => r.player.slug), ['b', 'a'], 'no-impact and page-less rows are left out');
  assert.equal(todayLine({ goals: 1, shots: 3, assists: null, minutes_nominal: 90 }), '1 goal · 3 shots · 90 min');
  assert.doesNotMatch(todayLine({ goals: 0, assists: undefined, minutes_nominal: 12 }), /0 goal/);
  const html = keyPlayers(m);
  assert.match(html, /data-player-slug="b" data-match-id="m1"/);
});

test('Player DNA radar: ranked metrics only, needs 3 axes, labels named', () => {
  const metrics = [['goals_per90', 99], ['shots_per90', 80], ['assists_per90', 60], ['cards_per90', null]].map(([key, percentile]) => ({ key, percentile, value: 1 }));
  const svg = dnaRadar(metrics);
  assert.match(svg, /class="dna-radar"/);
  assert.equal((svg.match(/class="rd /g) || []).length, 3, 'null percentile is not plotted');
  assert.match(svg, /Goals per 90 p99/);
  assert.equal(dnaRadar(metrics.slice(0, 2)), '');
});

test('team + player helpers: age from sourced DOB only; quick G+A/90 only when qualified; squad cards with portraits', () => {
  assert.equal(ageOn('1987-06-24', new Date('2026-09-28T00:00:00Z')), 39);
  assert.equal(ageOn('1987-10-01', new Date('2026-09-28T00:00:00Z')), 38);
  assert.equal(ageOn(null), null);
  assert.equal(quickGA({ qualified: true, minutes_nominal: 2000, goals: 20, assists: 11 }), '1.40');
  assert.equal(quickGA({ qualified: false, minutes_nominal: 200, goals: 1, assists: 0 }), '—');
  assert.equal(quickGA({ qualified: true, minutes_nominal: 900, goals: null, assists: 1 }), '—', 'a missing count is never zero');
  const card = squadCard({ slug: 'x', name: 'X', role: 'forward', appearances: 3, starts: 2 });
  assert.match(card, /pic pic-md sil/); assert.match(card, /data-player-slug="x"/); assert.doesNotMatch(card, /goals/, 'no DNA counts shown when the cache has none');
});

test('premium monogram: up to four initials, never a fake crest', () => {
  assert.equal(initials('Red Bull New York'), 'RBNY');
  assert.equal(initials('Arsenal'), 'ARS');
  assert.match(crest({ name: 'Red Bull New York' }), /class="tmark m4"/);
  assert.doesNotMatch(crest({ name: 'Arsenal' }), /<img/);
});

test('ticker: one semantic score list; the marquee copy is aria-hidden, inert, unselectable and nosnippet', () => {
  const src = readFileSync('src/components/score-ticker.js', 'utf8');
  for (const needle of ["setAttribute('aria-hidden', 'true')", "setAttribute('inert', '')", "setAttribute('data-nosnippet', '')", "removeAttribute('href')", 'a.tabIndex = -1']) assert.ok(src.includes(needle), needle);
  assert.match(readFileSync('src/styles/main.css', 'utf8'), /\.stk-clone \{[^}]*user-select: none/);
});

test('competitionMark: approved same-origin logo, provider dark variant on dark surfaces, mono fallback', async () => {
  const { competitionMark } = await import('../../src/components/media.js');
  const { COMPETITION_MEDIA } = await import('../../src/lib/competition-media.js');
  for (const slug of ['mls', 'premier-league', 'uefa-champions-league', 'bundesliga']) {
    const l = COMPETITION_MEDIA[slug]; assert.ok(l?.url, slug);
    assert.match(l.url, /^\/api\/soccer\/media\/[0-9a-f]{64}$/); assert.equal(l.basis, 'owner_approved_identification');
    const light = competitionMark(slug, 'lg'); const dark = competitionMark(slug, 'lg', { tone: 'dark' });
    assert.match(light, /class="clogo t-light lg"/); assert.ok(light.includes(`src="${l.url}"`)); assert.ok(dark.includes(`src="${l.url_dark || l.url}"`));
    assert.match(light, /data-fallback-comp="[A-Z]+"/, 'a broken file falls back to the mono');
    assert.doesNotMatch(light + dark, /https?:\/\//);
  }
  assert.match(competitionMark('copa-libertadores', 'xs'), /class="cmono a-x xs"/, 'no approved logo -> premium mono');
  const ui = readFileSync('src/components/ui.js', 'utf8'); assert.doesNotMatch(ui, /function compMono/, 'one competition mark component');
  assert.match(readFileSync('src/main.js', 'utf8'), /competitionMark\(c\.slug, 'xs', \{ tone: 'dark' \}\)/, 'top competition navigation');
  assert.match(readFileSync('src/components/score-ticker.js', 'utf8'), /competitionMark\(m\.competition\.slug/, 'score ticker');
});
