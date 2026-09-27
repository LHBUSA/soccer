// Deterministic composers for the four current story classes. Read ONLY the frozen
// packet. No free generation: every sentence is a template over packet fields and
// is omitted when an input is missing. Wording follows the competition profile
// (e.g. MLS says "overall standings", never relegation or European places).
import { slugify } from '../../shared/ids.js';

export const COMPOSER_V2 = 'template/soccer-news@2.0.0';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = iso => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const ord = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const list = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const DESK = { 'premier-league': 'premier-league', bundesliga: 'bundesliga', mls: 'mls', 'uefa-champions-league': 'champions-league' };
const standingsWord = p => (p.competition.slug === 'mls' ? 'overall MLS standings' : `${p.competition.name} table`);
const method = (p, extra = '') => ({ key: 'method', heading: 'Evidence and method', paragraphs: [
  `Every figure in this story comes from its frozen evidence packet (${p.version}, profile ${p.event.profile}, hash ${p.hash.slice(0, 12)}).${extra} Not reported: ${p.unavailable.join('; ')}.`,
  ...p.provenance.attributions,
] });
const teamEntity = t => ({ type: 'SportsTeam', id: t.id, name: t.name, slug: t.slug, href: `/teams/${t.slug}` });
const compEntity = p => ({ type: 'SportsOrganization', name: p.competition.name, slug: p.competition.slug, href: `/competitions/${p.competition.slug}` });
const uniq = xs => { const s = new Set(); return xs.filter(x => { const k = x.id || x.slug; if (!k || s.has(k)) return false; s.add(k); return true; }); };
const finish = (p, a) => ({ ...a, desk: DESK[p.competition.slug], story_class: p.event.kind, composer: COMPOSER_V2, slug: slugify(`${a.slug_base} ${p.hash.slice(0, 6)}`) });

export function compose(p) {
  if (p.event.kind === 'match_recap') return finish(p, recap(p));
  if (p.event.kind === 'team_trend') return finish(p, trend(p));
  if (p.event.kind === 'player_form') return finish(p, form(p));
  if (p.event.kind === 'competition_intelligence') return finish(p, race(p));
  throw new Error(`no composer for ${p.event.kind}`);
}

