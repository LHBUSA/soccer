// Soccer score ticker (the PropBetEdge house score rail, as on NHL / WNBA / MLB / NFL): one compact
// broadcast strip directly under the navigation on every page. Data: /api/soccer/live (the same
// envelope PBEcast uses). Live first, then upcoming, then recent finals; each item opens PBEcast.
// Desktop (wide + hover): a continuous marquee (pauses on hover / focus); touch: swipe. The native
// scrollbar is never shown and the strip never widens the page. Reduced motion: no marquee.
// A failed refresh keeps the last-known strip and says so; a live chip is never shown unqualified
// when the data is old.
// Market line (MLB ticker standard): a scheduled / live chip whose match has an exact, displayable, non-stale
// Kalshi 90-minute market carries one compact segment "MKT ARS 41.0¢ · DRAW 27.0¢ · CHE 32.0¢" (Kalshi's own
// outcome codes, home / draw / away). The board is ONE shared read (shared client, 15 s TTL, our same-origin
// markets API, never Kalshi); the first paint waits for it at most KALSHI_FIRST_PAINT_MS beside the scores read;
// later prices are written into the chips IN PLACE (the run and the marquee copy), never rebuilding the strip,
// with fixed-width prices so nothing moves. The chip still opens PBEcast. Finals / no market -> chip unchanged.
import { api } from '../lib/api.js';
import { byDeadline, kalshi, KALSHI_FIRST_PAINT_MS, tickerMarket } from '../data/kalshi.js';
import { esc } from '../lib/html.js';
import { liveView } from '../lib/cast.js';
import { competitionMark, crest } from './media.js';

const POLL_LIVE = 60000; const POLL_SLATE = 300000; const POLL_IDLE = 900000;
const MAX_ITEMS = 24;
const STALE_MS = 5 * 60e3;
const MARKET_LIVE = 20000; const MARKET_PRE = 45000;

/** Market segment HTML for parts [{label, px}] (tickerMarket), or ''. */
export function tickerMarketHtml(parts) {
  if (!parts?.length) return '';
  return `<span class="stk-mkt" title="Kalshi prediction market · Mid-market (not sportsbook odds)"><span class="stk-mkt-b">MKT</span>${parts.map(p => `<span class="stk-mkt-o">${esc(p.label)} <span class="stk-mkt-px">${esc(p.px)}</span></span>`).join('<span class="stk-mkt-sep" aria-hidden="true">·</span>')}</span>`;
}
const marketKey = parts => (parts ? parts.map(p => `${p.label}:${p.px}`).join('|') : '');

/** Write (or remove) the market segment of one chip in place; nothing else in the chip changes. */
export function patchChipMarket(chip, parts) {
  const el = chip.querySelector('.stk-mkt');
  if (!parts) { if (el) el.remove(); return; }
  const pxs = el ? el.querySelectorAll('.stk-mkt-px') : [];
  if (!el || pxs.length !== parts.length || [...el.querySelectorAll('.stk-mkt-o')].some((o, i) => !o.textContent.startsWith(`${parts[i].label} `))) {
    if (el) el.remove();
    chip.insertAdjacentHTML('beforeend', tickerMarketHtml(parts));
    return;
  }
  parts.forEach((p, i) => { if (pxs[i].textContent !== p.px) pxs[i].textContent = p.px; });
}

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

