// ARTICLE DATA VISUALS: the deterministic renderer for the soccer-visuals contract
// (workers/soccer-news/src/visuals.js). Draws ONLY what the stored, frozen spec holds: no value is computed
// here beyond geometry (bar widths, positions). Each figure states its source and that it is frozen at
// publication. Unknown or malformed specs render nothing.
import { esc, join } from '../lib/html.js';
import { dateLong } from '../lib/format.js';
import { L, W, pitchLines } from './pitch.js';

const n = v => (v === null || v === undefined ? '—' : typeof v === 'number' && !Number.isInteger(v) ? String(Math.round(v * 10) / 10) : String(v));
const unitSuffix = u => (u === 'percent' ? '%' : u === 'm' ? ' m' : '');
const short = t => t?.name || '';
const surname = p => String(p?.name || '').split(' ').slice(-1)[0];
const bar = (v, max, side) => `<i class="vz-bar ${side}" style="width:${max > 0 ? Math.max(2, Math.round((100 * (Number(v) || 0)) / max)) : 0}%"></i>`;
const teamKey = d => `<div class="vz-key"><span class="vz-sw home"></span>${esc(short(d.teams?.home))}<span class="vz-sw away"></span>${esc(short(d.teams?.away))}</div>`;

// ---- mirrored comparison rows (shot profile, matchup): home value | label | away value, bars from centre
function mirrored(d, rows) {
  return `<div class="vz-mirror">
    <div class="vz-mhead"><b class="h">${esc(short(d.teams.home))}</b><span></span><b class="a">${esc(short(d.teams.away))}</b></div>
    ${join(rows, r => {
      const numeric = typeof r.home === 'number' && typeof r.away === 'number';
      const max = numeric ? Math.max(Math.abs(r.home), Math.abs(r.away)) : 0;
      return `<div class="vz-mrow"><span class="vz-v h">${esc(n(r.home))}${unitSuffix(r.unit)}</span><span class="vz-l">${esc(r.label)}</span><span class="vz-v a">${esc(n(r.away))}${unitSuffix(r.unit)}</span>
        ${numeric && r.unit !== 'rank' && r.unit !== 'plain' && max > 0 ? `<span class="vz-mbars"><span class="vz-half l">${bar(Math.abs(r.home), max, 'home')}</span><span class="vz-half r">${bar(Math.abs(r.away), max, 'away')}</span></span>` : ''}</div>`;
    })}</div>`;
}

function matchFlow(v) {
  const d = v.data;
  const LABEL = { shots: 'Shots', shots_on_target: 'On target', goals: 'Goals' };
  return `${teamKey(d)}<div class="vz-flow">${join(d.metrics, m => {
    const max = Math.max(1, ...d.halves.flatMap(h => [h.home[m], h.away[m]]));
    return `<div class="vz-frow"><span class="vz-l">${esc(LABEL[m] || m)}</span>${join(d.halves, h => `<div class="vz-fcell"><small>${esc(h.key)}</small>
      <span class="vz-fbar">${bar(h.home[m], max, 'home')}<b>${esc(n(h.home[m]))}</b></span><span class="vz-fbar">${bar(h.away[m], max, 'away')}<b>${esc(n(h.away[m]))}</b></span></div>`)}</div>`;
  })}</div>`;
}

