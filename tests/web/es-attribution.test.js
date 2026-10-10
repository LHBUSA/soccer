// Global #67 (M1): Spanish All Access acquisition is measured with the existing, approved mechanism only: the SAME
// canonical Payment Link gains locale=es + client_reference_id=pbe-es-pro-soccer on Spanish pages; the network /pro
// link gains ?lang=es&via=soccer. English pages, the price and the Payment Link itself are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ALL_ACCESS_OFFER, ALL_ACCESS_URL } from '../../src/lib/pbe-membership.js';
import { attributeCheckout, attributeNetworkPro, attributeHref, clientReferenceId, PAYMENT_LINK } from '../../src/i18n/attribution.js';
import { checkoutFor } from '../../src/lib/account-surface.js';
import { setCurrentLocale } from '../../src/i18n/current.js';
import { networkFooter } from '../../src/components/footer.js';
import { offerCard } from '../../src/components/offer.js';

const STRIPE = 'https://buy.stripe.com/8x2eVdgmOaqy4pv8Ez7wA0N';
const hrefs = html => [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1].replace(/&amp;/g, '&'));

test('same Payment Link and price; the tag is Stripe-valid and non-personal', () => {
  assert.equal(PAYMENT_LINK, STRIPE);
  assert.equal(ALL_ACCESS_OFFER.checkoutUrl, STRIPE);
  assert.equal(ALL_ACCESS_OFFER.price, '$29/month');
  assert.equal(clientReferenceId('es'), 'pbe-es-pro-soccer');
  assert.match(clientReferenceId('es'), /^[A-Za-z0-9_-]{1,200}$/);
});

test('es checkout: locale + tag appended to the same link; prefilled_email kept; idempotent', () => {
  const u = new URL(attributeCheckout(STRIPE, 'es'));
  assert.equal(`${u.origin}${u.pathname}`, STRIPE);
  assert.deepEqual([...u.searchParams.entries()], [['locale', 'es'], ['client_reference_id', 'pbe-es-pro-soccer']]);
  const withEmail = attributeCheckout(`${STRIPE}?prefilled_email=a%40b.co`, 'es');
  assert.deepEqual([...new URL(withEmail).searchParams.entries()], [['prefilled_email', 'a@b.co'], ['locale', 'es'], ['client_reference_id', 'pbe-es-pro-soccer']]);
  assert.equal(attributeCheckout(withEmail, 'es'), withEmail, 'idempotent');
  assert.equal(attributeHref(attributeHref(STRIPE, 'es'), 'es'), attributeHref(STRIPE, 'es'));
});

test('English and unready locales are byte-for-byte unchanged; other links never touched', () => {
  for (const l of ['en', 'pt', 'fr', undefined]) {
    assert.equal(attributeCheckout(STRIPE, l), STRIPE, String(l));
    assert.equal(attributeNetworkPro(ALL_ACCESS_URL, l), ALL_ACCESS_URL, String(l));
  }
  for (const h of ['https://buy.stripe.com/other', 'https://billing.stripe.com/p/login/x', '/all-access', 'https://propbetedge.ai/pro/x', 'https://evil.example/?u=' + STRIPE]) assert.equal(attributeHref(h, 'es'), h, h);
});

test('es network /pro link carries lang + via so the /pro checkout keeps the tag', () => {
  assert.equal(attributeNetworkPro(ALL_ACCESS_URL, 'es'), 'https://propbetedge.ai/pro?lang=es&via=soccer');
  assert.equal(attributeNetworkPro(`${ALL_ACCESS_URL}/`, 'es'), 'https://propbetedge.ai/pro?lang=es&via=soccer');
});

test('rendered purchase actions: tagged on /es, unchanged in English', () => {
  try {
    setCurrentLocale('en');
    assert.equal(checkoutFor(), STRIPE);
    assert.equal(checkoutFor('a@b.co'), `${STRIPE}?prefilled_email=a%40b.co`);
    assert.ok(hrefs(networkFooter()).includes(STRIPE));
    setCurrentLocale('es');
    assert.equal(checkoutFor(), `${STRIPE}?locale=es&client_reference_id=pbe-es-pro-soccer`);
    assert.equal(checkoutFor('a@b.co'), `${STRIPE}?prefilled_email=a%40b.co&locale=es&client_reference_id=pbe-es-pro-soccer`);
    const footer = hrefs(networkFooter()).filter(h => h.startsWith(STRIPE));
    assert.ok(footer.length >= 1 && footer.every(h => h.includes('client_reference_id=pbe-es-pro-soccer')), 'footer CTA tagged');
    const offer = hrefs(offerCard({ email: null })).filter(h => h.startsWith(STRIPE));
    assert.ok(offer.length >= 1 && offer.every(h => h.includes('client_reference_id=pbe-es-pro-soccer')), 'offer CTA tagged');
  } finally { setCurrentLocale('en'); }
});

test('the DOM pass applies the rule to every link (vendored membership panel included)', () => {
  const dom = readFileSync('src/i18n/dom.js', 'utf8');
  assert.match(dom, /import \{ attributeHref \} from '\.\/attribution\.js';/);
  assert.match(dom, /attributeHref\(h, locale\)/);
});
