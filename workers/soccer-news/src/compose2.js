// Deterministic composers for the four current story classes. Read ONLY the frozen
// packet. No free generation: every sentence is a template over packet fields and
// is omitted when an input is missing. Wording follows the competition profile
// (e.g. MLS says "overall standings", never relegation or European places).
import { slugify } from '../../shared/ids.js';
import { markPrimary, primaryFromPacket } from '../../shared/news-subject.js';

export const COMPOSER_V2 = 'template/soccer-news@2.1.0';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const fmtDate = iso => { const d = new Date(iso); return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; };
const ord = n => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
const plural = (n, w, p = `${w}s`) => `${n} ${n === 1 ? w : p}`;
const list = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const DESK = { 'premier-league': 'premier-league', 'la-liga': 'la-liga', 'serie-a': 'serie-a', 'ligue-1': 'ligue-1', bundesliga: 'bundesliga', mls: 'mls', 'uefa-champions-league': 'champions-league', 'uefa-europa-league': 'europa-league', 'uefa-nations-league': 'international', 'fifa-world-cup': 'fifa' };
const standingsWord = p => (p.competition.slug === 'mls' ? 'overall MLS standings' : `${p.competition.name} table`);
const method = (p, extra = '') => ({ key: 'method', heading: 'Evidence and method', paragraphs: [
  ...(p.event.corrects ? [/own goal/i.test(p.event.corrects.reason || '') ? 'Correction: this story replaces an earlier version that was withdrawn because an own goal was credited to the wrong side. The goal sequence now reproduces the recorded result.' : 'Correction: this story replaces an earlier version that was withdrawn after an error was found.'] : []),
  `Every figure in this story comes from its frozen evidence packet (${p.version}, profile ${p.event.profile}, hash ${p.hash.slice(0, 12)}).${extra} Not reported: ${p.unavailable.join('; ')}.`,
  ...p.provenance.attributions,
] });
const teamEntity = t => ({ type: 'SportsTeam', id: t.id, name: t.name, slug: t.slug, href: `/teams/${t.slug}` });
const compEntity = p => ({ type: 'SportsOrganization', name: p.competition.name, slug: p.competition.slug, href: `/competitions/${p.competition.slug}` });
const uniq = xs => { const s = new Set(); return xs.filter(x => { const k = x.id || x.slug; if (!k || s.has(k)) return false; s.add(k); return true; }); };
// The primary subject (news-subject.js) is marked on the entities from the packet's material event.
const finish = (p, a) => ({ ...a, entities: markPrimary(a.entities, primaryFromPacket(p)), desk: DESK[p.competition.slug], story_class: p.event.kind, composer: COMPOSER_V2, slug: slugify(`${a.slug_base} ${p.hash.slice(0, 6)}`) });

export function compose(p) {
  if (p.event.kind === 'match_recap') return finish(p, recap(p));
  if (p.event.kind === 'team_trend') return finish(p, trend(p));
  if (p.event.kind === 'player_form') return finish(p, form(p));
  if (p.event.kind === 'match_preview') return finish(p, p.preview_kind === 'matchday' ? matchday(p) : preview(p));
  if (p.event.kind === 'competition_intelligence' && p.brief === 'group_watch') return finish(p, groupWatch(p));
  if (p.event.kind === 'competition_intelligence') return finish(p, race(p));
  throw new Error(`no composer for ${p.event.kind}`);
}

