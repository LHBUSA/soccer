// Premium (Pro) copy by code: the Spanish Matchup Analyzer and Fatigue/XI/Rotation components are rendered from the
// API's structured codes and numbers. These tests run the REAL soccer-api functions, so a wording change in the API
// fails here until src/i18n/pro-copy.js follows (readers meanwhile see the API's own English, never stale Spanish).
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzer } from '../../workers/soccer-api/src/pro/analyzer.js';
import { teamFatigueIndex, xiLoad, rotationPressure } from '../../workers/soccer-api/src/pro/fatigue.js';
import { ANALYZER_EN, INDEX_EN, proCopy } from '../../src/i18n/pro-copy.js';
import { setCurrentLocale } from '../../src/i18n/current.js';
import { analyzerView, analyzerPreviewHtml } from '../../src/components/analyzer.js';

// Inline API-shaped inputs (not committed mock data): enough history for every analyzer component to exist.
const games = (gf, ga) => Array.from({ length: 10 }, () => ({ gf, ga, stat_signature: 'espn:source', stats: { shots: 12, shots_on_target: 5 }, opp_stats: { shots: 8, shots_on_target: 3 }, event_family: 'espn' }));
const season = (id, n) => Array.from({ length: n }, (_, i) => ({ status: 'finished', home_team_id: i % 2 ? id : 'x', away_team_id: i % 2 ? 'x' : id, home_score: 2, away_score: 1 }));
const full = () => analyzer({ homeGames: games(2, 0), awayGames: games(1, 1), homeSeason: season('h', 8), awaySeason: season('a', 8), homeId: 'h', awayId: 'a',
  homeLoad: { last_match_id: 'm1', days_since_last: 4, matches_7: 1 }, awayLoad: { last_match_id: 'm2', days_since_last: 6, matches_7: 2 },
  homeSquad: { xi_continuity: 0.82, matches_considered: 4, top11_minute_share: 0.71 }, awaySquad: { xi_continuity: 0.64, matches_considered: 4, top11_minute_share: 0.66 },
  homeHistory: { seasons: [{ competition: { slug: 'bundesliga' }, season: '2025/26', league_record: { played: 34, goals_for: 60, goals_against: 40 } }] },
  awayHistory: { seasons: [{ competition: { slug: 'bundesliga' }, season: '2025/26', league_record: { played: 34, goals_for: 50, goals_against: 45 } }] },
  competition: 'bundesliga', season: '2026/27', asOf: '2026-10-09T12:00:00Z' });
const digits = s => (String(s).match(/-?\d+(?:\.\d+)?/g) || []).join('|');

test('every analyzer component the API can emit is catalogued with its exact English label and basis', () => {
  const x = full();
  const keys = x.components.map(c => c.key);
  for (const k of ['form5', 'form10', 'scoring', 'conceding', 'gd', 'season_scoring', 'season_conceding', 'venue', 'shots', 'suppression', 'shot_diff', 'sot_diff', 'rest', 'load7', 'xi']) assert.ok(keys.includes(k), `fixture exercises ${k}`);
  assert.deepEqual(Object.keys(ANALYZER_EN.components).sort(), [...keys].sort(), 'catalogue == API component set');
  for (const c of x.components) {
    const en = ANALYZER_EN.components[c.key];
    assert.equal(c.label, en.label, `label ${c.key}`);
    if (en.basis === null) assert.match(c.basis, ANALYZER_EN.shotBasis, `shot basis ${c.key}`); else assert.equal(c.basis, en.basis, `basis ${c.key}`);
    assert.equal(c.normalization, ANALYZER_EN.normalization);
  }
  assert.equal(x.formula, ANALYZER_EN.formula);
  assert.equal(x.rating_label, ANALYZER_EN.ratingLabel);
  assert.equal(x.coverage.basis, ANALYZER_EN.coverageBasis);
  assert.ok(ANALYZER_EN.coverageLabels.includes(x.coverage.label));
  assert.equal(x.historical_context.home[0].basis, ANALYZER_EN.historyBasis);
  const weak = analyzer({});
  assert.ok(ANALYZER_EN.coverageLabels.includes(weak.coverage.label));
  const om = analyzer({ homeGames: games(2, 0).slice(0, 4), awayGames: games(1, 1).slice(0, 4) }).omitted;
  assert.ok(om.length && om.every(o => o.reason === ANALYZER_EN.omittedReason && ANALYZER_EN.components[o.key].label === o.label));
});

