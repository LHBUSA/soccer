// Player DNA drawer content: identity, compact DNA, the full-profile link; honest when no DNA.
import test from 'node:test';
import assert from 'node:assert/strict';
import { drawerContent } from '../../src/components/drawer.js';

const p = { slug: 'diego-chara', name: 'Diego Chará', role: 'midfielder', media: [{ media_type: 'portrait', url: '/api/soccer/media/ab', attribution: 'Ray Terrill, CC BY-SA 2.0' }], observed: { latest_team: { slug: 'portland-timbers', name: 'Portland Timbers', as_of: '2026-09-27T02:30:00Z' } } };

test('drawer: portrait + credit, latest lineup club, compact DNA, full profile link', () => {
  const dna = { data: { min_minutes_for_percentiles: 450, seasons: [{ competition: { slug: 'mls', name: 'MLS' }, season: '2026', players_compared: 554, eligible_for_percentiles: true, appearances: 21, starts: 12, minutes_nominal: 1258, goals: 0, assists: 0, shots: 3, metrics: [{ key: 'key_passes_per90', value: 0.64, percentile: 46 }] }] } };
  const html = drawerContent(p, dna);
  assert.match(html, /id="dr-title" tabindex="-1">Diego Chará</);
  assert.match(html, /Photo: Ray Terrill/);
  assert.match(html, /Portland Timbers/);
  assert.match(html, /dna2 compact/);
  assert.doesNotMatch(html, /dna-group/, 'the drawer is compact: grouped rows live on the full profile');
  assert.match(html, /href="\/players\/diego-chara"/);
});

test('drawer: no DNA season is said plainly; no portrait falls back to the silhouette', () => {
  const html = drawerContent({ slug: 'x', name: 'X', role: null }, { data: { seasons: [] } });
  assert.match(html, /No Player DNA season yet/);
  assert.match(html, /pic pic-xl sil/);
  assert.match(html, /Role not stated/);
});
