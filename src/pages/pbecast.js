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
import { callLine, describe, FEED_FILTERS, feedCounts, filterFn, liveCursor, matchPulse, withShotDetail } from '../lib/castfeed.js';
import { competitionMark, empty, link, mountMediaFallbacks, playerChip, sectionHead, sourcePanel, statusPill, teamLink, teamMark } from '../components/ui.js';
import { L, W, pitchLines } from '../components/pitch.js';
import { keyPlayers } from '../components/keyplayers.js';
import { matchTitle } from '../seo/meta.js';
import { boardEntry, boardWithin, byDeadline, castKalshiHtml, KALSHI_FIRST_PAINT_MS, kalshiLineFor, kalshiPollState, loadMatchMarket, marketPollMs } from '../data/kalshi.js';
import { wireKalshi } from '../vendor/kalshi/kalshi-market-ui.js';

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
    ${hubKalshi(m)}
    <span class="hc-cta">${esc(cta)} <span aria-hidden="true">→</span></span>
  </a>`;
}

const hubKalshi = m => { const line = kalshiLineFor(m); return line ? `<span class="hc-kx">${line}</span>` : ''; };

export const hub = {
  title: () => 'PBEcast — Live Soccer Match Tracker & Replays | PropBetEdge',
  async load() { const [env] = await Promise.all([api('live', {}, { fresh: true }), boardWithin()]); return { env }; },
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
// The Kalshi strip is read alongside the cast and waited for at most KALSHI_FIRST_PAINT_MS, so a
// direct visit paints it with the cast (no layout shift); a slower answer lands via mountCastKalshi.
export async function loadCast([id]) {
  const deadline = Date.now() + KALSHI_FIRST_PAINT_MS;
  const kx = castKx.id === id && castKx.entry ? null : loadMatchMarket(id);
  const env = await api(`matches/${id}/cast`, {}, { fresh: true });
  if (kx) {
    const entry = await byDeadline(kx, deadline);
    if (entry && castKx.id !== id) Object.assign(castKx, { id, entry, open: false });
    else if (entry && !castKx.entry) castKx.entry = entry;
  }
  return { env };
}

const ICON = { goal: '●', own_goal: '●', shot: '○', card_yellow: '▮', card_red: '▮', sub: '⇄' };
const WORD = { goal: 'Goal', own_goal: 'Own goal', shot: 'Shot', card_yellow: 'Yellow card', card_red: 'Red card', sub: 'Substitution' };
const OUT = { goal: 'goal', on_target: 'on target', off_target: 'off target', blocked: 'blocked', post: 'woodwork' };
const RECENT_MARKS = 6; // with a current event, the latest few located shots stay full strength; older ones fade
const DERIVED_GEO = 'PBE derived from the source event location on the canonical 105 × 68 m pitch. Event locations, not tracking.';

// One marker per eligible pitch event (pitchItems: shots, goals, own goals with a source location;
// never cards, substitutions or other timeline items). Goals carry a ring; ONLY the current event is
// highlighted, and only it gets the one-shot pulse (`cpulse`, never the page's `.pulse` loading-dot
// class, whose infinite keyframes would light every hidden halo). With a current event, located shots
// older than the latest few are drawn faintly (`old`); nothing is ever animated between locations.
const R = { goal: [1.5, 1.75], og: [1.5, 1.75], on: [1.05, 1.25], off: [0.8, 0.95], blocked: [0.8, 0.95], post: [0.8, 0.95] };
function markFor(x, portrait, { current = false, pulse = false, old = false } = {}) {
  const kind = pitchKind(x);
  if (!kind || x.x < 0 || x.x > L || x.y < 0 || x.y > W) return '';
  const p = portrait ? { x: x.y, y: L - x.x } : { x: x.x, y: x.y };
  const r = R[kind][portrait ? 1 : 0];
  const ring = kind === 'goal' || kind === 'og' ? `<circle class="ring${kind === 'og' ? ' og' : ''}" cx="${p.x}" cy="${p.y}" r="${r + (portrait ? 1 : 0.85)}"/>` : '';
  return `<g class="cmark k-${kind}${current ? ' cur' : ''}${old ? ' old' : ''}" data-ci="${x.i}" data-v="${x.v ?? ''}"${x.v !== null && x.v !== undefined ? ` data-seek="${x.v}"` : ''}>${ring}<circle class="shot ${x.team === 'away' ? 'away' : 'home'} ${kind}" cx="${p.x}" cy="${p.y}" r="${r}"/>${current && pulse ? `<circle class="cpulse" cx="${p.x}" cy="${p.y}" r="${r + 1.6}"/>` : ''}</g>`;
}

// Pitch marks for the events the view may show: the full match live / at full time, only
// replayView().seen during a replay (a future shot is never in the markup). `current` is the
// event in focus (the replay cursor's event, or the live feed's latest / selected one).
export function pitchMarks(items, portrait, { current = null, pulse = false } = {}) {
  const marks = pitchItems(items);
  const recent = new Set(marks.slice(-RECENT_MARKS));
  return join(marks, x => markFor(x, portrait, { current: !!current && x.i === current.i, pulse, old: !!current && x.i !== current.i && !recent.has(x) }));
}
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

// Geometry + provider xG for one event, each part only when it exists.
function geoXg(d) {
  const parts = [];
  if (d.geoText) parts.push(`${esc(d.geoText)} <abbr class="pbe-d" title="${esc(DERIVED_GEO)}">PBE derived</abbr>`);
  if (d.xg) parts.push(`<span class="xg" title="Expected goals as published by the provider. Not a PropBetEdge metric.">${esc(d.xg.label)} ${esc(d.xg.value.toFixed(2))}</span>`);
  return parts.join(' · ');
}

// A feed row: broadcast-style card built only from the event's own sourced fields plus PBE derived
// context from the events seen up to it (`seen` never holds a later event).
export function feedItem(x, m, { current = false, seekable = false, pickable = false, seen = null } = {}) {
  const upto = seen ? seen.slice(0, seen.indexOf(x) + 1) : [x];
  const d = describe(x, m, upto.length ? upto : [x]);
  const team = x.team === 'away' ? m.away : m.home;
  const teamName = team?.short_name || team?.name || '';
  let who;
  if (x.type === 'sub') who = `<span class="fi-sub"><b class="on">ON</b>${playerChip(x.player_in)}</span><span class="fi-sub"><b class="off">OFF</b>${playerChip(x.player_out)}</span>`;
  else if (x.type === 'own_goal') who = `${playerChip(x.player)}<span class="muted">own goal</span>`;
  else who = `${playerChip(x.player, { extra: x.penalty ? ' <span class="muted">(pen)</span>' : '' })}${x.type === 'card_yellow' || x.type === 'card_red' ? `<span class="muted">${esc(teamName)}</span>` : ''}`;
  const seek = seekable && x.v !== null && x.v !== undefined ? ` data-seek="${x.v}" tabindex="0"` : pickable ? ` data-pick="${x.i}" tabindex="0"` : '';
  const facts = d.facts.length ? `<span class="fi-facts">${esc(d.facts.join(' · '))}</span>` : '';
  const assist = x.assist ? `<span class="fi-assist"><span class="muted">Assist</span> ${playerChip(x.assist)}</span>` : '';
  const geo = geoXg(d);
  const ctx = (x.type === 'goal' || x.type === 'own_goal' ? d.derived : d.derived.filter(t => /straight/.test(t)));
  return `<li class="fi t-${esc(x.type)} ${x.team === 'away' ? 'away' : 'home'}${current ? ' cur' : ''}" data-fi="${x.i}" data-v="${x.v ?? ''}"${seek}${current ? ' aria-current="true"' : ''}>
    <span class="fi-min">${esc(x.display_minute || '—')}</span>
    <span class="fi-ic" aria-hidden="true">${ICON[x.type] || '•'}</span>
    <span class="fi-body"><span class="fi-kind">${esc(d.headline)}</span><span class="fi-who">${who}</span>${facts}${assist}${geo ? `<span class="fi-geo">${geo}</span>` : ''}${ctx.length ? `<span class="fi-ctx"><b>PBE</b> ${esc(ctx.join(' · '))}</span>` : ''}</span>
    ${x.type === 'goal' || x.type === 'own_goal' ? `<span class="fi-score">${esc(String(x.score.home))}–${esc(String(x.score.away))}</span>` : ''}
  </li>`;
}

// The feed list for a view: the user's filter and order over the events the view may show.
export const feedPrefs = { filter: 'all', order: 'desc' };
export function feedList(items, m, { current = null, seekable = false, pickable = false, prefs = feedPrefs } = {}) {
  const keep = filterFn(prefs.filter);
  const rows = items.filter(keep);
  if (!rows.length) {
    const label = (FEED_FILTERS.find(f => f[0] === prefs.filter) || FEED_FILTERS[0])[1].toLowerCase();
    return `<li class="fi-empty">${items.length ? `No ${esc(label)} recorded${seekable ? ' up to this point' : ''}.` : 'No sourced events yet.'}</li>`;
  }
  const ordered = prefs.order === 'asc' ? rows : [...rows].reverse();
  return join(ordered, x => feedItem(x, m, { current: !!current && x === current, seekable, pickable, seen: items }));
}

export function feedTools(items, prefs = feedPrefs, { replay = false } = {}) {
  const counts = feedCounts(items);
  return `<div class="feed-tools" data-feed-tools>
    <div class="ff" role="group" aria-label="Filter the feed">${join(FEED_FILTERS, ([k, label]) => `<button type="button" class="ff-b${prefs.filter === k ? ' on' : ''}" data-ff="${k}" aria-pressed="${prefs.filter === k}">${esc(label)} <span class="ff-n" data-ff-n="${k}">${counts[k]}</span></button>`)}</div>
    <label class="fo">Order <select data-fo><option value="desc"${prefs.order === 'desc' ? ' selected' : ''}>Latest first</option><option value="asc"${prefs.order === 'asc' ? ' selected' : ''}>${replay ? 'Match order (kick-off first)' : 'Kick-off first'}</option></select></label>
  </div>`;
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

// CURRENT MOMENT: clock, score and the event in focus with its sourced detail. Built from one state
// ({ seen, current, score, clock }) so replay can never show more than the cursor has reached.
export function momentPanel(st, m, { mode = 'replay', freshness = null, selected = false } = {}) {
  const hn = m.home?.short_name || m.home?.name || 'Home'; const an = m.away?.short_name || m.away?.name || 'Away';
  const x = st.current;
  const state = mode === 'live' ? (selected ? `SELECTED · ${x?.display_minute || ''}` : `LIVE${st.clock ? ` · ${st.clock}` : ''}`)
    : st.atEnd ? 'FULL TIME' : `REPLAY · ${st.clock}`;
  const scoreLine = `${hn} ${st.score.home}–${st.score.away} ${an}`;
  let body;
  if (!x || (st.atEnd && mode !== 'live')) {
    const goals = st.seen.filter(y => y.type === 'goal' || y.type === 'own_goal').length;
    body = `<p class="mo-head">${st.atEnd ? 'FULL TIME' : x === null && !st.seen.length ? 'KICK-OFF' : 'NO EVENT YET'}</p><p class="mo-call">${esc(st.atEnd ? `${st.seen.length} recorded events · ${goals} ${goals === 1 ? 'goal' : 'goals'}. Scrub or replay to step through them.` : 'Nothing recorded yet.')}</p>`;
  } else {
    const d = describe(x, m, st.seen.slice(0, st.seen.indexOf(x) + 1));
    const who = x.type === 'sub' ? `<span class="fi-sub"><b class="on">ON</b>${playerChip(x.player_in, { size: 'sm' })}</span><span class="fi-sub"><b class="off">OFF</b>${playerChip(x.player_out, { size: 'sm' })}</span>`
      : playerChip(x.player, { size: 'md', extra: x.penalty ? ' <span class="muted">(pen)</span>' : '' });
    const facts = [...d.facts];
    const geo = geoXg(d);
    body = `<p class="mo-head">${esc(d.headline)}</p>
      <div class="mo-who">${who}<span class="mo-team">${esc(d.team)}</span></div>
      ${facts.length ? `<p class="mo-facts">${esc(facts.join(' · '))}</p>` : ''}
      ${x.assist ? `<p class="mo-facts">Assist: ${esc(x.assist.name || '')}</p>` : ''}
      ${geo ? `<p class="mo-geo">${geo}</p>` : ''}
      <p class="mo-call"><span class="mo-call-k" title="A deterministic sentence built from the recorded events. Not a quote.">PBE CALL</span> ${esc(callLine(x, m, st.seen.slice(0, st.seen.indexOf(x) + 1)))}</p>`;
  }
  return `<div class="moment tone-${esc(x && !(st.atEnd && mode !== 'live') ? describe(x, m, [x]).tone : 'neutral')}" data-moment>
    <div class="mo-top"><span class="mo-state">${esc(state)}</span><span class="mo-score">${esc(scoreLine)}</span>${selected ? '<button type="button" class="mo-back" data-mo-latest>Back to latest</button>' : ''}</div>
    ${body}
    ${freshness ? `<p class="mo-fresh">${esc(freshness)}</p>` : ''}
  </div>`;
}

// MATCH PULSE: rolling + cumulative counts, PBE derived from the recorded events at the cursor.
export function pulsePanel(p, m) {
  const hn = m.home?.short_name || m.home?.name || 'Home'; const an = m.away?.short_name || m.away?.name || 'Away';
  if (!p.hasShotRecord) return `<div class="mpulse" data-pulse><p class="mp-k">MATCH PULSE</p><p class="muted small">This match's event source records goals and cards but no shots, so there is no shot pulse. Nothing is estimated in its place.</p></div>`;
  const row = (name, s) => `<div class="mp-row"><span class="mp-team">${esc(name)}</span><span class="mp-v"><b>${s.window.shots}</b> ${s.window.shots === 1 ? 'shot' : 'shots'} · <b>${s.window.on_target}</b> on target</span></div>`;
  const tot = (label, h, a) => `<div class="mp-tot"><span>${esc(String(h))}</span><span class="mp-l">${esc(label)}</span><span>${esc(String(a))}</span></div>`;
  const xgRow = p.home.xg && p.away.xg ? tot(`${p.home.xg.label} (provider)`, p.home.xg.total.toFixed(2), p.away.xg.total.toFixed(2)) : '';
  const xgNote = !xgRow && (p.home.xg_partial || p.away.xg_partial) ? '<p class="mp-note">The provider published xG for only some shots, so no xG total is shown.</p>' : '';
  const dist = p.home.avg_distance_m !== null || p.away.avg_distance_m !== null ? tot('Avg located shot distance (m)', p.home.avg_distance_m ?? '—', p.away.avg_distance_m ?? '—') : '';
  return `<div class="mpulse" data-pulse>
    <p class="mp-k">MATCH PULSE <span class="mp-win">Last ${p.window} min · ${esc(p.label)}</span></p>
    ${row(hn, p.home)}${row(an, p.away)}
    <div class="mp-tots">${tot('Shots', p.home.match.shots, p.away.match.shots)}${tot('On target', p.home.match.on_target, p.away.match.on_target)}${dist}${xgRow}</div>
    ${xgNote}
    <p class="mp-note">PBE derived from recorded ${esc(sourceName(m.event_source))} events up to this point. Recorded events may not be exhaustive; this is not possession or a probability.</p>
  </div>`;
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

