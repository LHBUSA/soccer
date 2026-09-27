// Server-rendered match page, built from a frozen packet + the event ledger.
// Pure function: data in, HTML string out. No client fetches, no provider calls.
// Pitch drawing uses the 105 x 68 canonical frame (match frame: home attacks right).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function pitchSvg(shots, teams) {
  const lines = `
    <rect x="0" y="0" width="105" height="68" class="turf"/>
    <g class="lines" fill="none">
      <rect x="0" y="0" width="105" height="68"/>
      <line x1="52.5" y1="0" x2="52.5" y2="68"/>
      <circle cx="52.5" cy="34" r="9.15"/>
      <rect x="0" y="13.84" width="16.5" height="40.32"/><rect x="88.5" y="13.84" width="16.5" height="40.32"/>
      <rect x="0" y="24.84" width="5.5" height="18.32"/><rect x="99.5" y="24.84" width="5.5" height="18.32"/>
      <rect x="-1.5" y="30.34" width="1.5" height="7.32"/><rect x="105" y="30.34" width="1.5" height="7.32"/>
    </g>`;
  const dots = shots.filter(s => s.x !== null).map(s => {
    const goal = s.outcome === 'goal';
    const cls = `shot ${s.team}${goal ? ' goal' : ''}${s.outcome === 'on_target' ? ' ontarget' : ''}`;
    return `<circle class="${cls}" cx="${s.x}" cy="${s.y}" r="${goal ? 1.6 : 1.05}"><title>${esc(`${s.minute}' ${s.player || ''} — ${s.outcome || 'shot'}${s.distance_m !== null ? `, ${s.distance_m} m` : ''}`)}</title></circle>`;
  }).join('');
  return `<svg viewBox="-3 -3 111 74" role="img" aria-label="Shot map: ${esc(teams.home.name)} attack right, ${esc(teams.away.name)} attack left">${lines}${dots}</svg>`;
}

function statRow(label, h, a, suffix = '') {
  const hv = Number(h) || 0; const av = Number(a) || 0; const tot = hv + av || 1;
  return `<div class="stat"><span class="v">${esc(h)}${suffix}</span><div class="bar"><i class="h" style="width:${(100 * hv / tot).toFixed(1)}%"></i><i class="a" style="width:${(100 * av / tot).toFixed(1)}%"></i></div><span class="v">${esc(a)}${suffix}</span><span class="l">${esc(label)}</span></div>`;
}

export function renderMatchPage({ packet, article, lineups, timeline }) {
  const { match, teams, stats } = packet;
  const title = `${teams.home.name} ${match.score.final} ${teams.away.name} — ${match.competition.name} ${match.season}`;
  const lu = side => `<ul>${lineups[side].map(p => `<li class="${p.is_starter ? '' : 'bench'}"><a href="/players/${esc(p.slug)}">${esc(p.name)}</a>${p.sub_minute !== null && p.sub_minute !== undefined ? ` <small>${p.is_starter ? '↓' : '↑'} ${p.sub_minute}'</small>` : ''}</li>`).join('')}</ul>`;
  const tl = timeline.map(t => `<li class="${t.team}"><b>${t.minute}'</b> ${esc(t.label)}</li>`).join('');
  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'SportsEvent', name: `${teams.home.name} v ${teams.away.name}`, startDate: match.kickoff_utc,
    location: match.venue ? { '@type': 'Place', name: match.venue } : undefined, sport: 'Soccer',
    homeTeam: { '@type': 'SportsTeam', name: teams.home.name }, awayTeam: { '@type': 'SportsTeam', name: teams.away.name },
    superEvent: { '@type': 'SportsEvent', name: `${match.competition.name} ${match.season}` }, eventStatus: 'https://schema.org/EventScheduled',
  };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>
