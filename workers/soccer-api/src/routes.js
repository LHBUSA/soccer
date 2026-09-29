import { articleVideos, videosFeed } from './video.js';
// soccer-api route handlers. Pure functions of (store, params) -> envelope, so
// they are testable against PGlite and served from PostgREST in production.
// Never exposes: raw captures, the identity queue, source-change ledger,
// provider disagreement tooling, service-role data, or bulk dumps (lists cap at 100).

import { computeTable, TIEBREAKS } from '../../soccer-news/src/packet.js';
import { selectSubject, subjectMedia } from '../../shared/news-subject.js';
import { visualIntact } from '../../soccer-news/src/visuals.js';
import { toMatchFrame } from '../../shared/coords.js';
import { displayMinute } from '../../shared/clock.js';
import { COVERAGE, envelope, maxTs } from './envelope.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { ownGoalBeneficiary } from '../../shared/own-goals.js';

export const API_VERSION = 'soccer-api/1.2.0';
const E = (data, o) => envelope(data, { version: API_VERSION, ...o });
export class NotFound extends Error { constructor(what) { super(`${what} not found`); this.status = 404; } }
const clampLimit = (v, d = 50) => Math.max(1, Math.min(100, Number(v) || d));

const TEAM_COLS = ['id', 'slug', 'name', 'short_name', 'official_name', 'team_type', 'country_code', 'city'];
const PLAYER_COLS = ['id', 'slug', 'display_name', 'first_name', 'last_name', 'birth_date', 'nationality_code', 'foot', 'height_cm', 'primary_role'];
const MATCH_COLS = ['id', 'competition_id', 'season_id', 'matchday', 'round_label', 'kickoff_at', 'venue_id', 'home_team_id', 'away_team_id', 'status', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht', 'duration', 'winner_team_id', 'result_provider', 'updated_at'];

// Media: ONLY displayable rows with a cached copy are ever exposed (rights_status is filtered here,
// in the one query every media read goes through). Displayable = 'approved' (independently
// free-licensed) or 'owner_approved_identification' (owner product decision 2026-09-28; NOT a
// licence, provenance kept truthful and exposed as `basis`).
export const DISPLAYABLE = ['approved', 'owner_approved_identification'];
const MEDIA_COLS = ['entity_id', 'media_type', 'cached_url', 'width', 'height', 'license', 'license_url', 'author', 'attribution', 'source', 'source_url', 'is_primary', 'rights_status'];
export async function approvedMedia(store, entityType, ids, { mediaType = null, primaryOnly = false } = {}) {
  const out = new Map();
  for (const part of chunkArr([...new Set(ids.filter(Boolean))], 150)) {
    const eq = { entity_type: entityType, ...(mediaType ? { media_type: mediaType } : {}), ...(primaryOnly ? { is_primary: true } : {}) };
    for (const r of await store.select('soccer_entity_media', { columns: MEDIA_COLS, eq, in: { entity_id: part, rights_status: DISPLAYABLE } })) {
      if (!r.cached_url) continue;
      out.set(r.entity_id, [...(out.get(r.entity_id) || []), shapeMedia(r)]);
    }
  }
  return out;
}
// Small portrait descriptor for lists (lineups, impact, directory, news cards): approved primary only.
export async function portraitMap(store, ids) {
  const out = new Map();
  for (const [id, list] of await approvedMedia(store, 'player', ids, { mediaType: 'portrait', primaryOnly: true })) out.set(id, { url: list[0].url, attribution: list[0].attribution, license: list[0].license });
  return out;
}
const shapeMedia = r => ({ media_type: r.media_type, url: r.cached_url, width: r.width, height: r.height, license: r.license, license_url: r.license_url, author: r.author, attribution: r.attribution, source: r.source, source_url: r.source_url, primary: r.is_primary, basis: r.rights_status === 'approved' ? 'free_license' : 'owner_approved_identification' });

async function teamsById(store, ids) {
  const out = new Map();
  for (const part of chunkArr([...new Set(ids.filter(Boolean))], 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name', 'team_type'], in: { id: part } })) out.set(t.id, t);
  const crests = await approvedMedia(store, 'team', [...out.keys()], { mediaType: 'crest', primaryOnly: true });
  for (const [id, m] of crests) out.get(id).crest = m[0];
  return out;
}

async function compsById(store, ids) {
  const u = [...new Set(ids.filter(Boolean))];
  if (!u.length) return new Map();
  return new Map((await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], in: { id: u } })).map(c => [c.id, { slug: c.slug, name: c.name }]));
}

// Which Match Intelligence layers exist for each match (existence only, never counts):
// lineups = a sourced lineup; stats = team stats (source or derived); event_map = >=1 located shot.
async function intelFlags(store, ids) {
  const sets = { lineups: new Set(), stats: new Set(), event_map: new Set() };
  for (const part of chunkArr([...new Set(ids.filter(Boolean))], 100)) {
    const [l, st, ev] = await Promise.all([
      store.select('soccer_lineups', { columns: ['match_id'], in: { match_id: part }, order: 'match_id.asc' }),
      store.select('soccer_team_match_stats', { columns: ['match_id'], in: { match_id: part }, eq: { stat_key: 'shots' }, order: 'match_id.asc' }),
      store.select('soccer_match_events', { columns: ['match_id'], in: { match_id: part }, eq: { event_type: 'shot' }, gte: { x_m: 0 }, order: 'match_id.asc' }),
    ]);
    for (const r of l) sets.lineups.add(r.match_id);
    for (const r of st) sets.stats.add(r.match_id);
    for (const r of ev) sets.event_map.add(r.match_id);
  }
  return id => ({ lineups: sets.lineups.has(id), stats: sets.stats.has(id), event_map: sets.event_map.has(id) });
}

const tiebreakOf = slug => (slug === 'mls' ? 'mls' : 'standard');

