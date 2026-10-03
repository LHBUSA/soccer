// MATCH INTELLIGENCE — the signature page.
// Mobile order: score · story · event map · stats · lineups · substitutions · source truth.
import { api } from '../lib/api.js';
import { esc, join, when } from '../lib/html.js';
import { DASH, STAT_LABELS, ago, dateTime, num, sourceName, statsHeading } from '../lib/format.js';
import { competitionMark, link, playerChip, sectionHead, sourcePanel, statusPill, teamLink, teamMark } from '../components/ui.js';
import { pitchSvg, validShots } from '../components/pitch.js';
import { mountRelatedNews } from '../components/related.js';
import { keyPlayers } from '../components/keyplayers.js';
import { matchTitle } from '../seo/meta.js';
import { analyzerPreviewHtml } from '../components/analyzer.js';
import { compMeta } from '../lib/competitions.js';
import { boardEntry, byDeadline, KALSHI_FIRST_PAINT_MS, loadMatchMarket, marketPollMs, matchKalshiHtml } from '../data/kalshi.js';
import { wireKalshi } from '../vendor/kalshi/kalshi-market-ui.js';

export const title = d => (d?.env?.data ? matchTitle(d.env.data) : 'Match Intelligence | PropBetEdge');

// The Kalshi market read starts WITH the match read and may hold the first paint for at most
// KALSHI_FIRST_PAINT_MS from the start of the load (never longer); a late answer fills the slot in mount().
export async function load([id]) {
  const deadline = Date.now() + KALSHI_FIRST_PAINT_MS;
  const kx = loadMatchMarket(id);
  const env = await api(`matches/${id}`);
  const entry = await byDeadline(kx, deadline);
  return { env, kx: entry === undefined ? boardEntry(id) : entry, kxPending: entry === undefined ? kx : null };
}

const personLink = p => (p?.slug ? link(`/players/${p.slug}`, esc(p.name)) : esc(p?.name || 'Unidentified player'));

export function story(m) {
  const items = [
    ...(m.timeline || []).map(t => ({ minute: t.minute, display: t.display_minute, team: t.team, kind: t.type, player: t.player, penalty: t.penalty })),
    ...(m.substitutions || []).map(s => ({ minute: s.minute, display: s.minute !== null && s.minute !== undefined ? `${s.minute}'` : null, team: s.team, kind: 'sub', inP: s.in, outP: s.out })),
  ].sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
  if (!items.length) return '<p class="muted">No goals, cards or substitutions are recorded for this match in the canonical graph.</p>';
  const icon = k => (k === 'goal' ? '<span class="ev goal" role="img" aria-label="Goal">●</span>' : k === 'own_goal' ? '<span class="ev og" role="img" aria-label="Own goal">●</span>'
    : k.startsWith('card_') ? `<span class="ev card ${k === 'card_yellow' ? 'y' : 'r'}" role="img" aria-label="${k === 'card_yellow' ? 'Yellow card' : 'Red card'}"></span>` : '<span class="ev sub" role="img" aria-label="Substitution">⇄</span>');
  const text = it => (it.kind === 'sub' ? `${playerChip(it.inP)} <span class="muted">for</span> ${personLink(it.outP)}`
    : playerChip(it.player, { extra: `${it.kind === 'own_goal' ? ' <span class="muted">(own goal)</span>' : ''}${it.penalty ? ' <span class="muted">(pen)</span>' : ''}` }));
  const teamName = side => (side === 'away' ? m.away : m.home)?.short_name || (side === 'away' ? m.away : m.home)?.name || '';
  return `<ol class="story">${join(items, it => `<li class="${it.team === 'away' ? 'away' : 'home'} k-${esc(it.kind)}${it.kind === 'goal' || it.kind === 'own_goal' ? ' goalrow' : ''}">
    <span class="min">${esc(it.display || (it.minute !== null && it.minute !== undefined ? `${it.minute}'` : DASH))}</span>${icon(it.kind)}<span class="who">${text(it)} <span class="side">${esc(it.kind === 'own_goal' ? '' : teamName(it.team))}</span></span></li>`)}</ol>`;
}

