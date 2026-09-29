// Soccer Pro routes (/v1/pro/*). NEVER edge-cached, never shared between readers.
//   GET /v1/pro/access              membership for this reader (always 200; browser-safe)
//   GET /v1/pro/catalog             PUBLIC: what Pro evaluates, method, coverage, model status (no values)
//   GET /v1/pro/board               PREMIUM: upcoming matches with each side's fatigue / rest
//   GET /v1/pro/matches/:id         PREMIUM: Pro Match Center (fatigue, XI load, rotation, matchup lab)
//   GET /v1/pro/teams/:slug         PREMIUM: team workload intelligence
// Premium without entitlement -> 403 { error: 'all_access_required', membership: 'free' } and NO values.
import { envelope, COVERAGE } from '../envelope.js';
import { proAccess } from './access.js';
import { FATIGUE_VERSION, playerLoad, rotationPressure, squadStructure, teamFatigueIndex, teamLoad, xiLoad } from './fatigue.js';
import { MATCHUP_VERSION, matchup, teamProfile } from './matchup.js';
import { compSlugs, matchupGames, playerApps, teamWindow, teamXis } from './load.js';

const API_VERSION = 'soccer-pro/1.0.0';
const DAY = 864e5;
export const PRO_HEADERS = { 'cache-control': 'private, no-store', vary: 'Cookie' };
const E = (data, meta) => envelope(data, { version: API_VERSION, ...meta });
const WORKLOAD_NOTE = 'Workload intelligence from schedules, sourced lineups and derived minutes. It is not a medical, fitness or injury assessment and never says a player is tired, injured or at risk.';

export const MODEL_LAB = {
  status: 'research_in_progress',
  label: 'RESEARCH IN PROGRESS',
  detail: 'A Bundesliga Dixon-Coles model runs as PRIVATE research shadow (prospective, frozen pre-kick predictions). No probabilities are published until it passes formal prospective promotion criteria; other competitions are not modelled until separately validated.',
  will_include_after_promotion: ['home / draw / away %', 'goal distribution', 'correct-score distribution', 'model version and issue time', 'prospective track record'],
};

export const MODULES = [
  { key: 'fatigue', name: 'Fatigue Intelligence', evaluates: ['days since the last match', 'matches in 7 / 14 / 21 days', 'short-rest turnarounds', 'home/away sequence', 'competition switches', 'club → national team → club return load', 'player minutes 7 / 14 / 21 days, starts, consecutive starts, 75+ and 90+ appearances'], outputs: ['TEAM FATIGUE INDEX', 'XI LOAD'] },
  { key: 'rotation', name: 'Rotation / XI Stability', evaluates: ['starting-XI continuity', 'lineup churn', 'top-11 / top-14 minute concentration', 'rotation depth', 'rest differential'], outputs: ['XI STABILITY', 'ROTATION PRESSURE', 'REST DIFFERENTIAL'] },
  { key: 'matchup', name: 'Matchup Lab', evaluates: ['attack edge', 'defensive edge', 'shot profile (inside the box, channels) where located', 'set pieces where the source marks them', 'form', 'rest', 'XI stability', 'goal timing and home/away splits'], outputs: ['PBE MATCHUP RATING (descriptive, not a win probability)'] },
  { key: 'model_lab', name: 'Model Lab', evaluates: ['prospective model research'], outputs: [MODEL_LAB.label] },
];

export function denied(access) {
  return { status: 403, body: { error: 'all_access_required', membership: access.membership?.state || 'free', check: access.check } };
}

async function teamBlock(store, teamId, asOf, comps) {
  const ms = (await teamWindow(store, teamId, asOf)).map(m => ({ ...m, competition_slug: comps.get(m.competition_id) || null }));
  const load = teamLoad(ms, teamId, asOf);
  const index = teamFatigueIndex(load);
  const xis = await teamXis(store, teamId, ms.filter(m => Date.parse(m.kickoff_at) < Date.parse(asOf)));
  const squad = squadStructure(xis);
  const apps = squad.last_xi.length ? await playerApps(store, squad.last_xi, new Date(Date.parse(asOf) - 21 * DAY).toISOString(), comps) : new Map();
  const loads = new Map([...apps.entries()].map(([p, a]) => [p, playerLoad(a, asOf)]));
  const xi = xiLoad(squad.last_xi, loads, load.matches_14);
  const rotation = rotationPressure(index, squad);
  return { ms, load, index, squad, loads, xi, rotation };
}