function shapeMatch(m, teams, comps = null, intel = null) {
  const t = id => { const x = teams.get(id); return x ? { id: x.id, slug: x.slug, name: x.name, short_name: x.short_name, ...(x.crest ? { crest: x.crest } : {}) } : { id }; };
  return {
    id: m.id, matchday: m.matchday, round: m.round_label, kickoff_at: m.kickoff_at, status: m.status,
    ...(comps && comps.get(m.competition_id) ? { competition: comps.get(m.competition_id) } : {}),
    home: t(m.home_team_id), away: t(m.away_team_id),
    score: m.home_score === null ? null : { home: m.home_score, away: m.away_score, home_ht: m.home_score_ht, away_ht: m.away_score_ht },
    result_source: m.result_provider,
    ...(intel ? { intel: intel(m.id) } : {}),
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
  const counts = await Promise.all(seasons.map(s => store.count('soccer_matches', { eq: { season_id: s.id } })));
  const withCounts = seasons.map((s, i) => ({ label: s.label, start_date: s.start_date, end_date: s.end_date, matches: counts[i] }));
  let current = null;
  if (seasons[0]) {
    const ms = await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'status'], eq: { season_id: seasons[0].id }, order: 'id.asc' });
    const teams = await teamsById(store, ms.flatMap(x => [x.home_team_id, x.away_team_id]));
    const n = st => ms.filter(x => x.status === st).length;
    current = {
      season: seasons[0].label, matches: ms.length, finished: n('finished'), scheduled: n('scheduled'), live: n('live'),
      teams: [...teams.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(t => ({ slug: t.slug, name: t.name, short_name: t.short_name, ...(t.team_type === 'national' ? { type: 'national' } : {}), ...(t.crest ? { crest: t.crest } : {}) })),
    };
    // A competition whose every team is a national team (Nations League, World Cup ...): copy says nations, not clubs.
    if (teams.size && [...teams.values()].every(t => t.team_type === 'national')) current.team_kind = 'national';
  }
  return E({ slug: c.slug, name: c.name, type: c.comp_type, country_code: c.country_code, tier: c.tier, seasons: withCounts, current, tiebreak: TIEBREAKS[tiebreakOf(c.slug)] }, {
    source: 'pbe', semantics: 'Competition, the seasons stored for it, and the teams appearing in canonical matches of the latest stored season.', source_updated_at: c.updated_at,
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
  if (q.order === 'asc') opts.order = 'kickoff_at.asc';
  const iso = v => (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(String(v || '')) ? v : null);
  if (iso(q.from)) opts.gte = { kickoff_at: q.from.length === 10 ? `${q.from}T00:00:00Z` : q.from };
  if (iso(q.to)) opts.lte = { kickoff_at: q.to.length === 10 ? `${q.to}T23:59:59Z` : q.to };
  if (q.date) { opts.gte = { kickoff_at: `${q.date}T00:00:00Z` }; opts.lte = { kickoff_at: `${q.date}T23:59:59Z` }; opts.order = 'kickoff_at.asc'; }
  if (q.team) {
    const [t] = await store.select('soccer_teams', { columns: ['id'], eq: { slug: q.team }, limit: 1 });
    if (!t) throw new NotFound(`team ${q.team}`);
    const [h, a] = await Promise.all([store.select('soccer_matches', { ...opts, eq: { ...opts.eq, home_team_id: t.id } }), store.select('soccer_matches', { ...opts, eq: { ...opts.eq, away_team_id: t.id } })]);
    const rows = [...h, ...a].sort((x, y) => (opts.order === 'kickoff_at.asc' ? 1 : -1) * (Date.parse(x.kickoff_at) - Date.parse(y.kickoff_at))).slice(0, opts.limit);
    const [teams, comps, intel] = await Promise.all([teamsById(store, rows.flatMap(r => [r.home_team_id, r.away_team_id])), compsById(store, rows.map(r => r.competition_id)), intelFlags(store, rows.map(r => r.id))]);
    return E(rows.map(r => shapeMatch(r, teams, comps, intel)), { source: 'pbe', semantics: 'Canonical matches (max 100 per page); intel flags which Match Intelligence layers exist.', source_updated_at: maxTs(rows.map(r => r.updated_at)), attribution: [...new Set(rows.map(r => r.result_provider))] });
  }
  const rows = await store.select('soccer_matches', opts);
  const [teams, comps, intel] = await Promise.all([teamsById(store, rows.flatMap(r => [r.home_team_id, r.away_team_id])), compsById(store, rows.map(r => r.competition_id)), intelFlags(store, rows.map(r => r.id))]);
  return E(rows.map(r => shapeMatch(r, teams, comps, intel)), { source: 'pbe', semantics: 'Canonical matches (max 100 per page); intel flags which Match Intelligence layers exist.', source_updated_at: maxTs(rows.map(r => r.updated_at)), attribution: [...new Set(rows.map(r => r.result_provider))], coverage: rows.length ? COVERAGE.OK : COVERAGE.PARTIAL });
}

export async function match(store, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFound('match');
  const [m] = await store.select('soccer_matches', { columns: MATCH_COLS, eq: { id }, limit: 1 });
  if (!m) throw new NotFound('match');
  const [teams, [comp], [season], venueRows, sources] = await Promise.all([
    teamsById(store, [m.home_team_id, m.away_team_id]),
    store.select('soccer_competitions', { columns: ['slug', 'name'], eq: { id: m.competition_id }, limit: 1 }),
    store.select('soccer_seasons', { columns: ['label'], eq: { id: m.season_id }, limit: 1 }),
    m.venue_id ? store.select('soccer_venues', { columns: ['name', 'city'], eq: { id: m.venue_id }, limit: 1 }) : Promise.resolve([]),
    store.select('soccer_match_source_results', { columns: ['provider', 'observed_at'], eq: { match_id: id } }),
  ]);
  const venue = venueRows[0] || null;

  // Key events only (goals, cards, shots) — never the full ledger.
  const keyEvents = await store.select('soccer_match_events', {
    columns: ['sequence', 'period', 'minute', 'team_id', 'player_id', 'event_type', 'subtype', 'outcome', 'is_goal', 'is_own_goal', 'card', 'set_piece', 'body_part', 'x_m', 'y_m', 'source_family', 'qualifiers'],
    eq: { match_id: id }, in: { event_type: ['shot', 'goal', 'foul', 'card'] }, order: 'sequence.asc',
  });
  const own = await store.select('soccer_match_events', { columns: ['sequence', 'period', 'minute', 'team_id', 'player_id', 'event_type', 'is_own_goal', 'card', 'source_family', 'qualifiers', 'x_m', 'y_m', 'is_goal', 'outcome', 'subtype', 'set_piece', 'body_part'], eq: { match_id: id, is_own_goal: true } });
  const all = [...keyEvents.filter(e => (e.event_type !== 'foul' || e.card)), ...own.filter(o => !keyEvents.some(k => k.sequence === o.sequence && k.source_family === o.source_family))];
  // One event family per match, richest first, so a goal never appears twice.
  const FAMILY_PRIORITY = ['wyscout_figshare', 'espn', 'openligadb'];
  const family = FAMILY_PRIORITY.find(f => all.some(e => e.source_family === f)) || null;
  const evs = all.filter(e => e.source_family === family).sort((a, b) => a.sequence - b.sequence);
  const playerIds = [...new Set(evs.map(e => e.player_id).filter(Boolean))];

  const [lineups, subs] = await Promise.all([
    store.select('soccer_lineups', { columns: ['id', 'team_id', 'formation', 'manager_id'], eq: { match_id: id } }),
    store.select('soccer_substitutions', { columns: ['team_id', 'player_out_id', 'player_in_id', 'minute'], eq: { match_id: id } }),
  ]);
  const lp = lineups.length ? await store.select('soccer_lineup_players', { columns: ['lineup_id', 'player_id', 'is_starter', 'shirt_number', 'position'], in: { lineup_id: lineups.map(l => l.id) } }) : [];
  const allPlayers = [...new Set([...playerIds, ...lp.map(x => x.player_id), ...subs.flatMap(s => [s.player_in_id, s.player_out_id])])];
  const people = new Map();
  for (const part of chunkArr(allPlayers, 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], in: { id: part } })) people.set(p.id, p);
  const mgrIds = lineups.map(l => l.manager_id).filter(Boolean);
  const mgrs = mgrIds.length ? new Map((await store.select('soccer_managers', { columns: ['id', 'slug', 'display_name'], in: { id: mgrIds } })).map(x => [x.id, x])) : new Map();
  const portraits = await portraitMap(store, [...people.keys()]);
  const person = pid => { const p = people.get(pid); return p ? { id: p.id, slug: p.slug, name: p.display_name, ...(portraits.get(p.id) ? { portrait: portraits.get(p.id) } : {}) } : null; };
  const side = tid => (tid === m.home_team_id ? 'home' : tid === m.away_team_id ? 'away' : null);

  const timeline = evs.filter(e => e.is_goal || e.is_own_goal || e.card).map(e => ({
    minute: e.minute, display_minute: displayMinute(e.period, e.minute), team: side(e.is_own_goal ? ownGoalBeneficiary(e, m.home_team_id, m.away_team_id) : e.team_id), type: e.is_goal ? 'goal' : e.is_own_goal ? 'own_goal' : `card_${e.card}`,
    player: person(e.player_id) || (e.qualifiers?.source_player ? { name: e.qualifiers.source_player.name, resolved: false } : null),
    penalty: e.set_piece === 'penalty', source: e.source_family,
  }));
  const shots = evs.filter(e => e.event_type === 'shot' && e.x_m !== null).map(e => {
    const mf = toMatchFrame({ x_m: Number(e.x_m), y_m: Number(e.y_m) }, { isHomeTeam: e.team_id === m.home_team_id });
    return { minute: e.minute, team: side(e.team_id), player: person(e.player_id), outcome: e.outcome, x: mf.x, y: mf.y };
  });
  const stats = await store.select('soccer_team_match_stats', { columns: ['team_id', 'stat_key', 'value', 'basis', 'derivation_version'], eq: { match_id: id } });
  const statsBasis = stats.some(x => x.basis === 'derived') ? 'derived' : stats.length ? 'source' : null;
  const statsOut = { home: {}, away: {}, basis: statsBasis, derivation: stats.find(x => x.basis === 'derived')?.derivation_version || null, provider: statsBasis === 'source' ? family : null };
  for (const s of stats) if (side(s.team_id) && s.basis === statsBasis) statsOut[side(s.team_id)][s.stat_key] = Number(s.value);

  const lineupOut = Object.fromEntries(lineups.map(l => [side(l.team_id), {
    manager: mgrs.get(l.manager_id) ? { slug: mgrs.get(l.manager_id).slug, name: mgrs.get(l.manager_id).display_name } : null,
    formation: l.formation,
    starters: lp.filter(x => x.lineup_id === l.id && x.is_starter).map(x => (person(x.player_id) ? { ...person(x.player_id), ...(x.shirt_number ? { shirt: x.shirt_number } : {}) } : null)),
    bench: lp.filter(x => x.lineup_id === l.id && !x.is_starter).map(x => (person(x.player_id) ? { ...person(x.player_id), ...(x.shirt_number ? { shirt: x.shirt_number } : {}) } : null)),
  }]));
  // ---- SHOT INTELLIGENCE: every shot of the chosen event family (located or not), with
  // score state before it, the linked assist where the source tags one, body part,
  // situation and provider xG labelled as the provider's.
  const assistEvents = family === 'espn' ? await store.select('soccer_match_events', { columns: ['sequence', 'team_id', 'player_id', 'subtype'], eq: { match_id: id, source_family: 'espn' }, in: { subtype: ['espn_assist', 'espn_assists_shot'] }, order: 'sequence.asc' }) : [];
  for (const a of assistEvents) if (a.player_id && !people.has(a.player_id)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], eq: { id: a.player_id } })) { people.set(p.id, p); const pm = await portraitMap(store, [p.id]); if (pm.get(p.id)) portraits.set(p.id, pm.get(p.id)); }
  let hs = 0; let as = 0;
  const shotTimeline = [];
  for (const e of evs) {
    if (e.event_type === 'shot') {
      // ESPN records the Assist play next to its goal, sometimes just after it: nearest within 4 plays, same team.
      const assist = e.is_goal ? assistEvents.filter(a => a.subtype === 'espn_assist' && a.team_id === e.team_id && Math.abs(e.sequence - a.sequence) <= 4).sort((x, y) => Math.abs(e.sequence - x.sequence) - Math.abs(e.sequence - y.sequence))[0] || null : null;
      shotTimeline.push({ minute: e.minute, display_minute: displayMinute(e.period, e.minute), team: side(e.team_id), player: person(e.player_id), outcome: e.outcome, goal: !!e.is_goal,
        body_part: e.body_part || null, set_piece: e.set_piece || null, situation: e.qualifiers?.shot_situation || null, score_before: `${hs}-${as}`,
        assist: assist ? person(assist.player_id) : null, provider_xg: e.qualifiers?.provider_xg || null, located: e.x_m !== null });
    }
    if (e.is_goal) { if (side(e.team_id) === 'home') hs += 1; else as += 1; }
    if (e.is_own_goal) { if (side(ownGoalBeneficiary(e, m.home_team_id, m.away_team_id)) === 'home') hs += 1; else as += 1; }
  }
  // ---- SEQUENCE (PBEcast): every sourced goal / own goal / shot / card in source order, plus
  // substitutions by minute. Coordinates ONLY where the source located the event (shots);
  // score = running canonical score after the item. Minutes are the source's, never interpolated.
  const sequence = [];
  { let h = 0; let a = 0;
    for (const e of evs) {
      const type = e.event_type === 'shot' ? (e.is_goal ? 'goal' : 'shot') : e.is_goal ? 'goal' : e.is_own_goal ? 'own_goal' : e.card ? `card_${e.card}` : null;
      if (!type) continue;
      const tside = side(e.is_own_goal ? ownGoalBeneficiary(e, m.home_team_id, m.away_team_id) : e.team_id);
      if (type === 'goal' || type === 'own_goal') { if (tside === 'home') h += 1; else if (tside === 'away') a += 1; }
      const loc = e.event_type === 'shot' && e.x_m !== null && e.y_m !== null ? toMatchFrame({ x_m: Number(e.x_m), y_m: Number(e.y_m) }, { isHomeTeam: e.team_id === m.home_team_id }) : null;
      const assist = type === 'goal' ? assistEvents.filter(x => x.subtype === 'espn_assist' && x.team_id === e.team_id && Math.abs(e.sequence - x.sequence) <= 4).sort((x, y) => Math.abs(e.sequence - x.sequence) - Math.abs(e.sequence - y.sequence))[0] || null : null;
      sequence.push({ minute: e.minute, display_minute: displayMinute(e.period, e.minute), period: e.period, team: tside, type,
        player: person(e.player_id) || (e.qualifiers?.source_player ? { name: e.qualifiers.source_player.name, resolved: false } : null),
        ...(e.event_type === 'shot' ? { outcome: e.outcome, body_part: e.body_part || null, provider_xg: e.qualifiers?.provider_xg || null } : {}),
        ...(assist ? { assist: person(assist.player_id) } : {}), ...(e.set_piece === 'penalty' ? { penalty: true } : {}),
        ...(loc ? { x: loc.x, y: loc.y } : {}), score: { home: h, away: a } });
    }
    for (const sb of subs) {
      const at = sequence.findIndex(x => (x.minute ?? 0) > (sb.minute ?? 999));
      const prev = at === -1 ? sequence[sequence.length - 1] : sequence[at - 1];
      const item = { minute: sb.minute, display_minute: sb.minute !== null && sb.minute !== undefined ? `${sb.minute}'` : null, team: side(sb.team_id), type: 'sub', player_in: person(sb.player_in_id), player_out: person(sb.player_out_id), score: prev ? prev.score : { home: 0, away: 0 } };
      if (at === -1) sequence.push(item); else sequence.splice(at, 0, item);
    }
  }
  // ---- PLAYER IMPACT: sourced counts only. ESPN matches count the ESPN event record;
  // Wyscout matches use PBE derived counts from the ledger. Minutes are nominal (from
  // lineups and substitutions), never the source's playing time.
  const derived = await store.select('soccer_player_match_stats', { columns: ['player_id', 'team_id', 'stat_key', 'value'], eq: { match_id: id, basis: 'derived' } });
  const impact = new Map();
  const row = (pid, tid) => { if (!impact.has(pid)) impact.set(pid, { player: person(pid), team: side(tid) }); return impact.get(pid); };
  for (const x of lp) { const l = lineups.find(z => z.id === x.lineup_id); const r = row(x.player_id, l.team_id); r.started = !!x.is_starter; if (x.shirt_number) r.shirt = x.shirt_number; }
  for (const d of derived) { const r = row(d.player_id, d.team_id); r[d.stat_key === 'minutes_nominal' ? 'minutes_nominal' : d.stat_key] = Number(d.value); }
  let impactBasis = derived.some(d => d.stat_key !== 'minutes_nominal') ? 'derived' : null;
  if (family === 'espn') {
    impactBasis = 'source_events';
    const all = await store.select('soccer_match_events', { columns: ['player_id', 'team_id', 'event_type', 'subtype', 'outcome', 'is_goal', 'card'], eq: { match_id: id, source_family: 'espn' }, order: 'sequence.asc' });
    const inc = (r, k) => { r[k] = (r[k] || 0) + 1; };
    for (const e of all) {
      if (!e.player_id) continue;
      if (!people.has(e.player_id)) continue; // unresolved identities are never shown as someone
      const r = row(e.player_id, e.team_id);
      for (const k of ['goals', 'assists', 'shots', 'shots_on_target', 'key_passes', 'passes', 'tackles', 'interceptions', 'clearances', 'saves', 'fouls_committed', 'yellow_cards', 'red_cards']) r[k] = r[k] ?? 0;
      if (e.is_goal) inc(r, 'goals');
      if (e.subtype === 'espn_assist') inc(r, 'assists');
      if (e.subtype === 'espn_assists_shot') inc(r, 'key_passes');
      if (e.event_type === 'shot') { inc(r, 'shots'); if (e.outcome === 'goal' || e.outcome === 'on_target') inc(r, 'shots_on_target'); }
      if (e.event_type === 'pass') inc(r, 'passes');
      if (e.event_type === 'tackle') inc(r, 'tackles');
      if (e.event_type === 'interception') inc(r, 'interceptions');
      if (e.event_type === 'clearance') inc(r, 'clearances');
      if (e.event_type === 'save') inc(r, 'saves');
      if (e.event_type === 'foul') inc(r, 'fouls_committed');
      if (e.card === 'yellow') inc(r, 'yellow_cards');
      if (e.card === 'red') inc(r, 'red_cards');
    }
  }
  for (const s of subs) { if (impact.has(s.player_in_id)) impact.get(s.player_in_id).sub_on = s.minute; if (impact.has(s.player_out_id)) impact.get(s.player_out_id).sub_off = s.minute; }
  const players = [...impact.values()].filter(r => r.player && (r.started || r.sub_on !== undefined || r.goals || r.shots || r.passes || r.minutes_nominal))
    .sort((a, b) => (a.team === b.team ? 0 : a.team === 'home' ? -1 : 1) || (b.started === true) - (a.started === true) || (b.goals || 0) - (a.goals || 0) || (b.shots || 0) - (a.shots || 0) || (a.player.name < b.player.name ? -1 : 1));

  const hasLedger = shots.length > 0;
  const notes = [];
  if (!hasLedger) notes.push('No event ledger with coordinates for this match: timeline shows reported goals only.');
  if (!lineups.length) notes.push('Lineups not available from a legitimate source for this match.');
  if (timeline.some(t => t.player && t.player.resolved === false)) notes.push('Some scorers are awaiting identity resolution.');
  return E({
    ...shapeMatch(m, teams), competition: comp, season: season?.label, venue,
    timeline, shots, stats: stats.length ? statsOut : null, lineups: lineups.length ? lineupOut : null,
    substitutions: subs.map(s => ({ minute: s.minute, team: side(s.team_id), in: person(s.player_in_id), out: person(s.player_out_id) })),
    event_source: family,
    shot_timeline: shotTimeline,
    sequence,
    players: players.length ? { basis: impactBasis, rows: players } : null,
    tactical: lineups.length ? { formations: Object.fromEntries(lineups.map(l => [side(l.team_id), l.formation || null])), source: 'formation as stated by the lineup source; positions are not stored' } : null,
    coordinates: hasLedger ? { system: '105x68 m, match frame: home attacks toward x=105', note: 'Event locations, not player tracking.' } : null,
  }, {
    source: 'pbe', source_updated_at: maxTs(m.updated_at, sources.map(s => s.observed_at)),
    semantics: `Canonical match assembled by PropBetEdge. ${statsBasis === 'derived' ? 'Team counts are derived by PropBetEdge from the event ledger (pbe-counts).' : statsBasis === 'source' ? `Team statistics are source facts supplied by ${family === 'espn' ? 'ESPN (secondary source)' : family}, not PropBetEdge metrics.` : 'No team statistics available.'} Shot locations on the 105x68 canonical pitch; provider xG, where present, is labelled with its provider and is not PBE xG.`,
    coverage: notes.length ? COVERAGE.PARTIAL : COVERAGE.OK, coverage_notes: notes,
    attribution: [...new Set([...sources.map(s => s.provider), ...(family === 'wyscout_figshare' ? ['wyscout'] : family ? [family] : [])])],
  });
}

