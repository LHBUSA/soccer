// PBEcast: the soccer match-cast surface.
//   /pbecast            hub: live now (provider clock + freshness), replays, upcoming
//   /pbecast/:matchId   the cast: LIVE (polls the API), REPLAY (finished: scrub / play the
//                       sourced sequence), PREGAME (kick-off, lineups when sourced)
// Everything drawn is a sourced event: shot locations where the source located them, goals,
// cards, substitutions, the running canonical score. No tracking, no invented positions, no
// interpolated clock: live shows the provider's own clock; replay shows the source minute.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { ago, dateShort, dateTime, num, sourceName, STAT_LABELS, statsHeading, time } from '../lib/format.js';
import { compMeta } from '../lib/competitions.js';
import { buildTimeline, clockAt, keyMoments, liveStatus, liveView, pctOf, PERIOD_LABEL, pitchItems, pitchKind, replayView } from '../lib/cast.js';
import { competitionMark, empty, link, mountMediaFallbacks, playerChip, sectionHead, sourcePanel, statusPill, teamLink, teamMark } from '../components/ui.js';
import { L, W, pitchLines } from '../components/pitch.js';
import { keyPlayers } from '../components/keyplayers.js';
import { matchTitle } from '../seo/meta.js';

const POLL_LIVE_MS = 60000;   // the ingest lane polls about once a minute; do not poll faster than the source can change
const POLL_HUB_MS = 60000;
const hasSequence = m => m?.intel?.events || m?.intel?.event_map;

// In-place refresh for live views: same URL, no history entry, no scroll jump, no loading flash.
// A hidden tab skips the fetch and checks again later; a failed fetch keeps the current view.
export function softRefresh(root, load, page, every) {
  const path = location.pathname + location.search;
  setTimeout(async () => {
    if (location.pathname + location.search !== path || !root.isConnected) return;
    if (document.hidden) return softRefresh(root, load, page, every);
    try {
      const d = await load();
      if (location.pathname + location.search !== path || !root.isConnected) return;
      root.innerHTML = page.render(d);
      mountMediaFallbacks(root);
      page.mount?.(root, d);
    } catch { softRefresh(root, load, page, every); }
  }, every);
}

// ---------------------------------------------------------------- hub
function hubCard(m, kind) {
  const lv = kind === 'live' ? liveView(m) : { score: m.score, clock: null };
  const sc = lv.score && lv.score.home !== null && lv.score.home !== undefined;
  const f = compMeta(m.competition?.slug);
  const side = (t, s) => `<span class="hc-side">${teamMark(t)}<span class="hc-name">${esc(t?.short_name || t?.name || '—')}</span>${sc ? `<b>${esc(String(s))}</b>` : ''}</span>`;
  const top = kind === 'live' ? `<span class="hc-clock">${esc(lv.clock || m.live?.detail || 'LIVE')}</span>`
    : kind === 'replay' ? '<span class="hc-tag">REPLAY</span>' : `<span class="hc-tag up">${esc(dateShort(m.kickoff_at))} · ${esc(time(m.kickoff_at))}</span>`;
  const cta = kind === 'live' ? 'OPEN LIVE CAST' : kind === 'replay' ? (hasSequence(m) ? 'REPLAY THE MATCH' : 'RESULT ONLY') : 'PREVIEW';
  return `<a class="hcard k-${kind}" href="/pbecast/${esc(m.id)}" data-link>
    <span class="hc-top">${f ? competitionMark(f.slug, 'xs') : ''}<span class="hc-comp">${esc(f?.name || m.competition?.name || '')}</span>${kind === 'live' ? statusPill('live') : ''}${top}</span>
    ${side(m.home, lv.score?.home)}${side(m.away, lv.score?.away)}
    <span class="hc-cta">${esc(cta)} <span aria-hidden="true">→</span></span>
  </a>`;
}

