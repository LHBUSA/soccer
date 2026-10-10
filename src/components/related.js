// "In the news": stories whose frozen evidence names this match / team / player.
// Filled after render (the entity page never waits on it); nothing is shown when no
// story exists, so no dead-end "no news" boxes.
import { api } from '../lib/api.js';
import { currentLocale, newsLocale, servedInLocale } from '../i18n/current.js';
import { esc, join } from '../lib/html.js';
import { dateShort } from '../lib/format.js';
import { compByDesk } from '../lib/competitions.js';
import { competitionMark, sectionHead } from './ui.js';

export async function mountRelatedNews(root, params, { title = 'In the news', kicker = 'NEWSROOM' } = {}) {
  const slot = root.querySelector('[data-related-news]');
  if (!slot) return;
  try {
    // Localized page: only verified current translations (servedInLocale), read from a wider window.
    const native = currentLocale() !== 'en';
    const env = await api('news', newsLocale({ ...params, limit: native ? 20 : 6 }));
    const items = (env.data || []).filter(a => servedInLocale(a)).slice(0, 6);
    if (!items.length || !slot.isConnected) return;
    slot.innerHTML = `${sectionHead(kicker, title)}<ul class="related">${join(items, a => {
      const c = compByDesk(a.desk);
      return `<li><a href="/news/${esc(a.desk)}/${esc(a.slug)}" data-link>${c ? competitionMark(c.slug, 'xs') : ''}<span class="rel-head">${esc(a.headline)}</span><span class="rel-date">${esc(dateShort(a.published_at))}</span></a></li>`;
    })}</ul>`;
  } catch { /* related stories are optional: never break the page */ }
}