export async function team(store, slug, env = null) {
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
  const comps = await compsById(store, [...all].map(r => r.competition_id));
  const intel = await intelFlags(store, [...recent, ...next].map(r => r.id));
  const { records, observed, latestSeasons } = await teamSeasonDepth(store, t, all, comps);
  await attachQuickDna(store, env, observed.players, latestSeasons);
  const media = (await approvedMedia(store, 'team', [t.id])).get(t.id) || [];
  return E({ id: t.id, slug: t.slug, name: t.name, official_name: t.official_name, type: t.team_type, country_code: t.country_code, city: t.city, form, media, crest: media.find(x => x.media_type === 'crest' && x.primary) || null, records, players_observed: observed, recent: recent.map(r => shapeMatch(r, teams, comps, intel)), upcoming: next.map(r => shapeMatch(r, teams, comps, intel)) }, {
    source: 'pbe', semantics: 'Canonical team; form = last 5 finished canonical matches (W/D/L), newest first. records = league-stage record in the latest stored season of each competition (position only where a league table exists). players_observed = players named in sourced lineups for those seasons (appearance = started or came on).', source_updated_at: maxTs(t.updated_at, recent.map(r => r.updated_at)),
    attribution: [...new Set(all.map(r => r.result_provider))],
  });
}

async function teamSeasonDepth(store, t, all, comps) {
  // Latest season per competition among the team's recent canonical matches.
  const latest = new Map();
  for (const m of all) if (!latest.has(m.competition_id)) latest.set(m.competition_id, m.season_id);
  const records = []; const seasonMatchIds = [];
  for (const [compId, seasonId] of latest) {
    const [seasonRow] = await store.select('soccer_seasons', { columns: ['label'], eq: { id: seasonId }, limit: 1 });
    const league = (await store.select('soccer_stages', { columns: ['id'], eq: { season_id: seasonId, stage_type: 'league' } })).map(x => x.id);
    const [h, a] = await Promise.all(['home_team_id', 'away_team_id'].map(k => store.select('soccer_matches', { columns: ['id', 'stage_id', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'kickoff_at'], eq: { season_id: seasonId, [k]: t.id }, order: 'id.asc' })));
    const mine = [...h, ...a];
    seasonMatchIds.push(...mine.filter(x => x.status === 'finished').map(x => x.id));
    const done = mine.filter(x => x.status === 'finished' && x.home_score !== null && league.includes(x.stage_id));
    const comp = comps.get(compId) || null;
    if (!done.length) { records.push({ competition: comp, season: seasonRow?.label || null, record: null, position: null }); continue; }
    const tb = tiebreakOf(comp?.slug);
    const full = await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'kickoff_at'], eq: { season_id: seasonId, status: 'finished' }, in: { stage_id: league }, order: 'id.asc' });
    const tbl = computeTable(full.filter(x => x.home_score !== null && x.away_score !== null), { tiebreak: tb });
    const i = tbl.findIndex(r => r.team_id === t.id);
    const r = tbl[i];
    const record = { played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, goals_for: r.gf, goals_against: r.ga, goal_difference: r.gd, points: r.points, form: r.form };
    const groups = await seasonGroups(store, seasonId);
    if (groups.some(g => g.group_type === 'group')) {
      // Group competition: no rank across groups. Position = the verified group position, else none.
      const member = (await store.select('soccer_season_group_members', { columns: ['group_id'], eq: { team_id: t.id }, in: { group_id: groups.map(g => g.id) }, limit: 1 }))[0];
      const g = member && groups.find(x => x.id === member.group_id);
      let position = null; let size = null;
      if (g) {
        const source = await store.select('soccer_source_standings', { columns: STANDING_COLS, eq: { group_id: g.id, provider: 'espn' } });
        if (verifyGroupStandings(source, new Map(tbl.map(x => [x.team_id, x]))).verified) { position = source.find(s => s.team_id === t.id)?.rank ?? null; size = source.length; }
      }
      records.push({ competition: comp, season: seasonRow?.label || null, position, teams_in_table: size, group: g ? groupMeta(g) : null, record });
      continue;
    }
    records.push({ competition: comp, season: seasonRow?.label || null, position: i + 1, teams_in_table: tbl.length, record });
  }
  // Players observed in sourced lineups for those seasons.
  const lineups = [];
  for (const part of chunkArr(seasonMatchIds, 100)) lineups.push(...await store.select('soccer_lineups', { columns: ['id', 'match_id'], eq: { team_id: t.id }, in: { match_id: part } }));
  const lps = []; const subsIn = new Set();
  for (const part of chunkArr(lineups.map(l => l.id), 100)) lps.push(...await store.select('soccer_lineup_players', { columns: ['lineup_id', 'player_id', 'is_starter'], in: { lineup_id: part }, order: 'lineup_id.asc,player_id.asc' }));
  for (const part of chunkArr(lineups.map(l => l.match_id), 100)) for (const s of await store.select('soccer_substitutions', { columns: ['match_id', 'player_in_id'], eq: { team_id: t.id }, in: { match_id: part } })) subsIn.add(`${s.match_id}|${s.player_in_id}`);
  const matchOf = new Map(lineups.map(l => [l.id, l.match_id]));
  const agg = new Map();
  for (const x of lps) {
    const a = agg.get(x.player_id) || { appearances: 0, starts: 0, named: 0 };
    a.named += 1;
    if (x.is_starter) { a.starts += 1; a.appearances += 1; } else if (subsIn.has(`${matchOf.get(x.lineup_id)}|${x.player_id}`)) a.appearances += 1;
    agg.set(x.player_id, a);
  }
  const people = new Map();
  for (const part of chunkArr([...agg.keys()], 150)) for (const p of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name', 'primary_role'], in: { id: part } })) people.set(p.id, p);
  const portraits = await portraitMap(store, [...people.keys()]);
  const observed = [...agg.entries()].filter(([id]) => people.has(id)).map(([id, a]) => ({ id, slug: people.get(id).slug, name: people.get(id).display_name, role: people.get(id).primary_role, ...(portraits.get(id) ? { portrait: portraits.get(id) } : {}), ...a }))
    .sort((x, y) => y.appearances - x.appearances || y.starts - x.starts || (x.name < y.name ? -1 : 1));
  return { records, observed: { lineups_counted: lineups.length, players: observed }, latestSeasons: [...latest.values()] };
}

