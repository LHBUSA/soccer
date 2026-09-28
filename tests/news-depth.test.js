// NEWS DEPTH V2: packet v3 depth (as-of-safe, structured), evidence-family + repetition + section-depth gates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bucketOf, depthFromRows, packetV3, PACKET_V3 } from '../workers/soccer-news/src/depth.js';
import { compose } from '../workers/soccer-news/src/compose2.js';
import { deskArticle, evidenceFamilies, judge, qualityGates, validateEditorial } from '../workers/soccer-news/src/desk.js';

const V2 = JSON.parse(readFileSync('tests/fixtures/news/bayern-packet.json', 'utf8'));
const V3 = JSON.parse(readFileSync('tests/fixtures/news/bayern-packet-v3.json', 'utf8'));

test('buckets: stoppage stays in its half; extra time separate', () => {
  assert.equal(bucketOf(15, '1H'), '0-15'); assert.equal(bucketOf(47, '1H'), '31-45+'); assert.equal(bucketOf(46, '2H'), '46-60');
  assert.equal(bucketOf(93, '2H'), '76-90+'); assert.equal(bucketOf(100, 'E1'), 'extra_time'); assert.equal(bucketOf(null, '1H'), null);
});

test('packet v3: the original is the base, never mutated; depth is structured evidence, not prose', () => {
  assert.equal(V3.version, PACKET_V3); assert.equal(V3.derived_from.packet_hash, V2.hash); assert.notEqual(V3.hash, V2.hash);
  for (const k of ['match', 'goals', 'stats', 'provenance']) assert.deepEqual(V3[k], V2[k], k);
  assert.equal(V3.teams.home.table_after.position, V2.teams.home.table_after.position);
  const d = V3.depth;
  assert.equal(d.goal_sequence.halftime_score, '3-0'); assert.equal(d.goal_sequence.opening_goal.minute, "18'"); assert.equal(d.goal_sequence.first_second_half_goal.minute, "54'");
  assert.deepEqual(d.goal_sequence.goals_after_60, { home: 3, away: 0 });
  const olise = d.player_lines.find(r => r.player.name === 'Michael Olise'); assert.deepEqual([olise.goals, olise.shots, olise.shots_on_target], [3, 6, 5]);
  assert.deepEqual([d.shot_profile.home.shots, d.shot_profile.away.shots, d.shot_profile.home.share_of_total_shots_pct], [23, 3, 88]);
  assert.deepEqual([d.table_move.home.position_before, d.table_move.home.position_after, d.table_move.away.position_after], [4, 1, 16]);
  assert.ok(d.recent_league_results.home.every(r => r.date < V2.match.kickoff_utc.slice(0, 10)), 'as-of safe: only results before kickoff');
  assert.doesNotMatch(JSON.stringify(d), /momentum|dominan|pressure|xg|chance quality/i);
  const strings = []; const walk = v => { if (typeof v === 'string') strings.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(walk); }; walk(d);
  assert.ok(strings.every(s => s.length < 120), 'structured evidence, no prose blobs');
});

test('packet v3: a next fixture that kicked off before a rebuild is dropped; the original is untouched', () => {
  const base = { ...V2, teams: { ...V2.teams, home: { ...V2.teams.home, next: { match_id: 'x', date: '2026-09-20', opponent: { name: 'Z' }, venue: 'home' } } } };
  const p = packetV3(base, {}, { derivedFrom: base.hash, rebuiltAt: '2026-09-28T00:00:00Z' });
  assert.equal(p.teams.home.next, null); assert.equal(p.teams.home.next_omitted, 'kicked off before this rebuild');
  assert.equal(base.teams.home.next.date, '2026-09-20'); assert.equal(p.hash, undefined);
  const fresh = packetV3(base, {}, {});
  assert.equal(fresh.teams.home.next.competition, V2.competition.name, 'a live packet keeps its next fixture with the competition');
});

