import test from 'node:test';
import assert from 'node:assert/strict';

import { ORG, articleMeta } from '../src/seo/meta.js';

const images = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => images(n, out));
  else if (node && typeof node === 'object') {
    if (node['@type'] === 'ImageObject') out.push(node);
    Object.values(node).forEach((v) => images(v, out));
  }
  return out;
};

test('logo is PropBetEdge art', () => {
  assert.deepEqual(ORG.logo.creator, { '@type': 'Organization', name: 'PropBetEdge' });
  assert.equal(ORG.logo.copyrightNotice, '© 2026 PropBetEdge');
});

test('article card (text-only api/og.js art) is PropBetEdge art with dimensions', () => {
  const a = { slug: 'x', desk: 'mls', headline: 'H', published_at: '2026-09-30T20:00:00Z', entities: [] };
  const meta = articleMeta('/news/mls/x', { data: a }, 'mls');
  const nodes = images(meta.jsonld);
  const card = nodes.find((n) => n.url.endsWith('/og/article/x.png'));
  assert.equal(card.creator.name, 'PropBetEdge');
  assert.equal(card.copyrightNotice, '© 2026 PropBetEdge');
  assert.equal(card.contentUrl, card.url);
  assert.equal(card.width, 1200);
  assert.equal(card.height, 630);
});