// Quick Player DNA numbers for team player rows, read from the season DNA cache ONLY (a cache
// miss adds nothing; a team page never pays a cold DNA computation).
async function cachedSeasonProfiles(store, env, seasonId, kind) {
  const kv = env?.SOCCER_STATE; if (!kv) return null;
  const asOf = new Date().toISOString();
  const [last] = await store.select('soccer_matches', { columns: ['kickoff_at'], eq: { season_id: seasonId, status: 'finished' }, lte: { kickoff_at: asOf }, order: 'kickoff_at.desc', limit: 1 });
  const cutoff = last ? new Date(last.kickoff_at).toISOString() : 'none';
  const hit = await kv.get(`dna:${DNA_VERSION}:${kind}:${seasonId}:${cutoff}`, 'json').catch(() => null);
  return hit ? new Map(hit.profiles) : null;
}
async function attachQuickDna(store, env, rows, seasonIds) {
  if (!rows?.length) return;
  for (const sid of seasonIds || []) {
    const prof = await cachedSeasonProfiles(store, env, sid, 'player'); if (!prof) continue;
    for (const r of rows) { const p = prof.get(r.id); if (!p || r.dna) continue; r.dna = { goals: p.goals, assists: p.assists, shots: p.shots, minutes_nominal: p.minutes_nominal, goal_contributions_per90: p.goal_contributions_per90, percentile_goal_contributions_per90: p.percentiles?.goal_contributions_per90 ?? null }; }
  }
}

// Observed player record: lineups (starts / came on) plus goals and shots from the
// richest event family per match (wyscout_figshare > espn > openligadb), so a goal
// reported by two providers is counted once.
const FAMILY_RANK = { wyscout_figshare: 0, espn: 1, openligadb: 2 };
function perMatchBestFamily(rows) {
  const best = new Map();
  for (const r of rows) { const b = best.get(r.match_id); if (b === undefined || FAMILY_RANK[r.source_family] < FAMILY_RANK[b]) best.set(r.match_id, r.source_family); }
  return rows.filter(r => best.get(r.match_id) === r.source_family);
}

async function playerObserved(store, p) {
  const lps = await store.select('soccer_lineup_players', { columns: ['lineup_id', 'is_starter'], eq: { player_id: p.id }, order: 'lineup_id.asc' });
  const lineups = [];
  for (const part of chunkArr(lps.map(x => x.lineup_id), 100)) lineups.push(...await store.select('soccer_lineups', { columns: ['id', 'match_id', 'team_id'], in: { id: part } }));
  const starterOf = new Map(lps.map(x => [x.lineup_id, x.is_starter]));
  const subIns = new Set((await store.select('soccer_substitutions', { columns: ['match_id'], eq: { player_in_id: p.id }, order: 'match_id.asc' })).map(x => x.match_id));
  const [goalsRaw, shotsRaw, located] = await Promise.all([
    store.select('soccer_match_events', { columns: ['match_id', 'source_family', 'sequence', 'team_id'], eq: { player_id: p.id, is_goal: true }, order: 'match_id.asc,sequence.asc' }),
    store.select('soccer_match_events', { columns: ['match_id', 'source_family', 'sequence', 'team_id', 'minute', 'outcome', 'x_m', 'y_m'], eq: { player_id: p.id, event_type: 'shot' }, order: 'match_id.asc,sequence.asc' }),
    store.count('soccer_match_events', { eq: { player_id: p.id }, neq: { source_coordinate_system: 'none' } }),
  ]);
  const goals = perMatchBestFamily(goalsRaw); const shots = perMatchBestFamily(shotsRaw);
  const matchIds = [...new Set([...lineups.map(l => l.match_id), ...goals.map(g => g.match_id), ...shots.map(s => s.match_id)])];
  const ms = [];
  for (const part of chunkArr(matchIds, 100)) ms.push(...await store.select('soccer_matches', { columns: MATCH_COLS, in: { id: part } }));
  const byId = new Map(ms.map(m => [m.id, m]));
  const lineupByMatch = new Map(lineups.map(l => [l.match_id, l]));
  const seasons = new Map();
  const sIds = [...new Set(ms.map(m => m.season_id))];
  for (const part of chunkArr(sIds, 100)) for (const s of await store.select('soccer_seasons', { columns: ['id', 'label'], in: { id: part } })) seasons.set(s.id, s.label);
  const [teams, comps] = await Promise.all([teamsById(store, ms.flatMap(m => [m.home_team_id, m.away_team_id])), compsById(store, ms.map(m => m.competition_id))]);
  const count = (arr, id) => arr.filter(x => x.match_id === id).length;
  const rows = new Map();
  for (const id of matchIds) {
    const m = byId.get(id); if (!m) continue;
    const l = lineupByMatch.get(id);
    const teamId = l?.team_id || goals.find(g => g.match_id === id)?.team_id || shots.find(x => x.match_id === id)?.team_id || null;
    const key = `${m.competition_id}|${m.season_id}|${teamId || ''}`;
    // appearances/starts stay null unless a sourced lineup names the player: no lineup is "not recorded", never 0.
    const r = rows.get(key) || { competition: comps.get(m.competition_id) || null, season: seasons.get(m.season_id) || null, team: teamId && teams.get(teamId) ? { slug: teams.get(teamId).slug, name: teams.get(teamId).name } : null, appearances: null, starts: null, goals: 0, shots: 0, shots_recorded: false };
    if (l) {
      const started = starterOf.get(l.id) === true;
      r.starts = (r.starts || 0) + (started ? 1 : 0);
      r.appearances = (r.appearances || 0) + (started || subIns.has(id) ? 1 : 0);
    }
    r.goals += count(goals, id); r.shots += count(shots, id);
    if (lineupByMatch.has(id) || shotsRaw.some(x => x.match_id === id)) r.shots_recorded = true;
    rows.set(key, r);
  }
  // Shots are only a count where the match has a shot-level source; otherwise null.
  for (const r of rows.values()) { if (!r.shots_recorded) r.shots = null; delete r.shots_recorded; }
  const sum = k => { const v = [...rows.values()].map(r => r[k]).filter(x => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) : null; };
  const totals = { appearances: sum('appearances'), starts: sum('starts'), goals: sum('goals'), shots: sum('shots') };
  const recent = ms.filter(m => lineupByMatch.has(m.id) && m.status === 'finished').sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at)).slice(0, 10)
    .map(m => ({ ...shapeMatch(m, teams, comps), side: lineupByMatch.get(m.id).team_id === m.home_team_id ? 'home' : 'away', started: starterOf.get(lineupByMatch.get(m.id).id) === true, came_on: subIns.has(m.id), goals: count(goals, m.id), shots: count(shots, m.id) }));
  // The team of the player's most recent sourced lineup (identity context for the hero; not a claim of current contract).
  const lastLineup = ms.filter(m => lineupByMatch.has(m.id)).sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at))[0];
  const lt = lastLineup ? teams.get(lineupByMatch.get(lastLineup.id).team_id) : null;
  return {
    latest_team: lt ? { slug: lt.slug, name: lt.name, short_name: lt.short_name, ...(lt.crest ? { crest: lt.crest } : {}), as_of: lastLineup.kickoff_at, competition: comps.get(lastLineup.competition_id) || null } : null,
    totals: { ...totals, located_events: located, lineups_named: lineups.length },
    by_competition: [...rows.values()].sort((a, b) => ((b.season || '') < (a.season || '') ? -1 : (b.season || '') > (a.season || '') ? 1 : 0)),
    recent,
    // Located shots in the attacking frame (the player's team attacks toward x = 105).
    shot_map: shots.filter(x => x.x_m !== null && x.y_m !== null).slice(-300).map(x => ({ match_id: x.match_id, minute: x.minute, outcome: x.outcome, x: Number(x.x_m), y: Number(x.y_m) })),
  };
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
  const observed = await playerObserved(store, p);
  const media = (await approvedMedia(store, 'player', [p.id])).get(p.id) || [];
  return E({
    id: p.id, slug: p.slug, name: p.display_name, first_name: p.first_name, last_name: p.last_name, birth_date: p.birth_date,
    nationality_code: p.nationality_code, foot: p.foot, height_cm: p.height_cm, role: p.primary_role,
    seasons: Object.values(totals).sort((a, b) => (a.season < b.season ? 1 : -1)), reported_goals_other_seasons: goalsReported,
    observed, media,
  }, {
    source: 'pbe', semantics: 'seasons = per-season totals of pbe-counts derived from the event ledger (seasons with an event ledger only); minutes are nominal (90/120, cut at substitution/dismissal). observed = what source data shows for this player: appearances/starts from sourced lineups (appearance = started or came on), goals and shots from the richest event family per match, located_events = events with a pitch location. Observed, not complete career statistics.',
    coverage: Object.keys(totals).length || observed.totals.lineups_named ? COVERAGE.PARTIAL : COVERAGE.UNAVAILABLE, coverage_notes: ['Event-level statistics exist only for seasons with a legitimate event ledger (Bundesliga 2017/18).'],
    source_updated_at: p.updated_at, attribution: Object.keys(totals).length ? ['wyscout'] : [],
  });
}

