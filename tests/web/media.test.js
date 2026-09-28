// Identity images (docs/MEDIA.md): approved media only, owned fallbacks, no broken or invented images.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { crest, portrait, portraitOf, SILHOUETTE, SILHOUETTE_2X } from '../../src/components/media.js';
import { playerChip, teamMark } from '../../src/components/ui.js';

const MEDIA = '/api/soccer/media/08c37723f3419daa4e1184f9df2e461031385442106f1dd268d7883e2b898558';

test('crest: approved crest with identification credit, else the initials mark', () => {
  const withCrest = crest({ name: 'FC Bayern München', crest: { url: MEDIA, attribution: 'FC Bayern Munich, Public domain' } }, 'xl');
  assert.match(withCrest, /<img src="\/api\/soccer\/media\/[0-9a-f]{64}"/);
  assert.match(withCrest, /Used to identify the club/);
  assert.match(withCrest, /data-fallback="BM"/);
  assert.equal(crest({ name: 'Inter Miami CF' }), '<span class="tmark" aria-hidden="true">IM</span>');
  assert.equal(teamMark, crest);
});

test('portrait: approved portrait (lists or player media), else the raster silhouette', () => {
  const p = portrait({ name: 'Diego Chará', portrait: { url: MEDIA, attribution: 'Ray Terrill, CC BY-SA 2.0' } }, 'lg');
  assert.match(p, /class="pic pic-lg"/);
  assert.match(p, /title="Photo: Ray Terrill, CC BY-SA 2.0"/);
  assert.match(p, /data-fallback-portrait/);
  assert.equal(portraitOf({ media: [{ media_type: 'crest', url: 'x' }, { media_type: 'portrait', url: MEDIA }] }).url, MEDIA);
  const sil = portrait({ name: 'No Photo' }, 'sm');
  assert.match(sil, /class="pic pic-sm sil" aria-hidden="true"/);
  assert.ok(sil.includes(SILHOUETTE) && sil.includes(SILHOUETTE_2X));
  assert.doesNotMatch(sil, /<svg/, 'the silhouette is a raster asset, not drawn vector art');
  for (const f of [SILHOUETTE, SILHOUETTE_2X]) {
    const b = readFileSync(`public${f}`);
    assert.equal(b.toString('ascii', 8, 12), 'WEBP', f);
  }
  assert.ok(existsSync('scripts/brand/render-silhouette.py'), 'the silhouette is reproducible from its renderer');
});

test('portrait: values are escaped; only the API url is used', () => {
  const p = portrait({ portrait: { url: '/api/soccer/media/x"onerror="alert(1)', attribution: '<b>' } });
  assert.doesNotMatch(p, /"onerror="/);
  assert.match(p, /&lt;b&gt;/);
});

test('playerChip: linked name + portrait; unresolved source names get no portrait and keep their tag', () => {
  const c = playerChip({ slug: 'preston-judd', name: 'Preston Judd' });
  assert.match(c, /href="\/players\/preston-judd"/);
  assert.match(c, /pic pic-xs sil/);
  const u = playerChip({ name: 'Source Name', resolved: false, portrait: { url: MEDIA } });
  assert.match(u, /identity pending/);
  assert.doesNotMatch(u, /media\/[0-9a-f]{64}/);
  assert.match(playerChip(null), /Unidentified player/);
});
