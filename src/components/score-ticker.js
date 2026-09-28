// Soccer score ticker (the PropBetEdge house score rail, as on NHL / WNBA / MLB / NFL): one compact
// broadcast strip directly under the navigation on every page. Data: /api/soccer/live (the same
// envelope PBEcast uses). Live first, then upcoming, then recent finals; each item opens PBEcast.
// Desktop (wide + hover): a continuous marquee (pauses on hover / focus); touch: swipe. The native
// scrollbar is never shown and the strip never widens the page. Reduced motion: no marquee.
// A failed refresh keeps the last-known strip and says so; a live chip is never shown unqualified
// when the data is old.
import { api } from '../lib/api.js';
import { esc } from '../lib/html.js';
import { liveView } from '../lib/cast.js';
import { crest } from './media.js';

const POLL_LIVE = 30000; const POLL_SLATE = 120000; const POLL_IDLE = 600000;
const MAX_ITEMS = 24;
const STALE_MS = 5 * 60e3;

export const tickerTime = (iso, now = new Date()) => {
  const d = new Date(iso);
  const sameDay = d.toDateString() === now.toDateString();
  const t = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? t : `${d.toLocaleDateString([], { weekday: 'short' })} ${t}`;
};

// Order and window: live, then kick-offs in the next 36 h, then finals of the last 4 days.
export function tickerItems(x, now = Date.now()) {
  if (!x) return [];
  const soon = (x.upcoming || []).filter(m => Date.parse(m.kickoff_at) - now < 36 * 3600e3);
  return [...(x.live || []).map(m => ({ m, k: 'live' })), ...soon.map(m => ({ m, k: 'next' })), ...(x.recent || []).map(m => ({ m, k: 'ft' }))].slice(0, MAX_ITEMS);
}

export function tickerItem({ m, k }, { stale = false, now = new Date() } = {}) {
  const lv = k === 'live' ? liveView(m) : { score: m.score, clock: null };
  const sc = k !== 'next' && lv.score && lv.score.home !== null && lv.score.home !== undefined;
  const name = t => esc(t?.short_name || t?.name || '—');
  const side = (t, s) => `<span class="stk-side">${crest(t, 'xs')}<b>${name(t)}</b>${sc ? `<i>${esc(String(s))}</i>` : ''}</span>`;
  const state = k === 'live' ? `<span class="stk-chip${stale || m.live?.enrichment?.freshness?.stale ? ' delayed' : ''}">${stale ? 'LIVE · DELAYED' : 'LIVE'}</span>${lv.clock ? `<span class="stk-st">${esc(lv.clock)}</span>` : ''}`
    : k === 'ft' ? '<span class="stk-st ft">FINAL</span>' : `<span class="stk-st">${esc(tickerTime(m.kickoff_at, now))}</span>`;
  const label = `${m.home?.name || ''} ${sc ? `${lv.score.home} ` : ''}${sc ? '' : 'v '}${m.away?.name || ''}${sc ? ` ${lv.score.away}` : ''}, ${k === 'live' ? 'live' : k === 'ft' ? 'full time' : `kick-off ${tickerTime(m.kickoff_at, now)}`}. Open PBEcast.`;
  return `<a class="stk-g" data-state="${k}" href="/pbecast/${esc(m.id)}" data-link aria-label="${esc(label)}">
    ${m.competition ? `<span class="stk-comp a-${esc({ mls: 'mls', 'premier-league': 'epl', 'uefa-champions-league': 'ucl', bundesliga: 'bl' }[m.competition.slug] || 'x')}">${esc({ mls: 'MLS', 'premier-league': 'PL', 'uefa-champions-league': 'UCL', bundesliga: 'BL' }[m.competition.slug] || m.competition.name)}</span>` : ''}
    ${state}${side(m.home, lv.score?.home)}<span class="stk-vs" aria-hidden="true">${sc ? '–' : 'v'}</span>${side(m.away, lv.score?.away)}
  </a>`;
}

export function mountScoreTicker(host) {
  if (!host) return () => {};
  const reduce = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const wide = typeof matchMedia === 'function' ? matchMedia('(min-width: 900px) and (hover: hover)') : null;
  host.innerHTML = `<section class="stk" aria-label="Soccer scores" data-fresh="loading">
    <div class="wrap stk-in">
      <a class="stk-brand" href="/pbecast" data-link><b>SCORES</b><span class="stk-status">PBEcast</span></a>
      <div class="stk-viewport" tabindex="0" role="group" aria-label="Soccer scores, scrollable">
        <div class="stk-track"><div class="stk-run"><span class="stk-empty">Loading scores…</span></div></div>
      </div>
    </div>
  </section>`;
  const root = host.querySelector('.stk'); const viewport = host.querySelector('.stk-viewport');
  const track = host.querySelector('.stk-track'); const run = host.querySelector('.stk-run'); const status = host.querySelector('.stk-status');
  let last = null; let lastAt = 0; let failed = false; let sig = ''; let timer = null; let stopped = false;

  const layout = () => {
    track.querySelectorAll('.stk-clone').forEach(n => n.remove());
    track.classList.remove('marquee'); viewport.classList.remove('locked');
    if (!(run.scrollWidth > viewport.clientWidth + 2) || reduce?.matches || !wide?.matches) return;
    const clone = run.cloneNode(true); clone.classList.add('stk-clone'); clone.setAttribute('aria-hidden', 'true');
    clone.querySelectorAll('a').forEach(a => { a.removeAttribute('href'); a.removeAttribute('data-link'); a.tabIndex = -1; });
    track.append(clone);
    track.style.setProperty('--stk-dur', `${Math.max(30, Math.round(run.scrollWidth / 40))}s`);
    track.classList.add('marquee'); viewport.classList.add('locked');
  };
  const paint = () => {
    const x = last?.data || null;
    const stale = failed || (lastAt && Date.now() - lastAt > STALE_MS);
    const items = tickerItems(x);
    const live = items.filter(i => i.k === 'live').length;
    root.dataset.fresh = !x ? 'unavailable' : stale ? 'stale' : 'ok';
    root.dataset.live = live ? '1' : '';
    status.textContent = !x ? 'Unavailable' : stale ? 'Delayed' : live ? `${live} live` : 'PBEcast';
    const next = !x ? 'none' : `${stale ? 's' : ''}|${items.map(({ m, k }) => `${m.id}:${k}:${m.score?.home}:${m.score?.away}:${m.live?.display_clock || ''}:${m.live?.enrichment?.score?.home ?? ''}`).join('|')}`;
    if (next === sig) return; sig = next;
    run.innerHTML = !x ? '<span class="stk-empty">Scores unavailable right now</span>'
      : items.length ? items.map(i => tickerItem(i, { stale })).join('') : '<span class="stk-empty">No matches in the next 36 hours</span>';
    layout();
  };
  const poll = async () => {
    if (stopped) return;
    let wait = POLL_SLATE;
    if (!document.hidden) {
      try { last = await api('live', {}, { fresh: true }); lastAt = Date.now(); failed = false; wait = last.data.live?.length ? POLL_LIVE : tickerItems(last.data).length ? POLL_SLATE : POLL_IDLE; } catch { failed = true; }
      paint();
    }
    timer = setTimeout(poll, wait);
  };
  const onResize = () => layout();
  window.addEventListener('resize', onResize, { passive: true });
  reduce?.addEventListener?.('change', () => { sig = ''; paint(); });
  wide?.addEventListener?.('change', () => { sig = ''; paint(); });
  poll();
  return () => { stopped = true; clearTimeout(timer); window.removeEventListener('resize', onResize); };
}