function standingSentence(p, t) {
  const g = t.group;
  if (g?.verified) {
    const where = g.group_type === 'league_phase' ? 'the league phase' : `the ${g.group}`;
    return `${t.name} ${g.group_type === 'league_phase' ? 'are' : 'sit'} ${ord(g.position)} of ${g.teams_in_group} in ${where} on ${plural(g.points, 'point')} from ${plural(g.played, 'match', 'matches')}${g.zone ? `, a position the published standings mark as: ${g.zone}` : ''}.`;
  }
  if (t.table_after && t.table_before) return `${t.name} ${t.table_after.position === t.table_before.position ? `stayed ${ord(t.table_after.position)}` : `moved from ${ord(t.table_before.position)} to ${ord(t.table_after.position)}`} in the ${standingsWord(p)} after the match, on ${plural(t.table_after.points, 'point')} from ${plural(t.table_after.played, 'match', 'matches')}.`;
  return null;
}
const nextSentence = t => (t.next ? `${t.name}: ${t.next.venue === 'home' ? 'v' : 'at'} ${t.next.opponent.name}, ${fmtDate(t.next.date)}.` : null);

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
  // 1. What happened: the result, then the goals as one flowing sentence.
  const what = [W ? `${W.name} beat ${L.name} ${hi}-${lo}${m.venue ? ` at ${m.venue}` : ''}${ht ? `, having been ${(m.winner === 'home' ? m.score.home_ht - m.score.away_ht : m.score.away_ht - m.score.home_ht) < 0 ? 'behind' : (m.score.home_ht === m.score.away_ht ? 'level' : 'ahead')} ${m.score.home_ht}-${m.score.away_ht} at half-time` : ''}.` : `${H.name} and ${A.name} drew ${m.score.final}${m.venue ? ` at ${m.venue}` : ''}.`];
  if (p.goals.length) what.push(`${p.goals.map(g => `${g.display_minute || `${g.minute}'`} ${g.own_goal ? `an own goal by ${g.scorer?.name || 'an unidentified player'}` : g.scorer?.name || 'an unidentified scorer'}${g.penalty ? ' (penalty)' : ''}${g.assist ? `, set up by ${g.assist.name}` : ''} for ${T[g.team].name} (${g.running_score})`).join('; ')}.`);
  sections.push({ key: 'result', heading: 'What happened', paragraphs: what });
  // 2. Why it mattered
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
  if (why.length) sections.push({ key: 'angle', heading: 'Why it mattered', paragraphs: [why.join(' ')] });
  // 3. The numbers
  const sh = [];
  if (p.stats && p.stats.home.shots !== undefined && p.stats.away.shots !== undefined) {
    sh.push(`${H.name} had ${p.stats.home.shots} shots${p.stats.home.shots_on_target !== undefined ? ` (${p.stats.home.shots_on_target} on target)` : ''}; ${A.name} had ${p.stats.away.shots}${p.stats.away.shots_on_target !== undefined ? ` (${p.stats.away.shots_on_target} on target)` : ''}.`);
    if (p.stats.home.possession_pct !== undefined && p.stats.away.possession_pct !== undefined) sh.push(`Possession as recorded by the source: ${p.stats.home.possession_pct}% to ${p.stats.away.possession_pct}%.`);
    if (p.stats.home.corners !== undefined && p.stats.away.corners !== undefined) sh.push(`Corners ${p.stats.home.corners}-${p.stats.away.corners}.`);
  }
  if (p.shots_located && p.shots_located.avg_distance_m.home !== null && p.shots_located.avg_distance_m.away !== null) sh.push(`Average distance of located shots from goal: ${H.name} ${p.shots_located.avg_distance_m.home} m, ${A.name} ${p.shots_located.avg_distance_m.away} m.`);
  if (sh.length) sections.push({ key: 'shots', heading: 'The numbers', paragraphs: sh });
  // 4. Decisive players
  if (p.decisive?.length) sections.push({ key: 'players', heading: 'Decisive players', paragraphs: [`${p.decisive.map(r => `${r.player.name} (${T[r.team].name}): ${[r.goals ? plural(r.goals, 'goal') : null, r.assists ? plural(r.assists, 'assist') : null, r.shots ? `${plural(r.shots, 'shot')}${r.shots_on_target ? ` (${r.shots_on_target} on target)` : ''}` : null].filter(Boolean).join(', ')}`).join('. ')}.`] });
  // 5. Standings context (verified group table where it exists, else the after-match table)
  const tb = [];
  for (const k of ['home', 'away']) {
    const t = T[k];
    const s = standingSentence(p, t); if (s) tb.push(s);
    if (!t.group?.verified && t.form_before?.length) tb.push(`${t.name}'s previous ${t.form_before_count ?? t.form_before.length} league results: ${t.form_before.join(' ')}.`);
  }
  if (tb.length) sections.push({ key: 'table', heading: 'Where it leaves them', paragraphs: tb });
  // 6. What comes next
  const nx = [nextSentence(H), nextSentence(A)].filter(Boolean);
  if (nx.length) sections.push({ key: 'next', heading: 'What comes next', paragraphs: nx });
  sections.push(method(p, `${p.stats ? ` Team statistics are ${p.stats.basis === 'source' ? 'source facts, not PropBetEdge metrics' : 'PropBetEdge counts from the event ledger'}.` : ''}${[H, A].some(t => t.group?.verified) ? ' Group positions come from the published standings and were verified against PropBetEdge canonical results when this story was built.' : ''}`));
  const entities = uniq([teamEntity(H), teamEntity(A), { type: 'SportsEvent', id: m.id, name: `${H.name} v ${A.name}`, href: `/matches/${m.id}` }, compEntity(p),
    ...p.goals.flatMap(g => [g.scorer, g.assist]).filter(Boolean).map(s => ({ type: 'Person', id: s.id, name: s.name, slug: s.slug, href: `/players/${s.slug}` })),
    ...(p.decisive || []).map(r => ({ type: 'Person', id: r.player.id, name: r.player.name, slug: r.player.slug, href: `/players/${r.player.slug}` })),
    ...[H.next, A.next].filter(Boolean).map(n => teamEntity(n.opponent))]);
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
  const d = p.dna;
  if (d && d.goals_for_per_match !== null && d.goals_against_per_match !== null) {
    const ranks = [d.percentiles.goals_against_per_match !== null ? `p${d.percentiles.goals_against_per_match} for goals conceded` : null, d.percentiles.goals_for_per_match !== null ? `p${d.percentiles.goals_for_per_match} for goals scored` : null].filter(Boolean);
    sections.push({ key: 'profile', heading: 'Season profile', paragraphs: [`Across ${plural(d.matches, 'match', 'matches')} this season they average ${d.goals_for_per_match} goals scored and ${d.goals_against_per_match} conceded per match${d.clean_sheet_pct !== null ? `, with clean sheets in ${d.clean_sheet_pct}% of them` : ''}.${ranks.length ? ` Among the ${d.teams_compared} teams, that is ${ranks.join(' and ')} (Team DNA percentiles; higher is better).` : ''}`] });
  }
  if (t.table_now) sections.push({ key: 'table', heading: 'Where it leaves them', paragraphs: [`${t.name} are ${ord(t.table_now.position)} of ${p.teams_in_table} in the ${standingsWord(p)} on ${plural(t.table_now.points, 'point')} from ${plural(t.table_now.played, 'match', 'matches')}.`] });
  if (t.next) sections.push({ key: 'next', heading: 'What comes next', paragraphs: [nextSentence(t)] });
  sections.push(method(p, d ? ` Team DNA uses only matches before ${d.as_of.slice(0, 10)}.` : ''));
  return { headline, dek, sections, entities: uniq([teamEntity(t), compEntity(p), ...tr.games.map(g => teamEntity(g.opponent)), ...(t.next ? [teamEntity(t.next.opponent)] : [])]), slug_base: `${t.name} ${tr.matches} ${phrase} ${p.event.as_of.slice(0, 10)}` };
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