test('Spanish analyzer: every API string translated by code, numbers identical, nothing left in English', () => {
  const x = full(); const t = proCopy('es');
  for (const c of x.components) {
    for (const [en, es] of [[c.label, t.label(c)], [c.basis, t.basis(c)], [c.explanation, t.explanation(c)]]) {
      assert.notEqual(es, en, `untranslated: ${en}`);
      assert.equal(digits(es), digits(en.replace(/shots_on_target/, '')), `numbers changed: ${en} -> ${es}`);
    }
    assert.match(t.explanation(c), /^Local: .+; visitante: .+\. Muestras: \d+ \/ \d+\. /);
  }
  for (const [fn, v] of [['formula', x.formula], ['ratingLabel', x.rating_label], ['coverageBasis', x.coverage.basis], ['coverageLabel', x.coverage.label], ['historyBasis', ANALYZER_EN.historyBasis], ['omittedReason', ANALYZER_EN.omittedReason], ['normalization', ANALYZER_EN.normalization]]) {
    assert.notEqual(t[fn](v), v, fn); assert.equal(digits(t[fn](v)), digits(v), `${fn} numbers`);
  }
  // The meaning guard: never a probability/prediction/sportsbook claim the API does not make.
  for (const s of [t.formula(x.formula), t.ratingLabel(x.rating_label)]) assert.doesNotMatch(s, /casa de apuestas|cuota|apuesta/i);
  assert.match(t.ratingLabel(x.rating_label), /No es una probabilidad de victoria ni una predicción/);
});

test('changed or unknown API wording falls back to the API English (no stale translation, no mixed sentence)', () => {
  const t = proCopy('es');
  const c = { ...full().components[0] };
  assert.equal(t.label({ ...c, label: 'Recent form · last 6' }), 'Recent form · last 6');
  assert.equal(t.basis({ ...c, basis: 'A new basis sentence.' }), 'A new basis sentence.');
  const changed = { ...c, explanation: `${c.explanation} Extra.` };
  assert.equal(t.explanation(changed), changed.explanation);
  assert.equal(t.coverageLabel('NEW LABEL'), 'NEW LABEL');
  assert.equal(t.unit('new-unit'), 'new-unit');
  // Public preview: no `key`, the closed label set identifies the code.
  const p = { label: c.label, unit: c.unit, home: c.home, away: c.away, edge: c.edge, sample: c.sample, coverage: c.coverage, basis: c.basis, explanation: c.explanation };
  assert.equal(t.label(p), 'Forma reciente · últimos 5');
  assert.notEqual(t.explanation(p), p.explanation);
});

test('English is untouched: proCopy("en") returns API text verbatim, except the provider signature (DATA · PropSports)', () => {
  const x = full(); const t = proCopy('en');
  for (const c of x.components) {
    assert.equal(t.label(c), c.label); assert.equal(t.unit(c.unit), c.unit);
    if (c.group === 'style') {
      assert.match(c.basis, /espn:source/, 'API keeps its provenance signature');
      assert.match(t.basis(c), /^Paired team\/opponent (shots|shots on target) from one compatible stat basis \(DATA · PropSports\)\.$/);
      assert.equal(t.explanation(c), c.explanation.replace(c.basis, t.basis(c)));
    } else { assert.equal(t.basis(c), c.basis); assert.equal(t.explanation(c), c.explanation); }
  }
  assert.equal(t.formula(x.formula), x.formula);
  assert.equal(t.ui, null);
});

test('fatigue / XI load / rotation components: catalogued by key, details translated with the same numbers', () => {
  const load = { matches_14: 4, short_rest_sequences_21: 2, days_since_last: 3, next_match: { rest_days_before: 3 }, away_share_last5: 0.4, home_away_last5: 'H A H A H', competition_switches_last5: 1 };
  const tfi = teamFatigueIndex(load);
  const pl = new Map([['p1', { minutes_14: 180, international_return: true }], ['p2', { minutes_14: 90 }]]);
  const xl = xiLoad(['p1', 'p2'], pl, 2);
  const rp = rotationPressure(tfi, { top11_minute_share: 0.78, xi_continuity: 0.73 });
  const rpNone = rotationPressure(tfi, { top11_minute_share: null, xi_continuity: null });
  const tfiNone = teamFatigueIndex({ ...load, days_since_last: null, next_match: null, home_away_last5: null });
  const all = [...tfi.components, ...xl.components, ...rp.components, ...rpNone.components, ...tfiNone.components];
  assert.deepEqual([...new Set(all.map(c => c.key))].sort(), Object.keys(INDEX_EN).sort(), 'catalogue == API index components');
  const t = proCopy('es');
  for (const c of all) {
    assert.equal(c.label, INDEX_EN[c.key].label, `label ${c.key}`);
    assert.notEqual(t.indexLabel(c), c.label, `label ${c.key} translated`);
    if (c.key === 'travel_sequence' && c.detail !== 'none') { assert.equal(t.indexDetail(c), c.detail, 'H/A sequence is data'); continue; }
    if (/[a-z]/i.test(c.detail)) assert.notEqual(t.indexDetail(c), c.detail, `detail ${c.key}: ${c.detail}`); // '69/100' has no words
    assert.equal(digits(t.indexDetail(c)), digits(c.detail), `detail numbers ${c.key}`);
  }
  assert.equal(proCopy('en').indexDetail(tfi.components[0]), tfi.components[0].detail);
});

