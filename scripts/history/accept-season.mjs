#!/usr/bin/env node
// PASS A ACCEPTANCE for one historical competition-season (owner decisions 2026-10-02). Read-only unless --promote.
// A season becomes public ONLY when every check passes; otherwise it stays 'held' with its reasons recorded.
//   node scripts/history/accept-season.mjs <competition-slug> <season-label> [--expect-teams 20] [--promote]
// Checks (canonical base tables, the season's own rows):
//   rows: every match has two distinct sides, a stage and a kickoff inside the season's plausible window
//   results: every past match is finished with both scores (postponed/cancelled/abandoned are listed, not failed)
//   identity: every side's team_type matches the competition (clubs vs national teams), no unknown team
//   league format (comp_type league): team count (optional --expect-teams), every team the same number of league
//     matches, home == away per team, no repeated (home, away) pair in the league stage
//   provenance: result_provider per match (source_families), coverage tier measured from the stored components
// HARDENED INVARIANTS (owner 2026-10-03, after Premier League 2002/03):
//   structure   registered era (data/history-structure.json) -> exact league match count, club count, matches per club,
//               finished count (completed season); otherwise uniform league games or a reviewed manifest
//   pairings    no repeated (home, away) in the league stage unless the competition registers repeat_pairings
//   listings    no postponed/cancelled canonical match beside a finished canonical replay of the same pairing; no open
//               queued ESPN match event for the season (an undiscovered/queued replay)
//   discovery   the history lane cursor (KV) is complete: every indexed event fetched, every repeated pairing's
//               status (and score when finished) read
//   totals      sum of per-club league appearances == 2 x league matches
//   provenance  every ESPN-owned match has its ESPN crosswalk; every finished ESPN-owned match its ESPN source result
//   sources     any provider observation whose score disagrees with the canonical score HOLDS (never auto-resolved)
// A compact acceptance report is printed (stderr) and stored for every run.
// Output: docs/evidence/history/accept-<slug>-<label>.json; --promote writes publication_state 'published' with
// reviewed_at, coverage_tier, source_families and limitations (a failing season is never promoted).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { promotionWrites } from './season-limitations.mjs';
const [slug, label] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PROMOTE = process.argv.includes('--promote');
const expectTeams = arg('--expect-teams', null);
// --min-matches: the canonical season must hold at least this many matches (the runner passes the fixtures the lane
// discovered minus recorded repeated pairings). A season with zero matches never passes.
const minMatches = Math.max(1, Number(arg('--min-matches', '1')) || 1);
if (!slug || !label) throw new Error('usage: accept-season.mjs <competition-slug> <season-label> [--expect-teams N] [--promote]');
const env = Object.fromEntries(readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]));
const U = env.SOCCER_MODEL_SUPABASE_URL; if (!/tkmlnhmylqnttmnsnief/.test(U)) throw new Error('target guard');
const h = { apikey: env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, authorization: `Bearer ${env.SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY}` };
const get = async q => { const r = await fetch(`${U}/rest/v1/${q}`, { headers: h }); if (!r.ok) throw new Error(`${r.status} ${q}`); return r.json(); };
const pages = async q => { const out = []; for (let o = 0; ; o += 1000) { const r = await get(`${q}&limit=1000&offset=${o}`); out.push(...r); if (r.length < 1000) return out; } };
const [comp] = await get(`soccer_competitions?select=id,slug,comp_type&slug=eq.${slug}`);
if (!comp) throw new Error(`no competition ${slug}`);
const [season] = await get(`soccer_seasons?select=id,label,publication_state,coverage_tier&competition_id=eq.${comp.id}&label=eq.${encodeURIComponent(label)}`);
if (!season) throw new Error(`no season ${slug} ${label}`);
const ms = await pages(`soccer_matches?select=id,stage_id,kickoff_at,status,home_team_id,away_team_id,home_score,away_score,venue_id,result_provider&season_id=eq.${season.id}&order=id.asc`);
const stages = await get(`soccer_stages?select=id,name,stage_type&season_id=eq.${season.id}`);
const teamIds = [...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))];
const teams = []; for (let i = 0; i < teamIds.length; i += 100) teams.push(...await get(`soccer_teams?select=id,name,team_type&id=in.(${teamIds.slice(i, i + 100).join(',')})`));
const fail = []; const notes = [];
if (ms.length < minMatches) fail.push({ check: 'too_few_matches', expected_at_least: minMatches, found: ms.length });
const now = Date.now();
const y0 = Number(label.slice(0, 4)); const y1 = label.includes('/') ? y0 + 1 : y0;
// split seasons run into the next summer (play-offs, finals); calendar seasons end by the next January
const lo = Date.parse(`${y0 - 1}-06-01T00:00:00Z`); const hi = Date.parse(label.includes("/") ? `${y1 + 1}-07-31T00:00:00Z` : `${y1 + 1}-01-31T00:00:00Z`);
// rows
const bad = ms.filter(m => !m.home_team_id || !m.away_team_id || m.home_team_id === m.away_team_id || !m.stage_id);
if (bad.length) fail.push({ check: 'two_valid_sides_and_stage', count: bad.length, ids: bad.slice(0, 10).map(m => m.id) });
const off = ms.filter(m => Date.parse(m.kickoff_at) < lo || Date.parse(m.kickoff_at) > hi);
if (off.length) fail.push({ check: 'kickoff_outside_season_window', count: off.length, window: [new Date(lo).toISOString(), new Date(hi).toISOString()], ids: off.slice(0, 10).map(m => m.id) });
// results
const past = ms.filter(m => Date.parse(m.kickoff_at) < now);
const noResult = new Set(['postponed', 'cancelled', 'abandoned']);
const missing = past.filter(m => !noResult.has(m.status) && (m.status !== 'finished' || !Number.isInteger(m.home_score) || !Number.isInteger(m.away_score)));
if (missing.length) fail.push({ check: 'past_match_without_final_score', count: missing.length, statuses: missing.reduce((o, m) => ({ ...o, [m.status]: (o[m.status] || 0) + 1 }), {}), ids: missing.slice(0, 10).map(m => m.id) });
const voided = past.filter(m => noResult.has(m.status));
if (voided.length) notes.push(`${voided.length} past match(es) postponed/cancelled/abandoned (listed, not results)`);
// identity
const type = new Map(teams.map(t => [t.id, t.team_type]));
const unknown = teamIds.filter(t => !type.has(t));
if (unknown.length) fail.push({ check: 'unknown_team', count: unknown.length });
const wantType = comp.comp_type === 'international_tournament' ? 'national' : 'club';
const wrongType = teams.filter(t => t.team_type !== wantType);
if (wrongType.length) fail.push({ check: 'club_national_contamination', expected: wantType, teams: wrongType.map(t => t.name) });
// league format
const league = new Set(stages.filter(s => s.stage_type === 'league').map(s => s.id));
const lm = ms.filter(m => league.has(m.stage_id) && !noResult.has(m.status));
let format = null;
const STRUCT = JSON.parse(readFileSync('data/history-structure.json', 'utf8')).competitions[slug] || null;
const REPEATS = STRUCT ? !!STRUCT.repeat_pairings : comp.comp_type !== 'league';
const seasonKey = l => (l.includes('/') ? l : `${l}/${String((Number(l) + 1) % 100).padStart(2, '0')}`);
const era = (STRUCT?.eras || []).find(e => seasonKey(label) >= e.from && seasonKey(label) <= e.to) || null;
// A REVIEWED season format manifest (data/history-review/<slug>-<label>.json) replaces the generic league rules for that
// season: exact regular-season count, every club's reviewed W/D/L/GF/GA, playoff stages equal to the reviewed fixtures.
let review = null; try { review = JSON.parse(readFileSync(`data/history-review/${slug}-${label.replace('/', '-')}.json`, 'utf8')); } catch { review = null; }
if (review?.review_status === 'approved') {
  const rs = stages.find(x => x.name === review.regular_season.stage);
  const reg = ms.filter(m => m.stage_id === rs?.id && m.status === 'finished');
  const slugs = new Map(); for (let i = 0; i < teamIds.length; i += 100) for (const t2 of await get(`soccer_teams?select=id,slug&id=in.(${teamIds.slice(i, i + 100).join(',')})`)) slugs.set(t2.id, t2.slug);
  const tab = {}; for (const m of reg) for (const [me, gf, ga] of [[m.home_team_id, m.home_score, m.away_score], [m.away_team_id, m.away_score, m.home_score]]) { const r = (tab[slugs.get(me)] ||= { played: 0, won: 0, drawn: 0, lost: 0, goals_for: 0, goals_against: 0 }); r.played++; r.goals_for += gf; r.goals_against += ga; if (gf > ga) r.won++; else if (gf === ga) r.drawn++; else r.lost++; }
  const bad = Object.entries(review.regular_season.standings).filter(([sl, w]) => ['played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against'].some(k => (tab[sl]?.[k] ?? -1) !== w[k])).map(([sl]) => sl);
  if (reg.length !== review.regular_season.expected_matches) fail.push({ check: 'reviewed_regular_season_count', expected: review.regular_season.expected_matches, found: reg.length });
  if (bad.length) fail.push({ check: 'reviewed_standings_mismatch', teams: bad });
  const want = review.playoffs.fixtures.reduce((o, f) => ({ ...o, [f.stage]: (o[f.stage] || 0) + 1 }), {});
  for (const [stName, n] of Object.entries(want)) { const st2 = stages.find(x => x.name === stName); const got = st2 ? ms.filter(m => m.stage_id === st2.id && m.status === 'finished').length : 0; if (got !== n) fail.push({ check: 'reviewed_playoff_stage_count', stage: stName, expected: n, found: got }); }
  const stray = ms.filter(m => m.status === 'finished' && !stages.some(x => (x.id === rs?.id || want[x.name]) && x.id === m.stage_id));
  if (stray.length) fail.push({ check: 'finished_match_outside_reviewed_stages', count: stray.length });
  format = { reviewed_manifest: `data/history-review/${slug}-${label.replace('/', '-')}.json`, regular_season: reg.length, playoff_stages: want };
  notes.push('format from a reviewed season manifest (provider stage metadata insufficient)');
} else if (comp.comp_type === 'league' && lm.length) {
  const count = new Map(); const home = new Map(); const away = new Map(); const pairs = new Map();
  for (const m of lm) { for (const t of [m.home_team_id, m.away_team_id]) count.set(t, (count.get(t) || 0) + 1); home.set(m.home_team_id, (home.get(m.home_team_id) || 0) + 1); away.set(m.away_team_id, (away.get(m.away_team_id) || 0) + 1); const k = `${m.home_team_id}|${m.away_team_id}`; pairs.set(k, (pairs.get(k) || 0) + 1); }
  const per = [...count.values()]; const dist = per.reduce((o, n) => ({ ...o, [n]: (o[n] || 0) + 1 }), {});
  format = { teams: count.size, league_matches: lm.length, games_per_team: dist };
  if (expectTeams && count.size !== Number(expectTeams)) fail.push({ check: 'team_count', expected: Number(expectTeams), found: count.size });
  if (Object.keys(dist).length !== 1) fail.push({ check: 'games_per_team_uneven', distribution: dist });
  const unbalanced = [...count.keys()].filter(t => (home.get(t) || 0) !== (away.get(t) || 0));
  if (!REPEATS && unbalanced.length) fail.push({ check: 'home_away_unbalanced', count: unbalanced.length });
}
// ---- HARDENED INVARIANTS ----------------------------------------------------------------------------------------
const leagueAll = ms.filter(m => league.has(m.stage_id)); // every status: a stray listing must break the count
const completed = !ms.some(m => m.status === 'scheduled' || m.status === 'unknown') && past.length === ms.length;
const appear = new Map(); for (const m of lm) for (const t of [m.home_team_id, m.away_team_id]) appear.set(t, (appear.get(t) || 0) + 1);
const perClub = [...appear.values()];
const pairCount = new Map(); for (const m of leagueAll) { const k = `${m.home_team_id}|${m.away_team_id}`; pairCount.set(k, (pairCount.get(k) || 0) + 1); }
const repeatedPairs = [...pairCount.values()].filter(n => n > 1).length;
if (!REPEATS && repeatedPairs) fail.push({ check: 'repeated_home_away_pair', count: repeatedPairs, note: 'competition does not register repeated meetings' });
if (era && !review) {
  if (leagueAll.length !== era.league_matches) fail.push({ check: 'structure_league_match_count', expected: era.league_matches, found: leagueAll.length, era: era.basis });
  if (appear.size !== era.teams) fail.push({ check: 'structure_team_count', expected: era.teams, found: appear.size });
  const offClubs = perClub.filter(n => n !== era.league_matches_per_team).length;
  if (offClubs) fail.push({ check: 'structure_matches_per_club', expected: era.league_matches_per_team, clubs_off: offClubs, min: Math.min(...perClub), max: Math.max(...perClub) });
  const finLeague = lm.filter(m => m.status === 'finished').length;
  if (completed && finLeague !== era.league_matches) fail.push({ check: 'structure_finished_count', expected: era.league_matches, found: finLeague });
} else if (!review && comp.comp_type === 'league') notes.push('no registered era: uniform league games per club decides');
const sumApps = perClub.reduce((a, n) => a + n, 0);
if (sumApps !== 2 * lm.length) fail.push({ check: 'team_totals', sum_of_club_appearances: sumApps, expected: 2 * lm.length });
// listings: postponed/cancelled beside a finished replay; queued (undiscovered) replays
const finishedPair = new Set(ms.filter(m => m.status === 'finished').map(m => `${m.home_team_id}|${m.away_team_id}|${m.stage_id}`));
const besideReplay = ms.filter(m => noResult.has(m.status) && finishedPair.has(`${m.home_team_id}|${m.away_team_id}|${m.stage_id}`));
if (besideReplay.length) fail.push({ check: 'postponed_listing_beside_finished_replay', count: besideReplay.length, ids: besideReplay.slice(0, 10).map(m => m.id) });
const queue = (await get('soccer_identity_queue?select=external_id,reason,payload&entity_type=eq.match&provider=eq.espn&status=eq.open')).filter(q => q.payload?.competition === slug && String(q.payload?.year) === label.slice(0, 4));
if (queue.length) fail.push({ check: 'unresolved_identity_queue', count: queue.length, reasons: queue.reduce((o, q) => ({ ...o, [q.reason]: (o[q.reason] || 0) + 1 }), {}) });
// discovery completeness from the history lane cursor (KV), when this season was ingested by a history lane
let discovery = { checked: false };
for (const laneName of [`espn_${slug.replace(/-/g, '_')}@${label.slice(0, 4)}:results`, `espn_${slug.replace(/-/g, '_')}@${label.slice(0, 4)}`]) {
  const kv = spawnSync('npx', ['wrangler', 'kv', 'key', 'get', `lane:${laneName}`, '--namespace-id', '3e665f75414849578249f5aed979b868', '--remote'], { cwd: 'workers/soccer-ingest', encoding: 'utf8', shell: true, env: { ...process.env, NODE_OPTIONS: '--require D:/Workers/exfat-readlink.cjs' } });
  let st = null; try { st = JSON.parse(kv.stdout); } catch { st = null; }
  if (!st?.cursor) continue;
  const cur = st.cursor; const fx = cur.fixtures || {}; const idx = cur.index || [];
  const missingEvents = idx.filter(id => !fx[id]).length;
  const groups = new Map(); for (const [id, f] of Object.entries(fx)) { const k = `${f.stype}|${f.h}|${f.a}`; groups.set(k, [...(groups.get(k) || []), id]); }
  const rep = [...groups.values()].filter(g => g.length > 1).flat();
  const noStatus = rep.filter(id => !fx[id].st).length; const noScore = rep.filter(id => fx[id].st === 'finished' && !fx[id].sc).length;
  discovery = { checked: true, lane: laneName, indexed: idx.length, fetched: Object.keys(fx).length, missing_events: missingEvents, repeated_pairing_events: rep.length, without_status: noStatus, finished_without_score: noScore };
  if (missingEvents || (cur.history && (noStatus || noScore))) fail.push({ check: 'history_discovery_incomplete', ...discovery });
  break;
}
// provenance reconciliation: crosswalks and ESPN source results against the canonical set
const chunk = a => { const o = []; for (let i = 0; i < a.length; i += 80) o.push(a.slice(i, i + 80)); return o; };
const xwm = new Set(); const srcRows = [];
for (const ch of chunk(ms.map(m => m.id))) {
  for (const x of await get(`soccer_match_external_ids?select=match_id&provider=eq.espn&match_id=in.(${ch.join(',')})`)) xwm.add(x.match_id);
  srcRows.push(...await get(`soccer_match_source_results?select=match_id,provider,status,home_score,away_score&match_id=in.(${ch.join(',')})`));
}
const espnOwned = ms.filter(m => m.result_provider === 'espn');
const noXw = espnOwned.filter(m => !xwm.has(m.id));
if (noXw.length) fail.push({ check: 'espn_match_without_crosswalk', count: noXw.length });
const espnSrc = new Set(srcRows.filter(x => x.provider === 'espn').map(x => x.match_id));
const noSrc = espnOwned.filter(m => m.status === 'finished' && !espnSrc.has(m.id));
if (noSrc.length) fail.push({ check: 'finished_espn_match_without_source_result', count: noSrc.length });
const byId = new Map(ms.map(m => [m.id, m]));
const disagree = srcRows.filter(x => { const m = byId.get(x.match_id); return m && m.status === 'finished' && Number.isInteger(x.home_score) && Number.isInteger(x.away_score) && (x.home_score !== m.home_score || x.away_score !== m.away_score); });
if (disagree.length) fail.push({ check: 'source_score_disagreement', count: disagree.length, ids: disagree.slice(0, 10).map(x => `${x.match_id}:${x.provider}`) });
const acceptance = { canonical_matches: ms.length, finished: ms.filter(m => m.status === 'finished').length, teams: teamIds.length, league_matches: leagueAll.length, matches_per_club: perClub.length ? { min: Math.min(...perClub), max: Math.max(...perClub) } : null, repeated_pairings: repeatedPairs, repeat_pairings_allowed: REPEATS, era: era?.basis || (review ? 'reviewed manifest' : null), unresolved_identity_queue: queue.length, discovery, crosswalked: xwm.size, espn_source_results: espnSrc.size, score_disagreements: disagree.length, postponed_beside_replay: besideReplay.length };