export const hub = {
  title: () => 'PBEcast — Live Soccer Match Tracker & Replays | PropBetEdge',
  async load() { return { env: await api('live', {}, { fresh: true }) }; },
  render(d) {
    const x = d.env.data; const lane = x.lane;
    const replays = x.recent || [];
    return `<section class="hero compact cast-hero"><div class="wrap">
      <p class="kicker gold">PBECAST</p><h1 class="display">Every match, event by event</h1>
      <p class="lede">Live scores with the provider's own clock, then a replay of every sourced shot, goal, card and substitution on the canonical pitch. Event locations, not player tracking.</p>
      <p class="lane-line">${lane ? `Live lane: about one source check a minute per live match${lane.last_success_at ? ` · last live run ${esc(ago(lane.last_success_at))}` : ''}` : 'Live lane status unavailable'}</p>
    </div></section>
    <section class="canvas"><div class="wrap">
      ${sectionHead('LIVE NOW', x.live.length ? `${num(x.live.length)} ${x.live.length === 1 ? 'match' : 'matches'} in play` : 'No match in play')}
      ${x.live.length ? `<div class="hgrid" aria-live="polite">${join(x.live, m => hubCard(m, 'live'))}</div>` : '<p class="muted">No covered match is in play right now. Live casts open automatically at kick-off.</p>'}
      ${sectionHead('REPLAYS', 'Last four days')}
      ${replays.length ? `<div class="hgrid">${join(replays, m => hubCard(m, 'replay'))}</div>` : empty('No recent matches', 'Replays appear here after the final whistle.')}
      ${when(x.upcoming?.length, () => `${sectionHead('UPCOMING', 'Next kick-offs')}<div class="hgrid">${join(x.upcoming.slice(0, 12), m => hubCard(m, 'upcoming'))}</div>`)}
      ${sourcePanel(d.env.meta, { title: 'HOW PBECAST WORKS' })}
    </div></section>`;
  },
  mount(root, d) {
    if (d.env.data.live.length) softRefresh(root, () => hub.load(), hub, POLL_HUB_MS);
  },
};

// ---------------------------------------------------------------- cast
export async function loadCast([id]) { return { env: await api(`matches/${id}/cast`, {}, { fresh: true }) }; }

const ICON = { goal: '●', own_goal: '●', shot: '○', card_yellow: '▮', card_red: '▮', sub: '⇄' };
const WORD = { goal: 'Goal', own_goal: 'Own goal', shot: 'Shot', card_yellow: 'Yellow card', card_red: 'Red card', sub: 'Substitution' };
const OUT = { goal: 'goal', on_target: 'on target', off_target: 'off target', blocked: 'blocked', post: 'woodwork' };

// One marker per eligible pitch event (pitchItems: shots, goals, own goals with a source location;
// never cards, substitutions or other timeline items). Goals carry a ring; ONLY the current replay
// event is highlighted, and only it gets the one-shot pulse (`cpulse`, never the page's `.pulse`
// loading-dot class, whose infinite keyframes would light every hidden halo).
const R = { goal: [1.5, 1.75], og: [1.5, 1.75], on: [1.05, 1.25], off: [0.8, 0.95], blocked: [0.8, 0.95], post: [0.8, 0.95] };
function markFor(x, portrait, { current = false, pulse = false } = {}) {
  const kind = pitchKind(x);
  if (!kind || x.x < 0 || x.x > L || x.y < 0 || x.y > W) return '';
  const p = portrait ? { x: x.y, y: L - x.x } : { x: x.x, y: x.y };
  const r = R[kind][portrait ? 1 : 0];
  const ring = kind === 'goal' || kind === 'og' ? `<circle class="ring${kind === 'og' ? ' og' : ''}" cx="${p.x}" cy="${p.y}" r="${r + (portrait ? 1 : 0.85)}"/>` : '';
  return `<g class="cmark k-${kind}${current ? ' cur' : ''}" data-ci="${x.i}" data-v="${x.v ?? ''}"${x.v !== null && x.v !== undefined ? ` data-seek="${x.v}"` : ''}>${ring}<circle class="shot ${x.team === 'away' ? 'away' : 'home'} ${kind}" cx="${p.x}" cy="${p.y}" r="${r}"/>${current && pulse ? `<circle class="cpulse" cx="${p.x}" cy="${p.y}" r="${r + 1.6}"/>` : ''}</g>`;
}

