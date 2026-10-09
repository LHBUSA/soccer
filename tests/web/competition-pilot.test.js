// Regression contract: league-hub pilot must not change international tables or model/API access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { render, mount } from '../../src/pages/competition.js';
import { pro } from '../../src/pages/pro.js';

const source = readFileSync(new URL('../../src/pages/competition.js', import.meta.url), 'utf8');
const proSource = readFileSync(new URL('../../src/pages/pro.js', import.meta.url), 'utf8');
const mk = (slug) => ({
  slug, season: '2026', current: '2026', isCurrent: true, grouped: false,
  comp: { status: 'fulfilled', value: { data: { name: slug, type: 'league', country_code: '', current: { season: '2026', teams: [], finished: 0, scheduled: 0, live: 1 }, seasons: [{ label: '2026', matches: 1 }] }, meta: {} } },
  table: { status: 'fulfilled', value: { data: { rows: [] }, meta: {} } }, confs: [],
  recent: { status: 'fulfilled', value: { data: [] } },
  upcoming: { status: 'fulfilled', value: { data: [] } },
  cov: { status: 'fulfilled', value: { data: { competitions: [] } } },
  live: { status: 'fulfilled', value: { data: [{ id: 'fixture-one', status: 'live', kickoff_at: '2026-10-08T20:00:00Z', home: { slug: 'a', name: 'A' }, away: { slug: 'b', name: 'B' }, score: { home: 1, away: 0 } }] } }, tab: 'overview',
});
test('MLS, Premier League and Bundesliga hubs present live matches first with dedicated discovery links', () => {
  for (const slug of ['mls','premier-league','bundesliga']) {
    const h = render(mk(slug));
    assert.match(h, /LIVE NOW/);
    assert.ok(h.indexOf('<p class="kicker">LIVE NOW</p>') > -1, 'live heading rendered');
    assert.ok(h.indexOf('<p class="kicker">LIVE NOW</p>') < h.indexOf('<div class="two">'), 'live section precedes standings layout');
    assert.match(h, new RegExp('/players\\?competition=' + slug));
    assert.match(h, new RegExp('/news/' + slug));
    assert.match(h, /data-related-news/);
    assert.match(h, /\/pbecast/);
  }
});
test('nonpilot hubs do not inherit pilot features; international group logic stays in place', () => {
  assert.doesNotMatch(render(mk('la-liga')), /League Player DNA/);
  assert.match(source, /if \(d\.grouped\) return renderGroups/);
  assert.match(source, /if \(desk && \(d\.grouped \|\| PILOT_LEAGUES\.has\(d\.slug\)\)\)/);
});
test('premium Pro copy points to published official record without changing entitlement checks', () => {
  assert.doesNotMatch(proSource, /Soccer Pro publishes no predictions yet/);
  assert.match(proSource, /Official Soccer Algo record/);
  assert.match(proSource, /href="\/track-record"/);
  assert.match(proSource, /const board = access\.pro \?/);
  assert.match(proSource, /const res = access\.pro \?/);
});
