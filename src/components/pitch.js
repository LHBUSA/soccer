// Event map on the canonical 105 x 68 m pitch. Input: API shots in the MATCH
// frame (home attacks toward x = 105, y = 0 top touchline). Real geometry, real
// events only — no trails, no inferred positions.
import { esc } from '../lib/html.js';

export const L = 105; export const W = 68;
const PAD = 3;

export function pitchLines() {
  const box = (x, w, h) => `<rect x="${x}" y="${(W - h) / 2}" width="${w}" height="${h}"/>`;
  const arcR = 9.15;
  // Penalty arc: part of the r=9.15 circle around the penalty spot outside the box.
  const dx = 16.5 - 11; const dy = Math.sqrt(arcR * arcR - dx * dx);
  return `
  <rect class="turf" x="0" y="0" width="${L}" height="${W}"/>
  ${Array.from({ length: 7 }, (_, i) => `<rect class="stripe" x="${i * 15}" y="0" width="7.5" height="${W}"/>`).join('')}
  <g class="lines">
    <rect x="0" y="0" width="${L}" height="${W}"/>
    <line x1="${L / 2}" y1="0" x2="${L / 2}" y2="${W}"/>
    <circle cx="${L / 2}" cy="${W / 2}" r="${arcR}"/>
    ${box(0, 16.5, 40.32)}${box(L - 16.5, 16.5, 40.32)}
    ${box(0, 5.5, 18.32)}${box(L - 5.5, 5.5, 18.32)}
    <path d="M ${16.5} ${W / 2 - dy} A ${arcR} ${arcR} 0 0 1 ${16.5} ${W / 2 + dy}"/>
    <path d="M ${L - 16.5} ${W / 2 - dy} A ${arcR} ${arcR} 0 0 0 ${L - 16.5} ${W / 2 + dy}"/>
    <path d="M 0 1 A 1 1 0 0 0 1 0"/><path d="M ${L - 1} 0 A 1 1 0 0 0 ${L} 1"/>
    <path d="M 0 ${W - 1} A 1 1 0 0 1 1 ${W}"/><path d="M ${L - 1} ${W} A 1 1 0 0 1 ${L} ${W - 1}"/>
  </g>
  <g class="spots"><circle cx="${L / 2}" cy="${W / 2}" r="0.45"/><circle cx="11" cy="${W / 2}" r="0.45"/><circle cx="${L - 11}" cy="${W / 2}" r="0.45"/></g>
  <g class="goals"><rect x="-2" y="${W / 2 - 3.66}" width="2" height="7.32"/><rect x="${L}" y="${W / 2 - 3.66}" width="2" height="7.32"/></g>`;
}

export function shotClass(s) {
  const kind = s.outcome === 'goal' ? 'goal' : s.outcome === 'on_target' ? 'on' : 'off';
  return `shot ${s.team === 'home' ? 'home' : 'away'} ${kind}`;
}

export function validShots(shots) {
  return (shots || []).filter(s => Number.isFinite(s.x) && Number.isFinite(s.y) && s.x >= 0 && s.x <= L && s.y >= 0 && s.y <= W);
}

// Portrait (phones): rotate so the home team attacks UP. Screen (sx, sy) = (y, L - x);
// the geometry is identical, only the drawing is rotated.
export const toPortrait = (x, y) => ({ x: y, y: L - x });

export function pitchSvg(shots, { homeName = 'Home', awayName = 'Away', portrait = false } = {}) {
  const pts = validShots(shots);
  if (portrait) return portraitSvg(pts, { homeName, awayName });
  const marks = pts.map((s, i) => {
    const r = s.outcome === 'goal' ? 1.55 : 1.05;
    const label = `${s.minute ?? '?'}' ${s.player?.name || 'Unidentified player'} (${s.team === 'home' ? homeName : awayName}) — ${s.outcome === 'goal' ? 'goal' : s.outcome === 'on_target' ? 'on target' : s.outcome === 'blocked' ? 'blocked' : s.outcome === 'off_target' ? 'off target' : 'shot'}`;
    return `<g class="mark" data-i="${i}" tabindex="0" role="button" aria-label="${esc(label)}">
      <circle class="hit" cx="${s.x}" cy="${s.y}" r="2.6"/>
      <circle class="${shotClass(s)}" cx="${s.x}" cy="${s.y}" r="${r}"/>
      ${s.outcome === 'goal' ? `<circle class="ring" cx="${s.x}" cy="${s.y}" r="2.4"/>` : ''}
    </g>`;
  }).join('');
  return `<svg class="pitch" viewBox="${-PAD} ${-PAD} ${L + 2 * PAD} ${W + 2 * PAD}" role="group" aria-label="Event map: ${pts.length} located shots. ${esc(homeName)} attack right, ${esc(awayName)} attack left.">
    ${pitchLines()}
    <text class="dir" x="${L - 1}" y="${-0.8}" text-anchor="end">${esc(homeName.toUpperCase())} →</text>
    ${awayName ? `<text class="dir" x="1" y="${-0.8}">← ${esc(awayName.toUpperCase())}</text>` : ''}
    <g class="marks">${marks}</g>
  </svg>`;
}

function portraitSvg(pts, { homeName, awayName }) {
  const marks = pts.map((s, i) => {
    const p = toPortrait(s.x, s.y);
    const r = s.outcome === 'goal' ? 1.8 : 1.25;
    const label = `${s.minute ?? '?'}' ${s.player?.name || 'Unidentified player'} (${s.team === 'home' ? homeName : awayName})`;
    return `<g class="mark" data-i="${i}" tabindex="0" role="button" aria-label="${esc(label)}">
      <circle class="hit" cx="${p.x}" cy="${p.y}" r="3"/>
      <circle class="${shotClass(s)}" cx="${p.x}" cy="${p.y}" r="${r}"/>
      ${s.outcome === 'goal' ? `<circle class="ring" cx="${p.x}" cy="${p.y}" r="2.8"/>` : ''}
    </g>`;
  }).join('');
  // Draw the landscape pitch inside a rotated group: (x, y) -> (y, L - x) == rotate(-90) then translate.
  return `<svg class="pitch portrait" viewBox="${-PAD} ${-PAD - 4} ${W + 2 * PAD} ${L + 2 * PAD + 8}" role="group" aria-label="Event map (portrait): ${pts.length} located shots. ${esc(homeName)} attack up, ${esc(awayName)} attack down.">
    <g transform="translate(0 ${L}) rotate(-90)">${pitchLines()}</g>
    <text class="dir" x="${W / 2}" y="${-3.6}" text-anchor="middle">↑ ${esc(homeName.toUpperCase())} ATTACK</text>
    ${awayName ? `<text class="dir" x="${W / 2}" y="${L + 5.6}" text-anchor="middle">↓ ${esc(awayName.toUpperCase())} ATTACK</text>` : ''}
    <g class="marks">${marks}</g>
  </svg>`;
}