// Pitch marks for the events the view may show: the full match live / at full time, only
// replayView().seen during a replay (a future shot is never in the markup). `current` is the
// replay's current event (the only one highlighted); none at full time or live.
export const pitchMarks = (items, portrait, { current = null, pulse = false } = {}) =>
  join(pitchItems(items), x => markFor(x, portrait, { current: !!current && x.i === current.i, pulse }));
export function castPitch(tl, m, { portrait = false, items = tl.items, current = null } = {}) {
  const hn = m.home?.short_name || m.home?.name || 'Home'; const an = m.away?.short_name || m.away?.name || 'Away';
  const marks = pitchMarks(items, portrait, { current });
  if (portrait) {
    return `<svg class="pitch portrait cast" viewBox="-3 -7 ${W + 6} ${L + 14}" role="img" aria-label="PBEcast pitch: sourced shot locations. ${esc(hn)} attack up, ${esc(an)} attack down.">
      <g transform="translate(0 ${L}) rotate(-90)">${pitchLines()}</g>
      <text class="dir" x="${W / 2}" y="-3.6" text-anchor="middle">↑ ${esc(hn.toUpperCase())}</text><text class="dir" x="${W / 2}" y="${L + 5.6}" text-anchor="middle">↓ ${esc(an.toUpperCase())}</text>
      <g class="marks">${marks}</g></svg>`;
  }
  return `<svg class="pitch cast" viewBox="-3 -3 ${L + 6} ${W + 6}" role="img" aria-label="PBEcast pitch: sourced shot locations. ${esc(hn)} attack right, ${esc(an)} attack left.">
    ${pitchLines()}<text class="dir" x="${L - 1}" y="-0.8" text-anchor="end">${esc(hn.toUpperCase())} →</text><text class="dir" x="1" y="-0.8">← ${esc(an.toUpperCase())}</text>
    <g class="marks">${marks}</g></svg>`;
}

export function feedItem(x, m, { current = false, seekable = false } = {}) {
  const team = x.team === 'away' ? m.away : m.home;
  const who = x.type === 'sub' ? `${playerChip(x.player_in)} <span class="muted">on for</span> ${playerChip(x.player_out)}`
    : `${playerChip(x.player, { extra: x.penalty ? ' <span class="muted">(pen)</span>' : '' })}${x.assist ? ` <span class="muted">assist</span> ${playerChip(x.assist)}` : ''}`;
  const detail = x.type === 'shot' ? OUT[x.outcome] || 'shot' : '';
  const seek = seekable && x.v !== null && x.v !== undefined ? ` data-seek="${x.v}" tabindex="0"` : '';
  return `<li class="fi t-${esc(x.type)} ${x.team === 'away' ? 'away' : 'home'}${current ? ' cur' : ''}" data-fi="${x.i}" data-v="${x.v ?? ''}"${seek}${current ? ' aria-current="true"' : ''}>
    <span class="fi-min">${esc(x.display_minute || '—')}</span>
    <span class="fi-ic" aria-hidden="true">${ICON[x.type] || '•'}</span>
    <span class="fi-body"><span class="fi-kind">${esc(WORD[x.type] || 'Event')}${detail ? ` · ${esc(detail)}` : ''} · ${esc(team?.short_name || team?.name || '')}</span><span class="fi-who">${who}</span></span>
    ${x.type === 'goal' || x.type === 'own_goal' ? `<span class="fi-score">${esc(String(x.score.home))}–${esc(String(x.score.away))}</span>` : ''}
  </li>`;
}

// The replay's current event in words: what the scrubber is at (never a later event).
export function nowLine(rv, m) {
  const hn = m.home?.short_name || m.home?.name || 'Home'; const an = m.away?.short_name || m.away?.name || 'Away';
  if (rv.atEnd) return `Full time · ${hn} ${rv.score.home}–${rv.score.away} ${an}`;
  const x = rv.current;
  if (!x) return `Kick-off · ${rv.clock} · ${hn} 0–0 ${an}`;
  const team = x.team === 'away' ? m.away : m.home;
  const who = x.type === 'sub' ? `${x.player_in?.name || 'Unidentified'} on for ${x.player_out?.name || 'unidentified'}` : x.player?.name || '';
  const detail = x.type === 'shot' ? ` (${OUT[x.outcome] || 'shot'})` : '';
  return `${x.display_minute || rv.clock} ${WORD[x.type] || 'Event'}${detail}${who ? ` · ${who}` : ''} · ${team?.short_name || team?.name || ''} · ${hn} ${rv.score.home}–${rv.score.away} ${an}`;
}