export function statsBlock(m) {
  const h = statsHeading(m.stats);
  if (!h) return '<p class="muted">No match statistics are available for this match. Absent statistics are not zeros.</p>';
  const rows = STAT_LABELS[m.stats.basis].filter(([k]) => m.stats.home[k] !== undefined || m.stats.away[k] !== undefined);
  if (!rows.length) return '<p class="muted">No recognised statistics for this match.</p>';
  return `<div class="stats">
    <p class="stats-basis ${m.stats.basis}"><b>${esc(h.title)}</b> ${esc(h.note)}</p>
    ${join(rows, ([k, label, suffix = '', dp = 0]) => {
      const hv = m.stats.home[k]; const av = m.stats.away[k];
      const hn = Number(hv) || 0; const an = Number(av) || 0; const tot = hn + an;
      const known = hv !== undefined && av !== undefined && tot > 0;
      return `<div class="srow"><span class="sv">${num(hv, { dp, suffix })}</span>
        <span class="sl">${esc(label)}</span><span class="sv r">${num(av, { dp, suffix })}</span>
        ${known ? `<span class="sbar"><i class="h" style="width:${(100 * hn / tot).toFixed(1)}%"></i><i class="a" style="width:${(100 * an / tot).toFixed(1)}%"></i></span>` : '<span class="sbar none"></span>'}</div>`;
    })}
  </div>`;
}

const shirt = p => `<span class="shirt"${p.shirt ? '' : ' aria-hidden="true"'}>${p.shirt ? esc(String(p.shirt)) : ''}</span>`;

export function lineupsBlock(m) {
  if (!m.lineups) return '<p class="muted">Lineups are not available from a legitimate source for this match.</p>';
  const side = (key, team) => {
    const l = m.lineups[key];
    if (!l) return `<div class="lineup"><h3>${esc(team?.name || '')}</h3><p class="muted">Not available.</p></div>`;
    return `<div class="lineup ${key}"><h3>${teamLink(team)}</h3>
      <p class="formation">${l.formation ? `Formation <b>${esc(l.formation)}</b>` : 'Formation not stated by the source'}${l.manager ? ` · Manager ${l.manager.slug ? esc(l.manager.name) : esc(l.manager.name)}` : ''}</p>
      <p class="lu-label">STARTING XI</p><ul>${join((l.starters || []).filter(Boolean), p => `<li>${shirt(p)}${playerChip(p, { size: 'sm' })}</li>`)}</ul>
      ${when((l.bench || []).filter(Boolean).length, () => `<p class="lu-label">BENCH</p><ul class="bench">${join(l.bench.filter(Boolean), p => `<li>${shirt(p)}${playerChip(p)}</li>`)}</ul>`)}
    </div>`;
  };
  return `<div class="lineups">${side('home', m.home)}${side('away', m.away)}</div>`;
}

export function subsBlock(m) {
  if (!m.substitutions?.length) return '<p class="muted">No substitutions recorded.</p>';
  const sorted = [...m.substitutions].sort((a, b) => (a.minute ?? 999) - (b.minute ?? 999));
  return `<div class="subs"><div class="subs-head"><span>Min</span><span>Off</span><span>On</span></div>${join(sorted, s => `<div class="subrow ${s.team}">
    <span class="min">${s.minute !== null && s.minute !== undefined ? `${esc(s.minute)}'` : DASH}</span><span>${playerChip(s.out)}</span><span>${playerChip(s.in)}</span></div>`)}</div>`;
}