async function people(store, ids) {
  if (!ids.length) return new Map();
  return new Map((await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: ids.slice(0, 150) } })).map(p => [p.id, p]));
}
const teamRef = t => (t ? { slug: t.slug, name: t.name, short_name: t.short_name, type: t.team_type === 'national' ? 'national' : 'club' } : null);

export async function proTeam(store, slug, access, asOf = new Date().toISOString()) {
  if (!access.granted) return denied(access);
  const [t] = await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name', 'team_type'], eq: { slug, status: 'active' }, limit: 1 });
  if (!t) return { status: 404, body: { error: `team ${slug}` } };
  const comps = await compSlugs(store);
  const b = await teamBlock(store, t.id, asOf, comps);
  const ppl = await people(store, b.squad.last_xi);
  return { status: 200, body: E({
    team: teamRef(t), as_of: asOf, versions: { fatigue: FATIGUE_VERSION },
    team_fatigue_index: b.index, load: b.load, squad: { ...b.squad, last_xi: b.squad.last_xi.map(p => ({ slug: ppl.get(p)?.slug, name: ppl.get(p)?.display_name, ...b.loads.get(p) })) },
    xi_load: { ...b.xi, players: b.xi.players.map(x => ({ ...x, player_id: undefined, slug: ppl.get(x.player_id)?.slug, name: ppl.get(x.player_id)?.display_name })) }, rotation_pressure: b.rotation,
  }, { source: 'pbe', semantics: WORKLOAD_NOTE, coverage: b.squad.matches_considered ? COVERAGE.OK : COVERAGE.PARTIAL, coverage_notes: b.squad.matches_considered ? [] : ['No sourced lineups in the window: squad and XI components are unavailable.'] }) };
}