// ---------------- previews (forward-looking; never a prediction) ----------------
const compShort = p => (p.competition.slug === 'mls' ? 'MLS' : p.competition.name);
const eventEntity = (id, H, A) => ({ type: 'SportsEvent', id, name: `${H.name} v ${A.name}`, href: `/matches/${id}` });
const personEntity = pl => ({ type: 'Person', id: pl.id, name: pl.name, slug: pl.slug, href: `/players/${pl.slug}` });
const RESULT_WORD = { W: 'won', D: 'drew', L: 'lost' };
function standingLine(p, t) {
  const g = t.group;
  if (g?.verified) return `${t.name} sit ${ord(g.position)} of ${g.teams_in_group} in ${g.group_type === 'league_phase' ? 'the league phase' : `the ${g.group}`} on ${plural(g.points, 'point')} from ${plural(g.played, 'match', 'matches')}${g.zone ? `, a position the published standings mark as: ${g.zone}` : ''}.`;
  if (t.table_now) return `${t.name} go into the match ${ord(t.table_now.position)} in the ${standingsWord(p)}, with ${plural(t.table_now.points, 'point')} from ${plural(t.table_now.played, 'match', 'matches')}.`;
  return null;
}
function formLine(p, t) {
  const f = t.recent_form; if (!f?.played) return null;
  const last = f.results[0];
  return `${t.name} have ${plural(f.won, 'win')}, ${plural(f.drawn, 'draw')} and ${plural(f.lost, 'defeat')} from their last ${plural(f.played, `${compShort(p)} match`, `${compShort(p)} matches`)} (goals ${f.goals}); most recently they ${RESULT_WORD[last.result]} ${last.score} ${last.venue === 'home' ? 'at home to' : 'away to'} ${last.opponent.name} on ${fmtDate(last.date)}.`;
}

