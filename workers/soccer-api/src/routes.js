// soccer-api route handlers. Pure functions of (store, params) -> envelope, so
// they are testable against PGlite and served from PostgREST in production.
// Never exposes: raw captures, the identity queue, source-change ledger,
// provider disagreement tooling, service-role data, or bulk dumps (lists cap at 100).

import { computeTable } from '../../soccer-news/src/packet.js';
import { toMatchFrame } from '../../shared/coords.js';
import { displayMinute } from '../../shared/clock.js';
import { COVERAGE, envelope, maxTs } from './envelope.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';

export const API_VERSION = 'soccer-api/1.0.0';
const E = (data, o) => envelope(data, { version: API_VERSION, ...o });
export class NotFound extends Error { constructor(what) { super(`${what} not found`); this.status = 404; } }
const clampLimit = (v, d = 50) => Math.max(1, Math.min(100, Number(v) || d));

const TEAM_COLS = ['id', 'slug', 'name', 'short_name', 'official_name', 'team_type', 'country_code', 'city'];
const PLAYER_COLS = ['id', 'slug', 'display_name', 'first_name', 'last_name', 'birth_date', 'nationality_code', 'foot', 'height_cm', 'primary_role'];
const MATCH_COLS = ['id', 'competition_id', 'season_id', 'matchday', 'round_label', 'kickoff_at', 'venue_id', 'home_team_id', 'away_team_id', 'status', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht', 'duration', 'winner_team_id', 'result_provider', 'updated_at'];

async function teamsById(store, ids) {
  const out = new Map();
  for (const part of chunkArr([...new Set(ids.filter(Boolean))], 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name'], in: { id: part } })) out.set(t.id, t);
  return out;
}

function shapeMatch(m, teams) {
  const t = id => { const x = teams.get(id); return x ? { id: x.id, slug: x.slug, name: x.name, short_name: x.short_name } : { id }; };
  return {
    id: m.id, matchday: m.matchday, round: m.round_label, kickoff_at: m.kickoff_at, status: m.status,
    home: t(m.home_team_id), away: t(m.away_team_id),
    score: m.home_score === null ? null : { home: m.home_score, away: m.away_score, home_ht: m.home_score_ht, away_ht: m.away_score_ht },
    result_source: m.result_provider,
  };
}

async function competitionBySlug(store, slug) {
  const [c] = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type', 'gender', 'country_code', 'tier', 'updated_at'], eq: { slug }, limit: 1 });
  if (!c) throw new NotFound(`competition ${slug}`);
  return c;
}

async function seasonsOf(store, competitionId) {
  return (await store.select('soccer_seasons', { columns: ['id', 'label', 'start_date', 'end_date'], eq: { competition_id: competitionId } }))
    .sort((a, b) => (a.label < b.label ? 1 : -1));
}

export async function health(store, { lanes = [] } = {}) {
  const t0 = Date.now();
  const competitions = await store.count('soccer_competitions');
  const dbMs = Date.now() - t0;
  const stale = lanes.filter(l => l.priority && (!l.last_success_at || Date.now() - Date.parse(l.last_success_at) > 3 * 3600e3));
  return E({ ok: competitions > 0 && stale.length === 0, db_ms: dbMs, competitions, lanes: lanes.map(l => ({ lane: l.lane, health: l.health, last_success_at: l.last_success_at })) }, {
    source: 'pbe', semantics: 'Service health: canonical store reachable and priority ingest lanes fresh (< 3 h).',
    coverage: stale.length ? COVERAGE.DEGRADED : COVERAGE.OK, coverage_notes: stale.map(l => `${l.lane} stale`), source_updated_at: maxTs(lanes.map(l => l.last_success_at)),
  });
}

export async function competitions(store) {
  const comps = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type', 'gender', 'country_code', 'tier', 'updated_at'] });
  const out = [];
  for (const c of comps) {
    const seasons = await seasonsOf(store, c.id);
    const matches = await store.count('soccer_matches', { eq: { competition_id: c.id } });
    if (!matches) continue; // registry-only competitions with no data are not listed
    out.push({ slug: c.slug, name: c.name, type: c.comp_type, country_code: c.country_code, seasons: seasons.length, latest_season: seasons[0]?.label || null, matches });
  }
  return E(out, { source: 'pbe', semantics: 'Competitions with canonical matches stored by PropBetEdge.', source_updated_at: maxTs(comps.map(c => c.updated_at)) });
}

export async function competition(store, slug) {
  const c = await competitionBySlug(store, slug);
  const seasons = await seasonsOf(store, c.id);
  const withCounts = [];
  for (const s of seasons) {
    const n = await store.count('soccer_matches', { eq: { season_id: s.id } });
    withCounts.push({ label: s.label, start_date: s.start_date, end_date: s.end_date, matches: n });
  }
  return E({ slug: c.slug, name: c.name, type: c.comp_type, country_code: c.country_code, tier: c.tier, seasons: withCounts }, {
    source: 'pbe', semantics: 'Competition and the seasons stored for it.', source_updated_at: c.updated_at,
  });
}

export async function matches(store, q) {
  const opts = { columns: MATCH_COLS, eq: {}, order: 'kickoff_at.desc', limit: clampLimit(q.limit) };
  if (q.competition) opts.eq.competition_id = (await competitionBySlug(store, q.competition)).id;
  if (q.season && q.competition) {
    const s = (await seasonsOf(store, opts.eq.competition_id)).find(x => x.label === q.season);
    if (!s) throw new NotFound(`season ${q.season}`);
    opts.eq.season_id = s.id; delete opts.eq.competition_id;
  }
  if (q.status) opts.eq.status = q.status;
  if (q.date) { opts.gte = { kickoff_at: `${q.date}T00:00:00Z` }; opts.lte = { kickoff_at: `${q.date}T23:59:59Z` }; opts.order = 'kickoff_at.asc'; }
  if (q.team) {
    const [t] = await store.select('soccer_teams', { columns: ['id'], eq: { slug: q.team }, limit: 1 });
    if (!t) throw new NotFound(`team ${q.team}`);
    const [h, a] = await Promise.all([store.select('soccer_matches', { ...opts, eq: { ...opts.eq, home_team_id: t.id } }), store.select('soccer_matches', { ...opts, eq: { ...opts.eq, away_team_id: t.id } })]);
    const rows = [...h, ...a].sort((x, y) => (opts.order === 'kickoff_at.asc' ? 1 : -1) * (Date.parse(x.kickoff_at) - Date.parse(y.kickoff_at))).slice(0, opts.limit);
    const teams = await teamsById(store, rows.flatMap(r => [r.home_team_id, r.away_team_id]));
    return E(rows.map(r => shapeMatch(r, teams)), { source: 'pbe', semantics: 'Canonical matches (max 100 per page).', source_updated_at: maxTs(rows.map(r => r.updated_at)), attribution: [...new Set(rows.map(r => r.result_provider))] });
  }
  const rows = await store.select('soccer_matches', opts);
  const teams = await teamsById(store, rows.flatMap(r => [r.home_team_id, r.away_team_id]));
  return E(rows.map(r => shapeMatch(r, teams)), { source: 'pbe', semantics: 'Canonical matches (max 100 per page).', source_updated_at: maxTs(rows.map(r => r.updated_at)), attribution: [...new Set(rows.map(r => r.result_provider))], coverage: rows.length ? COVERAGE.OK : COVERAGE.PARTIAL });
}

export async function match(store, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFound('match');
  const [m] = await store.select('soccer_matches', { columns: MATCH_COLS, eq: { id }, limit: 1 });
  if (!m) throw new NotFound('match');
  const teams = await teamsById(store, [m.home_team_id, m.away_team_id]);
  const [comp] = await store.select('soccer_competitions', { columns: ['slug', 'name'], eq: { id: m.competition_id }, limit: 1 });
  const [season] = await store.select('soccer_seasons', { columns: ['label'], eq: { id: m.season_id }, limit: 1 });
  const venue = m.venue_id ? (await store.select('soccer_venues', { columns: ['name', 'city'], eq: { id: m.venue_id }, limit: 1 }))[0] : null;
  const sources = await store.select('soccer_match_source_results', { columns: ['provider', 'observed_at'], eq: { match_id: id } });

  // Key events only (goals, cards, shots) — never the full ledger.
  const keyEvents = await store.select('soccer_match_events', {
    columns: ['sequence', 'period', 'minute', 'team_id', 'player_id', 'event_type', 'subtype', 'outcome', 'is_goal', 'is_own_goal', 'card', 'set_piece', 'body_part', 'x_m', 'y_m', 'source_family', 'qualifiers'],
    eq: { match_id: id }, in: { event_type: ['shot', 'goal', 'foul'] }, order: 'sequence.asc',
  });
  const own = await store.select('soccer_match_events', { columns: ['sequence', 'period', 'minute', 'team_id', 'player_id', 'event_type', 'is_own_goal', 'card', 'source_family', 'qualifiers', 'x_m', 'y_m', 'is_goal', 'outcome', 'subtype', 'set_piece', 'body_part'], eq: { match_id: id, is_own_goal: true } });
  const evs = [...keyEvents.filter(e => e.event_type !== 'foul' || e.card), ...own.filter(o => !keyEvents.some(k => k.sequence === o.sequence && k.source_family === o.source_family))].sort((a, b) => a.sequence - b.sequence);
  const playerIds = [...new Set(evs.map(e => e.player_id).filter(Boolean))];

  const lineups = await store.select('soccer_lineups', { columns: ['id', 'team_id', 'formation', 'manager_id'], eq: { match_id: id } });
  const lp = lineups.length ? await store.select('soccer_lineup_players', { columns: ['lineup_id', 'player_id', 'is_starter', 'shirt_number', 'position'], in: { lineup_id: lineups.map(l => l.id) } }) : [];
  const subs = await store.select('soccer_substitutions', { columns: ['team_id', 'player_out_id', 'player_in_id', 'minute'], eq: { match_id: id } });
  const allPlayers = [...new Set([...playerIds, ...lp.map(x => x.player_id), ...subs.flatMap(s => [s.player_in_id, s.player_out_id])])];
  const people = new Map();
  for (const part of chunkArr(allPlayers, 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: part } })) people.set(p.id, p);
  const mgrIds = lineups.map(l => l.manager_id).filter(Boolean);
  const mgrs = mgrIds.length ? new Map((await store.select('soccer_managers', { columns: ['id', 'slug', 'display_name'], in: { id: mgrIds } })).map(x => [x.id, x])) : new Map();
  const person = pid => { const p = people.get(pid); return p ? { id: p.id, slug: p.slug, name: p.display_name } : null; };
  const side = tid => (tid === m.home_team_id ? 'home' : tid === m.away_team_id ? 'away' : null);

  const timeline = evs.filter(e => e.is_goal || e.is_own_goal || e.card).map(e => ({
    minute: e.minute, display_minute: displayMinute(e.period, e.minute), team: side(e.team_id), type: e.is_goal ? 'goal' : e.is_own_goal ? 'own_goal' : `card_${e.card}`,
    player: person(e.player_id) || (e.qualifiers?.source_player ? { name: e.qualifiers.source_player.name, resolved: false } : null),
    penalty: e.set_piece === 'penalty', source: e.source_family,
  }));
  const shots = evs.filter(e => e.event_type === 'shot' && e.x_m !== null).map(e => {
    const mf = toMatchFrame({ x_m: Number(e.x_m), y_m: Number(e.y_m) }, { isHomeTeam: e.team_id === m.home_team_id });
    return { minute: e.minute, team: side(e.team_id), player: person(e.player_id), outcome: e.outcome, x: mf.x, y: mf.y };
  });
  const stats = await store.select('soccer_team_match_stats', { columns: ['team_id', 'stat_key', 'value', 'basis', 'derivation_version'], eq: { match_id: id } });
  const statsOut = { home: {}, away: {}, derivation: stats[0]?.derivation_version || null };
  for (const s of stats) if (side(s.team_id)) statsOut[side(s.team_id)][s.stat_key] = Number(s.value);

  const lineupOut = Object.fromEntries(lineups.map(l => [side(l.team_id), {
    manager: mgrs.get(l.manager_id) ? { slug: mgrs.get(l.manager_id).slug, name: mgrs.get(l.manager_id).display_name } : null,
    formation: l.formation,
    starters: lp.filter(x => x.lineup_id === l.id && x.is_starter).map(x => person(x.player_id)),
    bench: lp.filter(x => x.lineup_id === l.id && !x.is_starter).map(x => person(x.player_id)),
  }]));
  const hasLedger = shots.length > 0;
  const notes = [];
  if (!hasLedger) notes.push('No event ledger with coordinates for this match: timeline shows reported goals only.');
  if (!lineups.length) notes.push('Lineups not available from a legitimate source for this match.');
  if (timeline.some(t => t.player && t.player.resolved === false)) notes.push('Some scorers are awaiting identity resolution.');
  return E({
    ...shapeMatch(m, teams), competition: comp, season: season?.label, venue,
    timeline, shots, stats: stats.length ? statsOut : null, lineups: lineups.length ? lineupOut : null,
    substitutions: subs.map(s => ({ minute: s.minute, team: side(s.team_id), in: person(s.player_in_id), out: person(s.player_out_id) })),
    coordinates: hasLedger ? { system: '105x68 m, match frame: home attacks toward x=105', note: 'Event locations, not player tracking.' } : null,
  }, {
    source: 'pbe', source_updated_at: maxTs(m.updated_at, sources.map(s => s.observed_at)),
    semantics: 'Canonical match assembled by PropBetEdge. Counts are derived from the event ledger (pbe-counts); shot locations on the 105x68 canonical pitch.',
    coverage: notes.length ? COVERAGE.PARTIAL : COVERAGE.OK, coverage_notes: notes,
    attribution: [...new Set([...sources.map(s => s.provider), ...(hasLedger ? ['wyscout'] : [])])],
  });
}

export async function team(store, slug) {
  const [t] = await store.select('soccer_teams', { columns: [...TEAM_COLS, 'updated_at'], eq: { slug, status: 'active' }, limit: 1 });
  if (!t) throw new NotFound(`team ${slug}`);
  const [h, a] = await Promise.all([
    store.select('soccer_matches', { columns: MATCH_COLS, eq: { home_team_id: t.id }, order: 'kickoff_at.desc', limit: 40 }),
    store.select('soccer_matches', { columns: MATCH_COLS, eq: { away_team_id: t.id }, order: 'kickoff_at.desc', limit: 40 }),
  ]);
  const all = [...h, ...a].sort((x, y) => Date.parse(y.kickoff_at) - Date.parse(x.kickoff_at));
  const recent = all.filter(x => x.status === 'finished').slice(0, 10);
  const next = all.filter(x => x.status === 'scheduled').sort((x, y) => Date.parse(x.kickoff_at) - Date.parse(y.kickoff_at)).slice(0, 5);
  const teams = await teamsById(store, [...recent, ...next].flatMap(r => [r.home_team_id, r.away_team_id]));
  const form = recent.slice(0, 5).map(x => { const gf = x.home_team_id === t.id ? x.home_score : x.away_score; const ga = x.home_team_id === t.id ? x.away_score : x.home_score; return gf > ga ? 'W' : gf < ga ? 'L' : 'D'; });
  return E({ id: t.id, slug: t.slug, name: t.name, official_name: t.official_name, type: t.team_type, country_code: t.country_code, city: t.city, form, recent: recent.map(r => shapeMatch(r, teams)), upcoming: next.map(r => shapeMatch(r, teams)) }, {
    source: 'pbe', semantics: 'Canonical team; form = last 5 finished canonical matches (W/D/L), newest first.', source_updated_at: maxTs(t.updated_at, recent.map(r => r.updated_at)),
    attribution: [...new Set(all.map(r => r.result_provider))],
  });
}

export async function player(store, slug) {
  const [p] = await store.select('soccer_players', { columns: [...PLAYER_COLS, 'updated_at'], eq: { slug, status: 'active' }, limit: 1 });
  if (!p) throw new NotFound(`player ${slug}`);
  const stats = await store.select('soccer_player_match_stats', { columns: ['match_id', 'team_id', 'stat_key', 'value'], eq: { player_id: p.id, basis: 'derived' } });
  const byMatch = new Map();
  for (const s of stats) byMatch.set(s.match_id, { ...(byMatch.get(s.match_id) || { team_id: s.team_id }), [s.stat_key]: Number(s.value) });
  const matchIds = [...byMatch.keys()];
  const ms = [];
  for (const part of chunkArr(matchIds, 150)) ms.push(...await store.select('soccer_matches', { columns: ['id', 'season_id', 'competition_id', 'kickoff_at'], in: { id: part } }));
  const seasonIds = [...new Set(ms.map(x => x.season_id))];
  const seasons = seasonIds.length ? new Map((await store.select('soccer_seasons', { columns: ['id', 'label'], in: { id: seasonIds } })).map(s => [s.id, s.label])) : new Map();
  const totals = {};
  for (const m of ms) {
    const label = seasons.get(m.season_id);
    const t = totals[label] || (totals[label] = { season: label, appearances: 0 });
    const row = byMatch.get(m.id);
    if ((row.minutes_nominal || 0) > 0) t.appearances += 1;
    for (const [k, v] of Object.entries(row)) if (k !== 'team_id') t[k] = (t[k] || 0) + v;
  }
  const goalsReported = await store.count('soccer_match_events', { eq: { player_id: p.id, source_family: 'openligadb', is_goal: true } });
  return E({
    id: p.id, slug: p.slug, name: p.display_name, first_name: p.first_name, last_name: p.last_name, birth_date: p.birth_date,
    nationality_code: p.nationality_code, foot: p.foot, height_cm: p.height_cm, role: p.primary_role,
    seasons: Object.values(totals).sort((a, b) => (a.season < b.season ? 1 : -1)), reported_goals_other_seasons: goalsReported,
  }, {
    source: 'pbe', semantics: 'Per-season totals of pbe-counts derived from the event ledger (seasons with an event ledger only); minutes are nominal (90/120, cut at substitution/dismissal). reported_goals_other_seasons counts goals reported by OpenLigaDB in seasons without a ledger.',
    coverage: Object.keys(totals).length ? COVERAGE.PARTIAL : COVERAGE.UNAVAILABLE, coverage_notes: ['Event-level statistics exist only for seasons with a legitimate event ledger (Bundesliga 2017/18).'],
    source_updated_at: p.updated_at, attribution: Object.keys(totals).length ? ['wyscout'] : [],
  });
}

export async function table(store, q) {
  const c = await competitionBySlug(store, q.competition || 'bundesliga');
  const seasons = await seasonsOf(store, c.id);
  const season = q.season ? seasons.find(s => s.label === q.season) : seasons[0];
  if (!season) throw new NotFound(`season ${q.season}`);
  const leagueStages = (await store.select('soccer_stages', { columns: ['id'], eq: { season_id: season.id, stage_type: 'league' } })).map(s => s.id);
  const played = leagueStages.length ? await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'kickoff_at', 'updated_at', 'result_provider'], eq: { season_id: season.id, status: 'finished' }, in: { stage_id: leagueStages } }) : [];
  const valid = played.filter(x => x.home_score !== null && x.away_score !== null);
  const rows = computeTable(valid);
  const teams = await teamsById(store, rows.map(r => r.team_id));
  return E({
    competition: c.slug, season: season.label, matches_counted: valid.length,
    rows: rows.map((r, i) => ({ position: i + 1, team: { slug: teams.get(r.team_id)?.slug, name: teams.get(r.team_id)?.name }, played: r.played, points: r.points, goals_for: r.gf, goals_against: r.ga, goal_difference: r.gd })),
  }, {
    source: 'pbe', semantics: 'Table computed by PropBetEdge from canonical finished league-stage results (play-offs excluded). Order: points, goal difference, goals for (head-to-head and deductions not applied).',
    source_updated_at: maxTs(valid.map(x => x.updated_at)), attribution: [...new Set(valid.map(x => x.result_provider))],
    coverage: valid.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE,
  });
}

export async function news(store, q) {
  const opts = { columns: ['slug', 'desk', 'story_class', 'headline', 'dek', 'published_at', 'updated_at'], eq: { status: 'published' }, order: 'published_at.desc', limit: clampLimit(q.limit, 20) };
  if (q.desk) opts.eq.desk = q.desk;
  const rows = await store.select('soccer_articles', opts);
  return E(rows, { source: 'pbe', semantics: 'Published PropBetEdge articles only; every article is backed by a frozen evidence packet and passed all publication gates.', coverage: rows.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: rows.length ? [] : ['Newsroom not launched.'], source_updated_at: maxTs(rows.map(r => r.updated_at)) });
}

export async function article(store, slug) {
  const [a] = await store.select('soccer_articles', { columns: ['slug', 'desk', 'story_class', 'headline', 'dek', 'body', 'entities', 'published_at', 'updated_at', 'packet_hash', 'composer', 'gate_version'], eq: { slug, status: 'published' }, limit: 1 });
  if (!a) throw new NotFound(`article ${slug}`);
  return E(a, { source: 'pbe', semantics: 'Published article; packet_hash identifies the frozen evidence packet behind every figure.', source_updated_at: a.updated_at });
}