test('depth rows: synthetic match -> phases, lines, profile; unknown team rows ignored', () => {
  const people = new Map([['a', { id: 'a', name: 'Ann Alpha' }], ['b', { id: 'b', name: 'Bo Beta' }]]);
  const packet = { match: { score: { home: 2, away: 1, home_ht: 1, away_ht: 0 } }, goals: [{ minute: 10, display_minute: "10'", team: 'home', scorer: people.get('a'), assist: people.get('b') }, { minute: 46, display_minute: "45+1'", team: 'away', scorer: { id: 'c', name: 'Cy' } }, { minute: 80, display_minute: "80'", team: 'home', scorer: people.get('a') }], stats: { basis: 'source', home: { shots: 10, shots_on_target: 4 }, away: { shots: 5, shots_on_target: 1 } }, teams: {} };
  const shots = [{ minute: 10, period: '1H', team_id: 'H', player_id: 'a', outcome: 'goal', is_goal: true, x_m: 95, y_m: 34, source_family: 'espn' }, { minute: 80, period: '2H', team_id: 'H', player_id: 'a', outcome: 'goal', is_goal: true, x_m: 80, y_m: 30, source_family: 'espn' }, { minute: 50, period: '2H', team_id: 'X', player_id: 'b', outcome: 'off_target', x_m: 70, y_m: 30, source_family: 'espn' }];
  const d = depthFromRows(packet, { shots, people, teamSide: t => ({ H: 'home', A: 'away' }[t] || null) });
  assert.deepEqual(d.phases.first_half.away, { shots: 0, shots_on_target: 0, goals: 1 }, "45+1' goal stays in the first half");
  assert.equal(d.goal_sequence.first_second_half_goal.minute, "80'");
  const ann = d.player_lines.find(r => r.player.name === 'Ann Alpha'); assert.deepEqual([ann.goals, ann.shots, ann.shots_inside_box], [2, 2, 1]);
  assert.equal(d.player_lines.find(r => r.player.name === 'Bo Beta').assists, 1);
  assert.equal(d.shot_profile.home.on_target_pct, 40); assert.equal(d.shot_profile.home.goals_per_shot, 0.2);
});

const draft = compose(V3);
const art = (headline, dek, sections) => deskArticle({ headline, dek, sections: sections.map((s, i) => ({ key: `s${i + 1}`, heading: s[0], paragraphs: s[1] })) }, draft);

test('depth gates reject a stat dump even when it is long enough', () => {
  const filler = 'Bayern München were in control against 1. FC Union Berlin for most of the evening.';
  const dump = art('Bayern München beat 1. FC Union Berlin 7-0 in Bundesliga', 'Bayern München beat 1. FC Union Berlin 7-0 in Bundesliga', [
    ['Olise and Kane', ['Harry Kane scored 2. Michael Olise scored 3. The match produced 7 goals.', 'The winning margin was 7 goals. Bayern had 23 shots. Union had 3.']],
    ['Bayern at the top', ['Bayern München won 7-0. Olise scored three goals.', filler]],
    ['Union in trouble', ['It finished 7-0. Olise scored three goals and Kane scored two goals.', filler]],
    ['More of Olise', ['Olise scored three goals in a 7-0 win.']],
  ]);
  const failed = judge(dump, V3).failed;
  for (const g of ['mechanical_phrasing', 'score_repetition', 'goal_totals_repeated', 'dek_adds_information']) assert.ok(failed.includes(g), `${g}: ${failed}`);
  const thin = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern turned a 3-0 half-time lead into a win that lifted them from fourth to first.', [['One', ['Bayern led.']], ['Two', ['Olise scored.']], ['Three', ['Union lost.']]]);
  assert.ok(judge(thin, V3).failed.includes('section_depth'), 'five headings with one sentence each is not a story');
});