function preview(p) {
  const { fixture: f, teams: T } = p; const H = T.home; const A = T.away;
  const angle = [...p.angles].sort((a, b) => b.weight - a.weight)[0];
  const d = angle?.detail || {};
  const lead = d.team ? (d.team.id === H.id ? H : A) : null;
  const tail = !angle ? 'preview'
    : angle.key === 'top_table_meeting' ? `${ord(d.home_position)} meets ${ord(d.away_position)} in the ${standingsWord(p)}`
    : angle.key === 'bottom_meeting' ? `${ord(d.home_position)} meets ${ord(d.away_position)} at the foot of the ${standingsWord(p)}`
    : angle.key === 'group_top_meeting' ? `the top two in ${d.group} meet`
    : angle.key === 'leader_in_action' && lead ? `${lead.name} put first place in the ${standingsWord(p)} on the line`
    : angle.key === 'group_leader_in_action' && lead ? `${lead.name} go in first in ${d.group}`
    : angle.key === 'player_scoring_run' && d.player ? `${d.player.name} brings a ${d.matches}-match scoring run`
    : angle.key === 'winning_run' && lead ? `${lead.name} bring ${plural(d.run, 'straight win')}`
    : angle.key === 'unbeaten_run' && lead ? `${lead.name} unbeaten in ${d.run}`
    : angle.key === 'losing_run' && lead ? `${lead.name} look to end a run of ${plural(d.run, 'defeat')}`
    : 'preview';
  const headline = `${H.name} v ${A.name}: ${tail}`;
  const dek = `${p.competition.name} ${p.competition.season}. Kick-off ${fmtDate(f.kickoff_date)} at ${f.kickoff_time_utc} UTC${f.venue ? `, ${f.venue}` : ''}.`;
  const sections = [{ key: 'fixture', heading: 'The fixture', paragraphs: [`${H.name} host ${A.name}${f.venue ? ` at ${f.venue}` : ''} on ${fmtDate(f.kickoff_date)}, kick-off ${f.kickoff_time_utc} UTC.`] }];
  const st = [standingLine(p, H), standingLine(p, A)].filter(Boolean);
  if (st.length) sections.push({ key: 'standing', heading: 'Where they stand', paragraphs: st });
  const fm = [formLine(p, H), formLine(p, A)].filter(Boolean);
  if (fm.length) sections.push({ key: 'form', heading: 'Recent form', paragraphs: fm });
  if (p.players_in_form?.length) sections.push({ key: 'players', heading: 'Players in form', paragraphs: [`${p.players_in_form.map(x => `${x.player.name} (${T[x.team].name}) has scored in ${x.consecutive_scoring_appearances} consecutive appearances, with ${plural(x.goals_in_run, 'goal')} in that run`).join('; ')}.`] });
  if (p.meetings_this_season?.length) sections.push({ key: 'meetings', heading: 'Earlier this season', paragraphs: [`${p.meetings_this_season.map(x => `${fmtDate(x.date)}: ${x.home.name} ${x.score} ${x.away.name}`).join('; ')}.`] });
  sections.push(method(p, ' This is a preview: it states only facts known before kick-off and makes no prediction.'));
  const entities = uniq([teamEntity(H), teamEntity(A), eventEntity(f.id, H, A), compEntity(p), ...(p.players_in_form || []).map(x => personEntity(x.player)), ...(p.meetings_this_season || []).flatMap(x => [teamEntity(x.home), teamEntity(x.away)])]);
  return { headline, dek, sections, entities, slug_base: `${H.name} ${A.name} preview ${f.kickoff_date}` };
}

