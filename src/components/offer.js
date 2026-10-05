// PropBetEdge All Access offer card (the ONE network offer; no Soccer-only plan or Stripe product).
// Owner link policy: GET ALL ACCESS is a purchase action and uses the canonical All Access Stripe Payment Link
// (the signed-in reader's verified email rides on it); WHAT'S INCLUDED is informational and opens /all-access.
import { esc, join } from '../lib/html.js';
import { LOCAL_ALL_ACCESS_PATH, NETWORK_SPORTS, OFFER_LINE, PREDICTIONS, PREDICTIONS_BLURB, PRICE, PROMO_CODE, checkoutFor } from '../lib/account-surface.js';

// The All Access offer: never shown to All Access members or the owner.
export function offerCard(m, { compact = false } = {}) {
  if (m?.state === 'all_access' || m?.state === 'owner') return '';
  return `<aside class="aa-card${compact ? ' compact' : ''}" aria-label="PropBetEdge All Access">
    <p class="aa-eyebrow">PROPBETEDGE ALL ACCESS</p>
    <p class="aa-price"><b>${esc(PRICE)}</b></p>
    <p class="aa-copy"><b>${esc(OFFER_LINE)}.</b> One membership across the PropBetEdge intelligence network.</p>
    <p class="aa-k">SPORTS · ${NETWORK_SPORTS.length}</p>
    <ul class="aa-sports" aria-label="${esc(NETWORK_SPORTS.map(s => s.name).join(', '))}">${join(NETWORK_SPORTS, s => `<li${s.here ? ' class="on"' : ''}>${esc(s.name)}</li>`)}</ul>
    <p class="aa-k">INTELLIGENCE</p>
    <p class="aa-intel"><b>◆ ${esc(PREDICTIONS.label)}</b><span>${esc(PREDICTIONS_BLURB)}</span></p>
    <p class="aa-promo">25% off while active with <b>${esc(PROMO_CODE)}</b></p>
    <div class="aa-actions"><a class="aa-cta" href="${esc(checkoutFor(m?.email))}" rel="noopener" data-pbe-placement="soccer_pro_all_access">GET ALL ACCESS</a><a class="aa-learn" href="${LOCAL_ALL_ACCESS_PATH}" data-link>WHAT'S INCLUDED</a></div>
  </aside>`;
}