test('rendered analyzer: English HTML unchanged by the copy layer; Spanish HTML carries no API English', () => {
  const x = { ...full(), home_id: 'h', away_id: 'a' };
  const match = { home: { name: 'Bayern München' }, away: { name: 'Borussia Dortmund' } };
  setCurrentLocale('en');
  const en = analyzerView(x, match);
  for (const c of x.components) { assert.ok(en.includes(proCopy('en').explanation(c).replace(/&/g, '&amp;')), 'English explanation (customer basis)'); }
  assert.ok(en.includes('EDGE ') && en.includes('RESULTS &amp; FORM') === false && en.includes('RESULTS & FORM'));
  setCurrentLocale('es');
  try {
    const es = analyzerView(x, match);
    for (const c of x.components) assert.ok(!es.includes(c.explanation), `English explanation leaked: ${c.key}`);
    assert.ok(!es.includes(x.formula) && !es.includes(x.coverage.basis));
    assert.ok(es.includes('Bayern München') && es.includes('Borussia Dortmund'), 'team names preserved');
    assert.match(es, /VENTAJA -?\d/); assert.match(es, /RESULTADOS Y FORMA/);
    const pv = analyzerPreviewHtml({ competition: 'bundesliga', season: '2026/27', as_of: x.as_of, coverage: x.coverage, components: x.components.slice(0, 3).map(({ key, ...c }) => c) }, match);
    assert.ok(!pv.includes('Samples:') && pv.includes('Muestras:'));
  } finally { setCurrentLocale('en'); }
});

// Owner directive 2026-10-09 (final polish): customer analyzer displays carry product league names and DATA · PropSports,
// never an API slug or provider signature; the API payload itself is unchanged.
const LEAK = /espn|:source|:derived|premier-league|uefa-|la-liga|serie-a/i;
const SLUGS = ['premier-league', 'la-liga', 'serie-a', 'bundesliga', 'mls', 'uefa-champions-league', 'fifa-world-cup', 'uefa-european-championship', 'uefa-womens-champions-league', 'womens-super-league'];

test('competition slug -> product name, localized only where Spanish has an established form', () => {
  const en = proCopy('en'); const es = proCopy('es');
  assert.deepEqual(SLUGS.map(s => en.competition(s)), ['Premier League', 'LaLiga', 'Serie A', 'Bundesliga', 'MLS', 'Champions League', 'FIFA World Cup', 'European Championship', "Women's Champions League", 'WSL']);
  assert.deepEqual(SLUGS.map(s => es.competition(s)), ['Premier League', 'LaLiga', 'Serie A', 'Bundesliga', 'MLS', 'Champions League', 'Copa Mundial de la FIFA', 'Eurocopa', 'Champions League Femenina', 'WSL']);
  assert.equal(en.competition('some-new-cup'), 'Some New Cup', 'unknown slug is humanized, never printed raw');
});

test('rendered preview + full analyzer: league name and DATA · PropSports in both languages, no slug or signature, same numbers', () => {
  const x = { ...full(), competition: 'premier-league', home_id: 'h', away_id: 'a' };
  const match = { home: { name: 'Arsenal' }, away: { name: 'Chelsea' } };
  const shots = x.components.filter(c => c.group === 'style');
  const preview = { competition: 'premier-league', season: '2026/27', as_of: x.as_of, coverage: x.coverage, components: shots.slice(0, 3).map(({ key, ...c }) => c) };
  const out = {};
  for (const loc of ['en', 'es']) {
    setCurrentLocale(loc);
    try { out[loc] = { pv: analyzerPreviewHtml(preview, match), full: analyzerView(x, match) }; } finally { setCurrentLocale('en'); }
    for (const html of Object.values(out[loc])) {
      assert.doesNotMatch(html, LEAK, `${loc}: internal identifier leaked`);
      assert.ok(html.includes('Premier League'), `${loc}: league name`);
      assert.ok(html.includes('DATA · PropSports'), `${loc}: attribution`);
    }
  }
  const nums = h => (h.replace(/<[^>]+>/g, ' ').match(/-?\d+(?:\.\d+)?/g) || []).join('|');
  assert.equal(nums(out.es.pv), nums(out.en.pv), 'preview numbers identical across languages');
  assert.equal(x.components.length, 15, 'premium analyzer keeps all 15 components');
  assert.match(x.components.find(c => c.key === 'shots').basis, /espn:source/, 'API provenance untouched');
});
