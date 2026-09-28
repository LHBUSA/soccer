// Official video (frontend): poster-first markup, privacy-enhanced embed after click only, blocked-region
// fallback, article WATCH only for a validated linked video, VideoObject only for validated video.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { officialVideo, embedSrc, videoObject, BLOCKED_CODES } from '../../src/components/video.js';
import { watchInArticle } from '../../src/pages/article.js';
import { articleMeta } from '../../src/seo/meta.js';
import { newsroomSections, watchModule } from '../../src/pages/news.js';
import { editorialDek, newsCard } from '../../src/components/newscard.js';

const V = { provider_video_id: 'dQw4w9WgXcQ', title: 'Bayern Munich - Union Berlin 7-0 | Highlights', channel_name: 'Bundesliga', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', thumbnail_url: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', published_at: '2026-09-18T21:00:00Z', video_type: 'highlights', duration_sec: 612, availability: 'embeddable', validated: true };

test('poster first: a button + thumbnail, no iframe, no youtube request, no autoplay in the markup', () => {
  const h = officialVideo(V, { feature: true });
  assert.match(h, /<button type="button" class="ovid-poster"/);
  assert.doesNotMatch(h, /<iframe/); assert.doesNotMatch(h, /youtube-nocookie\.com\/embed|autoplay/);
  assert.match(h, /src="https:\/\/i\.ytimg\.com\/vi\/dQw4w9WgXcQ\/hqdefault\.jpg"/);
  assert.match(h, /width="1280" height="720"/, 'explicit 16:9 dimensions');
  assert.match(h, /Official video · embedded from YouTube · not hosted by PropBetEdge/);
  assert.match(h, /Watch on YouTube ↗/); assert.match(h, /10:12/);
  assert.equal(officialVideo({ ...V, provider_video_id: 'bad id' }), '', 'invalid id renders nothing');
});

test('embed URL: youtube-nocookie, IFrame API enabled, exact origin, autoplay only once the reader clicked', () => {
  const u = new URL(embedSrc('dQw4w9WgXcQ', 'https://soccer.propbetedge.ai'));
  assert.equal(u.host, 'www.youtube-nocookie.com'); assert.equal(u.pathname, '/embed/dQw4w9WgXcQ');
  assert.equal(u.searchParams.get('enablejsapi'), '1'); assert.equal(u.searchParams.get('origin'), 'https://soccer.propbetedge.ai');
  assert.equal(u.searchParams.get('autoplay'), '1');
  assert.deepEqual([...BLOCKED_CODES].sort((a, b) => a - b), [100, 101, 150]);
  const src = readFileSync('src/components/video.js', 'utf8');
  assert.match(src, /referrerPolicy = 'strict-origin-when-cross-origin'/); assert.match(src, /allowFullscreen = true/);
  assert.match(src, /addEventListener\('click', \(\) => open\(card, origin\)/, 'the iframe is created on click only');
});

test('known region block renders the fallback with Watch on YouTube, never a dead player', () => {
  const h = officialVideo({ ...V, availability: 'blocked_us' });
  assert.match(h, /Not available for embedded playback in your region\./); assert.match(h, /class="btn gold" href="https:\/\/www\.youtube\.com\/watch\?v=dQw4w9WgXcQ"/);
  assert.doesNotMatch(h, /class="ovid-poster"/);
});

test('article WATCH only for a validated linked video; none otherwise (fail closed)', () => {
  assert.match(watchInArticle({ media: { videos: [V] } }), /WATCH · OFFICIAL HIGHLIGHTS/);
  assert.equal(watchInArticle({ media: { videos: [{ ...V, validated: false }] } }), '');
  assert.equal(watchInArticle({ media: { videos: [] } }), ''); assert.equal(watchInArticle({}), '');
});

test('VideoObject only for a validated video; embed + watch URLs and publisher set', () => {
  const o = videoObject(V);
  assert.equal(o['@type'], 'VideoObject'); assert.equal(o.embedUrl, 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'); assert.equal(o.contentUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  assert.equal(o.uploadDate, V.published_at); assert.equal(o.publisher.name, 'Bundesliga'); assert.equal(o.duration, 'PT10M12S');
  assert.equal(videoObject({ ...V, validated: false }), null);
  const env = v => ({ data: { slug: 's', desk: 'bundesliga', headline: 'Olise hat-trick', dek: 'x', published_at: V.published_at, entities: [], media: { videos: v } } });
  const types = m => m.jsonld.map(j => j['@type']);
  assert.ok(types(articleMeta('/news/bundesliga/s', env([V]), 'bundesliga')).includes('VideoObject'));
  assert.ok(!types(articleMeta('/news/bundesliga/s', env([{ ...V, validated: false }]), 'bundesliga')).includes('VideoObject'));
  assert.ok(!types(articleMeta('/news/bundesliga/s', env([]), 'bundesliga')).includes('VideoObject'));
});

const art = (slug, story_class, hoursAgo, extra = {}) => ({ slug, desk: 'bundesliga', story_class, headline: `Headline ${slug}`, dek: 'A real editorial standfirst that adds context.', published_at: new Date(Date.now() - hoursAgo * 3600e3).toISOString(), ...extra });

test('newsroom sections: every story once; thin groups fold into More stories', () => {
  const rest = [art('a', 'match_recap', 1), art('b', 'match_recap', 2), art('c', 'player_form', 3), art('d', 'competition_intelligence', 4)];
  const s = newsroomSections(rest);
  assert.deepEqual(s.map(g => g.kicker), ['MATCH REPORTS', 'MORE STORIES']);
  const slugs = s.flatMap(g => g.list.map(a => a.slug)); assert.equal(new Set(slugs).size, slugs.length); assert.equal(slugs.length, 4);
  assert.equal(watchModule([]), '', 'no videos -> no WATCH module');
  assert.match(watchModule([V, { ...V, provider_video_id: 'aaaaaaaaaaa' }], 'bundesliga'), /Latest official Bundesliga video/);
});

test('cards: editorial headline case, template metadata never shown as the dek', () => {
  assert.equal(editorialDek({ dek: 'Bundesliga 2026/27, 18 September 2026. Half-time 3-0.' }), null);
  assert.equal(editorialDek({ dek: 'MLS 2026: the standings after 14 results this week.' }), null);
  assert.equal(editorialDek({ dek: '4 goals in 4 consecutive appearances for Orlando City SC (2026).' }), null);
  assert.equal(editorialDek({ dek: 'Harry Kane scored twice as Bayern built a three-goal half-time lead.' }), 'Harry Kane scored twice as Bayern built a three-goal half-time lead.');
  const f = newsCard(art('x', 'match_recap', 1, { image: { kind: 'portrait', url: '/api/soccer/media/' + 'a'.repeat(64), alt: 'Michael Olise' } }), 'featured');
  assert.match(f, /class="nimg k-photo v-featured/); assert.match(f, /fetchpriority="high"/); assert.match(f, /Read story →/);
  assert.doesNotMatch(readFileSync('src/styles/main.css', 'utf8').match(/\.nwc-head \{[^}]*\}/)[0], /uppercase/);
});

test('the story resumes after WATCH without a second drop cap', () => {
  assert.match(readFileSync('src/styles/main.css', 'utf8'), /\.art-body\.cont > p:first-of-type::first-letter \{ float: none;/);
});