<style>
:root{--ink:#0d1a12;--paper:#fff;--muted:#5b6b61;--green:#0b3d23;--gold:#c9a227;--home:#c9a227;--away:#7fb8ff;--turf:#0f2e1c;--line:rgba(255,255,255,.55);--rule:#e3e8e4}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--ink:#e9efe9;--paper:#0b120e;--muted:#9fb0a5;--rule:#1f2a23}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1040px;margin:0 auto;padding:16px}
header.score{background:var(--green);color:#fff;border-radius:14px;padding:18px 16px;display:grid;grid-template-columns:1fr auto 1fr;gap:10px;align-items:center;text-align:center}
header.score .t{font-weight:700;font-size:clamp(15px,3.6vw,22px)}header.score .s{font:800 clamp(30px,8vw,52px)/1 ui-monospace,Menlo,monospace;color:var(--gold)}
.meta{color:var(--muted);font-size:14px;margin:10px 0 18px;text-align:center}
.grid{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:18px}@media (max-width:760px){.grid{grid-template-columns:1fr}}
.card{border:1px solid var(--rule);border-radius:12px;padding:14px}.card h2{font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
svg{width:100%;height:auto;display:block;border-radius:8px}.turf{fill:var(--turf)}.lines *{stroke:var(--line);stroke-width:.35}
.shot{stroke:#000;stroke-width:.2;opacity:.85}.shot.home{fill:var(--home)}.shot.away{fill:var(--away)}.shot.goal{stroke:#fff;stroke-width:.5;opacity:1}
.stat{display:grid;grid-template-columns:44px 1fr 44px;grid-template-rows:auto auto;column-gap:8px;margin:6px 0}.stat .v{font-variant-numeric:tabular-nums;font-weight:600}.stat .v:last-of-type{text-align:right}
.stat .bar{display:flex;height:8px;border-radius:4px;overflow:hidden;background:var(--rule);align-self:center}.bar .h{background:var(--home)}.bar .a{background:var(--away)}.stat .l{grid-column:1/-1;font-size:12px;color:var(--muted);text-align:center}
ol.tl{list-style:none;padding:0;margin:0}ol.tl li{padding:6px 0;border-bottom:1px solid var(--rule);font-size:14px}ol.tl li.away{text-align:right}
.lineups{display:grid;grid-template-columns:1fr 1fr;gap:12px}.lineups ul{list-style:none;padding:0;margin:0;font-size:14px}.lineups li.bench{color:var(--muted)}.lineups a{color:inherit}
article.story{margin-top:22px}article.story h1{font-size:clamp(22px,4.5vw,32px);line-height:1.2;margin:0 0 6px}article.story .dek{color:var(--muted);margin:0 0 14px}
article.story h3{font-size:14px;text-transform:uppercase;letter-spacing:.06em;color:var(--green);margin:18px 0 6px}
@media (prefers-color-scheme:dark){article.story h3{color:var(--gold)}}
.legend{font-size:12px;color:var(--muted);margin-top:6px}.legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin:0 4px 0 10px;vertical-align:middle}
footer{margin:28px 0 8px;font-size:12px;color:var(--muted);border-top:1px solid var(--rule);padding-top:10px}
</style></head><body><div class="wrap">
<header class="score"><div class="t">${esc(teams.home.name)}</div><div class="s">${match.score.home}–${match.score.away}</div><div class="t">${esc(teams.away.name)}</div></header>
<p class="meta">${esc(match.competition.name)} ${esc(match.season)} · Matchday ${esc(match.matchday)} · ${esc(match.kickoff_utc.slice(0, 10))}${match.venue ? ` · ${esc(match.venue)}` : ''} · HT ${esc(match.score.half_time)}</p>
<div class="grid">
<section class="card"><h2>Shot map</h2>${pitchSvg(packet.shots, teams)}
<div class="legend"><i style="background:var(--home)"></i>${esc(teams.home.name)} (attacking →)<i style="background:var(--away)"></i>${esc(teams.away.name)} (← attacking) · larger ringed = goal. Event locations, not player tracking.</div></section>
<section class="card"><h2>Match counts</h2>
${statRow('Shots', stats.home.shots, stats.away.shots)}${statRow('Shots on target', stats.home.shots_on_target, stats.away.shots_on_target)}
${statRow('Passes completed', stats.home.passes_completed, stats.away.passes_completed)}${statRow('Pass completion', stats.home.pass_completion_pct, stats.away.pass_completion_pct, '%')}
${statRow('Final-third passes completed', stats.home.final_third_passes_completed, stats.away.final_third_passes_completed)}${statRow('Duels won', stats.home.duels_won, stats.away.duels_won)}
${statRow('Corners', stats.home.corners, stats.away.corners)}${statRow('Fouls', stats.home.fouls_committed, stats.away.fouls_committed)}</section>
<section class="card"><h2>Timeline</h2><ol class="tl">${tl}</ol></section>
<section class="card"><h2>Lineups</h2><div class="lineups"><div><b>${esc(teams.home.name)}</b>${teams.home.manager ? `<br><small>Manager: ${esc(teams.home.manager.name)}</small>` : ''}${lu('home')}</div><div><b>${esc(teams.away.name)}</b>${teams.away.manager ? `<br><small>Manager: ${esc(teams.away.manager.name)}</small>` : ''}${lu('away')}</div></div></section>
</div>
<article class="story"><h1>${esc(article.headline)}</h1><p class="dek">${esc(article.dek)}</p>
${article.sections.map(s => `<h3>${esc(s.heading)}</h3>${s.paragraphs.map(p => `<p>${esc(p)}</p>`).join('')}`).join('')}</article>
<footer>PropBetEdge Soccer Intelligence · evidence packet ${esc(packet.hash.slice(0, 16))} · ${packet.provenance.attributions.map(esc).join(' · ')}</footer>
</div></body></html>`;
}