function recap(p) {
  const { match: m, teams: T } = p;
  const H = T.home; const A = T.away;
  const W = m.winner === 'draw' ? null : T[m.winner]; const L = m.winner === 'draw' ? null : T[m.winner === 'home' ? 'away' : 'home'];
  const hi = Math.max(m.score.home, m.score.away); const lo = Math.min(m.score.home, m.score.away);
  const scorers = new Map();
  for (const g of p.goals) if (!g.own_goal && g.scorer) scorers.set(g.scorer.id, { ...g.scorer, n: (scorers.get(g.scorer.id)?.n || 0) + 1 });
  const top = [...scorers.values()].sort((a, b) => b.n - a.n)[0];
  const leader = p.angles.find(a => a.key === 'leader_change' || a.key === 'overall_leader_change');
  const tail = top?.n === 3 ? `: ${top.name} hat-trick` : top?.n >= 2 ? `: ${top.name} scores ${top.n}` : '';
  const goTop = leader && W && leader.detail.new_leader === W.id ? ` to go top of the ${p.competition.slug === 'mls' ? 'overall MLS standings' : p.competition.name}` : '';
  const headline = W
    ? (m.winner === 'home' ? `${W.name} beat ${L.name} ${hi}-${lo}${goTop}${goTop ? '' : tail}` : `${W.name} win ${hi}-${lo} at ${L.name}${goTop}${goTop ? '' : tail}`)
    : `${H.name} and ${A.name} draw ${m.score.final}${tail}`;
  const ht = m.score.home_ht !== null && m.score.away_ht !== null;
  const dek = `${p.competition.name} ${p.competition.season}, ${fmtDate(m.kickoff_utc)}${m.venue ? `, ${m.venue}` : ''}.${ht ? ` Half-time ${m.score.home_ht}-${m.score.away_ht}.` : ''}`;
  const sections = [];
  sections.push({ key: 'result', heading: 'Result', paragraphs: [W
    ? `${W.name} beat ${L.name} ${hi}-${lo}${m.venue ? ` at ${m.venue}` : ''}${ht ? `, having been ${(m.winner === 'home' ? m.score.home_ht - m.score.away_ht : m.score.away_ht - m.score.home_ht) < 0 ? 'behind' : (m.score.home_ht === m.score.away_ht ? 'level' : 'ahead')} ${m.score.home_ht}-${m.score.away_ht} at half-time` : ''}.`
    : `${H.name} and ${A.name} drew ${m.score.final}${m.venue ? ` at ${m.venue}` : ''}.`] });
  if (p.goals.length) sections.push({ key: 'goals', heading: 'Goals', paragraphs: [`${p.goals.map(g => `${g.display_minute || `${g.minute}'`} ${g.own_goal ? `own goal by ${g.scorer?.name || 'an unidentified player'}` : g.scorer?.name || 'unidentified scorer'}${g.penalty ? ' (penalty)' : ''} for ${T[g.team].name}, ${g.running_score}`).join('; ')}.`] });
  const why = [];
  for (const a of p.angles) {
    const d = a.detail;
    if (a.key === 'leader_change' || a.key === 'overall_leader_change') why.push(`The result put ${d.new_leader_team.name} top of the ${standingsWord(p)}.`);
    if (a.key === 'title_race_swing') why.push(`The gap at the top of the table went from ${plural(d.gap_before, 'point')} to ${plural(d.gap_after, 'point')}.`);
    if (a.key === 'top4_entry_exit') why.push(`${d.team.name} moved from ${ord(d.from)} to ${ord(d.to)}, ${d.to <= 4 ? 'into' : 'out of'} the top four, and are still ${d.to <= 4 ? 'in' : 'outside'} it.`);
    if (a.key === 'relegation_zone_move') why.push(`${d.team.name} moved from ${ord(d.from)} to ${ord(d.to)}, ${d.to > d.from ? 'into' : 'out of'} the bottom three, and are still ${d.to > d.from ? 'in' : 'out of'} it.`);
    if (a.key === 'upset') why.push(`${W.name} started the day ${ord(d.winner_position_before)} and ${L.name} ${ord(d.loser_position_before)}.`);
    if (a.key === 'comeback_from_ht') why.push(`${W.name} trailed ${d.half_time} at half-time and won.`);
    if (a.key === 'multi_goal_scorer' && d.player) why.push(`${d.player.name} scored ${d.goals}.`);
    if (a.key === 'winning_streak') why.push(`${d.team.name} have now won ${d.run} league matches in a row.`);
    if (a.key === 'unbeaten_run_ended') why.push(`${d.team.name} had gone ${d.run} league matches without defeat before this.`);
    if (a.key === 'high_scoring') why.push(`The match produced ${d.goals} goals.`);
    if (a.key === 'heavy_margin') why.push(`The winning margin was ${d.margin} goals.`);
  }
  if (why.length) sections.push({ key: 'angle', heading: 'Why it matters', paragraphs: [why.join(' ')] });
  const sh = [];
  if (p.stats && p.stats.home.shots !== undefined && p.stats.away.shots !== undefined) {
    sh.push(`${H.name} had ${p.stats.home.shots} shots${p.stats.home.shots_on_target !== undefined ? ` (${p.stats.home.shots_on_target} on target)` : ''}; ${A.name} had ${p.stats.away.shots}${p.stats.away.shots_on_target !== undefined ? ` (${p.stats.away.shots_on_target} on target)` : ''}.`);
    if (p.stats.home.corners !== undefined && p.stats.away.corners !== undefined) sh.push(`Corners ${p.stats.home.corners}-${p.stats.away.corners}.`);
  }
  if (p.shots_located && p.shots_located.avg_distance_m.home !== null && p.shots_located.avg_distance_m.away !== null) sh.push(`Average distance of located shots from goal: ${H.name} ${p.shots_located.avg_distance_m.home} m, ${A.name} ${p.shots_located.avg_distance_m.away} m.`);
  if (sh.length) sections.push({ key: 'shots', heading: 'Shots', paragraphs: sh });
  const tb = [];
  for (const k of ['home', 'away']) {
    const t = T[k];
    if (t.table_after && t.table_before) tb.push(`${t.name} ${t.table_after.position === t.table_before.position ? `stayed ${ord(t.table_after.position)}` : `moved from ${ord(t.table_before.position)} to ${ord(t.table_after.position)}`} in the ${standingsWord(p)} after the match, on ${plural(t.table_after.points, 'point')} from ${plural(t.table_after.played, 'match', 'matches')}.`);
    if (t.form_before?.length) tb.push(`${t.name}'s previous ${t.form_before.length} league results: ${t.form_before.join(' ')}.`);
  }
  if (tb.length) sections.push({ key: 'table', heading: p.competition.slug === 'mls' ? 'Standings and form' : 'Table and form', paragraphs: tb });
  sections.push(method(p, p.stats ? ` Team statistics are ${p.stats.basis === 'source' ? 'source facts, not PropBetEdge metrics' : 'PropBetEdge counts from the event ledger'}.` : ''));
  const entities = uniq([teamEntity(H), teamEntity(A), { type: 'SportsEvent', id: m.id, name: `${H.name} v ${A.name}`, href: `/matches/${m.id}` }, compEntity(p),
    ...p.goals.map(g => g.scorer).filter(Boolean).map(s => ({ type: 'Person', id: s.id, name: s.name, slug: s.slug, href: `/players/${s.slug}` }))]);
  return { headline, dek, sections, entities, slug_base: `${H.name} ${A.name} ${m.kickoff_utc.slice(0, 10)}` };
}