export function tickerItem({ m, k }, { stale = false, now = new Date(), market = null } = {}) {
  const lv = k === 'live' ? liveView(m) : { score: m.score, clock: null };
  const sc = k !== 'next' && lv.score && lv.score.home !== null && lv.score.home !== undefined;
  const name = t => esc(t?.short_name || t?.name || '—');
  const side = (t, s) => `<span class="stk-side">${crest(t, 'xs')}<b>${name(t)}</b>${sc ? `<i>${esc(String(s))}</i>` : ''}</span>`;
  const state = k === 'live' ? `<span class="stk-chip${stale || m.live?.enrichment?.freshness?.stale ? ' delayed' : ''}">${stale ? 'LIVE · DELAYED' : 'LIVE'}</span>${lv.clock ? `<span class="stk-st">${esc(lv.clock)}</span>` : ''}`
    : k === 'ft' ? '<span class="stk-st ft">FINAL</span>' : `<span class="stk-st">${esc(tickerTime(m.kickoff_at, now))}</span>`;
  const label = `${m.home?.name || ''} ${sc ? `${lv.score.home} ` : ''}${sc ? '' : 'v '}${m.away?.name || ''}${sc ? ` ${lv.score.away}` : ''}, ${k === 'live' ? 'live' : k === 'ft' ? 'full time' : `kick-off ${tickerTime(m.kickoff_at, now)}`}. Open PBEcast.`;
  return `<a class="stk-g" data-state="${k}" data-mid="${esc(m.id)}" href="/pbecast/${esc(m.id)}" data-link aria-label="${esc(label)}">
    ${m.competition ? `<span class="stk-comp">${competitionMark(m.competition.slug, 'xs', { tone: 'dark' })}</span>` : ''}
    ${state}${side(m.home, lv.score?.home)}<span class="stk-vs" aria-hidden="true">${sc ? '–' : 'v'}</span>${side(m.away, lv.score?.away)}${tickerMarketHtml(market)}
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
        <div class="stk-track"><div class="stk-run"><span class="stk-skel" role="status"><span class="sr-only">Loading scores</span>${'<span class="stk-skel-g" aria-hidden="true"><i></i><b></b><i></i></span>'.repeat(5)}</span></div></div>
      </div>
    </div>
  </section>`;
  const root = host.querySelector('.stk'); const viewport = host.querySelector('.stk-viewport');
  const track = host.querySelector('.stk-track'); const run = host.querySelector('.stk-run'); const status = host.querySelector('.stk-status');
  let last = null; let lastAt = 0; let failed = false; let sig = ''; let timer = null; let stopped = false;
  let markets = new Map(); let mTimer = null; let mInFlight = false; let firstMarket = true;
  const marketsFor = items => {
    const map = new Map();
    for (const { m, k } of items) { const p = tickerMarket(kalshi.forEvent(m.id), m, k); if (p) map.set(m.id, p); }
    return map;
  };
  // Prices changed: patch every copy of the chip (run + marquee clone) in place; no rebuild, no scroll reset.
  const applyMarkets = () => {
    const items = tickerItems(last?.data || null);
    const next = marketsFor(items);
    for (const { m } of items) {
      if (marketKey(markets.get(m.id)) === marketKey(next.get(m.id))) continue;
      track.querySelectorAll(`.stk-g[data-mid="${CSS.escape(m.id)}"]`).forEach(chip => patchChipMarket(chip, next.get(m.id) || null));
    }
    markets = next;
  };
  const scheduleMarkets = () => {
    clearTimeout(mTimer); mTimer = null;
    if (stopped || !markets.size) return;
    const live = tickerItems(last?.data || null).some(i => i.k === 'live' && markets.has(i.m.id));
    mTimer = setTimeout(refreshMarkets, live ? MARKET_LIVE : MARKET_PRE);
  };
  const refreshMarkets = () => {
    if (stopped || mInFlight) return;
    if (document.hidden) { scheduleMarkets(); return; }
    mInFlight = true;
    kalshi.loadBoard().then(() => { if (!stopped) applyMarkets(); }, () => {}).finally(() => { mInFlight = false; scheduleMarkets(); });
  };

  const layout = () => {
    track.querySelectorAll('.stk-clone').forEach(n => n.remove());
    track.classList.remove('marquee'); viewport.classList.remove('locked');
    if (!(run.scrollWidth > viewport.clientWidth + 2) || reduce?.matches || !wide?.matches) return;
    // The visual loop copy: presentation only. One semantic score list exists (the run); the copy is
    // hidden from assistive tech (aria-hidden), inert (no focus, no clicks), excluded from text
    // selection / copy (CSS user-select: none) and from search snippets (data-nosnippet).
    const clone = run.cloneNode(true); clone.classList.add('stk-clone'); clone.setAttribute('aria-hidden', 'true');
    clone.setAttribute('inert', ''); clone.setAttribute('data-nosnippet', ''); clone.removeAttribute('id');
    clone.querySelectorAll('a').forEach(a => { a.removeAttribute('href'); a.removeAttribute('data-link'); a.removeAttribute('aria-label'); a.tabIndex = -1; });
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
    if (next === sig) { applyMarkets(); return; }
    sig = next;
    markets = marketsFor(items);
    run.innerHTML = !x ? '<span class="stk-empty">Scores unavailable right now</span>'
      : items.length ? items.map(i => tickerItem(i, { stale, market: markets.get(i.m.id) || null })).join('') : '<span class="stk-empty">No matches in the next 36 hours</span>';
    layout();
  };
  const poll = async () => {
    if (stopped) return;
    let wait = POLL_SLATE;
    if (!document.hidden) {
      // First paint: the shared board read runs beside the scores read and is waited for at most
      // KALSHI_FIRST_PAINT_MS, so chips that carry a market paint with it (no later width change).
      const board = firstMarket ? byDeadline(kalshi.loadBoard(), Date.now() + KALSHI_FIRST_PAINT_MS) : null;
      try { last = await api('live', {}, { fresh: true }); if (board) await board; lastAt = Date.now(); failed = false; wait = last.data.live?.length ? POLL_LIVE : tickerItems(last.data).length ? POLL_SLATE : POLL_IDLE; } catch { failed = true; }
      paint();
      if (firstMarket) { firstMarket = false; refreshMarkets(); } else if (!mTimer && !mInFlight) refreshMarkets();
    }
    timer = setTimeout(poll, wait);
  };
  const onResize = () => layout();
  window.addEventListener('resize', onResize, { passive: true });
  // A page opened in a background tab skips its first poll; load as soon as it is shown (never-loaded only).
  const onVisible = () => { if (!document.hidden && !lastAt && !stopped) { clearTimeout(timer); poll(); } };
  document.addEventListener('visibilitychange', onVisible);
  reduce?.addEventListener?.('change', () => { sig = ''; paint(); });
  wide?.addEventListener?.('change', () => { sig = ''; paint(); });
  poll();
  return () => { stopped = true; clearTimeout(timer); clearTimeout(mTimer); window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisible); };
}
