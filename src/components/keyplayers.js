// KEY PLAYERS of a match: from the match's own sourced Player Impact rows only (goals, assists,
// shots on target, key passes), ranked deterministically. Each card opens the Player DNA drawer
// with today's sourced line (data-match-id gives the drawer the match context).
import { esc, join } from '../lib/html.js';
import { num } from '../lib/format.js';
import { portrait } from './media.js';

const weight = r => (r.goals || 0) * 5 + (r.assists || 0) * 3 + (r.shots_on_target || 0) + (r.key_passes || 0) * 0.5 + (r.saves || 0) * 0.4;

export function keyPlayerRows(m, n = 6) {
  const rows = m?.players?.rows || [];
  return [...rows].filter(r => r.player?.slug && weight(r) > 0).sort((a, b) => weight(b) - weight(a) || (b.minutes_nominal || 0) - (a.minutes_nominal || 0) || String(a.player.name).localeCompare(String(b.player.name))).slice(0, n);
}

// Today's line, sourced counts only; a count the source did not record is left out, never 0.
export function todayLine(r) {
  const bits = [['goals', 'goal'], ['assists', 'assist'], ['shots', 'shot'], ['shots_on_target', 'on target', true], ['key_passes', 'key pass', true], ['saves', 'save']]
    .filter(([k]) => r[k] !== null && r[k] !== undefined && r[k] > 0)
    .map(([k, w, fixed]) => `${num(r[k])} ${fixed ? w : `${w}${r[k] === 1 ? '' : 's'}`}`);
  if (r.minutes_nominal !== null && r.minutes_nominal !== undefined) bits.push(`${num(r.minutes_nominal)} min`);
  return bits.join(' · ');
}

export function keyPlayers(m, { n = 6, title = true } = {}) {
  const rows = keyPlayerRows(m, n);
  if (!rows.length) return '';
  const team = side => (side === 'away' ? m.away : m.home);
  return `<div class="kp">${title ? '<p class="nrail-h">KEY PLAYERS</p>' : ''}<div class="kp-grid">${join(rows, r => `<a class="kp-card ${r.team === 'away' ? 'away' : 'home'}" href="/players/${esc(r.player.slug)}" data-link data-player-slug="${esc(r.player.slug)}" data-match-id="${esc(m.id)}">
    ${portrait(r.player, 'md')}<span class="kp-id"><b>${esc(r.player.name)}</b><small>${esc(team(r.team)?.short_name || team(r.team)?.name || '')}</small><span class="kp-line">${esc(todayLine(r))}</span></span></a>`)}</div></div>`;
}