export function timelineBar(tl, m) {
  const markers = tl.items.filter(x => x.v !== null && x.type !== 'shot');
  return `<div class="tl" data-tl>
    <div class="tl-track">
      ${join(tl.segments, s => `<span class="tl-seg" style="left:${pctOf(s.start, tl)}%;width:${pctOf(s.end, tl) - pctOf(s.start, tl)}%" title="${esc(PERIOD_LABEL[s.period])}"></span>`)}
      <span class="tl-fill" data-tl-fill style="width:100%"></span>
      ${join(tl.items.filter(x => x.v !== null && x.type === 'shot'), x => `<i class="tl-shot ${x.team === 'away' ? 'away' : 'home'}" data-v="${x.v}" style="left:${pctOf(x.v, tl)}%"></i>`)}
      ${join(markers, x => `<button type="button" class="tl-m t-${esc(x.type)} ${x.team === 'away' ? 'away' : 'home'}" style="left:${pctOf(x.v, tl)}%" data-seek="${x.v}" aria-label="${esc(`${x.display_minute || ''} ${WORD[x.type] || ''} ${x.type === 'sub' ? x.player_in?.name || '' : x.player?.name || ''}`)}"></button>`)}
    </div>
    <div class="tl-scale"><span>0'</span><span>HT</span><span>${esc(clockAt(tl.total, tl))}</span></div>
  </div>`;
}

function statsCompare(m) {
  const h = statsHeading(m.stats);
  if (!h) return '<p class="muted">No match statistics from a legitimate source for this match.</p>';
  const keys = ['possession_pct', 'shots', 'shots_on_target', 'provider_xg_espn', 'passes', 'corners', 'fouls_committed', 'saves'];
  const rows = STAT_LABELS[m.stats.basis].filter(([k]) => keys.includes(k) && (m.stats.home[k] !== undefined || m.stats.away[k] !== undefined));
  return `<p class="stats-basis ${m.stats.basis}"><b>${esc(h.title)}</b> ${esc(h.note)}</p><div class="cstats">${join(rows, ([k, label, suffix = '', dp = 0]) => {
    const hv = m.stats.home[k]; const av = m.stats.away[k]; const hn = Number(hv) || 0; const an = Number(av) || 0; const tot = hn + an;
    return `<div class="cs-row"><span class="cs-v">${num(hv, { dp, suffix })}</span><span class="cs-l">${esc(label)}</span><span class="cs-v r">${num(av, { dp, suffix })}</span>${tot > 0 && hv !== undefined && av !== undefined ? `<span class="cs-bar"><i class="h" style="width:${(100 * hn / tot).toFixed(1)}%"></i><i class="a" style="width:${(100 * an / tot).toFixed(1)}%"></i></span>` : ''}</div>`;
  })}</div>`;
}

function lineupsCompact(m) {
  if (!m.lineups) return '<p class="muted">Lineups are not available from a legitimate source for this match yet.</p>';
  const side = (k, t) => { const l = m.lineups[k]; if (!l) return ''; return `<div class="clu"><h3>${teamMark(t, 'xs')} ${esc(t?.short_name || t?.name || '')}${l.formation ? ` <span class="muted">${esc(l.formation)}</span>` : ''}</h3><ul>${join((l.starters || []).filter(Boolean), p => `<li><span class="shirt">${p.shirt ? esc(String(p.shirt)) : ''}</span>${playerChip(p, { size: 'sm' })}</li>`)}</ul></div>`; };
  return `<div class="clus">${side('home', m.home)}${side('away', m.away)}</div>`;
}

