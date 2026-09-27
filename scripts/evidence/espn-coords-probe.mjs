#!/usr/bin/env node
// Establish the semantics of ESPN Core play coordinates (fieldPositionX/Y) before
// any conversion is written. For completed events: collect every shot/goal play
// with its team, period and coordinates. If coordinates were team-relative, all
// shots of both teams would sit at the same end in both halves; if absolute, the
// end flips with team and half. Also captures one roster entry, one play and one
// athlete verbatim-shape. Writes docs/evidence/espn-soccer-coordinates.json.
//
//   node scripts/evidence/espn-coords-probe.mjs ger.1:401884782 eng.1:<id> ...

import { writeFileSync } from 'node:fs';
import { politeFetch } from '../../workers/shared/http.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const get = async url => JSON.parse(new TextDecoder().decode((await politeFetch(url.replace(/^http:/, 'https:'), { minIntervalMs: 700 })).bytes));
const idOf = ref => (ref || '').match(/\/(teams|athletes)\/(\d+)/)?.[2] || null;

async function events(league, n = 2) {
  const cal = await get(`${CORE}/${league}/events?limit=40&dates=20260801-20260926`);
  return cal.items.slice(0, n).map(i => i.$ref.match(/events\/(\d+)/)[1]);
}

const targets = process.argv.slice(2).length ? process.argv.slice(2).map(a => a.split(':')) : [];
if (!targets.length) for (const lg of ['ger.1', 'eng.1', 'usa.1']) for (const id of await events(lg, 2)) targets.push([lg, id]);

const out = { generated_at: new Date().toISOString(), events: [], samples: {} };
for (const [league, id] of targets) {
  const comp = await get(`${CORE}/${league}/events/${id}/competitions/${id}`);
  if (!comp.status || !(await get(comp.status.$ref)).type?.completed) { out.events.push({ league, id, skipped: 'not completed' }); continue; }
  const side = {};
  for (const c of comp.competitors) side[idOf(c.team.$ref)] = c.homeAway;
  const plays = [];
  for (let page = 1; page <= 3; page++) {
    const p = await get(`${CORE}/${league}/events/${id}/competitions/${id}/plays?limit=1000&page=${page}`);
    plays.push(...p.items);
    if (page >= p.pageCount) break;
  }
  if (!out.samples.play) out.samples.play = plays.find(p => /Shot|Goal/.test(p.type?.text || '')) || plays[0];
  // NB: 'Goal Kick' is not a shot (an earlier version of this probe matched /^Goal/ and misread it).
  const shots = plays.filter(p => /^(Goal( - .*)?|Shot On Target|Shot Off Target|Shot Blocked|Penalty - .*)$/i.test(p.type?.text || '') && !/Goal Kick/i.test(p.type?.text || '') && p.fieldPositionX !== undefined)
    .map(p => ({ type: p.type.text, team: side[idOf(p.team?.$ref)] || null, period: p.period?.number, x: p.fieldPositionX, y: p.fieldPositionY, x2: p.fieldPosition2X, y2: p.fieldPosition2Y, clock: p.clock?.displayValue,
      text_side: /from the left side of the (box|six yard box)|from a difficult angle on the left/i.test(p.text || '') ? 'left' : /from the right side of the (box|six yard box)|from a difficult angle on the right/i.test(p.text || '') ? 'right' : null }));
  const byGroup = {};
  for (const s of shots) {
    const k = `${s.team}_P${s.period}`;
    byGroup[k] = byGroup[k] || { n: 0, mean_x: 0, min_x: 101, max_x: -1 };
    const g = byGroup[k]; g.n += 1; g.mean_x += s.x; g.min_x = Math.min(g.min_x, s.x); g.max_x = Math.max(g.max_x, s.x);
  }
  for (const g of Object.values(byGroup)) g.mean_x = Math.round((g.mean_x / g.n) * 10) / 10;
  const allX = plays.filter(p => p.fieldPositionX !== undefined).map(p => p.fieldPositionX);
  const allY = plays.filter(p => p.fieldPositionY !== undefined).map(p => p.fieldPositionY);
  out.events.push({ league, id, plays: plays.length, x_range: [Math.min(...allX), Math.max(...allX)], y_range: [Math.min(...allY), Math.max(...allY)], shots_by_team_period: byGroup, shots });
  if (!out.samples.roster_entry) {
    const home = comp.competitors.find(c => c.homeAway === 'home');
    const roster = await get(home.roster.$ref);
    out.samples.roster_keys = Object.keys(roster);
    out.samples.roster_entry = roster.entries?.[0];
    const ath = roster.entries?.[0]?.athlete?.$ref;
    if (ath) { const a = await get(ath); out.samples.athlete_keys = Object.keys(a); out.samples.athlete = { id: a.id, uid: a.uid, guid: a.guid, displayName: a.displayName, firstName: a.firstName, lastName: a.lastName, dateOfBirth: a.dateOfBirth, citizenship: a.citizenship, position: a.position?.abbreviation }; }
  }
  console.log(league, id, JSON.stringify(out.events.at(-1).shots_by_team_period));
}
// Verdict: team-relative if, in every event, every team's shots in both halves have mean_x > 50 (or all < 50).
const verdicts = out.events.filter(e => e.shots_by_team_period).map(e => {
  const g = Object.values(e.shots_by_team_period).filter(v => v.n >= 2);
  return g.every(v => v.mean_x > 60) ? 'team_relative_attacking_high_x' : g.every(v => v.mean_x < 40) ? 'team_relative_attacking_low_x' : 'absolute_or_mixed';
});
const allShots = out.events.flatMap(e => e.shots || []);
const left = allShots.filter(s => s.text_side === 'left'); const right = allShots.filter(s => s.text_side === 'right');
const meanY = a => (a.length ? Math.round(a.reduce((n, s) => n + s.y, 0) / a.length * 10) / 10 : null);
out.y_orientation = { left_side_shots: left.length, left_mean_y: meanY(left), left_y_below_50: left.filter(s => s.y < 50).length, right_side_shots: right.length, right_mean_y: meanY(right), right_y_above_50: right.filter(s => s.y > 50).length };
out.y_orientation.conclusion = left.length >= 5 && right.length >= 5
  ? (left.filter(s => s.y > 50).length / left.length > 0.9 && right.filter(s => s.y < 50).length / right.length > 0.9 ? 'y0_is_attacking_right' : left.filter(s => s.y < 50).length / left.length > 0.9 && right.filter(s => s.y > 50).length / right.length > 0.9 ? 'y0_is_attacking_left' : 'inconclusive')
  : 'insufficient_text_evidence';
out.verdict = { per_event: verdicts, conclusion: new Set(verdicts).size === 1 ? verdicts[0] : 'inconsistent', y: out.y_orientation.conclusion };
writeFileSync('docs/evidence/espn-soccer-coordinates.json', JSON.stringify(out, null, 2) + '\n');
console.log('verdict', out.verdict);
