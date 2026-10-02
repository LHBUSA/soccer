#!/usr/bin/env node
// SEASON FORMAT REVIEW MANIFEST builder (owner decision 2026-10-02). For a season whose provider metadata cannot
// separate stages (ESPN files the 2001 MLS playoffs inside "Regular Season 2001"), a REVIEWED manifest records the
// season's real structure from public historical evidence. The evidence classifies provider events; it never becomes
// a canonical result source (ESPN stays canonical) and nothing is inferred from dates alone.
//   node scripts/history/build-format-review.mjs mls 2001
// Inputs (committed review evidence): docs/evidence/history/review/wikipedia-<season>-mls-season.wikitext (season
// article, playoff fixture boxes) and wikipedia-template-<season>-mls-season-table.wikitext (overall standings).
// Output: data/history-review/<comp>-<season>.json
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [comp, season] = process.argv.slice(2);
const DIR = 'docs/evidence/history/review';
const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
const article = `${DIR}/wikipedia-${season}-mls-season.wikitext`;
const table = `${DIR}/wikipedia-template-${season}-mls-season-table.wikitext`;
// REVIEWED team map: every name/link target the evidence uses -> canonical team slug (ESPN team ids carry franchise
// continuity: Dallas Burn = FC Dallas, Kansas City Wizards = Sporting Kansas City, MetroStars = Red Bull New York).
const TEAM_MAP = {
  CHI: 'chicago-fire-fc', COL: 'colorado-rapids', CLB: 'columbus-crew', DAL: 'fc-dallas', DC: 'd-c-united', KC: 'sporting-kansas-city',
  MIA: 'miami', LA: 'la-galaxy', MET: 'red-bull-new-york', NE: 'new-england-revolution', SJ: 'san-jose-earthquakes', TB: 'tampa-bay',
  'Chicago Fire Soccer Club': 'chicago-fire-fc', 'Chicago Fire FC': 'chicago-fire-fc', 'FC Dallas': 'fc-dallas', 'Sporting Kansas City': 'sporting-kansas-city',
  'Miami Fusion': 'miami', 'New York Red Bulls': 'red-bull-new-york', 'LA Galaxy': 'la-galaxy', 'Los Angeles Galaxy': 'la-galaxy', 'San Jose Earthquakes': 'san-jose-earthquakes',
  'Columbus Crew': 'columbus-crew', 'Columbus Crew SC': 'columbus-crew', 'Colorado Rapids': 'colorado-rapids', 'D.C. United': 'd-c-united', 'New England Revolution': 'new-england-revolution', 'Tampa Bay Mutiny': 'tampa-bay',
};
const link = s => (String(s).match(/\[\[([^\]|]+)/) || [])[1]?.trim() || String(s).replace(/'''/g, '').trim();
const team = s => { const k = link(s); if (!TEAM_MAP[k]) throw new Error(`unmapped team in evidence: ${k}`); return TEAM_MAP[k]; };

// standings (overall table template)
const t = readFileSync(table, 'utf8');
const codes = (t.match(/team_order=([^\n]+)/) || [])[1].split(',').map(x => x.trim());
const num = (k, c) => Number((t.match(new RegExp(`\\|${k}_${c}=[ \\t]*(\\d+)`)) || [])[1]);
const standings = Object.fromEntries(codes.map(c => [TEAM_MAP[c], { code: c, won: num('win', c), drawn: num('draw', c), lost: num('loss', c), goals_for: num('gf', c), goals_against: num('ga', c) }]));
for (const [slug, r] of Object.entries(standings)) { r.played = r.won + r.drawn + r.lost; if (!slug || Object.values(r).some(v => v === undefined || Number.isNaN(v))) throw new Error(`incomplete standings row ${JSON.stringify(r)}`); }
const appearances = Object.values(standings).reduce((a, r) => a + r.played, 0);
const dist = Object.values(standings).reduce((o, r) => ({ ...o, [r.played]: (o[r.played] || 0) + 1 }), {});

// playoff fixtures (Football boxes after the playoffs heading). A field value never spans lines.
const a = readFileSync(article, 'utf8');
const po = a.slice(a.indexOf('==MLS Cup Playoffs=='));
const sections = [...po.matchAll(/===([^=\n]+)===/g)].map(m => ({ name: m[1].trim(), at: m.index }));
const roundAt = i => { let r = null; for (const s of sections) if (s.at <= i) r = s.name; return r; };
const field = (box, k) => { const m = box.match(new RegExp(`\\|[ \\t]*${k}[ \\t]*=[ \\t]*([^\\n]*)`)); return m ? m[1].trim() : ''; };
const fixtures = []; const notes = [];
for (const m of po.matchAll(/\{\{Football box([\s\S]*?)\n\}\}/g)) {
  const box = m[1]; const date = field(box, 'date'); const score = field(box, 'score');
  const sc = score.match(/^(\d+)\s*[–-]\s*(\d+)/);
  if (!date || !sc || /series/i.test(score)) { notes.push({ round: roundAt(m.index), skipped_box: { date, score }, reason: 'no dated match (e.g. a series tiebreaker / sudden-death series overtime): not a fixture' }); continue; }
  const d = new Date(`${date} 12:00 UTC`);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date ${date}`);
  fixtures.push({ round: roundAt(m.index), date_local: d.toISOString().slice(0, 10), team_a: team(field(box, 'team1')), team_b: team(field(box, 'team2')), goals_a: Number(sc[1]), goals_b: Number(sc[2]), aet: /AET|extra time/i.test(score), stadium: link(field(box, 'stadium')) || null });
}
const STAGE = { Quarterfinals: 'Quarterfinals', Semifinals: 'Semifinals', 'MLS Cup': 'MLS Cup', 'MLS Cup 2001': 'MLS Cup' };
for (const f of fixtures) f.stage = STAGE[f.round] || f.round;
// REVIEWED provider date exceptions: a provider event whose date disagrees with the reviewed fixture date, resolved by
// independent evidence. The event is identified by its provider id AND must still agree on pairing and goals; the
// canonical kickoff (ESPN) is not changed, the disagreement is recorded as a limitation.
const DATE_EXCEPTIONS = {
  'mls|2001|Semifinals|2001-10-13|chicago-fire-fc|la-galaxy': { provider: 'espn', event_id: '17679', provider_local_date: '2001-10-14', reason: 'ESPN kickoff 2001-10-15T02:00Z (Oct 14 local) vs Oct 13 in the season article; the MLS Cup 2001 article independently cites the Los Angeles Times match report "Hernandez Is Just in Time" dated October 14, 2001 (the morning after an Oct 13 evening match).', evidence: ['https://en.wikipedia.org/wiki/2001_Major_League_Soccer_season', 'https://en.wikipedia.org/wiki/MLS_Cup_2001', 'https://www.latimes.com/archives/la-xpm-2001-oct-14-sp-57224-story.html'] },
};
for (const f of fixtures) { const x = DATE_EXCEPTIONS[`${comp}|${season}|${f.stage}|${f.date_local}|${f.team_a}|${f.team_b}`]; if (x) f.provider_date_exception = x; }
const manifest = {
  manifest_version: 'soccer-format-review/1.0.0', competition: comp, season, review_status: 'approved', reviewer: 'PropBetEdge history review (Claude, owner-directed 2026-10-02)', reviewed_at: new Date().toISOString(),
  rule: 'Provider events are classified only when (local date, unordered pairing, per-team goals) all agree with a reviewed fixture (Football box team1/team2 order is not home/away; the stadium is corroboration only); the regular season must reconcile to the reviewed standings; anything unproven stays held.',
  evidence: [{ source: 'https://en.wikipedia.org/wiki/2001_Major_League_Soccer_season', file: article, sha256: sha(article), license: 'CC BY-SA 4.0 (review evidence only; never a canonical source)' }, { source: 'https://en.wikipedia.org/wiki/Template:2001_Major_League_Soccer_season_table', file: table, sha256: sha(table), license: 'CC BY-SA 4.0 (review evidence only)' }, { source: 'https://en.wikipedia.org/wiki/MLS_Cup_2001', file: `${DIR}/wikipedia-MLS_Cup_2001.wikitext`, sha256: sha(`${DIR}/wikipedia-MLS_Cup_2001.wikitext`), license: 'CC BY-SA 4.0 (review evidence only)' }],
  facts: { teams: codes.length, regular_season_matches: appearances / 2, regular_season_end: '2001-09-09', playoffs_start: '2001-09-20', mls_cup: '2001-10-21', note: 'Regular season ended prematurely after the September 11 attacks; remaining matches were cancelled; playoff seeding by points per game; best-of-three series decided on points, with sudden-death series overtime when level.' },
  regular_season: { stage: 'Regular Season', expected_matches: appearances / 2, expected_team_games: dist, standings },
  playoffs: { structure: ['Quarterfinals (best of three)', 'Semifinals (best of three)', 'MLS Cup (single match)'], fixtures, notes },
  team_map: TEAM_MAP,
};
mkdirSync('data/history-review', { recursive: true });
writeFileSync(`data/history-review/${comp}-${season}.json`, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(JSON.stringify({ teams: codes.length, regular: appearances / 2, dist, playoff_fixtures: fixtures.length, by_stage: fixtures.reduce((o, f) => ({ ...o, [f.stage]: (o[f.stage] || 0) + 1 }), {}), skipped_boxes: notes.length }));