// The view state for a mode: replay opens at full time (everything sourced is known); live is the
// whole recorded sequence with the latest event in focus and the provider's clock as the cursor.
export function castState(env) {
  const m = env.data; const live = m.live || { mode: 'replay' };
  const tl = buildTimeline(withShotDetail(m.sequence || [], m.shot_timeline || []));
  const mode = live.mode === 'live' ? 'live' : live.mode === 'replay' ? 'replay' : live.mode === 'pregame' ? 'pregame' : 'other';
  if (mode === 'live') {
    const lv = liveView(m);
    const v = liveCursor(tl, lv.clock || live.display_clock);
    const last = [...tl.items].reverse().find(y => y.score);
    const score = lv.score && lv.score.home !== null && lv.score.home !== undefined ? lv.score : last ? last.score : { home: 0, away: 0 };
    return { m, tl, mode, live, lv, st: { v, seen: tl.items, current: tl.items[tl.items.length - 1] || null, score, clock: lv.clock || live.detail || '', atEnd: false } };
  }
  const rv = replayView(tl.total, tl, m.score);
  return { m, tl, mode, live, lv: { score: m.score, clock: null }, st: rv };
}

export function castView(env) {
  const { m, tl, mode, live, lv, st } = castState(env);
  const status = liveStatus(live);
  const sc = lv.score && lv.score.home !== null && lv.score.home !== undefined ? lv.score : null;
  const located = pitchItems(tl.items).length;
  const moments = keyMoments(tl);
  const clock = mode === 'live' ? (lv.clock || (lv.from === 'canonical' ? live.detail || '' : '')) : mode === 'replay' ? 'FT' : '';
  const replay = mode === 'replay';
  const fresh = mode === 'live' ? status?.note || null : replay ? 'Replay: everything shown is from events at or before the cursor.' : null;
  const focus = mode === 'live' ? st.current : null;
  const pitchFocus = focus && pitchKind(focus) ? focus : null;
  // No empty shot map: a competition whose source has no pitch locations (competitions.js spatial:false) never shows
  // one; a finished / non-live match with zero located events shows the neutral note instead. A live match of a
  // spatial competition keeps the map (its first located shot can arrive at any minute).
  const spatialOff = compMeta(m.competition?.slug)?.spatial === false;
  const showMap = !spatialOff && (located > 0 || mode === 'live');
  return `<section class="cast-top ${esc(mode)}"><div class="wrap">
      <p class="ct-meta">${link('/pbecast', 'PBECAST', 'ct-home')} · ${m.competition ? link(`/competitions/${m.competition.slug}`, `${competitionMark(m.competition.slug, 'xs', { tone: 'dark' })}<span>${esc(m.competition.name)}</span>`, 'ct-comp') : ''}${m.round ? ` · ${esc(m.round)}` : ''}</p>
      <h1 class="sr-only">${esc(m.home?.name || '')} v ${esc(m.away?.name || '')}: PBEcast</h1>
      <div class="ct-board">
        <div class="ct-team">${teamMark(m.home, 'md')}${teamLink(m.home, 'ct-name')}</div>
        <div class="ct-score" data-ct-score>${sc || replay ? `<span data-sh>${esc(String(sc?.home ?? 0))}</span><i>–</i><span data-sa>${esc(String(sc?.away ?? 0))}</span>` : '<span class="vs">v</span>'}</div>
        <div class="ct-team away">${teamMark(m.away, 'md')}${teamLink(m.away, 'ct-name')}</div>
      </div>
      <p class="ct-status">${mode === 'live' ? `<span class="ct-live ${esc(status.tone)}"><i class="livedot" aria-hidden="true"></i>${esc(status.label)}</span>${clock ? `<span class="ct-clock">${esc(clock)}</span>` : ''}` : replay ? `<span class="ct-tag">PBECAST REPLAY</span><span class="ct-clock" data-ct-clock>${esc(clock)}</span>` : statusPill(m.status)}
        <span class="muted">${esc(dateTime(m.kickoff_at))}${m.venue ? ` · ${esc(m.venue.name)}` : ''}</span></p>
      ${when(status, () => `<p class="ct-fresh" role="status">${esc(status.note)}</p>`)}
      ${castKalshiSlot(m)}
    </div></section>
    <section class="canvas cast-body" data-match-id="${esc(m.id)}"><div class="wrap">
      ${mode === 'pregame' ? `<div class="panel pregame">${sectionHead('PREGAME', `Kick-off ${dateTime(m.kickoff_at)}`)}<p>PBEcast goes live at kick-off: the score and the provider's clock, then every sourced shot, goal, card and substitution as the source records it. This page refreshes itself.</p></div>` : ''}
      ${when(tl.items.length, () => `<div class="cast-grid">
        <div class="cast-stage panel">
          ${replay ? `<div class="rp" data-replay>
            <button type="button" class="btn gold rp-play" data-rp-play aria-pressed="false">▶ REPLAY FROM KICK-OFF</button>
            <div class="rp-step"><button type="button" class="btn ghost dark" data-rp-prev aria-label="Previous event">◀ PREV</button><button type="button" class="btn ghost dark" data-rp-next aria-label="Next event">NEXT ▶</button></div>
            <label class="rp-speed">Speed <select data-rp-speed><option value="0.5">1 min / 2 s</option><option value="1" selected>1 min / s</option><option value="3">3 min / s</option></select></label>
            <input type="range" class="rp-range" data-rp-range min="0" max="${tl.total}" step="0.25" value="${tl.total}" aria-label="Replay position (match minute)">
            <p class="sr-only" data-rp-now aria-live="polite"><span data-rp-now-text>${esc(nowLine(st, m))}</span></p>
            ${when(moments.length, () => `<div class="rp-moments" aria-label="Jump to a key moment"><span class="rp-jump">JUMP TO</span>${join(moments, x => `<button type="button" class="chip" data-seek="${x.v}">${esc(x.display_minute || '')} ${esc(x.type === 'card_red' ? 'Red' : 'Goal')} ${esc(x.player?.name?.split(' ').slice(-1)[0] || '')}</button>`)}</div>`)}
          </div>` : ''}
          <div data-moment-slot>${momentPanel(st, m, { mode, freshness: fresh })}</div>
          ${timelineBar(tl, m)}
          ${showMap ? `<div class="pitchwrap land">${castPitch(tl, m, { current: pitchFocus })}</div>
          <div class="pitchwrap port">${castPitch(tl, m, { portrait: true, current: pitchFocus })}</div>
          <p class="emap-label" data-rp-caption>${replay ? esc(st.caption) : located ? `${num(located)} LOCATED SHOTS · EVENT LOCATIONS, NOT PLAYER TRACKING` : 'NO LOCATED EVENTS FROM THIS SOURCE · NOTHING IS PLOTTED'}</p>
          <p class="legend"><span><i class="lg goal"></i>Goal</span><span><i class="lg on"></i>On target</span><span><i class="lg off"></i>Off target / blocked</span><span class="muted">Shots only · tap a feed event to find it · cards and substitutions are in the feed</span></p>` : `<div class="cast-nomap" role="note"><p class="kicker">SHOT MAP NOT AVAILABLE</p><p>The source records ${spatialOff ? 'this competition\'s' : 'this match\'s'} events without pitch locations, so no shot map is drawn. Every shot, goal, card and substitution is in the match feed.</p></div>`}
          <div data-pulse-slot>${pulsePanel(matchPulse(st.seen, st.v ?? tl.total, tl), m)}</div>
        </div>
        <div class="cast-feed panel">${replay ? '<header class="sec-head"><p class="kicker">REPLAY FEED</p><h2 data-feed-sub>Full match</h2></header>' : sectionHead(mode === 'live' ? 'LIVE MATCH FEED' : 'MATCH FEED', 'Every sourced shot, goal, card and substitution')}
          ${feedTools(st.seen, feedPrefs, { replay })}
          <ol class="feed" data-feed${mode === 'live' ? ' aria-live="polite"' : ''}>${feedList(st.seen, m, { current: replay ? null : focus, seekable: replay, pickable: !replay })}</ol>
        </div>
      </div>`)}
      ${when(!tl.items.length && mode !== 'pregame', () => empty('No sourced events for this match', m.event_source === 'openligadb' ? 'The result source reports the score without an event record, so there is nothing to cast. Nothing is plotted rather than something invented.' : 'No event record is stored for this match yet.'))}
      ${when(m.players?.rows?.length, () => `<div class="panel kp-panel">${sectionHead('PLAYER IMPACT', 'Who shaped the match · tap a player for Player DNA')}${keyPlayers(m, { title: false })}</div>`)}
      <div class="two">
        <div class="panel">${sectionHead('MATCH STATS', 'By source basis')}${statsCompare(m)}</div>
        <div class="panel">${sectionHead('LINEUPS', 'Starting XI')}${lineupsCompact(m)}</div>
      </div>
      <p class="cast-links">${link(`/matches/${m.id}`, 'FULL MATCH INTELLIGENCE →', 'btn ghost dark')}</p>
      ${sourcePanel(env.meta, { title: 'PBECAST SOURCE & FRESHNESS', extra: [['Mode', mode.toUpperCase()], ['Source clock', live.display_clock || (mode === 'live' ? 'Not supplied' : 'Not live')], ['Last source observation', live.provider_observed_at ? `${dateTime(live.provider_observed_at)} (${ago(live.provider_observed_at)})` : 'None'], ['Event record', m.event_source ? sourceName(m.event_source) : 'None'], ...(live.enrichment ? [['Result of record', sourceName(live.canonical_result_source)], ['Live score', `${sourceName(live.enrichment.source)}, fetched ${live.enrichment.fetched_at ? `${dateTime(live.enrichment.fetched_at)} (${ago(live.enrichment.fetched_at)})` : 'never'}${live.enrichment.freshness?.stale ? ' · delayed' : ''}`]] : []), ['Derived context', 'Shot distance, rolling windows, runs and totals are PBE derived from recorded events at or before the moment shown. Provider xG is labelled with its provider.']] })}
    </div></section>`;
}

// Feed controls (filter + order) shared by every mode. `redraw` re-renders the list from the view's
// current state, so a filter change never reveals an event the view has not reached.
function mountFeedTools(root, redraw) {
  const tools = root.querySelector('[data-feed-tools]'); if (!tools) return;
  tools.addEventListener('click', e => {
    const b = e.target.closest('[data-ff]'); if (!b) return;
    feedPrefs.filter = b.dataset.ff;
    for (const x of tools.querySelectorAll('[data-ff]')) { const on = x.dataset.ff === feedPrefs.filter; x.classList.toggle('on', on); x.setAttribute('aria-pressed', String(on)); }
    redraw();
  });
  tools.querySelector('[data-fo]')?.addEventListener('change', e => { feedPrefs.order = e.target.value === 'asc' ? 'asc' : 'desc'; redraw(); });
}
const setCounts = (root, items) => { const c = feedCounts(items); for (const el of root.querySelectorAll('[data-ff-n]')) el.textContent = String(c[el.dataset.ffN] ?? 0); };
function scrollFeedToCurrent(feed) {
  if (!feed) return;
  const cur = feed.querySelector('.fi.cur');
  if (!cur) { feed.scrollTop = feedPrefs.order === 'asc' ? feed.scrollHeight : 0; return; }
  feed.scrollTop = Math.max(0, cur.offsetTop - feed.offsetTop - feed.clientHeight / 3);
}

// Replay engine: moves a cursor over the virtual minute axis. Every frame is ONE replayView() (built on
// stateAt): score, clock, Current Moment, pitch marks (future marks are removed from the markup), feed
// (events through the cursor), Match Pulse (events through the cursor), timeline markers (future ones
// dimmed) and caption. Prev / Next step between sourced events.
export function mountReplay(root, env) {
  const box = root.querySelector('[data-replay]'); if (!box) return () => {};
  const m = env.data; const tl = buildTimeline(withShotDetail(m.sequence || [], m.shot_timeline || []));
  const range = box.querySelector('[data-rp-range]'); const play = box.querySelector('[data-rp-play]'); const speed = box.querySelector('[data-rp-speed]');
  const fill = root.querySelector('[data-tl-fill]'); const clock = root.querySelector('[data-ct-clock]');
  const sh = root.querySelector('[data-sh]'); const sa = root.querySelector('[data-sa]'); const board = root.querySelector('[data-ct-score]');
  const caption = root.querySelector('[data-rp-caption]'); const nowText = root.querySelector('[data-rp-now-text]');
  const feed = root.querySelector('[data-feed]'); const feedSub = root.querySelector('[data-feed-sub]');
  const momentSlot = root.querySelector('[data-moment-slot]'); const pulseSlot = root.querySelector('[data-pulse-slot]');
  const markGroups = [...root.querySelectorAll('.pitch.cast .marks')];
  const tlMarks = [...root.querySelectorAll('.tl-m[data-seek], .tl-shot[data-v]')];
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const stops = [...new Set(tl.items.filter(x => x.v !== null).map(x => x.v))].sort((a, b) => a - b);
  let v = tl.total; let timer = null; let drawn = null; let lastGoals = null; let rvNow = null;
  const drawFeed = () => {
    if (!feed || !rvNow) return;
    feed.innerHTML = feedList(rvNow.seen, m, { current: rvNow.atEnd ? null : rvNow.current, seekable: true });
    mountMediaFallbacks(feed); scrollFeedToCurrent(feed); setCounts(root, rvNow.seen);
  };
  const show = (nv, { flash = false } = {}) => {
    const rv = replayView(nv, tl, m.score); v = rv.v; rvNow = rv;
    range.value = String(v); fill.style.width = `${pctOf(v, tl)}%`;
    if (clock) clock.textContent = rv.clock;
    if (sh) sh.textContent = String(rv.score.home);
    if (sa) sa.textContent = String(rv.score.away);
    if (caption) caption.textContent = rv.caption;
    if (nowText) nowText.textContent = nowLine(rv, m);
    if (feedSub) feedSub.textContent = rv.atEnd ? 'Full match' : `Through ${rv.clock}`;
    const key = `${rv.seen.length}:${rv.current?.i ?? ''}:${rv.atEnd}`;
    if (key !== drawn) {
      const current = rv.atEnd ? null : rv.current;
      for (const g of markGroups) g.innerHTML = pitchMarks(rv.seen, g.closest('svg').classList.contains('portrait'), { current, pulse: flash && !reduce });
      if (momentSlot) { momentSlot.innerHTML = momentPanel(rv, m, { mode: 'replay', freshness: 'Replay: everything shown is from events at or before the cursor.' }); mountMediaFallbacks(momentSlot); }
      if (pulseSlot) pulseSlot.innerHTML = pulsePanel(matchPulse(rv.seen, v, tl), m);
      drawFeed();
      const goals = rv.seen.filter(x => x.type === 'goal' || x.type === 'own_goal').length;
      if (flash && !reduce && lastGoals !== null && goals > lastGoals && board) { board.classList.remove('flash'); void board.offsetWidth; board.classList.add('flash'); }
      lastGoals = goals;
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
  const step = dir => {
    stop();
    const target = dir > 0 ? stops.find(s => s > v) : [...stops].reverse().find(s => s < (v >= tl.total ? tl.total + 1 : v));
    show(target ?? (dir > 0 ? tl.total : 0), { flash: true });
  };
  play.addEventListener('click', () => (timer ? stop() : start()));
  box.querySelector('[data-rp-prev]')?.addEventListener('click', () => step(-1));
  box.querySelector('[data-rp-next]')?.addEventListener('click', () => step(1));
  range.addEventListener('input', () => { stop(); show(Number(range.value)); });
  const seekFrom = e => { const b = e.target.closest('[data-seek]'); if (!b || !root.contains(b) || e.target.closest('a')) return; stop(); show(Number(b.dataset.seek), { flash: true }); };
  root.addEventListener('click', seekFrom);
  root.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('li[data-seek]')) { e.preventDefault(); seekFrom(e); } });
  mountFeedTools(root, drawFeed);
  show(tl.total);
  return stop;
}

// Live (and other non-replay) views: the feed and pitch stay on the whole recorded sequence; tapping a
// feed event or a pitch mark puts THAT event in focus (Current Moment + its pitch location) until
// "Back to latest". A goal or a new latest event since the previous refresh flashes / pulses once.
const lastLive = { id: null, goals: null, latest: null };
export function mountLive(root, env) {
  const { m, tl, mode, st } = castState(env);
  if (mode !== 'live' || !tl.items.length) return;
  const feed = root.querySelector('[data-feed]'); const momentSlot = root.querySelector('[data-moment-slot]');
  const markGroups = [...root.querySelectorAll('.pitch.cast .marks')];
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const fresh = mode === 'live' ? liveStatus(m.live)?.note || null : null;
  let selected = null;
  const focus = (x, { pulse = false } = {}) => {
    const cur = x || st.current;
    const pitchCur = cur && pitchKind(cur) ? cur : null;
    for (const g of markGroups) g.innerHTML = pitchMarks(tl.items, g.closest('svg').classList.contains('portrait'), { current: pitchCur, pulse: pulse && !reduce });
    if (momentSlot) { momentSlot.innerHTML = momentPanel({ ...st, current: cur }, m, { mode: 'live', freshness: fresh, selected: !!x }); mountMediaFallbacks(momentSlot); }
    if (feed) { feed.innerHTML = feedList(tl.items, m, { current: cur, pickable: true }); mountMediaFallbacks(feed); }
  };
  const pick = e => {
    if (e.target.closest('a') || e.target.closest('[data-feed-tools]')) return;
    if (e.target.closest('[data-mo-latest]')) { selected = null; focus(null); return; }
    const li = e.target.closest('[data-pick]'); const mark = e.target.closest('.cmark[data-ci]');
    const i = li ? Number(li.dataset.pick) : mark ? Number(mark.dataset.ci) : null;
    if (i === null || !root.contains(e.target)) return;
    selected = tl.items.find(x => x.i === i) || null; focus(selected, { pulse: true });
  };
  root.addEventListener('click', pick);
  root.addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('li[data-pick]')) { e.preventDefault(); pick(e); } });
  mountFeedTools(root, () => { if (feed) { feed.innerHTML = feedList(tl.items, m, { current: selected || st.current, pickable: true }); mountMediaFallbacks(feed); } });
  // A refresh that brought a new latest event pulses its location once; a new goal flashes the score.
  const goals = tl.items.filter(x => x.type === 'goal' || x.type === 'own_goal').length;
  const latest = st.current ? `${st.current.i}:${st.current.type}:${st.current.minute}` : null;
  if (lastLive.id === m.id) {
    if (latest !== lastLive.latest) focus(null, { pulse: true });
    if (goals > (lastLive.goals ?? goals) && !reduce) root.querySelector('[data-ct-score]')?.classList.add('flash');
  }
  Object.assign(lastLive, { id: m.id, goals, latest });
}

// ---------------------------------------------------------------- Kalshi strip
// Never blocks the cast: the first paint uses what is already known for this match (the last event read,
// else the board entry the hub/match lists loaded); the event read + polling run beside the cast. The strip's
// open/closed state survives every live re-render. Polls: live 20 s, pregame 45 s. A replay shows "How the
// market closed" (history card) once the market has CLOSED / SETTLED and follows it: CLOSED 5 min until SETTLED, then none.
const castKx = { id: null, entry: null, open: false, timer: null };
export function stopCastKalshi() { clearTimeout(castKx.timer); castKx.timer = null; }
function castKalshiSlot(m) {
  if (castKx.id !== m.id) Object.assign(castKx, { id: m.id, entry: boardEntry(m.id), open: false });
  const html = castKalshiHtml(castKx.entry, { open: castKx.open });
  return `<div class="ct-kx" data-kx-cast${html ? '' : ' hidden'}>${html}</div>`;
}
function paintCastKalshi(slot) {
  const html = castKalshiHtml(castKx.entry, { open: castKx.open });
  slot.innerHTML = html; slot.hidden = !html;
  if (html) wireKalshi(slot);
}
export function mountCastKalshi(root, env) {
  stopCastKalshi();
  const m = env.data;
  const slot = root.querySelector('[data-kx-cast]');
  if (!slot) return;
  if (!slot.hidden) wireKalshi(slot);
  slot.addEventListener('toggle', e => { if (e.target.matches?.('details.kx-strip')) castKx.open = e.target.open; }, true);
  const mode = m.live?.mode;
  const lane = mode === 'live' ? 'live' : mode === 'pregame' ? 'pregame' : kalshiPollState(m.status) === 'pregame' ? 'pregame' : null;
  const refresh = async (force) => {
    const entry = await loadMatchMarket(m.id, { force });
    if (!slot.isConnected || castKx.id !== m.id) return;
    castKx.entry = entry; paintCastKalshi(slot);
    const ms = marketPollMs(lane === 'live' ? 'live' : lane === 'pregame' ? 'scheduled' : m.status, entry);
    clearTimeout(castKx.timer);
    if (ms) castKx.timer = setTimeout(() => { if (!slot.isConnected) return; if (document.hidden) return refresh(false); refresh(true); }, ms);
  };
  refresh(false);
}

export const cast = {
  canonical: d => `/matches/${d.env.data.id}`,
  title: d => (d?.env?.data ? `${matchTitle(d.env.data).replace(/\s*\|\s*PropBetEdge.*$/, '')} — PBEcast | PropBetEdge` : 'PBEcast | PropBetEdge'),
  load: loadCast,
  render(d) { return castView(d.env); },
  mount(root, d) {
    mountReplay(root, d.env);
    mountLive(root, d.env);
    mountCastKalshi(root, d.env);
    const mode = d.env.data.live?.mode;
    const soon = mode === 'pregame' && Date.parse(d.env.data.kickoff_at) - Date.now() < 30 * 60e3;
    if (mode === 'live' || soon) softRefresh(root, () => loadCast([d.env.data.id]), cast, mode === 'live' ? POLL_LIVE_MS : 60000);
  },
};