function matchday(p) {
  const fx = p.fixtures; const n = fx.length;
  const headline = `${compShort(p)} matchday: ${plural(n, 'fixture')} on ${fmtDate(p.day)}`;
  const dek = `${p.competition.name} ${p.competition.season}. Kick-offs from ${fx[0].kickoff_time_utc} to ${fx[n - 1].kickoff_time_utc} UTC.`;
  const pos = t => (t.group?.verified ? `${ord(t.group.position)} in ${t.group.group_type === 'league_phase' ? 'the league phase' : t.group.group}` : t.table_now ? ord(t.table_now.position) : null);
  const sections = [
    { key: 'fixtures', heading: 'The fixtures', paragraphs: [`${fx.map(x => `${x.kickoff_time_utc} UTC, ${x.home.name} v ${x.away.name}${x.venue ? ` at ${x.venue}` : ''}`).join('; ')}.`] },
    { key: 'stakes', heading: 'Standings at stake', paragraphs: [`${fx.filter(x => pos(x.home) && pos(x.away)).map(x => `${x.home.name} (${pos(x.home)}) v ${x.away.name} (${pos(x.away)})`).join('; ')}.`] },
  ];
  if (p.table_top?.length) sections.push({ key: 'top', heading: p.competition.slug === 'mls' ? 'Top of the overall standings' : 'Top of the table', paragraphs: [`${p.table_top.map(r => `${ord(r.position)} ${r.team.name}, ${plural(r.points, 'point')} from ${plural(r.played, 'match', 'matches')}`).join('; ')}.`] });
  else {
    const groups = [...new Map(fx.flatMap(x => [x.home.group, x.away.group]).filter(g => g?.verified).map(g => [g.group, g])).keys()];
    if (groups.length) sections.push({ key: 'groups', heading: 'Groups in play', paragraphs: [`The day's fixtures involve ${list(groups)}. Every position above comes from published standings that match PropBetEdge canonical results.`] });
  }
  const form = [...(p.teams_on_runs || []).map(r => (r.winning_run >= 3 ? `${r.team.name} have won ${r.winning_run} league matches in a row` : r.unbeaten_run >= 6 ? `${r.team.name} are unbeaten in ${r.unbeaten_run} league matches` : `${r.team.name} have lost ${r.losing_run} league matches in a row`)),
    ...(p.players_in_form || []).map(x => `${x.player.name} (${x.team.name}) has scored in ${x.consecutive_scoring_appearances} consecutive appearances`)];
  if (form.length) sections.push({ key: 'form', heading: 'Form to watch', paragraphs: [`${form.join('; ')}.`] });
  sections.push(method(p, ' This is a preview: it states only facts known before kick-off and makes no prediction.'));
  const entities = uniq([compEntity(p), ...fx.flatMap(x => [teamEntity(x.home), teamEntity(x.away), eventEntity(x.match_id, x.home, x.away)]), ...(p.players_in_form || []).map(x => personEntity(x.player))]);
  return { headline, dek, sections, entities, slug_base: `${p.competition.name} matchday ${p.day}` };
}

// Verified group tables (Nations League groups, UCL league phase). Unverified groups are not in the packet.
function groupWatch(p) {
  const G = p.groups; const one = G.length === 1;
  const headline = one ? `${G[0].leader.team.name} lead the ${p.competition.name} league phase on ${plural(G[0].leader.points, 'point')}`
    : `${p.competition.name}: the group leaders after ${plural(p.round.results_counted, 'result')} this week`;
  const dek = `${p.competition.name} ${p.competition.season}: ${one ? 'the league phase' : plural(G.length, 'group table')} as published and verified against PropBetEdge canonical results.`;
  const name = g => `${g.name}${g.tier ? ` (${g.tier})` : ''}`;
  const sections = [
    { key: 'leaders', heading: one ? 'The leading places' : 'Group leaders', paragraphs: [one
      ? `${G[0].rows.slice(0, 8).map(r => `${ord(r.position)} ${r.team.name}, ${plural(r.points, 'point')} from ${plural(r.played, 'match', 'matches')}`).join('; ')}.`
      : `${G.map(g => `${name(g)}: ${g.leader.team.name}, ${plural(g.leader.points, 'point')} from ${plural(g.leader.played, 'match', 'matches')}`).join('; ')}.`] },
  ];
  const close = G.filter(g => g.gap_top_two !== null && g.gap_top_two <= 1);
  if (close.length) sections.push({ key: 'close', heading: 'Level or within a point', paragraphs: [`${close.map(g => (g.gap_top_two === 0 ? `${name(g)}: ${g.rows[0].team.name} and ${g.rows[1].team.name} level on ${plural(g.rows[0].points, 'point')}` : `${name(g)}: ${g.rows[0].team.name} one point clear of ${g.rows[1].team.name}`)).join('; ')}.`] });
  sections.push({ key: 'results', heading: 'This week’s results', paragraphs: [`${p.round.results.map(r => `${r.home.name} ${r.score} ${r.away.name}`).join('; ')}.`] });
  sections.push(method(p, ' Only groups whose published standings match PropBetEdge canonical results are included.'));
  return { headline, dek, sections, entities: uniq([compEntity(p), ...G.flatMap(g => g.rows.slice(0, one ? 8 : 1).map(r => teamEntity(r.team))), ...p.round.results.flatMap(r => [teamEntity(r.home), teamEntity(r.away)])]), slug_base: `${p.competition.name} groups ${p.event.as_of.slice(0, 10)}` };
}