// Season groups for a season: MLS conferences, UCL league phase (from the standings lane).
async function seasonGroups(store, seasonId) {
  const rows = await store.select('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'abbreviation', 'group_type', 'updated_at'], eq: { season_id: seasonId }, order: 'group_key.asc' });
  if (!rows.some(g => g.group_type === 'group')) return rows;
  // Tournament groups carry their tier (League A..D) and display order (columns from migration 1000).
  const extra = new Map((await store.select('soccer_season_groups', { columns: ['id', 'parent_group_key', 'parent_name', 'sort_order'], eq: { season_id: seasonId, group_type: 'group' } })).map(g => [g.id, g]));
  return rows.map(g => ({ ...g, ...(extra.get(g.id) || {}) })).sort((a, b) => (a.sort_order ?? 1e9) - (b.sort_order ?? 1e9) || (a.group_key < b.group_key ? -1 : 1));
}
const STANDING_COLS = ['team_id', 'rank', 'played', 'won', 'drawn', 'lost', 'goals_for', 'goals_against', 'goal_difference', 'points', 'deductions', 'note', 'note_rank', 'observed_at'];
const groupMeta = g => ({ key: g.group_key, name: g.name, type: g.group_type, ...(g.group_type === 'group' ? { abbreviation: g.abbreviation || null, parent: g.parent_group_key ? { key: g.parent_group_key, name: g.parent_name } : null } : {}) });

// One verified group table: the provider's rows in official order, with every count taken from
// our canonical recomputation, or no rows at all when any count disagrees.
function verifiedGroupRows(source, byId, teams) {
  const check = verifyGroupStandings(source, byId);
  const shapeTeam = t => ({ slug: t?.slug, name: t?.name, short_name: t?.short_name, ...(t?.team_type === 'national' ? { type: 'national' } : {}), ...(t?.crest ? { crest: t.crest } : {}) });
  const rows = check.verified ? source.map(s => { const r = byId.get(s.team_id); return {
    position: s.rank, team: shapeTeam(teams.get(s.team_id)), played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, points: r.points - (s.deductions || 0), goals_for: r.gf, goals_against: r.ga, goal_difference: r.gd, form: r.form,
    ...(s.deductions ? { deductions: s.deductions } : {}), zone: s.note ? { label: s.note, rank: s.note_rank } : null,
  }; }) : [];
  return { check, rows };
}

// Verified group table. The provider (ESPN) supplies membership, official rank (its
// application of the competition's tie-breakers) and zone notes; PropBetEdge publishes
// the table ONLY if every team's P W D L GF GA PTS equals the table recomputed from our
// own canonical results. Any disagreement -> no rows, mismatches listed.
export { COUNT_KEYS, verifyGroupStandings } from '../../shared/standings.js';
import { verifyGroupStandings } from '../../shared/standings.js';

export async function table(store, q) {
  const c = await competitionBySlug(store, q.competition || 'bundesliga');
  const seasons = await seasonsOf(store, c.id);
  const season = q.season ? seasons.find(s => s.label === q.season) : seasons[0];
  if (!season) throw new NotFound(`season ${q.season}`);
  const leagueStages = (await store.select('soccer_stages', { columns: ['id'], eq: { season_id: season.id, stage_type: 'league' } })).map(s => s.id);
  const played = leagueStages.length ? await store.select('soccer_matches', { columns: ['id', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'kickoff_at', 'updated_at', 'result_provider'], eq: { season_id: season.id, status: 'finished' }, in: { stage_id: leagueStages } }) : [];
  const valid = played.filter(x => x.home_score !== null && x.away_score !== null);
  const tb = tiebreakOf(c.slug);
  const computed = computeTable(valid, { tiebreak: tb });
  const groups = await seasonGroups(store, season.id);
  const leaguePhase = groups.find(g => g.group_type === 'league_phase');
  // Tournament groups (Nations League A1..D2, later World Cup / EURO groups): there is NO
  // meaningful overall table across groups, so none is computed or ranked.
  const grouped = groups.some(g => g.group_type === 'group');
  const groupKey = leaguePhase ? leaguePhase.group_key : (q.group && q.group !== 'overall' ? String(q.group).toLowerCase() : null);
  const groupList = groups.map(groupMeta);
  const shapeTeam = t => ({ slug: t?.slug, name: t?.name, short_name: t?.short_name, ...(t?.crest ? { crest: t.crest } : {}) });
  const byId = new Map(computed.map(r => [r.team_id, r]));

  if (grouped && !groupKey) {
    // Groups index: every group with its tier and verification state; with expand=groups each
    // verified group's rows are included (each verified on its own; still no cross-group ranking).
    const all = [];
    for (const part of chunkArr(groups.map(g => g.id), 100)) all.push(...await store.select('soccer_source_standings', { columns: ['group_id', ...STANDING_COLS], eq: { provider: 'espn' }, in: { group_id: part } }));
    const teams = await teamsById(store, all.map(s => s.team_id));
    const expand = q.expand === 'groups';
    const out = groups.map(g => {
      const source = all.filter(s => s.group_id === g.id).sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
      const { check, rows } = verifiedGroupRows(source, byId, teams);
      return { ...groupMeta(g), teams: source.length, verified: check.verified, ...(check.verified ? {} : { withheld_reason: source.length ? 'published standings disagree with canonical results' : 'no published standings stored yet' }), ...(expand ? { rows } : {}) };
    });
    const tiers = [];
    for (const g of out) { const k = g.parent?.key || null; let t = tiers.find(x => x.key === k); if (!t) tiers.push(t = { key: k, name: g.parent?.name || null, groups: [] }); t.groups.push(g.key); }
    const verified = out.filter(g => g.verified).length;
    return E({ competition: c.slug, season: season.label, view: 'groups', groups: out, tiers, matches_counted: valid.length, rows: [], verified_groups: verified, withheld_groups: out.length - verified }, {
      source: 'pbe', semantics: "Group competition: no overall table exists and none is computed. Each group table uses ESPN's published membership, official position (tie-breakers as applied by the provider) and zone notes, and is shown only when every played/won/drawn/lost/goals/points figure equals the table PropBetEdge computes from its own canonical results; a group that does not verify is withheld on its own.",
      source_updated_at: maxTs([...valid.map(x => x.updated_at), ...all.map(s => s.observed_at)]), attribution: [...new Set([...valid.map(x => x.result_provider), 'Standings: ESPN (secondary source)'])],
      coverage: verified === out.length && out.length ? COVERAGE.OK : verified ? COVERAGE.PARTIAL : COVERAGE.UNAVAILABLE,
      coverage_notes: out.filter(g => !g.verified).map(g => `${g.name}: withheld (${g.withheld_reason}).`),
    });
  }

  if (groupKey) {
    const g = groups.find(x => x.group_key === groupKey);
    if (!g) throw new NotFound(`group ${groupKey}`);
    const source = (await store.select('soccer_source_standings', { columns: STANDING_COLS, eq: { group_id: g.id, provider: 'espn' } }))
      .sort((a, b) => (a.rank ?? 999) - (b.rank ?? 999));
    const teams = await teamsById(store, source.map(s => s.team_id));
    const { check, rows } = verifiedGroupRows(source, byId, teams);
    const kind = g.group_type === 'league_phase' ? 'league phase' : g.group_type === 'group' ? 'group' : 'conference';
    return E({
      competition: c.slug, season: season.label, group: groupMeta(g), groups: groupList, view: g.group_key,
      matches_counted: valid.length, tiebreak: `official ${c.slug === 'mls' ? 'MLS' : 'UEFA'} order as published by the provider`, rows,
      verification: { verified: check.verified, provider: 'espn', teams: source.length, mismatches: check.mismatches.slice(0, 20), provider_observed_at: maxTs(source.map(s => s.observed_at)) },
    }, {
      source: 'pbe', semantics: `${g.name}: ${kind} membership, position (the competition's official tie-breakers as applied by the provider) and zone notes come from ESPN's published standings (secondary source); every played/won/drawn/lost/goals/points figure is verified against the table PropBetEdge computes from its own canonical results before anything is shown.${check.verified ? '' : ' Verification failed, so no table is shown.'}`,
      source_updated_at: maxTs([...valid.map(x => x.updated_at), ...source.map(s => s.observed_at)]), attribution: [...new Set([...valid.map(x => x.result_provider), 'Standings: ESPN (secondary source)'])],
      coverage: check.verified ? COVERAGE.OK : COVERAGE.UNAVAILABLE,
      coverage_notes: check.verified ? [] : [source.length ? `Published standings disagree with canonical results for ${new Set(check.mismatches.map(m => m.team_id).filter(Boolean)).size} team(s); the table is withheld until they agree.` : 'No published standings stored for this group yet.'],
    });
  }
  const teams = await teamsById(store, computed.map(r => r.team_id));
  return E({
    competition: c.slug, season: season.label, groups: groupList, view: 'overall', matches_counted: valid.length, tiebreak: TIEBREAKS[tb],
    rows: computed.map((r, i) => ({ position: i + 1, team: shapeTeam(teams.get(r.team_id)), played: r.played, won: r.won, drawn: r.drawn, lost: r.lost, points: r.points, goals_for: r.gf, goals_against: r.ga, goal_difference: r.gd, form: r.form })),
  }, {
    source: 'pbe', semantics: `Table computed by PropBetEdge from canonical finished league-stage results (play-offs excluded). Order: ${TIEBREAKS[tb]} (head-to-head and deductions not applied). Form = last five counted results, newest first.${tb === 'mls' ? ` MLS: overall table across both conferences${groupList.length ? '; conference tables are available' : ''}.` : ''}`,
    source_updated_at: maxTs(valid.map(x => x.updated_at)), attribution: [...new Set(valid.map(x => x.result_provider))],
    coverage: valid.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE,
  });
}

// Media bytes, content-addressed: served only while an APPROVED registry row carries
// this hash (a rejected or unreviewed file can never be fetched by guessing its hash).
export async function mediaObject(store, bucket, sha) {
  if (!/^[0-9a-f]{64}$/.test(sha) || !bucket) throw new NotFound('media');
  const [row] = await store.select('soccer_entity_media', { columns: ['object_key', 'mime'], eq: { content_sha256: sha }, in: { rights_status: DISPLAYABLE }, limit: 1 });
  if (!row?.object_key) throw new NotFound('media');
  const obj = await bucket.get(row.object_key);
  if (!obj) throw new NotFound('media');
  return { body: obj.body, contentType: row.mime || obj.httpMetadata?.contentType || 'application/octet-stream' };
}

export async function news(store, q) {
  const opts = { columns: ['slug', 'desk', 'story_class', 'headline', 'dek', 'published_at', 'updated_at'], eq: { status: 'published' }, order: 'published_at.desc', limit: clampLimit(q.limit, 20) };
  if (q.desk) opts.eq.desk = q.desk;
  // Entity filters: stories whose frozen evidence names this team / player / match.
  if (q.team || q.player || q.match) {
    const ev = { columns: ['id'], eq: {}, limit: 200 };
    if (q.match) { if (!/^[0-9a-f-]{36}$/.test(q.match)) throw new NotFound('match'); ev.eq.match_id = q.match; }
    if (q.team) { const [t] = await store.select('soccer_teams', { columns: ['id'], eq: { slug: q.team }, limit: 1 }); if (!t) throw new NotFound(`team ${q.team}`); ev.cs = { team_ids: [t.id] }; }
    if (q.player) { const [p] = await store.select('soccer_players', { columns: ['id'], eq: { slug: q.player }, limit: 1 }); if (!p) throw new NotFound(`player ${q.player}`); ev.cs = { ...(ev.cs || {}), player_ids: [p.id] }; }
    const events = (await store.select('soccer_news_events', ev)).map(e => e.id);
    if (!events.length) return E([], { source: 'pbe', semantics: 'Published articles about this entity.', coverage: COVERAGE.UNAVAILABLE, coverage_notes: ['No published story names this entity yet.'] });
    opts.in = { news_event_id: events };
  }
  const rows = await store.select('soccer_articles', { ...opts, columns: [...opts.columns, 'entities'] });
  // Card image: the first person the story names who has an approved portrait, else the first
  // team with an approved crest; otherwise none (the page draws its branded fallback).
  const personIds = [...new Set(rows.flatMap(r => (r.entities || []).filter(e => e.type === 'Person' && e.id).map(e => e.id)))];
  const teamIds = [...new Set(rows.flatMap(r => (r.entities || []).filter(e => e.type === 'SportsTeam' && e.id).map(e => e.id)))];
  const [pm, cm] = await Promise.all([portraitMap(store, personIds), approvedMedia(store, 'team', teamIds, { mediaType: 'crest', primaryOnly: true })]);
  for (const r of rows) {
    const ents = r.entities || [];
    // ONE subject rule for cards and article pages (workers/shared/news-subject.js): the newsroom's
    // primary subject, else the person/team the headline names; its own media or none, never a teammate.
    const subject = selectSubject(r);
    const media = subjectMedia(subject, pm, cm, ents);
    r.image = media ? { kind: media.kind, url: media.url, alt: media.alt, attribution: media.attribution } : null;
    r.subject = subject.entity ? { type: subject.entity.type, name: subject.entity.name, slug: subject.entity.slug || null, reason: subject.reason } : null;
    r.teams = ents.filter(e => e.type === 'SportsTeam').slice(0, 2).map(e => ({ slug: e.slug, name: e.name }));
    delete r.entities;
  }
  return E(rows, { source: 'pbe', semantics: 'Published PropBetEdge articles only; every article is backed by a frozen evidence packet and passed all publication gates.', coverage: rows.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: rows.length ? [] : ['No published stories.'], source_updated_at: maxTs(rows.map(r => r.updated_at)) });
}

export async function article(store, slug) {
  const [a] = await store.select('soccer_articles', { columns: ['id', 'slug', 'desk', 'story_class', 'headline', 'dek', 'body', 'entities', 'published_at', 'updated_at', 'packet_hash', 'composer', 'gate_version'], eq: { slug, status: 'published' }, limit: 1 });
  if (!a) throw new NotFound(`article ${slug}`);
  // Official video linked to THIS story by the matcher (docs/VIDEO.md); none when no confident match.
  a.media = { videos: await articleVideos(store, a.id).catch(() => []) };
  // Data visuals are historical records frozen at publication (soccer-visuals): served exactly as stored, and
  // only while their values still hash to what was published. Nothing is recomputed from today's data.
  if (Array.isArray(a.body?.visuals)) {
    const intact = a.body.visuals.filter(visualIntact);
    a.body = { ...a.body, visuals: intact, ...(intact.length !== a.body.visuals.length ? { visuals_withheld: a.body.visuals.length - intact.length } : {}) };
  }
  delete a.id;
  // Additive (article page V3): approved media on the story's entities, the hero subject, and
  // related coverage by shared entities. Only approved media; nothing is guessed.
  const ents = a.entities || [];
  const personIds = ents.filter(e => e.type === 'Person' && e.id).map(e => e.id);
  const teamIds = ents.filter(e => e.type === 'SportsTeam' && e.id).map(e => e.id);
  const [pm, cm] = await Promise.all([portraitMap(store, personIds), approvedMedia(store, 'team', teamIds, { mediaType: 'crest', primaryOnly: true })]);
  a.entities = ents.map(e => ({ ...e, ...(e.type === 'Person' && pm.get(e.id) ? { portrait: pm.get(e.id) } : {}), ...(e.type === 'SportsTeam' && cm.get(e.id) ? { crest: { url: cm.get(e.id)[0].url, attribution: cm.get(e.id)[0].attribution } } : {}) }));
  // Hero: the same subject rule as the news cards (news-subject.js), so a card and its article agree.
  const subject = selectSubject({ headline: a.headline, story_class: a.story_class, entities: ents });
  const media = subjectMedia(subject, pm, cm, ents);
  a.hero = media ? { kind: media.kind, url: media.url, attribution: media.attribution, license: media.license || null, entity: { name: media.entity.name, slug: media.entity.slug }, ...(media.fallback ? { fallback: media.fallback } : {}) } : null;
  a.subject = subject.entity ? { type: subject.entity.type, name: subject.entity.name, slug: subject.entity.slug || null, reason: subject.reason } : null;
  // Related coverage: published stories sharing entities (players > match > teams), recency bonus.
  const ids = new Set(ents.map(e => e.id).filter(Boolean));
  const others = (await store.select('soccer_articles', { columns: ['slug', 'desk', 'story_class', 'headline', 'dek', 'published_at', 'entities'], eq: { status: 'published' }, order: 'published_at.desc', limit: 200 })).filter(o => o.slug !== a.slug);
  const W = { Person: 60, SportsEvent: 40, SportsTeam: 26 };
  const scored = others.map(o => {
    let s = 0; for (const e of o.entities || []) if (e.id && ids.has(e.id)) s += W[e.type] || 0;
    if (o.desk === a.desk) s += 4;
    const days = Math.abs((Date.parse(a.published_at) - Date.parse(o.published_at)) / 864e5);
    s += days <= 1 ? 12 : days <= 3 ? 9 : days <= 7 ? 6 : 0;
    return { o, s };
  }).filter(x => x.s >= 26).sort((x, y) => y.s - x.s || Date.parse(y.o.published_at) - Date.parse(x.o.published_at)).slice(0, 4);
  a.related = scored.map(({ o }) => ({ slug: o.slug, desk: o.desk, story_class: o.story_class, headline: o.headline, dek: o.dek, published_at: o.published_at }));
  return E(a, { source: 'pbe', semantics: 'Published article; packet_hash identifies the frozen evidence packet behind every figure.', source_updated_at: a.updated_at });
}

// Data depth: honest aggregates computed from the canonical store (read-only).
export async function coverage(store) {
  const comps = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'] });
  const [matchesTotal, finishedTotal, eventsTotal, eventsXY] = await Promise.all([
    store.count('soccer_matches'), store.count('soccer_matches', { eq: { status: 'finished' } }),
    store.count('soccer_match_events'), store.count('soccer_match_events', { neq: { source_coordinate_system: 'none' } }),
  ]);
  // Matches with at least one located shot = coordinate-backed event ledger.
  const shots = await store.select('soccer_match_events', { columns: ['match_id'], eq: { event_type: 'shot' }, gte: { x_m: 0 }, order: 'match_id.asc' });
  const shotMatches = [...new Set(shots.map(r => r.match_id))];
  const lineups = await store.select('soccer_lineups', { columns: ['match_id'], order: 'match_id.asc' });
  const lineupMatches = [...new Set(lineups.map(r => r.match_id))];
  const compOf = new Map();
  for (const part of chunkArr([...new Set([...shotMatches, ...lineupMatches])], 150)) for (const m of await store.select('soccer_matches', { columns: ['id', 'competition_id'], in: { id: part } })) compOf.set(m.id, m.competition_id);
  const per = [];
  for (const c of comps) {
    const [n, fin] = await Promise.all([store.count('soccer_matches', { eq: { competition_id: c.id } }), store.count('soccer_matches', { eq: { competition_id: c.id, status: 'finished' } })]);
    if (!n) continue;
    per.push({ slug: c.slug, name: c.name, matches: n, finished: fin, coordinate_backed_matches: shotMatches.filter(id => compOf.get(id) === c.id).length, matches_with_lineups: lineupMatches.filter(id => compOf.get(id) === c.id).length });
  }
  return E({
    totals: { canonical_matches: matchesTotal, finished_matches: finishedTotal, events: eventsTotal, events_with_coordinates: eventsXY, coordinate_backed_matches: shotMatches.length, matches_with_lineups: lineupMatches.length },
    competitions: per,
  }, {
    source: 'pbe', semantics: 'Counts computed live from the PropBetEdge canonical soccer graph. Coordinate-backed = at least one shot with an event location on the 105x68 pitch (event locations, not tracking). Lineups = a sourced lineup exists for the match.',
    source_updated_at: new Date().toISOString(),
  });
}

// Sitemap feed: every canonical URL key with its genuine updated_at (read-only).
// matches: finished + scheduled only (unknown/postponed pages are not indexed).
export async function sitemap(store, kind) {
  const K = {
    competitions: ['soccer_competitions', ['slug', 'updated_at'], {}, 'slug.asc'],
    teams: ['soccer_teams', ['slug', 'updated_at'], { eq: { status: 'active' } }, 'slug.asc'],
    players: ['soccer_players', ['slug', 'updated_at'], { eq: { status: 'active' } }, 'slug.asc'],
    matches: ['soccer_matches', ['id', 'status', 'updated_at'], { in: { status: ['finished', 'scheduled'] } }, 'id.asc'],
    news: ['soccer_articles', ['desk', 'slug', 'published_at', 'updated_at'], { eq: { status: 'published' } }, 'published_at.desc'],
  }[kind];
  if (kind === 'news') {
    const rows = await store.select(K[0], { columns: K[1], ...K[2], order: K[3], limit: 1000 });
    const out = rows.map(r => ({ key: `${r.desk}/${r.slug}`, desk: r.desk, updated_at: r.updated_at || r.published_at, published_at: r.published_at }));
    return E(out, { source: 'pbe', semantics: 'Published article URL keys (desk/slug) for the news sitemap; only published, gate-passed articles.', source_updated_at: maxTs(out.map(r => r.updated_at)) });
  }
  if (!K) throw new NotFound(`sitemap ${kind}`);
  const [table, columns, filter, order] = K;
  const rows = await store.select(table, { columns, ...filter, order });
  const out = rows.map(r => ({ key: r.slug || r.id, updated_at: r.updated_at || null, ...(r.status ? { status: r.status } : {}) }));
  return E(out, { source: 'pbe', semantics: `Canonical ${kind} URL keys for sitemaps; updated_at is the canonical row's last update.`, source_updated_at: maxTs(out.map(r => r.updated_at)) });
}

// ---------------- DNA routes (descriptive, time-safe; see dna.js) ----------------
import { DNA_VERSION, MIN_MINUTES, loadSeasonData, teamDna, playerProfiles, TEAM_DNA_METRICS, PLAYER_DNA_METRICS } from './dna.js';
const asOfOf = q => (/^\d{4}-\d{2}-\d{2}$/.test(String(q.as_of || '')) ? `${q.as_of}T00:00:00Z` : new Date().toISOString());
const metricList = (p, metrics) => metrics.map(([k, lower]) => ({ key: k, value: p[k] ?? null, percentile: p.percentiles?.[k] ?? null, lower_is_better: lower }));

export async function teamDnaRoute(store, slug, q, env = null) {
  const [t] = await store.select('soccer_teams', { columns: ['id', 'slug', 'name'], eq: { slug, status: 'active' }, limit: 1 });
  if (!t) throw new NotFound(`team ${slug}`);
  const asOf = asOfOf(q);
  const recent = [...await store.select('soccer_matches', { columns: ['competition_id', 'season_id', 'kickoff_at'], eq: { home_team_id: t.id, status: 'finished' }, order: 'kickoff_at.desc', limit: 20 }), ...await store.select('soccer_matches', { columns: ['competition_id', 'season_id', 'kickoff_at'], eq: { away_team_id: t.id, status: 'finished' }, order: 'kickoff_at.desc', limit: 20 })]
    .filter(m => Date.parse(m.kickoff_at) < Date.parse(asOf)).sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at));
  let comp = null;
  if (q.competition) comp = await competitionBySlug(store, q.competition);
  const pick = comp ? recent.find(m => m.competition_id === comp.id) : recent[0];
  if (!pick) return E({ team: { slug: t.slug, name: t.name }, as_of: asOf, profile: null }, { source: 'pbe', semantics: 'No finished matches before as_of.', coverage: COVERAGE.UNAVAILABLE });
  const [c] = await store.select('soccer_competitions', { columns: ['slug', 'name'], eq: { id: pick.competition_id }, limit: 1 });
  const [s] = await store.select('soccer_seasons', { columns: ['label'], eq: { id: pick.season_id }, limit: 1 });
  const { profiles: all, latest } = await seasonProfiles(store, env, pick.season_id, asOf, 'team'); const p = all.get(t.id);
  const D = { matches: latest ? [{ kickoff_at: latest }] : [] };
  return E({
    team: { slug: t.slug, name: t.name }, competition: c, season: s?.label, as_of: asOf, dna_version: DNA_VERSION, teams_compared: all.size,
    matches: p?.matches ?? 0, form: p?.form || [], comeback_wins: p?.comeback_wins ?? null, conceded_first: p?.conceded_first ?? null, stats_matches: p?.stats_matches ?? 0,
    metrics: p ? metricList(p, TEAM_DNA_METRICS) : [],
  }, {
    source: 'pbe', source_updated_at: maxTs(D.matches.map(m => m.kickoff_at)),
    semantics: `Team DNA: descriptive profile from canonical results, goal/card events and team statistics of ${c?.name} ${s?.label}, using ONLY matches that kicked off before ${asOf.slice(0, 10)} (time-safe). Percentile = rank among the ${all.size} teams of the same competition-season (100 = best; lower-is-better metrics inverted). Shot metrics count only matches with team statistics. Not a prediction.`,
    coverage: p ? COVERAGE.OK : COVERAGE.UNAVAILABLE,
  });
}

