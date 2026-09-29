// PropBetEdge All Access offer card (the ONE network offer; no Soccer-only plan or Stripe product).
import { esc } from '../lib/html.js';
import { OFFER } from '../lib/pro.js';

// The All Access offer: never shown to All Access members or the owner.
export function offerCard(m, { compact = false } = {}) {
  if (m?.state === 'all_access' || m?.state === 'owner') return '';
  return `<aside class="aa-card${compact ? ' compact' : ''}" aria-label="PropBetEdge All Access">
    <p class="aa-eyebrow">PROPBETEDGE ALL ACCESS</p>
    <p class="aa-price"><b>${esc(OFFER.price)}</b></p>
    <p class="aa-copy">${esc(OFFER.tagline)}: NFL · MLB · NBA · WNBA · NHL · UFC · Tennis · Soccer.</p>
    <p class="aa-promo">25% off while active with <b>${esc(OFFER.promoCode)}</b></p>
    <div class="aa-actions"><a class="aa-cta" href="${esc(OFFER.url)}" rel="noopener" data-pbe-placement="soccer_pro_all_access">GET ALL ACCESS</a><a class="aa-learn" href="/pro#included" data-link>WHAT'S INCLUDED</a></div>
  </aside>`;
}

