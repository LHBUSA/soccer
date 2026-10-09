// Soccer premium account sheet + native /all-access page (owner decisions 2026-10-05): Platinum is presentation
// only, a failed check is never a sales screen, purchase actions keep the canonical All Access Stripe link,
// informational links open the local page, and the network comes from the vendored registry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import FAMILY from '../../src/lib/family.json' with { type: 'json' };
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL, deriveMembership } from '../../src/lib/pbe-membership.js';
import { ALL_ACCESS_CHECKOUT_URL, LOCAL_ALL_ACCESS_PATH, NETWORK_ALL_ACCESS_URL, NETWORK_SPORTS, OFFER_LINE, RESEARCH, accountView, checkoutFor, designation, headerLabel } from '../../src/lib/account-surface.js';
import { offerCard } from '../../src/components/offer.js';
import { networkFooter } from '../../src/components/footer.js';
import { allAccess } from '../../src/pages/all-access.js';
import { buildMeta, metaPlan, INDEX } from '../../src/seo/meta.js';
import { resolve } from '../../src/lib/router.js';
import { STATIC_PATHS } from '../../api/sitemap.js';

const STRIPE = 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N';
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const hrefs = html => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));
const m = (state, email = null) => ({ ...deriveMembership({ sport: 'soccer', entitled: state !== 'free', accessSource: state === 'free' ? null : state, email }), manage_url: 'https://billing.stripe.com/p/login/cNi3cv2vY7em3lr4oj7wA00' });
const V = {
  anonymous: { pro: false, check: 'ok', membership: m('free') },
  signed_in: { pro: false, check: 'ok', membership: m('free', 'member@example.com') },
  check: { pro: false, check: 'unavailable', membership: m('free', 'member@example.com') },
  check_anon: { pro: false, check: 'unavailable', membership: m('free') },
  all_access: { pro: true, check: 'ok', membership: m('all_access', 'platinum@example.com') },
  owner: { pro: true, check: 'ok', membership: m('owner', 'owner@example.com') },
};

test('three link jobs, three constants; checkout URL and price unchanged', () => {
  assert.equal(LOCAL_ALL_ACCESS_PATH, '/all-access');
  assert.equal(NETWORK_ALL_ACCESS_URL, ALL_ACCESS_URL);
  assert.equal(ALL_ACCESS_CHECKOUT_URL, ALL_ACCESS_OFFER.checkoutUrl);
  assert.equal(ALL_ACCESS_CHECKOUT_URL, STRIPE);
  assert.equal(ALL_ACCESS_OFFER.price, '$29/month');
  assert.equal(checkoutFor('a@b.co'), `${STRIPE}?prefilled_email=a%40b.co`);
});

test('designations: Platinum for all_access, owner verified, no FREE, no Soccer Pro plan', () => {
  assert.equal(designation('all_access').badge, '◆ PLATINUM');
  assert.equal(designation('all_access').eyebrow, 'SOCCER · PLATINUM MEMBER');
  assert.equal(designation('all_access').truth, 'PropBetEdge All Access · 10 sports + Predictions');
  assert.equal(designation('owner').badge, 'VERIFIED OWNER');
  assert.equal(designation('free'), null);
  assert.equal(designation('sport_pro'), null, 'Soccer has no single-sport plan');
  for (const v of Object.values(V)) assert.notEqual(headerLabel(v), 'FREE');
  assert.equal(headerLabel(V.check), 'ACCESS CHECK');
  assert.equal(headerLabel(V.all_access), '◆ PLATINUM');
});

test('view machine: a failed check is the access check, never sales; pro is trusted only from the server', () => {
  assert.equal(accountView(V.anonymous), 'signed_out');
  assert.equal(accountView(V.signed_in), 'signed_in');
  assert.equal(accountView(V.check), 'check');
  assert.equal(accountView(V.check_anon), 'check');
  assert.equal(accountView(V.all_access), 'all_access');
  assert.equal(accountView(V.owner), 'owner');
  assert.equal(accountView({ pro: false, check: 'ok', membership: m('all_access', 'x@y.z') }), 'signed_in', 'a membership label never grants: pro comes from the server');
});