export async function playerDnaRoute(store, slug, q, env = null) {
  const [p] = await store.select('soccer_players', { columns: ['id', 'slug', 'display_name'], eq: { slug, status: 'active' }, limit: 1 });
  if (!p) throw new NotFound(`player ${slug}`);
  const asOf = asOfOf(q);
  const lps = await store.select('soccer_lineup_players', { columns: ['lineup_id'], eq: { player_id: p.id }, order: 'lineup_id.asc' });
  const lus = lps.length ? await store.select('soccer_lineups', { columns: ['match_id'], in: { id: lps.map(x => x.lineup_id).slice(0, 150) } }) : [];
  const ms = lus.length ? await store.select('soccer_matches', { columns: ['id', 'season_id', 'competition_id', 'kickoff_at'], in: { id: lus.map(x => x.match_id) } }) : [];
  const seasons = [...new Map(ms.filter(m => Date.parse(m.kickoff_at) < Date.parse(asOf)).sort((a, b) => Date.parse(b.kickoff_at) - Date.parse(a.kickoff_at)).map(m => [m.season_id, m])).values()].slice(0, 2);
  const out = [];
  for (const sm of seasons) {
    const [c] = await store.select('soccer_competitions', { columns: ['slug', 'name'], eq: { id: sm.competition_id }, limit: 1 });
    const [s] = await store.select('soccer_seasons', { columns: ['label'], eq: { id: sm.season_id }, limit: 1 });
    const { profiles: all } = await seasonProfiles(store, env, sm.season_id, asOf, 'player');
    const me = all.get(p.id); if (!me) continue;
    out.push({ competition: c, season: s?.label, players_compared: [...all.values()].filter(x => x.minutes_nominal >= MIN_MINUTES).length, eligible_for_percentiles: me.minutes_nominal >= MIN_MINUTES,
      appearances: me.appearances, starts: me.starts, sub_appearances: me.sub_appearances, subbed_off: me.subbed_off, minutes_nominal: me.minutes_nominal,
      goals: me.goals, assists: me.assists, shots: me.shots, shots_on_target: me.shots_on_target, key_passes: me.key_passes, cards: me.cards, splits: me.splits, last5: me.last5,
      metrics: metricList(me, PLAYER_DNA_METRICS) });
  }
  return E({ player: { slug: p.slug, name: p.display_name }, as_of: asOf, dna_version: DNA_VERSION, min_minutes_for_percentiles: MIN_MINUTES, seasons: out }, {
    source: 'pbe', semantics: `Player DNA: descriptive per-competition-season profile from sourced lineups (appearances, starts, nominal minutes), goal/shot/assist/card events and PBE derived counts, using ONLY matches that kicked off before ${asOf.slice(0, 10)} (time-safe). Per-90 rates use NOMINAL minutes. Percentiles rank against players with at least ${MIN_MINUTES} nominal minutes in the same competition-season. Not a prediction.`,
    coverage: out.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE,
  });
}