// provenance + measured tier (additive)
const providers = [...new Set(ms.map(m => m.result_provider).filter(Boolean))];
const fin = ms.filter(m => m.status === 'finished');
// coverage from the enrichment ledger (component status per match; <= 5 rows per match, so no row cap applies)
const comp5 = {};
for (let i = 0; i < fin.length; i += 150) for (const r of await get(`soccer_match_enrichment?select=match_id,component&status=eq.complete&match_id=in.(${fin.slice(i, i + 150).map(m => m.id).join(',')})`)) (comp5[r.component] ||= new Set()).add(r.match_id);
const both = (a, b) => (fin.length ? fin.filter(m => comp5[a]?.has(m.id) && comp5[b]?.has(m.id)).length / fin.length : 0);
const venue = fin.length ? fin.filter(m => m.venue_id).length / fin.length : 0;
const lineups = both('lineup_home', 'lineup_away'); const stats = both('stats_home', 'stats_away');
const events = fin.length ? fin.filter(m => comp5.plays?.has(m.id)).length / fin.length : 0;
const tier = !fin.length ? null : events >= 0.9 && lineups >= 0.9 ? 'EVENTS' : stats >= 0.9 && lineups >= 0.9 ? 'STATS' : lineups >= 0.9 ? 'LINEUP' : venue >= 0.9 ? 'MATCH' : 'RESULTS';
const limitations = [];
if (lineups < 0.9) limitations.push(`lineups for ${Math.round(lineups * 100)}% of finished matches`);
if (stats < 0.9) limitations.push(`team statistics for ${Math.round(stats * 100)}% of finished matches`);
if (events < 0.9) limitations.push(`event record for ${Math.round(events * 100)}% of finished matches`);
const result = { at: new Date().toISOString(), competition: slug, season: label, state_before: season.publication_state, acceptance, matches: ms.length, finished: fin.length, stages: stages.map(s => `${s.name}:${s.stage_type}`), teams: teamIds.length, format, providers, coverage: { venue, lineups, stats, events }, coverage_tier: tier, limitations, notes, checks_failed: fail, pass: fail.length === 0 };
if (PROMOTE) {
  if (!result.pass) throw new Error(`REFUSED: ${slug} ${label} failed ${fail.map(f => f.check).join(', ')} — stays held`);
  // evidence (limitations, tier, sources) and data state (publication) are separate writes, evidence first; reviewed
  // limitations are never dropped (scripts/history/season-limitations.mjs)
  const [cur] = await get(`soccer_seasons?select=limitations,publication_state,published_at,publication_note&id=eq.${season.id}`);
  const w = promotionWrites({ current: cur, reviewLimitations: review?.limitations || [], coverage: limitations, tier, providers, at: new Date().toISOString(), note: `Pass A accepted ${result.at.slice(0, 10)} (scripts/history/accept-season.mjs)` });
  for (const [what, body] of [['evidence', w.evidence], ['state', w.state]]) {
    const r = await fetch(`${U}/rest/v1/soccer_seasons?id=eq.${season.id}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`promote ${what} write failed ${r.status} ${await r.text()}`);
  }
  result.promoted = true;
}
mkdirSync('docs/evidence/history', { recursive: true });
writeFileSync(`docs/evidence/history/accept-${slug}-${label.replace('/', '-')}.json`, `${JSON.stringify(result, null, 1)}\n`);
const A = acceptance;
console.error([
  `ACCEPTANCE ${slug} ${label} -> ${result.pass ? 'PASS' : 'HOLD'}${result.promoted ? ' (PROMOTED)' : ''}`,
  `  canonical ${A.canonical_matches} | finished ${A.finished} | teams ${A.teams} | league ${A.league_matches} | per club ${A.matches_per_club ? `${A.matches_per_club.min}-${A.matches_per_club.max}` : '-'} | era ${A.era || '-'}`,
  `  repeated pairings ${A.repeated_pairings}${A.repeat_pairings_allowed ? ' (allowed)' : ''} | postponed beside replay ${A.postponed_beside_replay} | identity queue ${A.unresolved_identity_queue}`,
  `  discovery ${A.discovery.checked ? `${A.discovery.fetched}/${A.discovery.indexed} events, ${A.discovery.without_status} repeat w/o status, ${A.discovery.finished_without_score} w/o score` : 'no history cursor'}`,
  `  crosswalked ${A.crosswalked} | espn source results ${A.espn_source_results} | score disagreements ${A.score_disagreements} | tier ${tier}`,
  `  ${result.pass ? 'PASS' : `HOLD: ${fail.map(f => f.check).join(', ')}`}`,
].join('\n'));
console.log(JSON.stringify({ pass: result.pass, matches: result.matches, finished: result.finished, teams: result.teams, format, tier, failed: fail.map(f => f.check), notes, acceptance: A, promoted: !!result.promoted }));

