#!/usr/bin/env node
// SEASON FORMAT REVIEW MANIFEST builder (owner decision 2026-10-02). For a season whose provider metadata cannot
// separate stages (ESPN files the 2001 MLS playoffs inside "Regular Season 2001"), a REVIEWED manifest records the
// season's real structure from public historical evidence. The evidence classifies provider events; it never becomes
// a canonical result source (ESPN stays canonical) and nothing is inferred from dates alone.
//   node scripts/history/build-format-review.mjs mls <season>   (seasons registered in SEASONS below)
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
  DCU: 'd-c-united', NER: 'new-england-revolution', KCW: 'sporting-kansas-city', LAG: 'la-galaxy', SJE: 'san-jose-earthquakes',
  MIA: 'miami', LA: 'la-galaxy', MET: 'red-bull-new-york', NE: 'new-england-revolution', SJ: 'san-jose-earthquakes', TB: 'tampa-bay',
  'Chicago Fire Soccer Club': 'chicago-fire-fc', 'Chicago Fire FC': 'chicago-fire-fc', 'FC Dallas': 'fc-dallas', 'Sporting Kansas City': 'sporting-kansas-city',
  'Miami Fusion': 'miami', 'New York Red Bulls': 'red-bull-new-york', 'LA Galaxy': 'la-galaxy', 'Los Angeles Galaxy': 'la-galaxy', 'San Jose Earthquakes': 'san-jose-earthquakes',
  'Columbus Crew': 'columbus-crew', 'Columbus Crew SC': 'columbus-crew', 'Colorado Rapids': 'colorado-rapids', 'D.C. United': 'd-c-united', 'New England Revolution': 'new-england-revolution', 'Tampa Bay Mutiny': 'tampa-bay',
};
const link = s => (String(s).match(/\[\[([^\]|]+)/) || [])[1]?.trim() || String(s).replace(/'''/g, '').trim();
const team = s => { const k = link(s); if (!TEAM_MAP[k]) throw new Error(`unmapped team in evidence: ${k}`); return TEAM_MAP[k]; };

// standings (overall table template)
const t = readFileSync(table, 'utf8');
const order = t.match(/team_order[ \t]*=([^\n]+)/);
const codes = order ? order[1].split(',').map(x => x.trim()) : [...t.matchAll(/\|win_([A-Z]+)[ \t]*=/g)].map(m => m[1]);
const num = (k, c) => Number((t.match(new RegExp(`\\|${k}_${c}=[ \\t]*(\\d+)`)) || [])[1]);
const standings = Object.fromEntries(codes.map(c => [TEAM_MAP[c], { code: c, won: num('win', c), drawn: num('draw', c), lost: num('loss', c), goals_for: num('gf', c), goals_against: num('ga', c) }]));
for (const [slug, r] of Object.entries(standings)) { r.played = r.won + r.drawn + r.lost; if (!slug || Object.values(r).some(v => v === undefined || Number.isNaN(v))) throw new Error(`incomplete standings row ${JSON.stringify(r)}`); }
const appearances = Object.values(standings).reduce((a, r) => a + r.played, 0);
const dist = Object.values(standings).reduce((o, r) => ({ ...o, [r.played]: (o[r.played] || 0) + 1 }), {});

// playoff fixtures (Football boxes after the playoffs heading). A field value never spans lines.
const a = readFileSync(article, 'utf8');
const po = a.slice(a.indexOf('==MLS Cup Playoffs=='));
const sections = [...po.matchAll(/^===(.+?)===[ \t]*$/gm)].map(m => ({ name: m[1].replace(/<[^>]*>[^<]*<\/[^>]*>|<[^>]*>/g, '').trim(), at: m.index }));
const roundAt = i => { let r = null; for (const s of sections) if (s.at <= i) r = s.name; return r; };
const field = (box, k) => { const m = box.match(new RegExp(`\\|[ \\t]*${k}[ \\t]*=[ \\t]*([^\\n]*)`)); return m ? m[1].trim() : ''; };
const fixtures = []; const notes = [];
// Each box is extracted by brace balance (nested {{goal}}/{{penmiss}} templates; a box may close on a field line), so
// one box can never run into the next. Every opening must close, and the number of boxes must equal the openings.
const boxes = [];
for (const o of po.matchAll(/\{\{\s*Football box/gi)) {
  let depth = 0; let end = -1;
  for (let i = o.index; i < po.length - 1; i++) {
    if (po[i] === '{' && po[i + 1] === '{') { depth++; i++; } else if (po[i] === '}' && po[i + 1] === '}') { depth--; i++; if (!depth) { end = i + 1; break; } }
  }
  if (end < 0) throw new Error(`unclosed Football box at ${o.index}`);
  boxes.push({ index: o.index, body: po.slice(o.index + o[0].length, end - 2) });
}
for (const m of boxes) {
  const box = m.body; const date = field(box, 'date'); const score = field(box, 'score');
  const sc = score.match(/^(\d+)\s*[–-]\s*(\d+)/);
  if (!date || !sc || /series/i.test(score)) { notes.push({ round: roundAt(m.index), skipped_box: { date, score }, reason: 'no dated match (e.g. a series tiebreaker / sudden-death series overtime): not a fixture' }); continue; }
  const d = new Date(`${date} 12:00 UTC`);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date ${date}`);
  fixtures.push({ round: roundAt(m.index), date_local: d.toISOString().slice(0, 10), team_a: team(field(box, 'team1')), team_b: team(field(box, 'team2')), goals_a: Number(sc[1]), goals_b: Number(sc[2]), aet: /AET|extra time/i.test(score), stadium: link(field(box, 'stadium')) || null });
}
// REVIEWED per-season format facts (from the evidence files; nothing here is inferred from provider data)
const SEASONS = {
  2001: {
    stage: { Quarterfinals: 'Quarterfinals', Semifinals: 'Semifinals', 'MLS Cup': 'MLS Cup', 'MLS Cup 2001': 'MLS Cup' },
    structure: ['Quarterfinals (best of three)', 'Semifinals (best of three)', 'MLS Cup (single match)'],
    facts: { regular_season_end: '2001-09-09', playoffs_start: '2001-09-20', mls_cup: '2001-10-21', note: 'Regular season ended prematurely after the September 11 attacks; remaining matches were cancelled; playoff seeding by points per game; best-of-three series decided on points, with sudden-death series overtime when level.' },
  },
  2004: {
    stage: { 'Conference semifinals': 'Conference Semifinals', 'Conference finals': 'Conference Finals', 'MLS Cup': 'MLS Cup' },
    structure: ['Conference Semifinals (two legs, aggregate)', 'Conference Finals (single match)', 'MLS Cup (single match)'],
    facts: { regular_season_end: '2004-10-17', playoffs_start: '2004-10-22', mls_cup: '2004-11-14', note: '10 clubs, 30 matches each (150); top four per conference qualify; conference semifinals home-and-home on aggregate goals; conference finals and MLS Cup single matches (D.C. United beat New England 4-3 on penalties after 3-3 AET).' },
    fact_quotes: [
      { file: 'article', quote: 'The regular season began on April 3, and concluded on October 17. The 2004 MLS Cup Playoffs began on October 22, and concluded with [[MLS Cup 2004]] on November 14.' },
      { file: 'article', quote: 'Each team played 30 games that were evenly divided between home and away.' },
      { file: 'article', quote: 'The conference finals were played as a single match, and the winners advanced to [[MLS Cup 2004|MLS Cup]].' },
    ],
    // second source (MLS Cup 2004 article: finalists' road-to-the-final table and match infobox), per fixture
    corroboration: {
      'Conference Finals|2004-11-06': [{ file: 'cup', quote: ['|align=left|[[New England Revolution]]', '|colspan=3|3–3 {{pso|4–3}} (H)'].join('\n'), reads: 'D.C. United (finalist, H) 3–3 New England, 4–3 on penalties' }],
      'Conference Finals|2004-11-05': [{ file: 'cup', quote: ['|align=left|[[Los Angeles Galaxy]]', '|colspan=3|2–0 (H)'].join('\n'), reads: 'Kansas City Wizards (finalist, H) 2–0 Los Angeles Galaxy' }],
      'MLS Cup|2004-11-14': [
        { file: 'cup', quote: ['| team1  = [[D.C. United]]', '| team1score = 3 ', '| team2 = [[Kansas City Wizards]]', '| team2score = 2', '| date = {{Start date|2004|11|14}}'].join('\n'), reads: 'infobox: D.C. United 3–2 Kansas City Wizards, 2004-11-14' },
        { file: 'cup', quote: 'The match kicked off at 12:45&nbsp;p.m. [[Pacific Time Zone|Pacific Time]] on November 14, 2004', reads: 'kickoff 12:45 PT = 20:45Z; ESPN lists 17:30Z: kickoff TIME disagrees (date agrees); canonical kickoff stays ESPN, recorded as a limitation, never used to classify' },
      ],
    },
  },
};
const SEASON = SEASONS[season]; if (!SEASON) throw new Error(`season ${season} has no reviewed format config`);
for (const f of fixtures) { f.stage = SEASON.stage[f.round]; if (!f.stage) throw new Error(`unreviewed playoff round heading: ${f.round}`); }
// REVIEWED provider date exceptions: a provider event whose date disagrees with the reviewed fixture date, resolved by
// independent evidence. The event is identified by its provider id AND must still agree on pairing and goals; the
// canonical kickoff (ESPN) is not changed, the disagreement is recorded as a limitation.
const DATE_EXCEPTIONS = {
  'mls|2001|Semifinals|2001-10-13|chicago-fire-fc|la-galaxy': { provider: 'espn', event_id: '17679', provider_local_date: '2001-10-14', reason: 'ESPN kickoff 2001-10-15T02:00Z (Oct 14 local) vs Oct 13 in the season article; the MLS Cup 2001 article independently cites the Los Angeles Times match report "Hernandez Is Just in Time" dated October 14, 2001 (the morning after an Oct 13 evening match).', evidence: ['https://en.wikipedia.org/wiki/2001_Major_League_Soccer_season', 'https://en.wikipedia.org/wiki/MLS_Cup_2001', 'https://www.latimes.com/archives/la-xpm-2001-oct-14-sp-57224-story.html'] },
};
for (const f of fixtures) { const x = DATE_EXCEPTIONS[`${comp}|${season}|${f.stage}|${f.date_local}|${f.team_a}|${f.team_b}`]; if (x) f.provider_date_exception = x; }
// every reviewed quote must appear VERBATIM in its committed evidence file, or the build fails
const EV = { article, table, cup: `${DIR}/wikipedia-MLS_Cup_${season}.wikitext` };
const has = (file, quote) => { if (!readFileSync(EV[file], 'utf8').replace(/\r\n/g, '\n').includes(quote)) throw new Error(`reviewed quote not found in ${EV[file]}: ${quote.slice(0, 80)}`); return true; };
for (const q of SEASON.fact_quotes || []) has(q.file, q.quote);
for (const [key, qs] of Object.entries(SEASON.corroboration || {})) {
  const f = fixtures.find(x => `${x.stage}|${x.date_local}` === key); if (!f) throw new Error(`corroboration for unknown fixture ${key}`);
  f.corroboration = qs.map(q => (has(q.file, q.quote), { source: EV[q.file], quote: q.quote, reads: q.reads }));
}
const manifest = {
  manifest_version: 'soccer-format-review/1.0.0', competition: comp, season, review_status: 'approved', reviewer: 'PropBetEdge history review (Claude, owner-directed 2026-10-02)', reviewed_at: new Date().toISOString(),
  rule: 'Provider events are classified only when (local date, unordered pairing, per-team goals) all agree with a reviewed fixture (Football box team1/team2 order is not home/away; the stadium is corroboration only); the regular season must reconcile to the reviewed standings; anything unproven stays held.',
  evidence: [{ source: `https://en.wikipedia.org/wiki/${season}_Major_League_Soccer_season`, file: article, sha256: sha(article), license: 'CC BY-SA 4.0 (review evidence only; never a canonical source)' }, { source: `https://en.wikipedia.org/wiki/Template:${season}_Major_League_Soccer_season_table`, file: table, sha256: sha(table), license: 'CC BY-SA 4.0 (review evidence only)' }, { source: `https://en.wikipedia.org/wiki/MLS_Cup_${season}`, file: `${DIR}/wikipedia-MLS_Cup_${season}.wikitext`, sha256: sha(`${DIR}/wikipedia-MLS_Cup_${season}.wikitext`), license: 'CC BY-SA 4.0 (review evidence only)' }],
  facts: { teams: codes.length, regular_season_matches: appearances / 2, ...SEASON.facts, ...(SEASON.fact_quotes ? { quotes: SEASON.fact_quotes.map(q => ({ source: EV[q.file], quote: q.quote })) } : {}) },
  regular_season: { stage: 'Regular Season', expected_matches: appearances / 2, expected_team_games: dist, standings },
  playoffs: { structure: SEASON.structure, fixtures, notes },
  team_map: TEAM_MAP,
};
mkdirSync('data/history-review', { recursive: true });
writeFileSync(`data/history-review/${comp}-${season}.json`, `${JSON.stringify(manifest, null, 1)}\n`);
console.log(JSON.stringify({ teams: codes.length, regular: appearances / 2, dist, playoff_fixtures: fixtures.length, by_stage: fixtures.reduce((o, f) => ({ ...o, [f.stage]: (o[f.stage] || 0) + 1 }), {}), skipped_boxes: notes.length }));