// ---------------- DATA HEALTH (P15) ----------------
// One production health view per competition. Optional-component gaps (lineups, stats,
// play-by-play) are reported separately from results, so an upstream outage on one
// component never makes a whole lane look dead.
import registryData from '../../../data/registry/competitions.json' with { type: 'json' };
export async function dataHealth(store, env) {
  const now = Date.now();
  const kv = async k => (env?.SOCCER_STATE ? await env.SOCCER_STATE.get(k, 'json') : null);
  const out = [];
  for (const rc of registryData.competitions.filter(c => c.espn?.enabled || c.slug === 'bundesliga')) {
    const [c] = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], eq: { slug: rc.slug }, limit: 1 });
    if (!c) { out.push({ competition: rc.slug, missing: true }); continue; }
    const s = (await seasonsOf(store, c.id))[0];
    const ms = await store.select('soccer_matches', { columns: ['id', 'status', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score'], eq: { season_id: s.id }, order: 'id.asc' });
    const past = ms.filter(m => Date.parse(m.kickoff_at) < now - 3 * 3600e3);
    const teams = new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]));
    const ids = ms.filter(m => m.status === 'finished').map(m => m.id);
    const gaps = [];
    for (const part of chunkArr(ids, 100)) gaps.push(...await store.select('soccer_match_enrichment', { columns: ['component', 'status', 'last_error', 'attempts'], in: { match_id: part }, eq: {} }).then(r => r.filter(x => x.status !== 'complete' && x.status !== 'not_applicable')));
    const gapBy = {}; for (const g of gaps) { const k = g.component.replace(/_(home|away)$/, ''); gapBy[k] = (gapBy[k] || 0) + 1; }
    const lineupMatches = new Set(); for (const part of chunkArr(ids, 100)) for (const l of await store.select('soccer_lineups', { columns: ['match_id'], in: { match_id: part } })) lineupMatches.add(l.match_id);
    const statMatches = new Set(); for (const part of chunkArr(ids, 100)) for (const x of await store.select('soccer_team_match_stats', { columns: ['match_id'], in: { match_id: part }, eq: { stat_key: 'shots' } })) statMatches.add(x.match_id);
    const pbpMatches = new Set(); for (const part of chunkArr(ids, 100)) for (const x of await store.select('soccer_match_events', { columns: ['match_id'], in: { match_id: part }, eq: { event_type: 'shot' } })) pbpMatches.add(x.match_id);
    const lanes = await Promise.all([rc.espn?.enabled ? `espn_${rc.slug.replace(/-/g, '_')}` : null, rc.slug === 'bundesliga' ? 'openligadb_bl1_current' : null].filter(Boolean).map(async name => { const st = await kv(`lane:${name}`); return { lane: name, health: st?.health || 'unknown', last_success_at: st?.last_success_at || null, last_attempt_at: st?.last_attempt_at || null, consecutive_failures: st?.consecutive_failures ?? null, last_error: st?.last_error ? String(st.last_error).slice(0, 160) : null }; }));
    const heldArticles = await store.select('soccer_articles', { columns: ['hold_reasons'], eq: { status: 'held', desk: rc.desk } });
    const heldBy = {}; for (const a of heldArticles) for (const r of a.hold_reasons || []) heldBy[r] = (heldBy[r] || 0) + 1;
    const [pub] = await store.select('soccer_articles', { columns: ['published_at'], eq: { status: 'published', desk: rc.desk }, order: 'published_at.desc', limit: 1 });
    const crests = [...teams].length ? (await store.select('soccer_entity_media', { columns: ['entity_id'], eq: { entity_type: 'team', media_type: 'crest', is_primary: true }, in: { entity_id: [...teams], rights_status: DISPLAYABLE } })).length : 0;
    out.push({
      competition: c.slug, season: s.label,
      teams: { expected: rc.expected_teams ?? null, present: teams.size, ok: rc.expected_teams ? teams.size === rc.expected_teams : null },
      fixtures: { total: ms.length, scheduled: ms.filter(m => m.status === 'scheduled').length, finished: ids.length, live: ms.filter(m => m.status === 'live').length },
      missing_result: past.filter(m => m.status !== 'finished' && m.status !== 'postponed' && m.status !== 'cancelled').length,
      stale_live: ms.filter(m => m.status === 'live' && Date.parse(m.kickoff_at) < now - 4 * 3600e3).length,
      finished_missing: { lineup: ids.filter(i => !lineupMatches.has(i)).length, stats: ids.filter(i => !statMatches.has(i)).length, play_by_play: ids.filter(i => !pbpMatches.has(i)).length },
      enrichment_open: gapBy,
      media: { crests_approved: crests, teams: teams.size },
      lanes,
      news: { latest_published_at: pub?.published_at || null, held: heldArticles.length, held_reasons: heldBy },
    });
  }
  const queue = await store.select('soccer_identity_queue', { columns: ['entity_type', 'provider'], eq: { status: 'open' } });
  const qBy = {}; for (const q of queue) { const k = `${q.entity_type}/${q.provider}`; qBy[k] = (qBy[k] || 0) + 1; }
  const [portraits, players] = await Promise.all([store.count('soccer_entity_media', { eq: { entity_type: 'player', media_type: 'portrait', is_primary: true }, in: { rights_status: DISPLAYABLE } }), store.count('soccer_players', { eq: { status: 'active' } })]);
  const news = await kv('news:last_run');
  const standings = await kv('lane:espn_standings');
  const newsroom = await newsroomHealth(store, news, await kv('news:last_tick'), now);
  return E({
    at: new Date(now).toISOString(), competitions: out, newsroom,
    identity_queue_open: qBy, media: { portraits_approved: portraits, active_players: players },
    standings_lane: standings ? { last_success_at: standings.last_success_at, health: standings.health } : null,
    news_worker: news ? { last_run_at: news.at, llm: news.llm, by_competition: Object.fromEntries(Object.entries(news.competitions || {}).map(([k, v]) => [k, { candidates: v.candidates, new: v.new, published: v.published, held: v.held }])) } : null,
  }, { source: 'pbe', semantics: 'Production data health computed live from the canonical graph and lane state. Result gaps and optional-component gaps (lineup, stats, play-by-play) are separate: a failed optional component never marks the result or the lane dead.', source_updated_at: new Date(now).toISOString() });
}

