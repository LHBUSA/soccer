#!/usr/bin/env node
// FIFA World Cup PRODUCTION certification (read-only): verifies the canonical rows the bounded production ingest
// wrote, through the same route code soccer-api serves. Independent result check against openfootball
// worldcup.json (CC0, registry key 'openfootball'): a VALIDATION by normalised team name + date only, never an
// identity input and never written anywhere.
//   node scripts/canary/world-cup-prod-cert.mjs [--season 2026]
// Output: docs/evidence/espn/fifa-world-cup-production-<date>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { politeFetch } from '../../workers/shared/http.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { provenBracket } from '../../workers/shared/bracket.js';
import * as R from '../../workers/soccer-api/src/routes.js';
import * as C from '../../workers/soccer-api/src/cast.js';

const SLUG = 'fifa-world-cup';
const argv = process.argv.slice(2);
const SEASON = argv.includes('--season') ? argv[argv.indexOf('--season') + 1] : '2026';
const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const sel = (t, o) => store.select(t, o);
async function selectIn(t, col, vals, o = {}) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await sel(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return out; }
const report = { generated_at: new Date().toISOString(), mode: 'read-only production certification', competition: SLUG, season: SEASON, checks: {} };
const check = (k, pass, detail) => { report.checks[k] = { pass: !!pass, ...detail }; };