export function eventMap(m) {
  const shots = validShots(m.shots);
  if (!shots.length) {
    return `<div class="state empty"><p class="state-title">No event map for this match</p><p>${esc(m.event_source === 'openligadb' ? 'The source for this match reports goals only, without event locations.' : 'No located events are stored for this match.')} Nothing is plotted rather than something invented.</p></div>`;
  }
  const count = side => shots.filter(s => s.team === side).length;
  const goals = side => shots.filter(s => s.team === side && s.outcome === 'goal').length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return `<div class="emap">
    <div class="emap-head"><span class="emap-home"><i></i>${esc(m.home?.name)} · ${plural(count('home'), 'shot')} · ${plural(goals('home'), 'goal')}</span>
      <span class="emap-away"><i></i>${esc(m.away?.name)} · ${plural(count('away'), 'shot')} · ${plural(goals('away'), 'goal')}</span></div>
    <div class="emap-filters" role="group" aria-label="Filter shots">
      <button class="chip on" data-filter="all">All</button><button class="chip" data-filter="home">${esc(m.home?.short_name || m.home?.name)}</button>
      <button class="chip" data-filter="away">${esc(m.away?.short_name || m.away?.name)}</button><button class="chip" data-filter="goal">Goals</button>
    </div>
    <div class="pitchwrap land">${pitchSvg(shots, { homeName: m.home?.short_name || m.home?.name || 'Home', awayName: m.away?.short_name || m.away?.name || 'Away' })}</div>
    <div class="pitchwrap port">${pitchSvg(shots, { homeName: m.home?.short_name || m.home?.name || 'Home', awayName: m.away?.short_name || m.away?.name || 'Away', portrait: true })}</div>
    <p class="emap-label">EVENT LOCATIONS — NOT PLAYER TRACKING</p>
    <div class="emap-detail" aria-live="polite"><span class="muted">Tap or focus a shot for details.</span></div>
    <p class="legend"><span><i class="lg goal"></i>Goal</span><span><i class="lg on"></i>On target</span><span><i class="lg off"></i>Off target / blocked</span></p>
  </div>`;
}


const OUTCOME = { goal: 'Goal', on_target: 'Saved / on target', off_target: 'Off target', blocked: 'Blocked', post: 'Woodwork' };
const BODY = { right_foot: 'Right foot', left_foot: 'Left foot', head: 'Header', head_or_body: 'Header / body', other: 'Other' };

// SHOT INTELLIGENCE — every shot the event source records, in order.
export function shotTimeline(m) {
  const shots = m.shot_timeline || [];
  if (!shots.length) return '<p class="muted">No shot-level record for this match.</p>';
  const tn = s => (s === 'away' ? m.away : m.home)?.short_name || (s === 'away' ? m.away : m.home)?.name || '';
  const hasXg = shots.some(s => s.provider_xg);
  return `<div class="tablewrap" tabindex="0" role="region" aria-label="Shot timeline (scrolls horizontally)"><table class="ltable shots">
    <caption class="sr-only">Every shot in match order</caption>
    <thead><tr><th scope="col">Min</th><th class="tm" scope="col">Shooter</th><th scope="col" class="tl">Team</th><th scope="col" class="tl">Result</th><th scope="col" class="tl wide">How</th><th scope="col"><abbr title="Score before the shot">Score</abbr></th><th scope="col" class="tl wide">Assist</th>${hasXg ? '<th scope="col" title="Supplied expected goals, not a PropBetEdge model">xG</th>' : ''}</tr></thead>
    <tbody>${join(shots, s => `<tr class="${s.goal ? 'goalrow' : ''} ${s.team}">
      <td>${esc(s.display_minute || (s.minute !== null && s.minute !== undefined ? `${s.minute}'` : DASH))}</td>
      <th class="tm" scope="row">${playerChip(s.player)}</th><td class="tl">${esc(tn(s.team))}</td>
      <td class="tl">${s.goal ? '<b>Goal</b>' : esc(OUTCOME[s.outcome] || 'Shot')}</td>
      <td class="tl wide">${esc([BODY[s.body_part], s.set_piece ? String(s.set_piece).replace(/_/g, ' ') : null, s.situation && s.situation !== 'Regular Play' ? s.situation : null].filter(Boolean).join(' · ') || DASH)}</td>
      <td>${esc(s.score_before || DASH)}</td><td class="tl wide">${s.assist ? personLink(s.assist) : DASH}</td>
      ${hasXg ? `<td>${s.provider_xg ? num(s.provider_xg.value, { dp: 2 }) : DASH}</td>` : ''}</tr>`)}</tbody></table></div>
    ${hasXg ? '<p class="caveat">xG is a supplied stat (DATA · PropSports), not a PropBetEdge model.</p>' : ''}`;
}