// NEWSROOM HEALTH: one view that explains a quiet newsroom in 30 seconds. Global: is the cron fresh
// (a run every 30 min), is the editorial desk available, is NEWS_ENABLED on, publications in 24/72 h.
// Per news-enabled competition (registry `news`): season, last canonical match update, the last run's
// candidates / duplicates / new / published / held and its detection diagnostics (finished in window,
// eligible, awaiting enrichment, preview-window fixtures), the newest story and its age, the main hold
// reasons, and fixtures in the next 24 h. Public-safe: counts and reasons only (no error text, no ids).
export async function newsroomHealth(store, last, lastTick, now = Date.now()) {
  const hours = iso => (iso ? Math.round((now - Date.parse(iso)) / 36e5 * 10) / 10 : null);
  const pubs = await store.select('soccer_articles', { columns: ['desk', 'published_at'], eq: { status: 'published' }, gte: { published_at: new Date(now - 72 * 3600e3).toISOString() } });
  const held = await store.select('soccer_articles', { columns: ['desk', 'hold_reasons', 'updated_at'], eq: { status: 'held' } });
  const comps = [];
  for (const rc of registryData.competitions.filter(c => c.news?.enabled)) {
    const [c] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: rc.slug }, limit: 1 });
    const s = c ? (await seasonsOf(store, c.id))[0] : null;
    const [lastMatch] = s ? await store.select('soccer_matches', { columns: ['updated_at'], eq: { season_id: s.id }, order: 'updated_at.desc', limit: 1 }) : [];
    const upcoming = s ? await store.count('soccer_matches', { eq: { season_id: s.id, status: 'scheduled' }, gte: { kickoff_at: new Date(now).toISOString() }, lte: { kickoff_at: new Date(now + 24 * 3600e3).toISOString() } }) : 0;
    const [newest] = await store.select('soccer_articles', { columns: ['headline', 'story_class', 'published_at'], eq: { status: 'published', desk: rc.desk }, order: 'published_at.desc', limit: 1 });
    const holds = {}; for (const a of held.filter(x => x.desk === rc.desk)) for (const r of a.hold_reasons || []) holds[r] = (holds[r] || 0) + 1;
    const run = last?.competitions?.[rc.slug] || null;
    comps.push({
      competition: rc.slug, desk: rc.desk, stories: rc.news.stories, season: s?.label || null,
      last_canonical_match_update: lastMatch?.updated_at || null,
      last_run: run ? { candidates: run.candidates, duplicates: run.duplicates ?? null, new: run.new, published: run.published, held: run.held, by_class: run.by_class || null, detection: run.diagnostics || null, skipped: run.skipped || null } : null,
      newest_story: newest ? { headline: newest.headline, story_class: newest.story_class, published_at: newest.published_at, age_hours: hours(newest.published_at) } : null,
      published_24h: pubs.filter(p => p.desk === rc.desk && now - Date.parse(p.published_at) <= 24 * 3600e3).length,
      held_open: held.filter(x => x.desk === rc.desk).length,
      primary_hold_reasons: Object.entries(holds).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([reason, n]) => ({ reason, n })),
      fixtures_next_24h: upcoming,
      preview_eligible_last_run: run?.diagnostics?.preview_eligible ?? null,
    });
  }
  const lastAt = last?.at || null;
  return {
    // fresh = a successful run within 45 min (cron every 30). last_tick tells WHY it is not fresh:
    // no recent tick = cron not firing; outcome 'disabled' = NEWS_ENABLED off; 'failed' = the run errors.
    cron: { schedule: '7,37 * * * *', last_successful_run_at: lastAt, minutes_since: lastAt ? Math.round((now - Date.parse(lastAt)) / 6e4) : null, fresh: !!lastAt && now - Date.parse(lastAt) < 45 * 60e3, last_tick_at: lastTick?.at || null, last_tick_outcome: lastTick?.outcome || null },
    news_enabled: lastTick ? lastTick.news_enabled : last?.news_enabled ?? null,
    editorial_desk: last?.desk ? { available: !!last.desk.available, required: !!last.desk.required, version: last.desk.version } : null,
    published_24h: pubs.filter(p => now - Date.parse(p.published_at) <= 24 * 3600e3).length,
    published_72h: pubs.length,
    newest_published_at: pubs.map(p => p.published_at).sort().pop() || (await store.select('soccer_articles', { columns: ['published_at'], eq: { status: 'published' }, order: 'published_at.desc', limit: 1 }))[0]?.published_at || null,
    competitions: comps,
  };
}

// Season-level DNA cache (KV). The key is the DATA CUTOFF (the last finished match that
// kicked off before as_of), so any two as_of dates between the same matches share one
// entry and the profile stays time-safe. Current seasons: 6 h TTL (late lineups, retried
// components, corrections); historical seasons: 30 days.
export async function seasonProfiles(store, env, seasonId, asOf, kind) {
  const [last] = await store.select('soccer_matches', { columns: ['kickoff_at'], eq: { season_id: seasonId, status: 'finished' }, lte: { kickoff_at: asOf }, order: 'kickoff_at.desc', limit: 2 })
    .then(rows => rows.filter(r => Date.parse(r.kickoff_at) < Date.parse(asOf)));
  const cutoff = last ? new Date(last.kickoff_at).toISOString() : 'none';
  const key = `dna:${DNA_VERSION}:${kind}:${seasonId}:${cutoff}`;
  const kv = env?.SOCCER_STATE;
  if (kv) { const hit = await kv.get(key, 'json').catch(() => null); if (hit) return { profiles: new Map(hit.profiles), cutoff, cached: true, latest: hit.latest }; }
  const D = await loadSeasonData(store, seasonId, asOf);
  const profiles = kind === 'team' ? teamDna(D) : await playerProfiles(store, D);
  const latest = D.matches.length ? D.matches[D.matches.length - 1].kickoff_at : null;
  const recent = latest && Date.now() - Date.parse(latest) < 30 * 86400e3;
  if (kv) await kv.put(key, JSON.stringify({ profiles: [...profiles.entries()], latest }), { expirationTtl: recent ? 6 * 3600 : 30 * 86400 }).catch(() => {});
  return { profiles, cutoff, cached: false, latest };
}

// Warm the DNA cache for the latest season of each product competition (soccer-api cron).
export async function warmDna(store, env) {
  const out = [];
  const asOf = new Date().toISOString();
  for (const slug of ['mls', 'premier-league', 'uefa-champions-league', 'bundesliga']) {
    const [c] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug }, limit: 1 }); if (!c) continue;
    const s = (await seasonsOf(store, c.id))[0]; if (!s) continue;
    for (const kind of ['team', 'player']) { const t0 = Date.now(); const r = await seasonProfiles(store, env, s.id, asOf, kind); out.push({ slug, season: s.label, kind, cached: r.cached, ms: Date.now() - t0, size: r.profiles.size }); }
  }
  // The Wyscout 2017/18 Bundesliga season (event-dense; the only lineup season for many players).
  const [bl] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: 'bundesliga' }, limit: 1 });
  const wy = bl ? (await seasonsOf(store, bl.id)).find(x => x.label === '2017/18') : null;
  if (wy) { const t0 = Date.now(); const r = await seasonProfiles(store, env, wy.id, asOf, 'player'); out.push({ slug: 'bundesliga', season: '2017/18', kind: 'player', cached: r.cached, ms: Date.now() - t0, size: r.profiles.size }); }
  return out;
}

// Newsroom WATCH module: recent official highlights (verified channels only), optionally per desk.
export async function videos(store, q = {}) {
  const desk = ['mls', 'premier-league', 'champions-league', 'bundesliga', 'international'].includes(q.desk) ? q.desk : null;
  const limit = Math.max(1, Math.min(8, Number(q.limit) || 4));
  const rows = await videosFeed(store, { desk, limit });
  return E(rows, { source: 'youtube_official', semantics: 'Official videos from verified publisher channels, embedded from YouTube (privacy-enhanced player, loaded on click). Not hosted by PropBetEdge.', coverage: rows.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE, coverage_notes: rows.length ? [] : ['No recent official video for this desk.'] });
}