function goalTimeline(v) {
  const d = v.data; const end = d.axis.end || 90; const X = at => (100 * at) / end;
  // HTML track (not a stretched SVG): markers stay round at every width. Home above the line, away below.
  const ticks = [15, 30, 60, 75].map(t => (t <= 45 ? t : t + d.axis.first_half_stoppage));
  return `${teamKey(d)}<div class="vz-tl" role="img" aria-label="${esc(`Goal timeline: ${d.goals.map(g => `${g.display_minute} ${g.own_goal ? 'own goal' : surname(g.scorer)}${g.penalty ? ' (penalty)' : ''} (${short(d.teams[g.team])})`).join(', ')}`)}">
      <span class="vz-track"><i class="h1" style="width:${X(d.axis.halftime)}%"></i></span>
      ${join(ticks, t => `<span class="vz-tick" style="left:${X(t)}%"></span>`)}
      <span class="vz-ht" style="left:${X(d.axis.halftime)}%"></span>
      ${join(d.goals, g => `<span class="vz-gm ${g.team}${g.own_goal ? ' og' : ''}${g.penalty ? ' pen' : ''}" style="left:${X(g.at)}%" title="${esc(`${g.display_minute} ${g.own_goal ? 'own goal' : g.scorer?.name || ''}`)}"></span>`)}
    </div>
    <div class="vz-tlscale"><span>0'</span><span style="left:${X(d.axis.halftime)}%">HT${d.halftime ? ` ${esc(d.halftime)}` : ''}</span><span>FT ${esc(d.final)}</span></div>
    <ol class="vz-goals">${join(d.goals, g => `<li class="${g.team}"><b class="vz-min">${esc(g.display_minute)}</b><span class="vz-sw ${g.team}"></span><span class="vz-who">${g.own_goal ? `Own goal${g.scorer ? ` (${esc(g.scorer.name)})` : ''}` : esc(g.scorer?.name || 'Unidentified scorer')}${g.penalty ? ' <em>pen</em>' : ''}${g.assist ? ` <small>assist ${esc(g.assist.name)}</small>` : ''}</span><span class="vz-team">${esc(short(d.teams[g.team]))}</span><b class="vz-rs">${esc(g.running_score)}</b></li>`)}</ol>`;
}