test('evidence families are read from the prose (a story that ignores the table and stats is incomplete)', () => {
  const only = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three and Harry Kane two as Bayern turned a 3-0 half-time lead into a seven-goal win.', [
    ['Three before the break', ['Bayern München were 3-0 up at half-time after goals in the 18th, 39th and 43rd minute from Jamal Musiala, Harry Kane and Michael Olise.', 'Union Berlin had no answer in the opening period.']],
    ['Olise finishes it', ['Kane scored again in the 54th minute, Ismael Saibari added the fifth in the 70th and Olise struck in the 73rd and 76th minutes.', 'That completed his hat-trick.']],
    ['The final whistle', ['The rest of the evening passed without further goals.', 'Bayern closed the game out.']],
  ]);
  const fam = evidenceFamilies(only, V3);
  assert.ok(fam.used.includes('GOAL_SEQUENCE') && fam.used.includes('PLAYER_CONTRIBUTIONS'), JSON.stringify(fam));
  assert.ok(!fam.used.includes('TABLE_CONTEXT') && !fam.used.includes('TEAM_STATS'));
  const cov = qualityGates(only, V3).find(r => r.gate === 'evidence_coverage');
  assert.equal(cov.pass, false); assert.deepEqual(cov.detail, ['match stats / shot profile', 'table / competitive context']);
});

test('fact gates are unchanged by the depth block (still no invention); a sentence-initial preposition is not a name', () => {
  const a = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern went from fourth to first.', [['X', ['Against Bayern, Union Berlin had three shots.', 'Thomas Müller came off the bench.']]]);
  assert.deepEqual(validateEditorial(a, V3).find(r => r.gate === 'new_player_or_team').detail, ['Thomas', 'Müller']);
});

test('wrong_score: packet phase buckets and nearby stat pairs are not scores; a real wrong score still fails', () => {
  const ok = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern went from fourth to first.', [['X', ['During the 16-30 minute spell Bayern took six shots, and Union did not shoot until the 46-60 minute period.', 'Bayern held a 15-2 advantage in efforts on target.']]]);
  assert.equal(validateEditorial(ok, V3).find(r => r.gate === 'wrong_score').pass, true);
  const bad = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern went from fourth to first.', [['X', ['Bayern won 8-0 in the end.', 'Earlier it was 16-31 minutes of pressure and a 16-30 lead.']]]);
  assert.deepEqual(validateEditorial(bad, V3).find(r => r.gate === 'wrong_score').detail, ['8-0', '16-31', '16-30']);
});

test('new_player_or_team: a capitalised descriptor opening a sentence before a club is not a name; an invented first name is', () => {
  const a = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern went from fourth to first.', [['Unbeaten Bayern go top', ['Unbeaten Bayern München stayed that way.', 'Clinical Kane scored twice.']]]);
  assert.equal(validateEditorial(a, V3).find(r => r.gate === 'new_player_or_team').pass, true);
  const b = art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern went from fourth to first.', [['X', ['Thomas Müller came on.', 'Serge Kane scored.']]]);
  assert.deepEqual(validateEditorial(b, V3).find(r => r.gate === 'new_player_or_team').detail, ['Thomas', 'Müller', 'Serge']);
});

test('QA false positives fixed narrowly: bucket bounds, sourced stat pairs, month abbreviations, the verb "record"', () => {
  const g = (paras, gate) => validateEditorial(art('Olise hat-trick powers Bayern past Union Berlin in 7-0 rout', 'Michael Olise scored three as Bayern went from fourth to first.', [['X', paras]]), V3).find(r => r.gate === gate);
  assert.equal(g(['Bayern took six shots between the 61st and 75th minutes.'], 'new_number_not_in_packet').pass, true);
  assert.equal(g(['The corner count was lopsided all evening, with Bayern holding a 9-2 edge.'], 'wrong_score').pass, true);
  assert.deepEqual(g(['Bayern won 9-2 on the night.'], 'wrong_score').detail, ['9-2'], 'a stat pair used as a result is still a wrong score');
  assert.equal(g(['The run stretched from Aug. 28 to Sept. 18.'], 'new_date').pass, true);
  assert.equal(g(['The run stretched from Aug. 28 to Sept. 18.'], 'new_player_or_team').pass, true);
  assert.deepEqual(g(['The run started on Aug. 30.'], 'new_date').detail, ['30 August']);
  assert.equal(g(['Bayern did not record one save of note.'], 'unsupported_record').pass, true);
  for (const bad of ['It was a club record.', 'Bayern set a new record.', 'A record win for Bayern.', 'The result was record-breaking.']) assert.equal(g([bad], 'unsupported_record').pass, false, bad);
});