// PLAYER IMPACT — sourced counts per player; minutes are nominal.
const IMPACT_COLS = [['minutes_nominal', 'Min', 'Nominal minutes (lineups and substitutions)'], ['goals', 'G', 'Goals'], ['assists', 'A', 'Assists'], ['shots', 'Sh', 'Shots'], ['shots_on_target', 'SoT', 'Shots on target'], ['key_passes', 'KP', 'Key passes'], ['passes', 'Pas', 'Passes'], ['tackles', 'Tkl', 'Tackles'], ['interceptions', 'Int', 'Interceptions'], ['saves', 'Sv', 'Saves'], ['yellow_cards', 'YC', 'Yellow cards'], ['red_cards', 'RC', 'Red cards']];
export function playerImpact(m) {
  const p = m.players;
  if (!p?.rows?.length) return '<p class="muted">No player-level record for this match.</p>';
  const cols = IMPACT_COLS.filter(([k]) => p.rows.some(r => r[k] !== undefined && r[k] !== null));
  const basis = p.basis === 'derived' ? 'PBE derived counts from the event ledger' : 'Counted from the PropSports event record';
  const side = key => { const rows = p.rows.filter(r => r.team === key); if (!rows.length) return ''; const team = key === 'away' ? m.away : m.home; return `
    <h3 class="impact-team">${teamLink(team)}</h3>
    <div class="tablewrap" tabindex="0" role="region" aria-label="${esc(team?.name || key)} player impact (scrolls horizontally)"><table class="ltable impact"><caption class="sr-only">${esc(team?.name || key)} players</caption>
      <thead><tr><th class="tm" scope="col">Player</th>${join(cols, ([, l, t]) => `<th scope="col"><abbr title="${esc(t)}">${esc(l)}</abbr></th>`)}</tr></thead>
      <tbody>${join(rows, r => `<tr><th class="tm" scope="row">${playerChip(r.player, { extra: r.started ? '' : ' <span class="subtag" title="Came on">sub</span>' })}${r.sub_on !== undefined && r.sub_on !== null ? `<span class="sr-only"> on ${esc(r.sub_on)}'</span>` : ''}</th>${join(cols, ([k]) => `<td>${num(r[k])}</td>`)}</tr>`)}</tbody></table></div>`; };
  return `<p class="stats-basis"><b>PLAYER IMPACT</b> ${esc(basis)}. Minutes are nominal. A dash means not recorded, not zero.</p>${side('home')}${side('away')}`;
}

export function freshness(m, meta) {
  if (m.status !== 'live') return '';
  return `<p class="fresh" role="status">Live · updated ${esc(ago(meta?.source_updated_at))}. Scores refresh about every 5 minutes from the source; this page checks every minute.</p>`;
}

