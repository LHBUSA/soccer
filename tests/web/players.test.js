// /players directory contract: URL state, rate leaders only inside one competition, sourced cards.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from '../../src/lib/router.js';
import { hrefFor, playerCard, readQuery, render } from '../../src/pages/players.js';
import { buildMeta, metaPlan } from '../../src/seo/meta.js';
import { STATIC_PATHS } from '../../api/sitemap.js';

const q = s => readQuery(new URLSearchParams(s));

test('route + static meta + sitemap', () => {
  assert.equal(resolve('/players').page, 'players');
  assert.equal(resolve('/players/').page, 'players');
  assert.equal(resolve('/players/lionel-messi').page, 'player');
  assert.deepEqual(metaPlan('/players'), { page: 'players' });
  const m = buildMeta('/players', 'players');
  assert.equal(m.status, 200); assert.match(m.title, /Player DNA/); assert.equal(m.canonical, 'https://soccer.propbetedge.ai/players');
  assert.ok(STATIC_PATHS.includes('/players'));
});

test('query: unknown values fall back; per-90 sorts need one competition', () => {
  assert.deepEqual(q(''), { competition: '', sort: 'goals', role: '', q: '', team: '', page: 1 });
  assert.equal(q('team=portland-timbers').team, '', 'a team filter needs one competition');
  assert.equal(q('competition=mls&team=portland-timbers').team, 'portland-timbers');
  assert.equal(hrefFor(q('competition=mls&team=portland-timbers'), { competition: 'premier-league' }), '/players?competition=premier-league', 'changing competition drops the team');
  assert.equal(q('sort=goals_per90').sort, 'goals', 'no cross-competition rate leaders');
  assert.equal(q('competition=mls&sort=goals_per90').sort, 'goals_per90');
  assert.equal(q('competition=la-liga').competition, '');
  assert.equal(q('role=striker').role, '');
  assert.equal(q('page=-4').page, 1);
  assert.equal(hrefFor(q('competition=mls&sort=goals_per90'), { competition: '' }), '/players', 'leaving the competition drops the rate sort');
  assert.equal(hrefFor(q(''), { competition: 'mls', page: 2 }), '/players?competition=mls&page=2');
});

test('cards: leaders show value + named pool; missing values stay missing', () => {
  const p = { slug: 'x', name: 'X', role: 'forward', team: null, competition: { slug: 'mls' }, appearances: 3, minutes_nominal: 200, goals: 1, assists: null, qualified: false, value: 1.4, percentile: 100, compared_with: 554 };
  const lead = playerCard(p, { leaders: true });
  assert.match(lead.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' '), /p100 of 554/); // visible text: percentile pill + named pool
  assert.match(lead, /pct-pill pct-elite/);
  assert.match(lead, /Team not stated/);
  assert.match(lead, /<b>—<\/b>assists/);
  assert.match(lead, /Below the minutes needed/);
  assert.doesNotMatch(playerCard(p), /pc-lead/);
  const html = render({ s: q('competition=mls&sort=goals_per90'), env: { data: { total: 1, seasons: [], players: [p], leaders: true, min_minutes_for_percentiles: 450 }, meta: { source: 'pbe', coverage: { state: 'ok', notes: [] } } } });
  assert.match(html, /Leaders among the 450\+ nominal-minute players of Major League Soccer/);
});
