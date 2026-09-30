import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzerPreviewHtml } from '../../src/components/analyzer.js';

test('free matchup preview shows selected evidence and keeps predictions and composite score private', () => {
  const html = analyzerPreviewHtml({ competition: 'bundesliga', season: '2026/27', as_of: '2026-09-30', coverage: { label: 'LIMITED SAMPLE', basis: 'Only two covered matches.' }, components: [{ label: 'Recent goal difference', unit: 'goals/match', home: 0.8, away: -0.2, edge: 0.31, sample: { home: 5, away: 4 }, explanation: 'Home side has a higher recent goal difference.', basis: 'Five and four canonical finished matches.' }] }, { home: { name: 'Home' }, away: { name: 'Away' } });
  assert.match(html, /Selected evidence/);
  assert.match(html, /Home side has a higher recent goal difference/);
  assert.match(html, /SAMPLE 5 \/ 4/);
  assert.match(html, /No prediction or win probability/);
  assert.doesNotMatch(html, /Component score \/ 100|\bPBE MATCHUP RATING\b|predicted winner/i);
  const empty = analyzerPreviewHtml({ coverage: { label: 'WEAK DATA', basis: 'Fewer than three scored matches.' }, components: [] }, { home: { name: 'H' }, away: { name: 'A' } });
  assert.match(empty, /WEAK DATA/);
  assert.match(empty, /Fewer than three scored matches/);
  assert.doesNotMatch(empty, /0\.00/);
});