export function render(d) {
  const m = d.env.data; const meta = d.env.meta;
  const sc = m.score;
  const kxHtml = matchKalshiHtml(d.kx);
  const extra = [
    ['Event source', m.event_source ? sourceName(m.event_source) : 'None'],
    ['Result source', sourceName(m.result_source)],
    ['Coordinates', m.coordinates ? `${m.coordinates.system}. ${m.coordinates.note}` : 'No located events'],
  ];
  return `
  <section class="mhero"><div class="wrap">
    <h1 class="sr-only">${esc(m.home?.name || '')} ${sc ? `${esc(sc.home)}–${esc(sc.away)}` : 'v'} ${esc(m.away?.name || '')}: Match Intelligence</h1>
    <p class="mh-meta">${m.competition ? link(`/competitions/${m.competition.slug}`, `${competitionMark(m.competition.slug, 'xs', { tone: 'dark' })}<span>${esc(m.competition.name)}</span>`, 'mh-comp') : ''}${m.season ? ` · ${esc(m.season)}` : ''}${m.round ? ` · ${esc(m.round)}` : ''}</p>
    <div class="scoreboard">
      <div class="sb-team home">${teamMark(m.home, 'xl')}${teamLink(m.home, 'sb-name')}</div>
      <div class="sb-score">${sc ? `<span>${esc(sc.home)}</span><i>–</i><span>${esc(sc.away)}</span>` : '<span class="vs">v</span>'}
        ${when(sc && sc.home_ht !== null && sc.home_ht !== undefined, () => `<small>HT ${esc(sc.home_ht)}–${esc(sc.away_ht)}</small>`)}</div>
      <div class="sb-team away">${teamMark(m.away, 'xl')}${teamLink(m.away, 'sb-name')}</div>
    </div>
    <p class="mh-sub">${statusPill(m.status)} <span>${esc(dateTime(m.kickoff_at))}</span>${m.venue ? ` <span>· ${esc(m.venue.name)}${m.venue.city ? `, ${esc(m.venue.city)}` : ''}</span>` : ''}</p>
    <p class="kicker gold center">MATCH INTELLIGENCE</p>
    ${when(m.status === 'live' || (m.timeline || []).length || (m.shots || []).length, () => `<p class="center mh-cast">${link(`/pbecast/${m.id}`, m.status === 'live' ? '<i class="livedot" aria-hidden="true"></i> WATCH THE LIVE PBECAST' : '▶ REPLAY ON PBECAST', 'btn gold')}</p>`)}
    ${freshness(m, meta)}
  </div></section>
  <section class="canvas kx-sec" data-kx-match${kxHtml ? '' : ' hidden'}><div class="wrap mid">${kxHtml}</div></section>
  <section class="canvas alt" data-analyzer-preview hidden><div class="wrap"></div></section>
  <section class="canvas" data-match-id="${esc(m.id)}"><div class="wrap mgrid2">
    <div class="col-a">
      <div class="panel">${sectionHead('MATCH STORY', 'Goals, cards and substitutions')}${story(m)}</div>
      ${compMeta(m.competition?.slug)?.spatial === false
        // competitions.js spatial:false: the source gives no pitch locations; no map panel promising one
        ? `<div class="panel map">${sectionHead('EVENT MAP', 'Shot map not available')}<div class="cast-nomap" role="note"><p class="kicker">SHOT MAP NOT AVAILABLE</p><p>The source records this competition's events without pitch locations, so no shot map is drawn. Every shot, goal, card and substitution is in the match timeline.</p></div></div>`
        : `<div class="panel map">${sectionHead('EVENT MAP', 'Every shot on the canonical 105 × 68 m pitch')}${eventMap(m)}</div>`}
      ${when(m.shot_timeline?.length, () => `<div class="panel">${sectionHead('SHOT INTELLIGENCE', 'Every shot, in order')}${shotTimeline(m)}</div>`)}
    </div>
    <div class="col-b">
      <div class="panel">${sectionHead('MATCH STATS', 'By source basis')}${statsBlock(m)}</div>
      <div class="panel">${sectionHead('LINEUPS', 'Starting XI and bench')}${lineupsBlock(m)}</div>
      <div class="panel">${sectionHead('SUBSTITUTIONS', 'Who came off, who came on')}${subsBlock(m)}</div>
      ${sourcePanel(meta, { title: 'SOURCE & FRESHNESS', extra })}
    </div>
  </div></section>
  ${when(m.players?.rows?.length, () => `<section class="canvas alt" data-match-id="${esc(m.id)}"><div class="wrap">${sectionHead('PLAYER IMPACT', 'Who shaped the match')}${keyPlayers(m)}${playerImpact(m)}${newsSlot()}</div></section>`)}
  ${when(!m.players?.rows?.length, () => `<section class="canvas alt"><div class="wrap">${newsSlot()}</div></section>`)}`;
}

const newsSlot = () => '<div data-related-news></div>';

// Market card lifecycle: one poll chain per mounted match page, for every match that has or had a market
// (completed ones too): live 20 s / pregame 45 s; CLOSED (or a finished match whose market still trades)
// 5 min until it settles; SETTLED none (marketPollMs). The slot turns from the live card into "How the market
// closed" on its own when the API says so. It stops as soon as the slot leaves the DOM (navigation or re-render) and is cleared on every mount.
const kxState = { id: null, entry: null, timer: null };
export function stopMatchKalshi() { clearTimeout(kxState.timer); kxState.timer = null; }
function paintKalshi(slot, entry) {
  const html = matchKalshiHtml(entry);
  slot.querySelector('.wrap').innerHTML = html;
  slot.hidden = !html;
  if (html) wireKalshi(slot);
}
function mountKalshi(root, d) {
  stopMatchKalshi();
  const m = d.env.data;
  const slot = root.querySelector('[data-kx-match]');
  if (!slot) return;
  Object.assign(kxState, { id: m.id, entry: d.kx || null });
  if (d.kx) wireKalshi(slot);
  const schedule = () => {
    clearTimeout(kxState.timer); kxState.timer = null;
    const ms = marketPollMs(m.status, kxState.entry);
    if (!ms || !slot.isConnected) return;
    kxState.timer = setTimeout(async () => {
      if (!slot.isConnected) return;
      if (document.hidden) return schedule();
      const entry = await loadMatchMarket(m.id, { force: true });
      if (!slot.isConnected || kxState.id !== m.id) return;
      kxState.entry = entry; paintKalshi(slot, entry); schedule();
    }, ms);
  };
  if (d.kxPending) d.kxPending.then(entry => { if (slot.isConnected && entry && kxState.id === m.id) { kxState.entry = entry; paintKalshi(slot, entry); schedule(); } });
  schedule();
}

export function mount(root, d) {
  mountKalshi(root, d);
  mountRelatedNews(root, { match: d.env.data.id }, { title: 'Stories about this match' });
  const preview = root.querySelector('[data-analyzer-preview]');
  if (preview && d.env.meta.features?.includes('matchup_analyzer_v2')) api(`matches/${d.env.data.id}/analyzer-preview`).then(env => {
    if (!preview.isConnected || !env.data) return;
    preview.hidden = false;
    preview.innerHTML = `<div class="wrap">${analyzerPreviewHtml(env.data, d.env.data)}<p>${link(`/pro/matches/${d.env.data.id}`, 'OPEN THE FULL MATCHUP ANALYZER · ALL ACCESS →', 'sec-link')}</p></div>`;
  }).catch(() => {});
  // Live: soft refresh every 60 s while the page is still this match (no history change).
  if (d.env.data.status === 'live') {
    const path = location.pathname;
    const t = setTimeout(async () => {
      if (location.pathname !== path || !root.isConnected) return;
      try { const env = await api(`matches/${d.env.data.id}`, {}, { fresh: true }); if (location.pathname !== path) return; const next = { env, kx: kxState.id === env.data.id ? kxState.entry : null }; root.innerHTML = render(next); mount(root, next); } catch { /* keep the current view */ }
    }, 60000);
    root.dataset.liveTimer = String(t);
  }
  const shots = validShots(d.env.data.shots);
  const detail = root.querySelector('.emap-detail');
  const m = d.env.data;
  const show = i => {
    const s = shots[i]; if (!s || !detail) return;
    root.querySelectorAll('.mark.sel').forEach(n => n.classList.remove('sel'));
    root.querySelectorAll(`.mark[data-i="${i}"]`).forEach(n => n.classList.add('sel'));
    const team = s.team === 'home' ? m.home?.name : m.away?.name;
    const outcome = { goal: 'Goal', on_target: 'On target', off_target: 'Off target', blocked: 'Blocked' }[s.outcome] || 'Shot';
    detail.innerHTML = `<b>${esc(s.minute ?? '?')}'</b> ${s.player?.slug ? `<a href="/players/${esc(s.player.slug)}" data-link>${esc(s.player.name)}</a>` : esc(s.player?.name || 'Unidentified player')} <span class="muted">· ${esc(team || '')} · ${esc(outcome)}</span>`;
  };
  root.querySelectorAll('.mark').forEach(n => {
    n.addEventListener('click', () => show(Number(n.dataset.i)));
    n.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); show(Number(n.dataset.i)); } });
  });
  root.querySelectorAll('[data-filter]').forEach(b => b.addEventListener('click', () => {
    root.querySelectorAll('[data-filter]').forEach(x => x.classList.toggle('on', x === b));
    const f = b.dataset.filter;
    root.querySelectorAll('.mark').forEach(n => {
      const s = shots[Number(n.dataset.i)];
      const vis = f === 'all' || (f === 'goal' ? s.outcome === 'goal' : s.team === f);
      n.style.display = vis ? '' : 'none';
    });
  }));
}
