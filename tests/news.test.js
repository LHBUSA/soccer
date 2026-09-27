import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeMatchRecap } from '../workers/soccer-news/src/compose.js';
import { checkClaims, packetNumbers, runGates } from '../workers/soccer-news/src/gates.js';
import { computeTable, distanceToGoal } from '../workers/soccer-news/src/packet.js';

// The committed proof packet is a real frozen packet from the canonical store.
const packet = JSON.parse(readFileSync(new URL('../docs/evidence/proof/packet-bayern-dortmund-2018-03-31.json', import.meta.url), 'utf8'));
const ATTR = packet.provenance.attributions;

test('the composer output for a real packet passes every gate', () => {
  const a = composeMatchRecap(packet);
  const g = runGates(a, packet, { requiredAttributions: ATTR });
  assert.equal(g.pass, true, JSON.stringify(g.failed));
  assert.match(a.headline, /^Bayern München 6-0 Borussia Dortmund/);
});

test('an invented number is rejected even when it appears elsewhere in the packet', () => {
  const a = composeMatchRecap(packet);
  const shots = packet.stats.home.shots;
  const other = [...packetNumbers(packet)].map(Number).find(n => Number.isInteger(n) && n !== shots && n > 0);
  const t = structuredClone(a);
  const i = t.sections.findIndex(s => s.key === 'shots');
  t.sections[i].paragraphs[0] = t.sections[i].paragraphs[0].replace(`had ${shots} shots`, `had ${other} shots`);
  const g = runGates(t, packet, { requiredAttributions: ATTR });
  assert.equal(g.pass, false);
  assert.ok(g.failed.includes('claims_consistency'));
  assert.ok(checkClaims(t.sections[i].paragraphs[0], packet).length > 0);
});

test('a number absent from the packet fails numeric grounding', () => {
  const t = structuredClone(composeMatchRecap(packet));
  t.sections[0].paragraphs.push('Attendance was 987654.');
  assert.ok(runGates(t, packet, { requiredAttributions: ATTR }).failed.includes('numeric_grounding'));
});

for (const [gate, sentence] of [
  ['unsupported_quote', '“We were ready,” the coach said.'],
  ['unsupported_medical', 'He was later ruled out with a hamstring problem.'],
  ['unsupported_market', 'The favourites covered the spread.'],
  ['unsupported_record', 'It was a club record.'],
  ['unpublished_metric', 'They generated far more xG.'],
  ['unsupported_possession', 'They dominated possession.'],
  ['cliche', 'It was a statement win.'],
]) {
  test(`editorial text is gated: ${gate}`, () => {
    const t = structuredClone(composeMatchRecap(packet));
    t.sections[0].paragraphs.push(sentence);
    assert.ok(runGates(t, packet, { requiredAttributions: ATTR }).failed.includes(gate));
  });
}

test('the method section may name what is unavailable without tripping phrase gates', () => {
  const a = composeMatchRecap(packet);
  assert.match(a.sections.at(-1).paragraphs[0], /possession_pct/);
  assert.equal(runGates(a, packet, { requiredAttributions: ATTR }).pass, true);
});

test('missing attribution and wrong winner are caught', () => {
  const a = composeMatchRecap(packet);
  assert.ok(runGates(a, packet, { requiredAttributions: [...ATTR, 'Some Other Source'] }).failed.includes('attribution'));
  const t = structuredClone(a);
  t.headline = 'Borussia Dortmund 6-0 Bayern München';
  assert.ok(runGates(t, packet, { requiredAttributions: ATTR }).failed.includes('wrong_winner'));
});

test('a hat-trick claim needs a three-goal scorer', () => {
  const p = structuredClone(packet);
  p.goals = p.goals.filter((g, i) => !(g.scorer?.name === 'Robert Lewandowski' && i === p.goals.length - 1));
  const a = composeMatchRecap(packet); // still says hat-trick
  assert.ok(runGates(a, p, { requiredAttributions: ATTR }).failed.includes('hat_trick_grounding'));
});

test('identifier digits never ground a number', () => {
  const nums = packetNumbers({ id: '12345678-1234-5234-9234-123456789012', hash: 'f'.repeat(20) + '4242', stats: { shots: 7 } });
  assert.ok(nums.has('7'));
  assert.ok(!nums.has('4242') && !nums.has('12345678'));
});

test('table and geometry helpers', () => {
  const t = computeTable([
    { home_team_id: 'a', away_team_id: 'b', home_score: 2, away_score: 0 },
    { home_team_id: 'b', away_team_id: 'c', home_score: 1, away_score: 1 },
  ]);
  assert.deepEqual(t.map(r => [r.team_id, r.points, r.gd]), [['a', 3, 2], ['c', 1, 0], ['b', 1, -2]]);
  assert.equal(t[0].form, null); // no kickoff times -> results cannot be ordered -> no form
  const k = d => `2026-03-0${d}T19:00:00Z`;
  const wdl = computeTable([
    { home_team_id: 'x', away_team_id: 'y', home_score: 0, away_score: 1, kickoff_at: k(3) },
    { home_team_id: 'x', away_team_id: 'z', home_score: 2, away_score: 2, kickoff_at: k(1) },
    { home_team_id: 'y', away_team_id: 'z', home_score: 3, away_score: 0, kickoff_at: k(2) },
  ]);
  const y = wdl.find(r => r.team_id === 'y');
  assert.deepEqual([y.won, y.drawn, y.lost, y.form], [2, 0, 0, ['W', 'W']]);
  assert.deepEqual(wdl.find(r => r.team_id === 'x').form, ['L', 'D']); // newest first
  // MLS: wins break a points tie before goal difference.
  const tie = [
    { home_team_id: 'p', away_team_id: 'q', home_score: 5, away_score: 0, kickoff_at: k(1) }, // p: W +5
    { home_team_id: 'p', away_team_id: 'r', home_score: 0, away_score: 1, kickoff_at: k(2) }, // p: L -> 3 pts, 1 win, +4
    { home_team_id: 's', away_team_id: 'q', home_score: 1, away_score: 1, kickoff_at: k(3) },
    { home_team_id: 's', away_team_id: 'r', home_score: 1, away_score: 1, kickoff_at: k(4) },
    { home_team_id: 's', away_team_id: 't', home_score: 1, away_score: 1, kickoff_at: k(5) }, // s: 3 pts, 0 wins, 0 gd
  ];
  const pos = (tb, id) => computeTable(tie, { tiebreak: tb }).findIndex(r => r.team_id === id);
  assert.ok(pos('mls', 'p') < pos('mls', 's'));
  assert.equal(distanceToGoal(105, 34), 0);
  assert.equal(distanceToGoal(94, 34), 11);
  assert.equal(distanceToGoal(null, 34), null);
});
