// Brand identity V3: canonical PropBetEdge mark, favicon/PWA family, manifest, share card,
// Organization logo, header lockup. Raster assets only (the favicon.svg wraps the owned raster glyph).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { buildMeta, headTags, SHARE_IMAGE, LOGO, ORG } from '../../src/seo/meta.js';

const png = f => { const b = readFileSync(f); assert.equal(b.toString('hex', 0, 8), '89504e470d0a1a0a', `${f} is not a PNG`); return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }; };
function jpeg(f) {
  const b = readFileSync(f); let i = 2;
  while (i < b.length) { const m = b[i + 1]; const len = b.readUInt16BE(i + 2); if (m >= 0xc0 && m <= 0xc3) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }; i += 2 + len; }
  throw new Error('no SOF');
}
const webp = f => { const b = readFileSync(f); assert.equal(b.toString('ascii', 0, 4), 'RIFF'); assert.equal(b.toString('ascii', 8, 12), 'WEBP'); return b.length; };

test('the mark is built from the canonical PropBetEdge artwork (sha256 53d5f2a1…)', () => {
  assert.equal(createHash('sha256').update(readFileSync('scripts/brand/src/pbe-full-600.png')).digest('hex'), '53d5f2a15297578b323db7ef216dcb34d3eb2fe3e9a9b46401634ae3609af7e5');
  for (const h of [32, 64, 96, 160]) webp(`public/brand/pbe-mark-${h}.webp`);
  assert.deepEqual(png('public/brand/pbe-mark-64.png'), { w: 130, h: 64 });
});

test('favicon and app-icon family exist at the right sizes', () => {
  assert.ok(statSync('public/favicon.ico').size > 1000);
  assert.deepEqual(png('public/favicon-16x16.png'), { w: 16, h: 16 });
  assert.deepEqual(png('public/favicon-32x32.png'), { w: 32, h: 32 });
  assert.deepEqual(png('public/apple-touch-icon.png'), { w: 180, h: 180 });
  assert.deepEqual(png('public/icon-192.png'), { w: 192, h: 192 });
  assert.deepEqual(png('public/icon-512.png'), { w: 512, h: 512 });
  assert.deepEqual(png('public/icon-maskable-512.png'), { w: 512, h: 512 });
  const svg = readFileSync('public/favicon.svg', 'utf8');
  assert.match(svg, /data:image\/png;base64,/, 'favicon.svg wraps the owned raster glyph, not a redrawn vector logo');
});

test('manifest is valid and names PropBetEdge Soccer', () => {
  const m = JSON.parse(readFileSync('public/site.webmanifest', 'utf8'));
  assert.equal(m.name, 'PropBetEdge Soccer'); assert.equal(m.short_name, 'PBE Soccer');
  assert.equal(m.theme_color, '#0a1628'); assert.equal(m.background_color, '#0a1628'); assert.equal(m.display, 'standalone');
  for (const i of m.icons) assert.ok(existsSync(`public${i.src}`), i.src);
  assert.ok(m.icons.some(i => i.purpose === 'maskable'));
});

test('share card is 1200x630 and the JSON-LD logo is the canonical 512 mark', () => {
  assert.deepEqual(jpeg('public/share/propbetedge-soccer-social-v1.jpg'), { w: 1200, h: 630 });
  assert.deepEqual(png('public/share/propbetedge-logo-v3-512.png'), { w: 512, h: 512 });
  assert.equal(SHARE_IMAGE, 'https://soccer.propbetedge.ai/share/propbetedge-soccer-social-v1.jpg');
  assert.equal(ORG.logo.url, LOGO);
  const home = buildMeta('/', 'home');
  assert.equal(home.title, 'Soccer Intelligence, Live Match Data & Player DNA | PropBetEdge');
  assert.equal(home.image, SHARE_IMAGE);
  const org = home.jsonld.find(j => j['@type'] === 'Organization');
  assert.equal(org.logo.url, 'https://soccer.propbetedge.ai/share/propbetedge-logo-v3-512.png');
  const tags = headTags(home);
  for (const t of ['og:title', 'og:description', 'og:image"', 'og:image:width" content="1200', 'og:image:height" content="630', 'og:image:alt', 'twitter:card" content="summary_large_image']) assert.ok(tags.includes(t), t);
});

test('stadium backdrop is an original raster render within budget', () => {
  assert.ok(webp('public/brand/soccer-stadium-2560.webp') <= 400 * 1024);
  assert.ok(webp('public/brand/soccer-stadium-1600.webp') <= 400 * 1024);
  assert.ok(webp('public/brand/soccer-stadium-portrait-1080.webp') <= 400 * 1024);
  assert.ok(existsSync('scripts/brand/render-stadium.py'));
});

test('head and header carry the identity: icons, manifest, canonical mark linked to propbetedge.ai', () => {
  const html = readFileSync('index.html', 'utf8');
  for (const s of ['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/site.webmanifest', 'class="backdrop"']) assert.ok(html.includes(s), s);
  const main = readFileSync('src/main.js', 'utf8');
  assert.match(main, /href="https:\/\/propbetedge\.ai\/"[^>]*><img src="\/brand\/pbe-mark-64\.webp"/);
  assert.match(main, /PROPBETEDGE<\/span><span class="b2">SOCCER INTELLIGENCE/);
});

test('middleware hands every static file to the filesystem, including the web manifest', async () => {
  const { isFilePath } = await import('../../middleware.js');
  for (const f of ['/site.webmanifest', '/favicon.ico', '/icon-512.png', '/brand/player-silhouette-128.webp', '/robots.txt']) assert.equal(isFilePath(f), true, f);
  for (const p of ['/', '/players', '/players/lionel-messi', '/pbecast/5b0c8f3e-1111-5222-8333-444455556666', '/news/mls/some-story-abc123']) assert.equal(isFilePath(p), false, p);
});


test('network GA4 is bundled, production-only and allowed by the strict CSP', () => {
  const analytics = readFileSync('src/analytics.js', 'utf8');
  const main = readFileSync('src/main.js', 'utf8');
  const html = readFileSync('index.html', 'utf8');
  const vercel = readFileSync('vercel.json', 'utf8');

  assert.match(analytics, /GA_ID = 'G-BRS48R8PG9'/);
  assert.match(analytics, /GA_SURFACE = 'soccer'/);
  assert.match(analytics, /PROD_HOST = 'soccer\.propbetedge\.ai'/);
  assert.match(analytics, /cookie_domain: '\.propbetedge\.ai'/);
  assert.match(analytics, /pbe_network_click/);
  assert.match(main, /import \{ initAnalytics \} from '\.\/analytics\.js'/);
  assert.match(main, /initAnalytics\(\)/);
  assert.doesNotMatch(html, /googletagmanager|G-BRS48R8PG9/, 'GA bootstrap stays out of inline HTML');
  assert.match(vercel, /script-src 'self' https:\/\/www\.googletagmanager\.com/);
  assert.match(vercel, /connect-src 'self' https:\/\/www\.google-analytics\.com https:\/\/analytics\.google\.com https:\/\/region1\.google-analytics\.com/);
  // stop at the directive boundary: style-src may legitimately allow inline styles
  assert.doesNotMatch(vercel, /script-src[^;"]*'unsafe-inline'/, 'strict CSP keeps inline JavaScript blocked');
  assert.match(vercel, /style-src 'self' 'unsafe-inline'/, 'the directive after script-src is style-src (so the boundary check is meaningful)');
});