const TREND_WORD = { winning_run: ['win', 'league wins in a row'], unbeaten_run: ['unbeaten', 'league matches unbeaten'], losing_run: ['defeat', 'league defeats in a row'], winless_run: ['winless', 'league matches without a win'] };
function trend(p) {
  const t = p.team; const tr = p.trend; const [, phrase] = TREND_WORD[tr.kind];
  const headline = `${t.name} make it ${tr.matches} ${p.competition.slug === 'mls' ? 'MLS' : p.competition.name} ${phrase.replace(/^league /, '')}`;
  const dek = `${p.competition.name} ${p.competition.season}. ${tr.wins} won, ${tr.draws} drawn, ${tr.losses} lost; goals ${tr.goals_for}-${tr.goals_against} across the run.`;
  const sections = [
    { key: 'run', heading: 'The run', paragraphs: [`${t.name} have ${tr.kind === 'winning_run' ? 'won' : tr.kind === 'losing_run' ? 'lost' : tr.kind === 'unbeaten_run' ? 'avoided defeat in' : 'failed to win'} their last ${tr.matches} league matches, scoring ${tr.goals_for} and conceding ${tr.goals_against}.`] },
    { key: 'results', heading: 'Results', paragraphs: [`${tr.games.map(g => `${g.date}: ${g.result} ${g.goals_for}-${g.goals_against} ${g.venue === 'home' ? 'v' : 'at'} ${g.opponent.name}`).join('; ')}.`] },
  ];
  if (t.table_now) sections.push({ key: 'table', heading: 'Where it leaves them', paragraphs: [`${t.name} are ${ord(t.table_now.position)} of ${p.teams_in_table} in the ${standingsWord(p)} on ${plural(t.table_now.points, 'point')} from ${plural(t.table_now.played, 'match', 'matches')}.`] });
  sections.push(method(p));
  return { headline, dek, sections, entities: uniq([teamEntity(t), compEntity(p), ...tr.games.map(g => teamEntity(g.opponent))]), slug_base: `${t.name} ${tr.matches} ${phrase} ${p.event.as_of.slice(0, 10)}` };
}