export async function proMatch(store, id, access) {
  if (!access.granted) return denied(access);
  const [m] = await store.select('soccer_matches', { columns: ['id', 'competition_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], eq: { id }, limit: 1 });
  if (!m) return { status: 404, body: { error: `match ${id}` } };
  const comps = await compSlugs(store);
  // As of kickoff for an upcoming match; as of the instant before kickoff for a played one (no hindsight).
  const asOf = new Date(Math.min(Date.now(), Date.parse(m.kickoff_at) - 60e3)).toISOString();
  const teams = new Map((await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name', 'team_type'], in: { id: [m.home_team_id, m.away_team_id] } })).map(t => [t.id, t]));
  const [H, A] = await Promise.all([teamBlock(store, m.home_team_id, asOf, comps), teamBlock(store, m.away_team_id, asOf, comps)]);
  const [gh, ga] = await Promise.all([matchupGames(store, m.home_team_id, H.ms.filter(x => Date.parse(x.kickoff_at) < Date.parse(asOf))), matchupGames(store, m.away_team_id, A.ms.filter(x => Date.parse(x.kickoff_at) < Date.parse(asOf)))]);
  const ph = teamProfile(gh); const pa = teamProfile(ga);
  const lab = matchup(ph, pa, { homeFatigue: H.index, awayFatigue: A.index, homeSquad: H.squad, awaySquad: A.squad });
  const restH = H.load.next_match?.id === m.id ? H.load.next_match.rest_days_before : H.load.days_since_last;
  const restA = A.load.next_match?.id === m.id ? A.load.next_match.rest_days_before : A.load.days_since_last;
  const side = (b, p) => ({ team_fatigue_index: b.index, load: b.load, xi_stability: { xi_continuity: b.squad.xi_continuity, lineup_changes_avg: b.squad.lineup_changes_avg, top11_minute_share: b.squad.top11_minute_share, top14_minute_share: b.squad.top14_minute_share, rotation_depth: b.squad.rotation_depth }, xi_load: { score: b.xi.score, components: b.xi.components }, rotation_pressure: b.rotation, profile: p });
  return { status: 200, body: E({
    match: { id: m.id, kickoff_at: m.kickoff_at, status: m.status, competition: comps.get(m.competition_id), home: teamRef(teams.get(m.home_team_id)), away: teamRef(teams.get(m.away_team_id)) },
    as_of: asOf, versions: { fatigue: FATIGUE_VERSION, matchup: MATCHUP_VERSION },
    home: side(H, ph), away: side(A, pa),
    rest_differential: restH === null || restA === null || restH === undefined || restA === undefined ? null : { home_days: restH, away_days: restA, difference: Math.round((restH - restA) * 100) / 100 },
    matchup_lab: lab, model_lab: MODEL_LAB,
  }, { source: 'pbe', semantics: `${WORKLOAD_NOTE} Matchup Lab is descriptive: the PBE MATCHUP RATING leans from named components and is not a win probability. Everything is computed as of ${asOf} (no information after kickoff).`,
    coverage: ph.matches && pa.matches ? COVERAGE.OK : COVERAGE.PARTIAL, coverage_notes: [ph.matches ? null : 'Home side: no finished matches in the window.', pa.matches ? null : 'Away side: no finished matches in the window.'].filter(Boolean) }) };
}

export async function proBoard(store, access) {
  if (!access.granted) return denied(access);
  const now = new Date().toISOString();
  const upcoming = await store.select('soccer_matches', { columns: ['id', 'competition_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id'], eq: { status: 'scheduled' }, gte: { kickoff_at: now }, lte: { kickoff_at: new Date(Date.now() + 7 * DAY).toISOString() }, order: 'kickoff_at.asc', limit: 16 });
  const comps = await compSlugs(store);
  const teamIds = [...new Set(upcoming.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teams = new Map((await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name', 'team_type'], in: teamIds.length ? { id: teamIds } : { id: ['00000000-0000-0000-0000-000000000000'] } })).map(t => [t.id, t]));
  const loadOf = new Map();
  for (const tid of teamIds) {
    const ms = (await teamWindow(store, tid, now, { backDays: 21, aheadDays: 8 })).map(m => ({ ...m, competition_slug: comps.get(m.competition_id) || null }));
    const load = teamLoad(ms, tid, now); loadOf.set(tid, { load, index: teamFatigueIndex(load) });
  }
  const side = tid => ({ team: teamRef(teams.get(tid)), team_fatigue_index: loadOf.get(tid).index.score, days_since_last: loadOf.get(tid).load.days_since_last, matches_14: loadOf.get(tid).load.matches_14 });
  return { status: 200, body: E(upcoming.map(m => ({ id: m.id, kickoff_at: m.kickoff_at, competition: comps.get(m.competition_id), home: side(m.home_team_id), away: side(m.away_team_id) })), { source: 'pbe', semantics: `Upcoming matches (7 days) with each side's TEAM FATIGUE INDEX. ${WORKLOAD_NOTE}` }) };
}

export async function proCatalog(store) {
  const [comps, finished, lineups] = await Promise.all([
    store.select('soccer_competitions', { columns: ['slug', 'name'] }),
    store.count('soccer_matches', { eq: { status: 'finished' } }),
    store.count('soccer_lineups'),
  ]);
  return { status: 200, body: E({
    product: 'Soccer Pro', access: 'PropBetEdge All Access', all_access_url: 'https://propbetedge.ai/pro', offer: { price: '$29/month', promo_code: 'THEEDGE25', promo_line: '25% off while active with code THEEDGE25', scope: 'every current and future PropBetEdge Pro sport' },
    modules: MODULES, model_lab: MODEL_LAB, coverage: { competitions: comps.map(c => c.slug), finished_matches: finished, sourced_lineups: lineups },
    free_includes: ['news', 'fixtures and results', 'verified tables', 'match intelligence', 'PBEcast', 'Player DNA', 'team pages', 'competition hubs', 'official video', 'sources and method'],
  }, { source: 'pbe', semantics: 'What Soccer Pro evaluates and how. Contains no premium values.' }) };
}

export async function handlePro(req, env, store, path) {
  if (path === 'catalog') return proCatalog(store); // public: no session lookup
  const access = await proAccess(req, env);
  if (path === 'access') return { status: 200, body: E({ membership: access.membership, check: access.check, pro: access.granted }, { source: 'propbetedge-auth', semantics: 'The Soccer membership of this reader, decided server-side by the PropBetEdge network auth (All Access or owner = Pro).' }) };
  if (path === 'board') return proBoard(store, access);
  let m = path.match(/^matches\/([0-9a-f-]{36})$/);
  if (m) return proMatch(store, m[1], access);
  m = path.match(/^teams\/([a-z0-9-]{1,120})$/);
  if (m) return proTeam(store, m[1], access);
  return { status: 404, body: { error: 'not found' } };
}
