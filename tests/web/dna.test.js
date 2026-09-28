// Player DNA V2 render contract: ranks only for eligible seasons, the comparison group is named,
// grouped rows cover every published metric, and ineligible seasons show counts without ranks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DNA_GROUPS, PLAYER_LABELS, dnaSignature, playerDnaView, playerSeasonView } from '../../src/components/dna.js';

const metrics = [['goals_per90', 0.9, 99], ['shots_per90', 5.94, 100], ['shots_on_target_rate', 0.38, 62], ['goals_per_shot', 0.15, 72], ['assists_per90', 0.5, 99], ['key_passes_per90', 2.39, 97], ['goal_contributions_per90', 1.4, 100], ['start_rate', 0.96, 78], ['minutes_per_appearance', 87, 85], ['cards_per90', 0.14, 61]]
  .map(([key, value, percentile]) => ({ key, value, percentile, lower_is_better: key === 'cards_per90' }));
const season = { competition: { slug: 'mls', name: 'MLS' }, season: '2026', players_compared: 554, eligible_for_percentiles: true, appearances: 23, starts: 22, minutes_nominal: 2000, goals: 20, assists: 11, shots: 132, shots_on_target: 50, key_passes: 53, splits: { home: { appearances: 12, goals: 10 }, away: { appearances: 11, goals: 10 } }, last5: { appearances: 5, goals: 6, shots: 35 }, metrics };

test('every player DNA metric belongs to exactly one group and has a label', () => {
  const keys = DNA_GROUPS.flatMap(([, k]) => k);
  assert.equal(new Set(keys).size, keys.length);
  assert.deepEqual([...keys].sort(), Object.keys(PLAYER_LABELS).sort());
});

test('eligible season: signature + named comparison group + grouped rows + splits', () => {
  const html = playerSeasonView(season, 450);
  assert.match(html, /class="dna-sig"/);
  assert.match(html, /rank against the <b>554<\/b> players with at least 450 nominal minutes in MLS 2026/);
  for (const [t] of DNA_GROUPS) assert.ok(html.includes(`>${t}<`), t);
  assert.match(html, /goals in 12 apps/);
  assert.equal((dnaSignature(metrics).match(/sig-col/g) || []).length, metrics.length);
});

test('ineligible season: counts only, no ranks, no signature', () => {
  const html = playerSeasonView({ ...season, eligible_for_percentiles: false, minutes_nominal: 300, metrics: metrics.map(m => ({ ...m, percentile: null })) }, 450);
  assert.doesNotMatch(html, /dna-sig/);
  assert.doesNotMatch(html, /p\d{1,3}</);
  assert.match(html, /300 of the 450 nominal minutes needed/);
});

test('season switcher: one tab per competition-season, only the first panel visible', () => {
  const env = { data: { min_minutes_for_percentiles: 450, seasons: [season, { ...season, competition: { slug: 'uefa-champions-league', name: 'UEFA Champions League' }, season: '2026/27' }] } };
  const html = playerDnaView(env);
  assert.equal((html.match(/data-dna-season=/g) || []).length, 2);
  assert.equal((html.match(/data-dna-panel="\d" hidden/g) || []).length, 1);
  assert.equal(playerDnaView({ data: { seasons: [] } }), '');
});