function form(p) {
  const pl = p.player; const f = p.form;
  const headline = `${pl.name} has scored in ${f.consecutive_scoring_appearances} straight ${p.competition.slug === 'mls' ? 'MLS' : p.competition.name} appearances`;
  const dek = `${plural(f.goals_in_run, 'goal')} in ${f.consecutive_scoring_appearances} consecutive appearances for ${p.team.name} (${p.competition.season}).`;
  const sections = [
    { key: 'run', heading: 'The run', paragraphs: [`${pl.name} has scored in ${f.consecutive_scoring_appearances} consecutive ${p.competition.slug === 'mls' ? 'MLS' : p.competition.name} appearances for ${p.team.name}, with ${plural(f.goals_in_run, 'goal')} in total.`] },
    { key: 'matches', heading: 'Match by match', paragraphs: [`${f.appearances.map(a => `${a.date} v ${a.opponent.name} (${a.score}): ${plural(a.goals, 'goal')}, ${a.started ? 'started' : 'came on'}`).join('; ')}.`] },
    { key: 'context', heading: 'Context', paragraphs: [`Appearances are counted from sourced lineups (started or came on); goals from the match event data, one source per match.`] },
  ];
  sections.push(method(p));
  return { headline, dek, sections, entities: uniq([{ type: 'Person', id: pl.id, name: pl.name, slug: pl.slug, href: `/players/${pl.slug}` }, teamEntity(p.team), compEntity(p), ...f.appearances.map(a => teamEntity(a.opponent))]), slug_base: `${pl.name} scoring run ${p.event.as_of.slice(0, 10)}` };
}

function race(p) {
  const tb = p.table; const [first, second] = tb.top;
  const mls = p.competition.slug === 'mls';
  const headline = tb.leader_gap > 0 ? `${first.team.name} lead the ${mls ? 'overall MLS standings' : p.competition.name} by ${plural(tb.leader_gap, 'point')}` : `${first.team.name} and ${second.team.name} level on ${first.points} points at the top of the ${mls ? 'overall MLS standings' : p.competition.name}`;
  const dek = `${p.competition.name} ${p.competition.season}: the ${mls ? 'standings' : 'table'} after ${plural(p.round.results_counted, 'result')} this week.`;
  const sections = [
    { key: 'top', heading: mls ? 'Top of the overall standings' : 'Top of the table', paragraphs: [`${tb.top.map(r => `${ord(r.position)} ${r.team.name}, ${plural(r.points, 'point')} from ${plural(r.played, 'match', 'matches')} (goal difference ${r.goal_difference > 0 ? '+' : ''}${r.goal_difference})`).join('; ')}.`] },
    { key: 'results', heading: 'This week’s results', paragraphs: [`${p.round.results.map(r => `${r.home.name} ${r.score} ${r.away.name}`).join('; ')}.`] },
  ];
  if (tb.bottom.length) sections.push({ key: 'bottom', heading: 'Bottom three', paragraphs: [`${tb.bottom.map(r => `${ord(r.position)} ${r.team.name}, ${plural(r.points, 'point')}`).join('; ')}.`] });
  if (mls) sections.push({ key: 'format', heading: 'How MLS standings are read here', paragraphs: [`This is the single overall table across both conferences, ordered by points, then wins, then goal difference, then goals for. Conference standings are not stored.`] });
  sections.push(method(p, ` Table order: ${tb.tiebreak === 'mls' ? 'points, wins, goal difference, goals for' : 'points, goal difference, goals for'}.`));
  return { headline, dek, sections, entities: uniq([compEntity(p), ...tb.top.map(r => teamEntity(r.team)), ...tb.bottom.map(r => teamEntity(r.team)), ...p.round.results.flatMap(r => [teamEntity(r.home), teamEntity(r.away)])]), slug_base: `${p.competition.name} table ${p.event.as_of.slice(0, 10)}` };
}