const PT = { goal: 'goal', on_target: 'on', off_target: 'off', blocked: 'blk', post: 'off', other: 'off' };
function pitch(points, { label, homeName, awayName, only = null } = {}) {
  const marks = join(points, p => `<g class="vz-shot ${p.team} ${PT[p.outcome] || 'off'}"><circle cx="${p.x}" cy="${p.y}" r="${p.outcome === 'goal' ? 1.6 : p.outcome === 'on_target' ? 1.15 : 0.9}"/>${p.outcome === 'goal' ? `<circle class="ring" cx="${p.x}" cy="${p.y}" r="2.6"/>` : ''}<title>${esc(`${p.minute ?? '?'}' ${p.player?.name || 'Unidentified player'} · ${p.outcome.replace('_', ' ')}`)}</title></g>`);
  return `<svg class="pitch vz-pitch" viewBox="-3 -4 ${L + 6} ${W + 7}" role="img" aria-label="${esc(label)}">${pitchLines()}
    ${only ? '' : `<text class="dir" x="${L - 1}" y="-1" text-anchor="end">${esc(String(homeName).toUpperCase())} →</text><text class="dir" x="1" y="-1">← ${esc(String(awayName).toUpperCase())}</text>`}
    <g>${marks}</g></svg>`;
}
const pitchLegend = `<p class="vz-legend"><span><i class="lg goal"></i>Goal</span><span><i class="lg on"></i>On target</span><span><i class="lg off"></i>Off target / blocked</span></p>`;
function shotMap(v) {
  const d = v.data;
  return `${teamKey(d)}${pitch(d.points, { label: `Shot map: ${d.located_shots} located shots of ${d.recorded_shots} recorded. ${short(d.teams.home)} attack right, ${short(d.teams.away)} attack left.`, homeName: short(d.teams.home), awayName: short(d.teams.away) })}${pitchLegend}
    ${d.full_coverage ? '' : `<p class="vz-note">${esc(`${d.located_shots} of ${d.recorded_shots} recorded shots have location data; the rest are counted but not plotted.`)}</p>`}`;
}

function playerFocus(v) {
  const d = v.data;
  return `<div class="vz-tiles">${join(d.stats, s => `<div class="vz-tile"><b>${esc(n(s.value))}</b><span>${esc(s.label)}</span></div>`)}</div>
    ${d.points?.length ? `<p class="vz-sub2">${esc(`${d.player.name}'s located shots (${d.located_shots})`)}</p>${pitch(d.points, { label: `${d.player.name}: ${d.located_shots} located shots`, only: true })}${pitchLegend}` : ''}`;
}

const posRow = (t, from, to, pts, extra = '') => `<div class="vz-pos"><span class="vz-team">${esc(t)}</span><span class="vz-move">${from !== null && from !== undefined ? `<b>${esc(n(from))}</b><i aria-hidden="true">→</i>` : ''}<b class="to">${esc(n(to))}</b></span><span class="vz-pts">${esc(n(pts))} pts</span>${extra}</div>`;
function tableMove(v) {
  const d = v.data;
  return `<div class="vz-poslist"><div class="vz-poshead"><span></span><span>Position (of ${esc(n(d.teams_in_table))})</span><span></span></div>${posRow(short(d.teams.home), d.home.position_before, d.home.position_after, d.home.points_after)}${posRow(short(d.teams.away), d.away.position_before, d.away.position_after, d.away.points_after)}</div>`;
}
function groupPosition(v) {
  const d = v.data;
  return `<div class="vz-poslist">${join([['home', d.home], ['away', d.away]].filter(([, g]) => g), ([k, g]) => posRow(short(d.teams[k]), null, `${g.position} of ${g.teams_in_group}`, g.points, `<small class="vz-zone">${esc(g.group)}${g.zone ? ` · ${esc(g.zone)}` : ''}</small>`))}</div>`;
}
const chip = c => `<span class="vz-res r-${esc(c.result)}" title="${esc(`${c.date} ${c.venue === 'home' ? 'v' : 'at'} ${c.opponent?.name || ''} ${c.score}`)}"><b>${esc(c.result)}</b><small>${esc(c.score)}</small></span>`;
function formStrip(v) {
  const d = v.data;
  return `<div class="vz-forms">${join([['home', d.home], ['away', d.away]], ([k, list]) => `<div class="vz-form"><span class="vz-team"><span class="vz-sw ${k}"></span>${esc(short(d.teams[k]))}</span><span class="vz-chips">${list.length ? join(list, chip) : '<small class="muted">No earlier results this season</small>'}</span></div>`)}</div>`;
}
function scoringRun(v) {
  const d = v.data; const max = Math.max(1, ...d.appearances.map(a => a.goals));
  return `<div class="vz-cols">${join(d.appearances, a => `<div class="vz-col"><span class="vz-colbar"><i style="height:${Math.round((100 * a.goals) / max)}%"></i></span><b>${esc(n(a.goals))}</b><small>${esc(a.opponent?.name || '')}</small><small class="muted">${esc(a.date.slice(5))} · ${esc(a.score)}${a.started ? '' : ' · sub'}</small></div>`)}</div>`;
}
function runResults(v) {
  const d = v.data;
  return `<div class="vz-chips wide">${join(d.games, g => chip({ ...g, score: `${g.goals_for}-${g.goals_against}` }))}</div>`;
}
function teamStanding(v) {
  const r = v.data.row;
  return `<div class="vz-tiles">${join([['Position', `${r.position} of ${v.data.teams_in_table}`], ['Points', r.points], ['Played', r.played], ['W-D-L', `${r.won}-${r.drawn}-${r.lost}`], ['Goal difference', r.goal_difference > 0 ? `+${r.goal_difference}` : r.goal_difference]], ([l, x]) => `<div class="vz-tile"><b>${esc(n(x))}</b><span>${esc(l)}</span></div>`)}</div>`;
}
const COL = { played: 'P', won: 'W', drawn: 'D', lost: 'L', goal_difference: 'GD', points: 'PTS' };
function table(rows, columns) {
  return `<div class="vz-tablewrap"><table class="vz-table"><thead><tr><th>#</th><th class="tm">Team</th>${join(columns, c => `<th>${COL[c] || c}</th>`)}</tr></thead><tbody>
    ${join(rows, r => `${r._gap ? '<tr class="vz-gap"><td colspan="99">…</td></tr>' : ''}<tr${r.zone ? ` title="${esc(r.zone)}"` : ''}><td>${esc(n(r.position))}</td><th class="tm" scope="row">${r.team?.slug ? `<a href="/teams/${esc(r.team.slug)}" data-link>${esc(r.team.name)}</a>` : esc(r.team?.name || '')}</th>${join(columns, c => `<td${c === 'points' ? ' class="pts"' : ''}>${esc(c === 'goal_difference' && r[c] > 0 ? `+${r[c]}` : n(r[c]))}</td>`)}</tr>`)}</tbody></table></div>`;
}
const standings = v => table([...v.data.top, ...(v.data.bottom || []).map((r, i) => (i === 0 ? { ...r, _gap: true } : r))], v.data.columns);
const groupTable = v => table(v.data.rows, v.data.columns);
function matchup(v) { return mirrored(v.data, v.data.rows); }
function playersInForm(v) {
  const max = Math.max(1, ...v.data.players.map(p => p.run));
  return `<div class="vz-plist">${join(v.data.players, p => `<div class="vz-prow"><span class="vz-team"><span class="vz-sw ${esc(p.team)}"></span>${p.player?.slug ? `<a href="/players/${esc(p.player.slug)}" data-link data-player-slug="${esc(p.player.slug)}">${esc(p.player.name)}</a>` : esc(p.player?.name || '')}</span><span class="vz-fbar">${bar(p.run, max, p.team)}<b>${esc(n(p.run))}</b></span><small>${esc(n(p.goals_in_run))} goals in the run</small></div>`)}</div>`;
}
function fixturesBoard(v) {
  const st = s => (!s ? '' : s.kind === 'group' ? `${s.position} · ${s.group}` : `${s.position}`);
  return `<ol class="vz-fixtures">${join(v.data.fixtures, f => `<li><b class="vz-min">${esc(f.kickoff_time_utc)}</b><span class="vz-fx"><span>${esc(f.home.name)}${f.home.standing ? ` <small>${esc(st(f.home.standing))}</small>` : ''}</span><i>v</i><span>${esc(f.away.name)}${f.away.standing ? ` <small>${esc(st(f.away.standing))}</small>` : ''}</span></span>${f.venue ? `<small class="muted">${esc(f.venue)}</small>` : ''}</li>`)}</ol>`;
}

const RENDER = { match_flow: matchFlow, goal_timeline: goalTimeline, shot_profile: v => mirrored(v.data, v.data.rows), shot_map: shotMap, player_focus: playerFocus, table_move: tableMove, group_position: groupPosition, form_strip: formStrip, scoring_run: scoringRun, run_results: runResults, team_standing: teamStanding, standings, group_table: groupTable, matchup, players_in_form: playersInForm, fixtures_board: fixturesBoard };

export function renderVisual(v) {
  const f = RENDER[v?.type]; if (!f || !v.data) return '';
  let inner; try { inner = f(v); } catch { return ''; }
  return `<figure class="viz t-${esc(v.type)}" data-viz="${esc(v.id)}"><figcaption><span class="vz-k">THE DATA</span><b>${esc(v.title)}</b>${v.subtitle ? `<small>${esc(v.subtitle)}</small>` : ''}</figcaption>
    <div class="vz-body">${inner}</div>
    <p class="vz-src">${esc(v.source)} <span>Frozen at publication${v.observed_at ? `, ${esc(dateLong(v.observed_at))}` : ''}.</span></p></figure>`;
}

// Order: the desk's emphasis (ids it chose from the code-built menu), then the story type's default priority.
const PRIORITY = ['goal_timeline', 'player_focus', 'matchup', 'scoring_run', 'run_results', 'group_table', 'standings', 'fixtures_board', 'shot_map', 'match_flow', 'shot_profile', 'table_move', 'group_position', 'team_standing', 'form_strip', 'players_in_form'];
export function orderVisuals(body) {
  const list = Array.isArray(body?.visuals) ? body.visuals.filter(v => RENDER[v?.type]) : [];
  const emph = (body?.visual_emphasis || []).filter(id => list.some(v => v.id === id));
  const rank = v => { const e = emph.indexOf(v.id); return e >= 0 ? e - 100 : (PRIORITY.indexOf(v.type) + 1 || 99); };
  return list.map((v, i) => ({ v, i })).sort((a, b) => rank(a.v) - rank(b.v) || a.i - b.i).map(x => x.v);
}