const [c] = await sel('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type'], eq: { slug: SLUG } });
check('competition_exists', !!c, { row: c || null });
const seasons = c ? await sel('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } }) : [];
const season = seasons.find(s => s.label === SEASON);
check('season_exists', !!season, { seasons: seasons.map(s => s.label) });
const matches = season ? await sel('soccer_matches', { columns: ['id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'home_pens', 'away_pens', 'duration', 'winner_team_id', 'result_provider'], eq: { season_id: season.id } }) : [];
const stages = season ? (await sel('soccer_stages', { columns: ['id', 'name', 'stage_type', 'stage_order'], eq: { season_id: season.id } })).sort((a, b) => a.stage_order - b.stage_order) : [];
const teamIds = [...new Set(matches.flatMap(m => [m.home_team_id, m.away_team_id]))];
const teams = await selectIn('soccer_teams', 'id', teamIds, { columns: ['id', 'name', 'team_type', 'founding_provider', 'country_code'] });
const teamX = await selectIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'external_id', 'method'], eq: { provider: 'espn' } });
check('national_teams_only', teams.length > 0 && teams.every(t => t.team_type === 'national'), { teams: teams.length, clubs: teams.filter(t => t.team_type !== 'national').map(t => t.name) });
check('no_duplicate_nation', teamX.length === teamIds.length && new Set(teamX.map(x => x.external_id)).size === teamX.length && new Set(teams.map(t => t.name.toLowerCase())).size === teams.length, { espn_ids: teamX.length, team_ids: teamIds.length, methods: teamX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}) });
check('no_guessed_flags', teams.every(t => !t.country_code), { with_country_code: teams.filter(t => t.country_code).length });
const fin = matches.filter(m => m.status === 'finished');
check('matches_exist', matches.length > 0, { matches: matches.length, by_status: matches.reduce((o, m) => ({ ...o, [m.status]: (o[m.status] || 0) + 1 }), {}) });
// scores reconcile: canonical row = ESPN source observation
const src = await selectIn('soccer_match_source_results', 'match_id', fin.map(m => m.id), { columns: ['match_id', 'provider', 'status', 'home_score', 'away_score'], eq: { provider: 'espn' } });
const bySrc = new Map(src.map(s => [s.match_id, s]));
const mism = fin.filter(m => { const s = bySrc.get(m.id); return !s || s.home_score !== m.home_score || s.away_score !== m.away_score; });
check('scores_reconcile_with_source', fin.length > 0 && mism.length === 0 && fin.every(m => m.home_score !== null && m.away_score !== null), { finished: fin.length, mismatches: mism.map(m => m.id) });
const ko = stages.filter(s => s.stage_type === 'knockout');
check('knockout_stages_exist', ko.length > 0, { stages: stages.map(s => ({ name: s.name, type: s.stage_type, matches: matches.filter(m => m.stage_id === s.id).length })) });
check('knockout_winners_stored', fin.filter(m => ko.some(s => s.id === m.stage_id)).every(m => m.winner_team_id), { shootouts: fin.filter(m => m.duration === 'penalties').length, extra_time: fin.filter(m => m.duration === 'extra_time').length });
const br = provenBracket(ko, matches);
check('bracket', true, { proven: br.proven, edges: br.edges.length, unproven: br.unproven.length, note: 'informational: edges are only ever drawn where proven' });
// groups
const groups = season ? await sel('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'group_type'], eq: { season_id: season.id } }) : [];
const members = await selectIn('soccer_season_group_members', 'group_id', groups.map(g => g.id), { columns: ['group_id', 'team_id'] });
check('group_memberships_exist', groups.length > 0 && members.length > 0, { groups: groups.length, members: members.length });
let table = null;
try {
  const idx = await R.table(store, { competition: SLUG, season: SEASON });
  table = { verified: idx.data.verified_groups, withheld: idx.data.withheld_groups, groups: idx.data.groups.map(g => ({ key: g.key, verified: g.verified, withheld_reason: g.withheld_reason || null })) };
} catch (e) { table = { error: e.message }; }
check('group_standings_verify', table && table.withheld === 0 && table.verified === groups.length, table);
// events / lineups only where sourced
const ev = await selectIn('soccer_match_events', 'match_id', fin.map(m => m.id), { columns: ['match_id', 'capture_id', 'source_family'] });
check('events_sourced', ev.every(e => e.capture_id && e.source_family === 'espn'), { events: ev.length, matches_with_events: new Set(ev.map(e => e.match_id)).size, without_capture: ev.filter(e => !e.capture_id).length });
const lu = await selectIn('soccer_lineups', 'match_id', matches.map(m => m.id), { columns: ['id', 'match_id', 'capture_id', 'provider'] });
check('lineups_sourced', lu.every(l => l.capture_id && l.provider === 'espn'), { lineups: lu.length, matches_with_both: fin.filter(m => lu.filter(l => l.match_id === m.id).length === 2).length });
const enr = await selectIn('soccer_match_enrichment', 'match_id', fin.map(m => m.id), { columns: ['match_id', 'component', 'status', 'detail'] });
const unresolved = enr.filter(e => e.component.startsWith('lineup') && e.status === 'complete').reduce((n, e) => n + (Number(e.detail?.players_unresolved) || 0), 0);
const lps = await selectIn('soccer_lineup_players', 'lineup_id', lu.map(l => l.id), { columns: ['player_id'] });
const players = await selectIn('soccer_players', 'id', lps.map(x => x.player_id), { columns: ['id', 'display_name', 'birth_date'] });
check('players_unresolved_not_invented', players.every(p => p.display_name && p.birth_date), { lineup_players: new Set(lps.map(x => x.player_id)).size, unresolved_lineup_places: unresolved, enrichment_gaps: enr.filter(e => e.status !== 'complete' && e.status !== 'not_applicable').map(e => `${e.match_id}:${e.component}:${e.status}`) });
// API + PBEcast on a real match
const comp = await R.competition(store, SLUG, { season: SEASON });
const deep = [...fin].sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at)).find(m => ev.some(e => e.match_id === m.id));
let cast = null;
if (deep) { const cc = await C.cast(store, deep.id, {}); cast = { match_id: deep.id, mode: cc.data.live?.mode ?? null, sequence: cc.data.sequence?.length ?? 0 }; }
check('api_competition', comp.data.current?.team_kind === 'national' && comp.data.current?.state === 'completed', { state: comp.data.current?.state, stages: comp.data.current?.stages?.map(s => s.key), coverage: comp.data.current?.coverage });
check('pbecast_replay_payload', cast && cast.mode === 'replay' && cast.sequence > 0, cast || {});
// independent validation: openfootball worldcup.json (CC0)
try {
  const r = await politeFetch(`https://raw.githubusercontent.com/openfootball/worldcup.json/master/${SEASON}/worldcup.json`);
  const of = JSON.parse(new TextDecoder().decode(r.bytes));
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
  const tname = new Map(teams.map(t => [t.id, norm(t.name)]));
  const ofm = (of.matches || []).filter(x => x.score?.ft);
  const key = (d, a, b) => `${d}|${[a, b].sort().join('|')}`;
  const ofIdx = new Map(ofm.map(x => [key(x.date, norm(x.team1), norm(x.team2)), x]));
  let agree = 0; const disagree = []; const unmatched = [];
  for (const m of fin) {
    const d = new Date(m.kickoff_at); const days = [0, -1, 1].map(k => new Date(d.getTime() + k * 864e5).toISOString().slice(0, 10));
    const hit = days.map(dd => ofIdx.get(key(dd, tname.get(m.home_team_id), tname.get(m.away_team_id)))).find(Boolean);
    if (!hit) { unmatched.push(m.id); continue; }
    const [a, b] = norm(hit.team1) === tname.get(m.home_team_id) ? hit.score.ft : [...hit.score.ft].reverse();
    const et = hit.score.et ? (norm(hit.team1) === tname.get(m.home_team_id) ? hit.score.et : [...hit.score.et].reverse()) : null;
    if ((a === m.home_score && b === m.away_score) || (et && et[0] === m.home_score && et[1] === m.away_score)) agree += 1; else disagree.push({ id: m.id, canonical: `${m.home_score}-${m.away_score}`, openfootball: `${a}-${b}${et ? ` (aet ${et[0]}-${et[1]})` : ''}` });
  }
  check('openfootball_validation', disagree.length === 0, { source: 'openfootball worldcup.json (CC0), validation only', openfootball_matches_with_score: ofm.length, agree, disagree, unmatched_by_name: unmatched.length });
} catch (e) { report.checks.openfootball_validation = { pass: null, skipped: String(e.message || e) }; }
report.pass = Object.entries(report.checks).filter(([k]) => k !== 'openfootball_validation').every(([, v]) => v.pass);
mkdirSync('docs/evidence/espn', { recursive: true });
const out = `docs/evidence/espn/fifa-world-cup-production-${report.generated_at.slice(0, 10)}.json`;
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(out, 'pass', report.pass, JSON.stringify(Object.fromEntries(Object.entries(report.checks).map(([k, v]) => [k, v.pass]))));