export function castView(env) {
  const m = env.data; const live = m.live || { mode: 'replay' };
  const tl = buildTimeline(m.sequence || []);
  const mode = live.mode === 'live' ? 'live' : live.mode === 'replay' ? 'replay' : live.mode === 'pregame' ? 'pregame' : 'other';
  const st = liveStatus(live);
  const lv = mode === 'live' ? liveView(m) : { score: m.score, clock: null };
  const sc = lv.score && lv.score.home !== null && lv.score.home !== undefined ? lv.score : null;
  const rv = replayView(tl.total, tl, m.score); // the replay opens at full time: everything sourced is known
  const located = pitchItems(tl.items).length;
  const moments = keyMoments(tl);
  const clock = mode === 'live' ? (lv.clock || (lv.from === 'canonical' ? live.detail || '' : '')) : mode === 'replay' ? 'FT' : '';
  return `<section class="cast-top ${esc(mode)}"><div class="wrap">
      <p class="ct-meta">${link('/pbecast', 'PBECAST', 'ct-home')} · ${m.competition ? link(`/competitions/${m.competition.slug}`, `${competitionMark(m.competition.slug, 'xs', { tone: 'dark' })}<span>${esc(m.competition.name)}</span>`, 'ct-comp') : ''}${m.round ? ` · ${esc(m.round)}` : ''}</p>
      <h1 class="sr-only">${esc(m.home?.name || '')} v ${esc(m.away?.name || '')}: PBEcast</h1>
      <div class="ct-board">
        <div class="ct-team">${teamMark(m.home, 'md')}${teamLink(m.home, 'ct-name')}</div>
        <div class="ct-score" data-ct-score>${sc || mode === 'replay' ? `<span data-sh>${esc(String(sc?.home ?? 0))}</span><i>–</i><span data-sa>${esc(String(sc?.away ?? 0))}</span>` : '<span class="vs">v</span>'}</div>
        <div class="ct-team away">${teamMark(m.away, 'md')}${teamLink(m.away, 'ct-name')}</div>
      </div>
      <p class="ct-status">${mode === 'live' ? `<span class="ct-live ${esc(st.tone)}"><i class="livedot" aria-hidden="true"></i>${esc(st.label)}</span>${clock ? `<span class="ct-clock">${esc(clock)}</span>` : ''}` : mode === 'replay' ? `<span class="ct-tag">PBECAST REPLAY</span><span class="ct-clock" data-ct-clock>${esc(clock)}</span>` : statusPill(m.status)}
        <span class="muted">${esc(dateTime(m.kickoff_at))}${m.venue ? ` · ${esc(m.venue.name)}` : ''}</span></p>
      ${when(st, () => `<p class="ct-fresh" role="status">${esc(st.note)}</p>`)}
    </div></section>
    <section class="canvas cast-body" data-match-id="${esc(m.id)}"><div class="wrap">
      ${mode === 'pregame' ? `<div class="panel pregame">${sectionHead('PREGAME', `Kick-off ${dateTime(m.kickoff_at)}`)}<p>PBEcast goes live at kick-off: the score and the provider's clock, then every sourced shot, goal, card and substitution as the source records it. This page refreshes itself.</p></div>` : ''}
      ${when(tl.items.length, () => `<div class="cast-grid">
        <div class="cast-stage panel">
          ${mode === 'replay' ? `<div class="rp" data-replay>
            <button type="button" class="btn gold rp-play" data-rp-play aria-pressed="false">▶ REPLAY FROM KICK-OFF</button>
            <label class="rp-speed">Speed <select data-rp-speed><option value="0.5">1 min / 2 s</option><option value="1" selected>1 min / s</option><option value="3">3 min / s</option></select></label>
            <input type="range" class="rp-range" data-rp-range min="0" max="${tl.total}" step="0.25" value="${tl.total}" aria-label="Replay position (match minute)">
            <p class="rp-now" data-rp-now aria-live="polite"><span class="rp-now-k">NOW</span><span data-rp-now-text>${esc(nowLine(rv, m))}</span></p>
            ${when(moments.length, () => `<div class="rp-moments" aria-label="Jump to a key moment"><span class="rp-jump">JUMP TO</span>${join(moments, x => `<button type="button" class="chip" data-seek="${x.v}">${esc(x.display_minute || '')} ${esc(x.type === 'card_red' ? 'Red' : 'Goal')} ${esc(x.player?.name?.split(' ').slice(-1)[0] || '')}</button>`)}</div>`)}
          </div>` : ''}
          ${timelineBar(tl, m)}
          <div class="pitchwrap land">${castPitch(tl, m)}</div>
          <div class="pitchwrap port">${castPitch(tl, m, { portrait: true })}</div>
          <p class="emap-label" data-rp-caption>${mode === 'replay' ? esc(rv.caption) : located ? `${num(located)} LOCATED SHOTS · EVENT LOCATIONS, NOT PLAYER TRACKING` : 'NO LOCATED EVENTS FROM THIS SOURCE · NOTHING IS PLOTTED'}</p>
          <p class="legend"><span><i class="lg goal"></i>Goal</span><span><i class="lg on"></i>On target</span><span><i class="lg off"></i>Off target / blocked</span><span class="muted">Shots only · cards and substitutions are in the feed</span></p>
        </div>
        <div class="cast-feed panel">${mode === 'replay' ? '<header class="sec-head"><p class="kicker">REPLAY FEED</p><h2 data-feed-sub>Full match · latest first</h2></header>' : sectionHead(mode === 'live' ? 'LIVE FEED' : 'MATCH FEED', 'Sourced events, newest first')}
          <ol class="feed" data-feed${mode === 'live' ? ' aria-live="polite"' : ''}>${mode === 'replay' ? join([...rv.seen].reverse(), x => feedItem(x, m, { current: x === rv.current, seekable: true })) : join([...tl.items].reverse(), x => feedItem(x, m))}</ol>
        </div>
      </div>`)}
      ${when(!tl.items.length && mode !== 'pregame', () => empty('No sourced events for this match', m.event_source === 'openligadb' ? 'The result source reports the score without an event record, so there is nothing to cast. Nothing is plotted rather than something invented.' : 'No event record is stored for this match yet.'))}
      ${when(m.players?.rows?.length, () => `<div class="panel kp-panel">${sectionHead('PLAYER IMPACT', 'Who shaped the match · tap a player for Player DNA')}${keyPlayers(m, { title: false })}</div>`)}
      <div class="two">
        <div class="panel">${sectionHead('MATCH STATS', 'By source basis')}${statsCompare(m)}</div>
        <div class="panel">${sectionHead('LINEUPS', 'Starting XI')}${lineupsCompact(m)}</div>
      </div>
      <p class="cast-links">${link(`/matches/${m.id}`, 'FULL MATCH INTELLIGENCE →', 'btn ghost dark')}</p>
      ${sourcePanel(env.meta, { title: 'PBECAST SOURCE & FRESHNESS', extra: [['Mode', mode.toUpperCase()], ['Source clock', live.display_clock || (mode === 'live' ? 'Not supplied' : 'Not live')], ['Last source observation', live.provider_observed_at ? `${dateTime(live.provider_observed_at)} (${ago(live.provider_observed_at)})` : 'None'], ...(live.enrichment ? [['Result of record', sourceName(live.canonical_result_source)], ['Live score', `${sourceName(live.enrichment.source)}, fetched ${live.enrichment.fetched_at ? `${dateTime(live.enrichment.fetched_at)} (${ago(live.enrichment.fetched_at)})` : 'never'}${live.enrichment.freshness?.stale ? ' · delayed' : ''}`]] : [])] })}
    </div></section>`;
}

// Replay engine: moves a cursor over the virtual minute axis. Every frame is ONE replayView() (built on
// stateAt): score, clock, current event, pitch marks (future marks are removed from the markup), feed
// (events through the cursor, current first), timeline markers (future ones dimmed) and caption.
export function mountReplay(root, env) {
  const box = root.querySelector('[data-replay]'); if (!box) return () => {};
  const m = env.data; const tl = buildTimeline(m.sequence || []);
  const range = box.querySelector('[data-rp-range]'); const play = box.querySelector('[data-rp-play]'); const speed = box.querySelector('[data-rp-speed]');
  const fill = root.querySelector('[data-tl-fill]'); const clock = root.querySelector('[data-ct-clock]');
  const sh = root.querySelector('[data-sh]'); const sa = root.querySelector('[data-sa]');
  const caption = root.querySelector('[data-rp-caption]'); const nowText = root.querySelector('[data-rp-now-text]');
  const feed = root.querySelector('[data-feed]'); const feedSub = root.querySelector('[data-feed-sub]');
  const markGroups = [...root.querySelectorAll('.pitch.cast .marks')];
  const tlMarks = [...root.querySelectorAll('.tl-m[data-seek], .tl-shot[data-v]')];
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  let v = tl.total; let timer = null; let drawn = null;
  const show = (nv, { flash = false } = {}) => {
    const rv = replayView(nv, tl, m.score); v = rv.v;
    range.value = String(v); fill.style.width = `${pctOf(v, tl)}%`;
    if (clock) clock.textContent = rv.clock;
    if (sh) sh.textContent = String(rv.score.home);
    if (sa) sa.textContent = String(rv.score.away);
    if (caption) caption.textContent = rv.caption;
    if (nowText) nowText.textContent = nowLine(rv, m);
    if (feedSub) feedSub.textContent = rv.atEnd ? 'Full match · latest first' : `Through ${rv.clock} · latest first`;
    const key = `${rv.seen.length}:${rv.current?.i ?? ''}:${rv.atEnd}`;
    if (key !== drawn) {
      const current = rv.atEnd ? null : rv.current;
      for (const g of markGroups) g.innerHTML = pitchMarks(rv.seen, g.closest('svg').classList.contains('portrait'), { current, pulse: flash && !reduce });
      if (feed) { feed.innerHTML = join([...rv.seen].reverse(), x => feedItem(x, m, { current: x === rv.current, seekable: true })); mountMediaFallbacks(feed); feed.scrollTop = 0; }
      drawn = key;
    }
    for (const el of tlMarks) {
      const at = Number(el.dataset.seek ?? el.dataset.v);
      el.classList.toggle('fut', at > v);
      el.classList.toggle('cur', !!rv.current && el.classList.contains('tl-m') && at === rv.current.v);
    }
    root.dataset.replayV = String(v);
  };
  const stop = () => { if (timer) clearInterval(timer); timer = null; play.setAttribute('aria-pressed', 'false'); play.textContent = v >= tl.total ? '▶ REPLAY FROM KICK-OFF' : '▶ RESUME'; };
  const start = () => {
    if (v >= tl.total) show(0);
    play.setAttribute('aria-pressed', 'true'); play.textContent = '❚❚ PAUSE';
    timer = setInterval(() => { if (!root.isConnected) return stop(); show(v + Number(speed.value) * 0.25, { flash: true }); if (v >= tl.total) stop(); }, 250);
  };
  play.addEventListener('click', () => (timer ? stop() : start()));
  range.addEventListener('input', () => { stop(); show(Number(range.value)); });
  const seekFrom = e => { const b = e.target.closest('[data-seek]'); if (!b || !root.contains(b) || e.target.closest('a')) return; stop(); show(Number(b.dataset.seek), { flash: true }); };
  root.addEventListener('click', seekFrom);
  root.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('li[data-seek]')) { e.preventDefault(); seekFrom(e); } });
  show(tl.total);
  return stop;
}

export const cast = {
  canonical: d => `/matches/${d.env.data.id}`,
  title: d => (d?.env?.data ? `${matchTitle(d.env.data).replace(/\s*\|\s*PropBetEdge.*$/, '')} — PBEcast | PropBetEdge` : 'PBEcast | PropBetEdge'),
  load: loadCast,
  render(d) { return castView(d.env); },
  mount(root, d) {
    mountReplay(root, d.env);
    const mode = d.env.data.live?.mode;
    const soon = mode === 'pregame' && Date.parse(d.env.data.kickoff_at) - Date.now() < 30 * 60e3;
    if (mode === 'live' || soon) softRefresh(root, () => loadCast([d.env.data.id]), cast, mode === 'live' ? POLL_LIVE_MS : 60000);
  },
};
