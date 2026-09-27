// Deterministic match-recap composer. Reads ONLY the frozen packet.
// No model, no free text generation: every sentence is a template filled from
// packet fields, and a sentence is omitted when its inputs are missing.
// An LLM editorial pass may be added later, but its output must pass the same
// gates against the same packet (docs/NEWS_ENGINE.md).

import { slugify } from '../../shared/ids.js';

export const COMPOSER = 'template/soccer-recap@1.0.0';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = iso => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const ord = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const list = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

function goalPhrase(g, packet) {
  const who = g.own_goal ? `an own goal by ${g.scorer?.name || 'an unidentified player'}` : g.scorer?.name || 'an unidentified scorer';
  const how = g.penalty ? ' from the penalty spot' : g.free_kick ? ' from a direct free kick' : g.body_part === 'head_or_body' ? ' with a header' : '';
  const assist = g.assist?.name ? `, set up by ${g.assist.name}` : '';
  const team = packet.teams[g.team].name;
  return `${g.display_minute || `${g.minute}'`} ${who}${how}${assist} (${team}, ${g.running_score})`;
}

export function composeMatchRecap(packet) {
  const { match, teams, goals, stats, shares, shot_profile: sp, key_performers: kp } = packet;
  if (match.status !== 'finished') throw new Error('recap composer needs a finished match');
  const H = teams.home; const A = teams.away;
  const score = match.score.final;
  const winner = match.winner === 'draw' ? null : teams[match.winner];
  const loser = match.winner === 'draw' ? null : teams[match.winner === 'home' ? 'away' : 'home'];

  const scorers = new Map();
  for (const g of goals) if (!g.own_goal && g.scorer) scorers.set(g.scorer.name, (scorers.get(g.scorer.name) || 0) + 1);
  const top = [...scorers.entries()].sort((a, b) => b[1] - a[1])[0];
  const hatTrick = top && top[1] === 3 ? top[0] : null;

  const headline = winner
    ? `${winner.name} ${score.split('-').map(Number).sort((a, b) => b - a).join('-')} ${loser.name}${hatTrick ? `: ${hatTrick} hat-trick` : top && top[1] >= 2 ? `: ${top[0]} scores ${top[1]}` : ''}`
    : `${H.name} ${score} ${A.name}${top ? `: ${top[0]} on target` : ''}`;
  const dek = `${match.competition.name} ${match.season}, Matchday ${match.matchday}, ${fmtDate(match.kickoff_utc)}${match.venue ? `, ${match.venue}` : ''}. Half-time ${match.score.half_time}.`;

  const sections = [];
  // RESULT
  const result = [];
  if (winner) result.push(`${winner.name} beat ${loser.name} ${score.split('-').map(Number).sort((a, b) => b - a).join('-')} in ${match.competition.name} Matchday ${match.matchday}${match.venue ? ` at ${match.venue}` : ''}, having led ${match.score.half_time} at half-time.`);
  else result.push(`${H.name} and ${A.name} drew ${score} in ${match.competition.name} Matchday ${match.matchday}${match.venue ? ` at ${match.venue}` : ''}.`);
  sections.push({ key: 'result', heading: 'Result', paragraphs: result });

  // GOALS
  if (goals.length) sections.push({ key: 'goals', heading: 'How the goals came', paragraphs: [goals.map(g => goalPhrase(g, packet)).join('; ') + '.'] });

  // SHOT PROFILE
  const sh = [];
  sh.push(`${H.name} had ${stats.home.shots} shots, ${stats.home.shots_on_target} on target; ${A.name} had ${stats.away.shots}, ${stats.away.shots_on_target} on target.`);
  if (sp.home.avg_shot_distance_m !== null && sp.away.avg_shot_distance_m !== null) {
    sh.push(`${H.name} took ${sp.home.shots_inside_box} of their shots inside the penalty area at an average distance of ${sp.home.avg_shot_distance_m} m from goal; ${A.name} took ${sp.away.shots_inside_box} inside the area at ${sp.away.avg_shot_distance_m} m.`);
  }
  sections.push({ key: 'shots', heading: 'Shot profile', paragraphs: sh });

  // TERRITORY
  const te = [];
  if (shares.completed_pass_share.home !== null) te.push(`${H.name} completed ${stats.home.passes_completed} of ${stats.home.passes} passes (${stats.home.pass_completion_pct}%) against ${A.name}'s ${stats.away.passes_completed} of ${stats.away.passes} (${stats.away.pass_completion_pct}%), a ${shares.completed_pass_share.home}% share of the match's completed passes.`);
  if (shares.attacking_third_event_share.home !== null) te.push(`${shares.attacking_third_event_share.home}% of on-ball events in either attacking third belonged to ${H.name}.`);
  te.push(`Duels: ${H.name} won ${stats.home.duels_won} of ${stats.home.duels}, ${A.name} ${stats.away.duels_won} of ${stats.away.duels}. Corners ${stats.home.corners}-${stats.away.corners}; fouls ${stats.home.fouls_committed}-${stats.away.fouls_committed}.`);
  sections.push({ key: 'territory', heading: 'Territory and control', paragraphs: te });

  // KEY PERFORMERS
  const perf = kp.filter(p => p.goals || p.assists || p.shots_on_target).map(p => {
    const bits = [];
    if (p.goals) bits.push(`${p.goals} goal${p.goals > 1 ? 's' : ''}`);
    if (p.assists) bits.push(`${p.assists} assist${p.assists > 1 ? 's' : ''}`);
    if (p.shots_on_target) bits.push(`${p.shots_on_target} shot${p.shots_on_target > 1 ? 's' : ''} on target`);
    if (p.key_passes) bits.push(`${p.key_passes} key pass${p.key_passes > 1 ? 'es' : ''}`);
    return `${p.name} (${teams[p.team].name}): ${list(bits)}`;
  });
  if (perf.length) sections.push({ key: 'performers', heading: 'Key performers', paragraphs: [perf.join('. ') + '.'] });

  // TABLE
  const tb = [];
  for (const k of ['home', 'away']) {
    const t = teams[k];
    if (t.table_after && t.table_before) {
      const moved = t.table_after.position === t.table_before.position ? `stayed ${ord(t.table_after.position)}` : `moved from ${ord(t.table_before.position)} to ${ord(t.table_after.position)}`;
      tb.push(`${t.name} ${moved} on ${t.table_after.points} points after ${t.table_after.played} matches.`);
    }
    if (t.form_before?.length) tb.push(`${t.name}'s previous ${t.form_before.length} league results: ${t.form_before.join(' ')}.`);
  }
  if (tb.length) sections.push({ key: 'table', heading: 'Table impact and form', paragraphs: tb });

  sections.push({
    key: 'method', heading: 'Evidence and method',
    paragraphs: [
      `Every figure above comes from the frozen evidence packet for this match (${packet.version}, hash ${packet.hash.slice(0, 12)}). Counts are derived from the event ledger (${packet.derivation.counts}); shot distance is ${packet.derivation.distance}. Not reported: ${packet.unavailable.join('; ')}.`,
      ...packet.provenance.attributions,
    ],
  });

  const entities = [
    { type: 'SportsTeam', id: H.id, name: H.name, slug: H.slug, href: `/teams/${H.slug}` },
    { type: 'SportsTeam', id: A.id, name: A.name, slug: A.slug, href: `/teams/${A.slug}` },
    { type: 'SportsEvent', id: match.id, name: `${H.name} v ${A.name}`, href: `/matches/${match.id}` },
    { type: 'SportsOrganization', name: match.competition.name, slug: match.competition.slug, href: `/competitions/${match.competition.slug}` },
    ...uniqueBy([...goals.flatMap(g => [g.scorer, g.assist]), ...kp].filter(Boolean), p => p.id).map(p => ({ type: 'Person', id: p.id, name: p.name, slug: p.slug, href: `/players/${p.slug}` })),
  ];
  const slug = slugify(`${H.name} ${A.name} ${match.kickoff_utc.slice(0, 10)} recap`);
  return { slug, headline, dek, sections, entities, composer: COMPOSER, desk: match.competition.slug, story_class: 'match_recap' };
}

function uniqueBy(xs, f) { const seen = new Set(); return xs.filter(x => { const k = f(x); if (!k || seen.has(k)) return false; seen.add(k); return true; }); }