test('/all-access per state: purchase only where allowed, exact Stripe link, never FREE', () => {
  for (const [name, a] of Object.entries(V)) {
    const html = allAccess.render({ access: a });
    const stripe = hrefs(html).filter(h => h.includes('buy.stripe.com'));
    assert.doesNotMatch(text(html), /\bFREE\b(?! for every reader)/, `${name}: no FREE label`);
    if (name === 'anonymous' || name === 'signed_in') {
      assert.equal(stripe.length, 1, `${name}: one GET ALL ACCESS`);
      assert.ok(stripe[0].startsWith(STRIPE), `${name}: canonical Stripe link`);
    } else {
      assert.equal(stripe.length, 0, `${name}: no purchase action`);
      assert.doesNotMatch(text(html), /GET ALL ACCESS|\$29/, `${name}: no price or purchase copy`);
    }
  }
  assert.match(allAccess.render({ access: V.all_access }), /PLATINUM MEMBER/);
  assert.match(allAccess.render({ access: V.owner }), /VERIFIED OWNER/);
  assert.match(allAccess.render({ access: V.check }), /Access check temporarily unavailable/);
});

test('/all-access network: 10 sports + Predictions from the registry, Soccer here, Predictions never a sport', () => {
  assert.deepEqual(NETWORK_SPORTS.map(s => s.key), FAMILY.sports.map(s => s.key));
  assert.equal(NETWORK_SPORTS.length, 10);
  assert.equal(OFFER_LINE, '10 sports + Predictions'); // canonical family registry label
  const html = allAccess.render({ access: V.anonymous });
  for (const s of NETWORK_SPORTS) assert.ok(html.includes(s.name), s.key);
  assert.match(html, /F1 Intelligence/);
  assert.match(html, /YOU ARE HERE/);
  assert.match(html, /INTELLIGENCE PRODUCT · NOT A SPORT/);
  assert.doesNotMatch(text(html), /11 sports|eleven sports/i);
  for (const s of FAMILY.sports.filter(s => s.key !== 'soccer')) assert.ok(hrefs(html).includes(s.url), `${s.key} opens its product`);
});

test('Model Lab is research, never presented as live predictions', () => {
  assert.match(RESEARCH[0].sub, /no probabilities published/);
  const html = text(allAccess.render({ access: V.all_access }));
  assert.match(html, /never a win probability/);
  assert.doesNotMatch(html, /win probabilit(y|ies) (are|is) (live|included)/i);
});

test('offer card: GET ALL ACCESS keeps the Stripe link; WHAT\'S INCLUDED opens /all-access; never for members', () => {
  const out = offerCard(m('free'));
  assert.ok(hrefs(out).includes(STRIPE));
  assert.ok(hrefs(out).includes('/all-access'));
  assert.ok(!hrefs(out).includes(ALL_ACCESS_URL));
  assert.doesNotMatch(out, /NFL · MLB · NBA · WNBA · NHL · UFC · Tennis · Soccer/);
  assert.match(offerCard(m('free', 'a@b.co')), /prefilled_email=a%40b\.co/);
  assert.equal(offerCard(m('all_access')), '');
  assert.equal(offerCard(m('owner')), '');
});

test('footer: Stripe checkout, local information, plus explicit canonical network destination', () => {
  const html = networkFooter();
  assert.ok(hrefs(html).includes(STRIPE));
  assert.ok(hrefs(html).filter(h => h === '/all-access').length >= 2, 'WHAT\'S INCLUDED + network All Access');
  assert.ok(hrefs(html).includes(ALL_ACCESS_URL), 'network product destination stays externally linked');
});

test('/all-access is a real local page: route, indexable self-canonical meta, sitemap, no redirect constructs', () => {
  assert.equal(resolve('/all-access').page, 'allAccess');
  const meta = buildMeta('/all-access', metaPlan('/all-access').page);
  assert.equal(meta.status, 200);
  assert.equal(meta.canonical, 'https://soccer.propbetedge.ai/all-access');
  assert.equal(meta.robots, INDEX);
  assert.match(meta.title, /All Access/);
  assert.ok(STATIC_PATHS.includes('/all-access'));
  const src = readFileSync(new URL('../../src/pages/all-access.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /location\.(href|replace|assign)|http-equiv|<iframe|propbetedge\.ai\/pro/);
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  assert.ok(!JSON.stringify(vercel.redirects || []).includes('all-access'), 'no redirect for /all-access');
});

test('header ALL ACCESS nav and account sheet stay on the site; no FREE pill on /pro', () => {
  const main = readFileSync(new URL('../../src/main.js', import.meta.url), 'utf8');
  assert.match(main, /<a class="nav-aa" href="\$\{LOCAL_ALL_ACCESS_PATH\}" data-link data-pages="allAccess">ALL ACCESS<\/a>/);
  const pro = readFileSync(new URL('../../src/pages/pro.js', import.meta.url), 'utf8');
  assert.doesNotMatch(pro, /'FREE'/, 'no FREE membership label literal (the FREE vs ALL ACCESS feature column is a tier heading, not a label)');
  const acct = readFileSync(new URL('../../src/components/account.js', import.meta.url), 'utf8');
  assert.doesNotMatch(acct, /max-height|overflow:\s*auto/);
});
