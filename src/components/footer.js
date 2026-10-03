// PropBetEdge NETWORK FOOTER (Soccer). Sport network from the shared membership contract
// (9 sports, Soccer current), Soccer Intelligence + Soccer Pro links, the network, and the account
// card. The card shows the All Access offer only to readers the contract says may buy it; the
// manage link only where the contract says there is billing to manage (filled after the server answers).
import { NETWORK } from '../lib/pbe-membership.js';
import { esc, join } from '../lib/html.js';
import { OFFER } from '../lib/pro.js';
import { renderPreferredSource } from './preferred-source.js';

export const DISCORD_URL = 'https://discord.gg/kb5zCTHbME';
export const X_URL = 'https://x.com/PROPBETEDGE';
const ORDER = ['nfl', 'mlb', 'nba', 'wnba', 'nhl', 'ufc', 'tennis', 'soccer', 'golf'];

const INTELLIGENCE = [['/', 'Today'], ['/matches', 'Matches'], ['/pbecast', 'PBEcast'], ['/picks', 'Official Picks'], ['/track-record', 'Algo Track Record'], ['/players', 'Player DNA'], ['/competitions', 'Team Intelligence'], ['/tables', 'Tables'], ['/competitions', 'Competitions'], ['/news', 'News'], ['/sources', 'Sources & Method']];
const PRO = [['/pro#matchup', 'Matchup Lab'], ['/pro#fatigue', 'Fatigue Intelligence'], ['/pro#rotation', 'Rotation / XI Stability'], ['/pro#model-lab', 'Model Lab'], ['/pro#match-center', 'Pro Match Center'], ['/pro#track-record', 'Track Record']];
const NET = [[OFFER.url, 'All Access'], ['https://propbetedge.ai/', 'Sports News'], ['https://learn.propbetedge.ai/', 'Learn'], ['https://propsports.proptechusa.ai', 'PropSports API'], ['https://proptechusa.ai', 'PropTechUSA.ai'], [DISCORD_URL, 'Discord'], [X_URL, 'X @PROPBETEDGE']];

const col = (title, links, ext = false) => `<nav class="fcol" aria-label="${esc(title)}"><p class="fh">${esc(title.toUpperCase())}</p>${join(links, ([h, l]) => `<a href="${esc(h)}"${ext || /^https?:/.test(h) ? ' rel="noopener"' : ' data-link'}>${esc(l)}</a>`)}</nav>`;

export function networkFooter() {
  const sports = ORDER.map(k => NETWORK.find(s => s.key === k)).filter(Boolean);
  return `<footer class="foot netfoot"><div class="wrap">
    <nav class="fsports" aria-label="PropBetEdge sport network"><p class="fh">SPORT NETWORK</p><div class="fsport-row">${join(sports, s => s.key === 'soccer'
      ? `<span class="fsport on" aria-current="page">${esc(s.label.toUpperCase())}<small>CURRENT</small></span>`
      : `<a class="fsport" href="${esc(s.url)}/" rel="noopener">${esc(s.label.toUpperCase())}</a>`)}</div></nav>
    <div class="fgrid">
      ${col('Soccer Intelligence', INTELLIGENCE)}
      ${col('Soccer Pro', PRO)}
      ${col('Network', NET, true)}
      <aside class="facct" aria-label="Account" data-foot-account>
        <p class="aa-eyebrow">PROPBETEDGE ALL ACCESS</p>
        <p class="facct-copy">${esc(OFFER.tagline)}</p>
        <p class="aa-price"><b>${esc(OFFER.price)}</b></p>
        <p class="aa-promo">25% off while active with <b>${esc(OFFER.promoCode)}</b></p>
        <div class="facct-actions" data-foot-actions>
          <a class="aa-cta" href="${esc(OFFER.url)}" rel="noopener" data-pbe-placement="soccer_footer_all_access">GET ALL ACCESS</a>
          <a class="aa-learn" href="/pro#included" data-link>WHAT'S INCLUDED</a>
          <button type="button" class="aa-learn" data-account-open>SIGN IN / ACCOUNT</button>
        </div>
      </aside>
    </div>
    ${renderPreferredSource({ surface: 'footer' })}
    <p class="muted small fsrc"><!-- source-brand:allow (CC BY + ODbL licence credits) -->DATA · PropSports. Event data: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0 · Fixtures/results: OpenLigaDB, ODbL. Event maps show event locations, not player tracking. Workload intelligence is not a medical or fitness assessment.</p>
  </div></footer>`;
}

// After the server answers: All Access / owner see no purchase CTA; manage only when the contract says so.
export function applyFooterMembership(root, m) {
  const box = root.querySelector('[data-foot-actions]'); if (!box || !m) return;
  const card = root.querySelector('[data-foot-account]');
  if (m.state === 'all_access' || m.state === 'owner') {
    card.querySelector('.aa-price')?.remove(); card.querySelector('.aa-promo')?.remove();
    card.querySelector('.facct-copy').textContent = m.state === 'owner' ? 'Owner access: every PropBetEdge Pro sport.' : 'All Access is active on this account: every PropBetEdge Pro sport.';
    box.innerHTML = `${m.show_manage && m.manage_url ? `<a class="aa-cta" href="${esc(m.manage_url)}" rel="noopener">MANAGE SUBSCRIPTION</a>` : ''}<a class="aa-learn" href="/pro" data-link>SOCCER PRO</a><button type="button" class="aa-learn" data-account-open>ACCOUNT</button>`;
  } else if (m.email) {
    box.querySelector('[data-account-open]').textContent = 'ACCOUNT';
  }
}
