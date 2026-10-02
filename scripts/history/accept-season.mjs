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
// Output: docs/evidence/history/accept-<slug>-<label>.json; --promote writes publication_state 'published' with
// reviewed_at, coverage_tier, source_families and limitations (a failing season is never promoted).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const [slug, label] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const PROMOTE = process.argv.includes('--promote');
const expectTeams = arg('--expect-teams', null);
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
if (comp.comp_type === 'league' && lm.length) {
  const count = new Map(); const home = new Map(); const away = new Map(); const pairs = new Map();
  for (const m of lm) { for (const t of [m.home_team_id, m.away_team_id]) count.set(t, (count.get(t) || 0) + 1); home.set(m.home_team_id, (home.get(m.home_team_id) || 0) + 1); away.set(m.away_team_id, (away.get(m.away_team_id) || 0) + 1); const k = `${m.home_team_id}|${m.away_team_id}`; pairs.set(k, (pairs.get(k) || 0) + 1); }
  const per = [...count.values()]; const dist = per.reduce((o, n) => ({ ...o, [n]: (o[n] || 0) + 1 }), {});
  format = { teams: count.size, league_matches: lm.length, games_per_team: dist };
  if (expectTeams && count.size !== Number(expectTeams)) fail.push({ check: 'team_count', expected: Number(expectTeams), found: count.size });
  if (Object.keys(dist).length !== 1) fail.push({ check: 'games_per_team_uneven', distribution: dist });
  const unbalanced = [...count.keys()].filter(t => (home.get(t) || 0) !== (away.get(t) || 0));
  if (comp.slug !== 'mls' && unbalanced.length) fail.push({ check: 'home_away_unbalanced', count: unbalanced.length });
  const rep = [...pairs.values()].filter(n => n > 1).length;
  if (comp.slug !== 'mls' && rep) fail.push({ check: 'repeated_home_away_pair', count: rep });
}
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
const result = { at: new Date().toISOString(), competition: slug, season: label, state_before: season.publication_state, matches: ms.length, finished: fin.length, stages: stages.map(s => `${s.name}:${s.stage_type}`), teams: teamIds.length, format, providers, coverage: { venue, lineups, stats, events }, coverage_tier: tier, limitations, notes, checks_failed: fail, pass: fail.length === 0 };
if (PROMOTE) {
  if (!result.pass) throw new Error(`REFUSED: ${slug} ${label} failed ${fail.map(f => f.check).join(', ')} — stays held`);
  const r = await fetch(`${U}/rest/v1/soccer_seasons?id=eq.${season.id}`, { method: 'PATCH', headers: { ...h, 'content-type': 'application/json', prefer: 'return=minimal' }, body: JSON.stringify({ publication_state: 'published', published_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), coverage_tier: tier, source_families: providers, limitations, publication_note: `Pass A accepted ${result.at.slice(0, 10)} (scripts/history/accept-season.mjs)` }) });
  if (!r.ok) throw new Error(`promote failed ${r.status} ${await r.text()}`);
  result.promoted = true;
}
mkdirSync('docs/evidence/history', { recursive: true });
writeFileSync(`docs/evidence/history/accept-${slug}-${label.replace('/', '-')}.json`, `${JSON.stringify(result, null, 1)}\n`);
console.log(JSON.stringify({ pass: result.pass, matches: result.matches, finished: result.finished, teams: result.teams, format, tier, failed: fail.map(f => f.check), notes, promoted: !!result.promoted }));
