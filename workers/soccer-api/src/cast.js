// PBEcast + Player DNA directory routes (soccer-api). Read-only, sourced only.
//   GET /v1/live                 live / recent / upcoming matches for the PBEcast hub and home rail
//   GET /v1/matches/:id/cast     the canonical match (sequence, lineups, stats, impact, portraits)
//                                plus the live lane's source clock and freshness
//   GET /v1/players              Player DNA directory for the product competition-seasons
// The source clock is the provider's own display value (ESPN status displayClock), stored by
// the soccer-ingest live lane in KV `live:<matchId>`; nothing here computes or advances a clock.
import { match, approvedMedia, portraitMap, NotFound } from './routes.js';
import { envelope, maxTs, COVERAGE } from './envelope.js';
import { seasonProfiles } from './routes.js';
import { MIN_MINUTES, DNA_VERSION } from './dna.js';
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { readLiveSnapshot, refreshLiveEnvelope, snapshotServeable, writeLiveSnapshot } from '../../shared/live-snapshot.js';

export const CAST_VERSION = 'soccer-api/1.4.0'; // 1.4.0: live.enrichment (additive, rights-gated), live.canonical_result_source
const E = (data, o) => envelope(data, { version: CAST_VERSION, ...o });
export const PRODUCT_COMPS = ['mls', 'premier-league', 'uefa-champions-league', 'bundesliga'];
export const LIVE_CADENCE_S = 60; // soccer-ingest live lane: one poll per active match per minute (budgeted)

const MATCH_COLS = ['id', 'competition_id', 'season_id', 'matchday', 'round_label', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'home_score', 'away_score', 'home_score_ht', 'away_score_ht', 'result_provider', 'updated_at'];

async function liveState(env, id) {
  if (!env?.SOCCER_STATE) return null;
  return env.SOCCER_STATE.get(`live:${id}`, 'json').catch(() => null);
}
// Which live-lane state may be served publicly:
//   owner       the lane's state for a match whose canonical result ESPN owns (and legacy states
//               written before roles existed): served as before (display_clock, freshness);
//   enrichment  a secondary provider's state beside another canonical owner (Bundesliga): served
//               ONLY as live.enrichment, ONLY when its mode is 'public' AND this Worker's
//               LIVE_ENRICHMENT_PUBLIC switch is 'on' (owner source-rights gate). Shadow state
//               (internal validation) is never served.
export const STALE_AFTER_MS = 5 * 60e3; // no fresh provider observation for 5 minutes = DELAYED
export function servedLive(ls, env) {
  if (!ls) return { owner: null, enrichment: null };
  if (!ls.role || ls.role === 'owner') return { owner: ls, enrichment: null };
  if (ls.role === 'enrichment' && ls.mode === 'public' && env?.LIVE_ENRICHMENT_PUBLIC === 'on') return { owner: null, enrichment: ls };
  return { owner: null, enrichment: null };
}
// The additive enrichment contract. The canonical result stays in `score` / `status` of the match;
// this block is the secondary provider's own, fresher view with its provenance and freshness.
export function enrichmentBlock(ls, now = Date.now()) {
  if (!ls) return null;
  const age = ls.observed_at ? Math.max(0, Math.round((now - Date.parse(ls.observed_at)) / 1000)) : null;
  const stale = age === null || age * 1000 > STALE_AFTER_MS;
  return {
    source_role: 'secondary_enrichment', source: ls.source || null, fetched_at: ls.observed_at || null,
    status: ls.status || null,
    score: ls.score && ls.score.home !== null && ls.score.home !== undefined ? { home: ls.score.home, away: ls.score.away } : null,
    clock: { display: ls.display_clock || null, period: ls.period ?? null, detail: ls.detail || null },
    freshness: { age_seconds: age, stale, stale_after_seconds: STALE_AFTER_MS / 1000, changed_at: ls.changed_at || null },
  };
}

async function laneState(env) {
  if (!env?.SOCCER_STATE) return null;
  const st = await env.SOCCER_STATE.get('lane:espn_live', 'json').catch(() => null);
  return st ? { last_attempt_at: st.last_attempt_at || null, last_success_at: st.last_success_at || null, health: st.health || null } : null;
}

async function teamsAndComps(store, ms) {
  const teamIds = [...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))];
  const teams = new Map();
  for (const part of chunkArr(teamIds, 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name'], in: { id: part } })) teams.set(t.id, t);
  for (const [id, list] of await approvedMedia(store, 'team', teamIds, { mediaType: 'crest', primaryOnly: true })) if (teams.get(id)) teams.get(id).crest = list[0];
  const compIds = [...new Set(ms.map(m => m.competition_id))];
  const comps = compIds.length ? new Map((await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], in: { id: compIds } })).map(c => [c.id, { slug: c.slug, name: c.name }])) : new Map();
  return { teams, comps };
}

async function intel(store, ids) {
  const out = { lineups: new Set(), events: new Set(), located: new Set(), stats: new Set() };
  for (const part of chunkArr(ids, 100)) {
    const [l, ev, loc, st] = await Promise.all([
      store.select('soccer_lineups', { columns: ['match_id'], in: { match_id: part }, order: 'match_id.asc' }),
      store.select('soccer_match_events', { columns: ['match_id'], in: { match_id: part, event_type: ['shot', 'goal', 'card'] }, order: 'match_id.asc' }),
      store.select('soccer_match_events', { columns: ['match_id'], in: { match_id: part }, eq: { event_type: 'shot' }, gte: { x_m: 0 }, order: 'match_id.asc' }),
      store.select('soccer_team_match_stats', { columns: ['match_id'], in: { match_id: part }, eq: { stat_key: 'shots' }, order: 'match_id.asc' }),
    ]);
    l.forEach(r => out.lineups.add(r.match_id)); ev.forEach(r => out.events.add(r.match_id)); loc.forEach(r => out.located.add(r.match_id)); st.forEach(r => out.stats.add(r.match_id));
  }
  return id => ({ lineups: out.lineups.has(id), events: out.events.has(id), event_map: out.located.has(id), stats: out.stats.has(id) });
}

function shape(m, teams, comps, flags, live, enrichment = null) {
  const t = id => { const x = teams.get(id); return x ? { slug: x.slug, name: x.name, short_name: x.short_name, ...(x.crest ? { crest: x.crest } : {}) } : null; };
  return {
    id: m.id, status: m.status, kickoff_at: m.kickoff_at, competition: comps.get(m.competition_id) || null, round: m.round_label,
    home: t(m.home_team_id), away: t(m.away_team_id),
    score: m.home_score === null ? null : { home: m.home_score, away: m.away_score, home_ht: m.home_score_ht, away_ht: m.away_score_ht },
    intel: flags(m.id), updated_at: m.updated_at,
    ...(live || enrichment ? { live: { display_clock: live?.display_clock || null, detail: live?.detail || null, observed_at: live?.observed_at || null, ...(enrichment ? { enrichment } : {}) } } : {}),
  };
}

export async function buildLiveEnvelope(store, env, now = Date.now()) {
  const iso = t => new Date(t).toISOString();
  const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { slug: PRODUCT_COMPS } });
  const compIds = comps.map(c => c.id);
  const [liveRows, recent, upcoming] = await Promise.all([
    store.select('soccer_matches', { columns: MATCH_COLS, eq: { status: 'live' }, in: { competition_id: compIds }, order: 'kickoff_at.asc', limit: 40 }),
    store.select('soccer_matches', { columns: MATCH_COLS, eq: { status: 'finished' }, in: { competition_id: compIds }, gte: { kickoff_at: iso(now - 4 * 86400e3) }, lte: { kickoff_at: iso(now) }, order: 'kickoff_at.desc', limit: 24 }),
    store.select('soccer_matches', { columns: MATCH_COLS, eq: { status: 'scheduled' }, in: { competition_id: compIds }, gte: { kickoff_at: iso(now - 3 * 3600e3) }, order: 'kickoff_at.asc', limit: 24 }),
  ]);
  const all = [...liveRows, ...recent, ...upcoming];
  const [{ teams, comps: compMap }, flags, lane] = await Promise.all([teamsAndComps(store, all), intel(store, all.map(m => m.id)), laneState(env)]);
  const liveInfo = new Map(await Promise.all(liveRows.map(async m => [m.id, servedLive(await liveState(env, m.id), env)])));
  return E({
    live: liveRows.map(m => shape(m, teams, compMap, flags, liveInfo.get(m.id).owner, enrichmentBlock(liveInfo.get(m.id).enrichment, now))),
    recent: recent.map(m => shape(m, teams, compMap, flags)),
    upcoming: upcoming.map(m => shape(m, teams, compMap, flags)),
    lane: lane ? { ...lane, cadence_seconds: LIVE_CADENCE_S } : null,
  }, {
    source: 'pbe', source_updated_at: maxTs(all.map(m => m.updated_at)),
    semantics: `Canonical match states. Live scores and clocks come from ESPN (secondary source) through the soccer-ingest live lane, about once a minute per active match plus the provider's own delay. A clock is shown only as the provider states it.`,
    attribution: [...new Set(all.map(m => m.result_provider).filter(Boolean))],
  });
}

export async function materializeLive(store, env, { now = Date.now(), reason = 'scheduled' } = {}) {
  const before = store.requests;
  const envelope = await buildLiveEnvelope(store, env, now);
  const status = await writeLiveSnapshot(env.SOCCER_STATE, envelope, { now, reason, storeRequests: store.requests - before });
  return { envelope, status };
}

export async function live(store, env) {
  const now = Date.now();
  const snapshot = await readLiveSnapshot(env?.SOCCER_STATE);
  if (snapshotServeable(snapshot, now)) {
    const envelope = refreshLiveEnvelope(snapshot.envelope, now);
    envelope.meta = { ...envelope.meta, snapshot: { version: snapshot.snapshot_version, built_at: snapshot.built_at, source: 'kv' } };
    return envelope;
  }
  // Fail open to the canonical builder if the snapshot is absent/stale. This preserves availability
  // during rollout or a cron incident; the normal production path is one KV GET and zero PostgREST reads.
  const envelope = await buildLiveEnvelope(store, env, now);
  if (env?.SOCCER_STATE) await writeLiveSnapshot(env.SOCCER_STATE, envelope, { now, reason: 'api_fallback', storeRequests: store.requests }).catch(() => {});
  envelope.meta = { ...envelope.meta, snapshot: { source: 'database_fallback' } };
  return envelope;
}

export async function cast(store, id, env) {
  const env0 = await match(store, id);
  const m = env0.data;
  const [raw, lane] = await Promise.all([liveState(env, id), laneState(env)]);
  const { owner: ls, enrichment } = servedLive(raw, env);
  const liveNow = m.status === 'live';
  const observed = ls?.observed_at || null;
  const staleAfter = STALE_AFTER_MS;
  const stale = liveNow ? !observed || Date.now() - Date.parse(observed) > staleAfter : false;
  env0.data.live = {
    mode: liveNow ? 'live' : m.status === 'finished' ? 'replay' : m.status === 'scheduled' ? 'pregame' : m.status,
    display_clock: liveNow ? ls?.display_clock || null : null,
    detail: liveNow ? ls?.detail || null : null,
    provider_observed_at: observed,
    stale, stale_after_seconds: staleAfter / 1000,
    lane: lane ? { ...lane, cadence_seconds: LIVE_CADENCE_S } : null,
    canonical_result_source: m.result_source || null,
    enrichment: liveNow ? enrichmentBlock(enrichment) : null,
  };
  env0.meta.api_version = CAST_VERSION;
  env0.meta.source_updated_at = maxTs(env0.meta.source_updated_at, observed);
  env0.meta.semantics = `${env0.meta.semantics} PBEcast: the sequence is the provider's sourced events in order (event locations, not tracking); the clock is shown only as the provider states it.`;
  return env0;
}

// ---- Player DNA directory ----
const norm = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
export const DIRECTORY_SORTS = ['minutes', 'goals', 'assists', 'goals_per90', 'assists_per90', 'goal_contributions_per90', 'shots_per90', 'key_passes_per90'];

export async function players(store, q, env) {
  const slugs = q.competition ? PRODUCT_COMPS.filter(s => s === q.competition) : PRODUCT_COMPS;
  if (q.competition && !slugs.length) throw new NotFound(`competition ${q.competition}`);
  const rows = [];
  const seasonsOut = [];
  const asOf = new Date().toISOString();
  for (const slug of slugs) {
    const [c] = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name'], eq: { slug }, limit: 1 }); if (!c) continue;
    const seasons = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1));
    const s = q.season ? seasons.find(x => x.label === q.season) : seasons[0];
    if (!s) continue;
    const { profiles } = await seasonProfiles(store, env, s.id, asOf, 'player');
    const eligible = [...profiles.values()].filter(p => p.minutes_nominal >= MIN_MINUTES).length;
    seasonsOut.push({ competition: { slug: c.slug, name: c.name }, season: s.label, players: profiles.size, qualified: eligible });
    for (const p of profiles.values()) rows.push({ p, competition: { slug: c.slug, name: c.name }, season: s.label, qualified_pool: eligible });
  }
  const ids = [...new Set(rows.map(r => r.p.player_id))];
  const people = new Map();
  for (const part of chunkArr(ids, 150)) for (const x of await store.select('soccer_players', { columns: ['id', 'slug', 'display_name', 'primary_role', 'nationality_code'], in: { id: part }, eq: { status: 'active' } })) people.set(x.id, x);
  let list = rows.filter(r => people.has(r.p.player_id));
  if (q.q) { const needle = norm(q.q).trim(); if (needle.length >= 2) list = list.filter(r => norm(people.get(r.p.player_id).display_name).includes(needle)); }
  if (q.role) list = list.filter(r => people.get(r.p.player_id).primary_role === q.role);
  const teamIds = [...new Set(list.map(r => r.p.team_id).filter(Boolean))];
  const teams = new Map();
  for (const part of chunkArr(teamIds, 150)) for (const t of await store.select('soccer_teams', { columns: ['id', 'slug', 'name', 'short_name'], in: { id: part } })) teams.set(t.id, t);
  for (const [tid, m] of await approvedMedia(store, 'team', teamIds, { mediaType: 'crest', primaryOnly: true })) if (teams.get(tid)) teams.get(tid).crest = m[0];
  if (q.team) list = list.filter(r => teams.get(r.p.team_id)?.slug === q.team);
  // Leaders are only defined inside ONE competition-season, among qualified players.
  const sort = DIRECTORY_SORTS.includes(q.sort) ? q.sort : 'minutes';
  const leaderMode = sort !== 'minutes' && sort !== 'goals' && sort !== 'assists';
  if (leaderMode) {
    if (!q.competition) throw Object.assign(new Error('rate leaders need one competition'), { status: 400 });
    list = list.filter(r => r.p.minutes_nominal >= MIN_MINUTES && r.p[sort] !== null);
  }
  const key = sort === 'minutes' ? 'minutes_nominal' : sort;
  list.sort((a, b) => (b.p[key] ?? -1) - (a.p[key] ?? -1) || b.p.minutes_nominal - a.p.minutes_nominal || (people.get(a.p.player_id).display_name < people.get(b.p.player_id).display_name ? -1 : 1));
  const total = list.length;
  const offset = Math.max(0, Math.min(5000, Number(q.offset) || 0));
  const limit = Math.max(1, Math.min(100, Number(q.limit) || 48));
  const page = list.slice(offset, offset + limit);
  const portraits = await portraitMap(store, page.map(r => r.p.player_id));
  const data = page.map(r => {
    const x = people.get(r.p.player_id); const t = teams.get(r.p.team_id);
    return {
      slug: x.slug, name: x.display_name, role: x.primary_role, nationality_code: x.nationality_code,
      ...(portraits.get(x.id) ? { portrait: portraits.get(x.id) } : {}),
      team: t ? { slug: t.slug, name: t.name, short_name: t.short_name, ...(t.crest ? { crest: t.crest } : {}) } : null,
      competition: r.competition, season: r.season,
      appearances: r.p.appearances, starts: r.p.starts, minutes_nominal: r.p.minutes_nominal, goals: r.p.goals, assists: r.p.assists, shots: r.p.shots,
      qualified: r.p.minutes_nominal >= MIN_MINUTES,
      ...(leaderMode ? { value: r.p[sort], percentile: r.p.percentiles?.[sort] ?? null, compared_with: r.qualified_pool } : {}),
    };
  });
  return E({ total, offset, limit, sort, leaders: leaderMode, min_minutes_for_percentiles: MIN_MINUTES, dna_version: DNA_VERSION, seasons: seasonsOut, players: data }, {
    source: 'pbe',
    semantics: `Player DNA directory: players who appeared in sourced lineups of the latest stored season of each product competition (time-safe as of today). Rate leaders are shown only within one competition-season and only among players with at least ${MIN_MINUTES} nominal minutes; there is no cross-competition ranking. Descriptive, not a prediction.`,
    coverage: data.length ? COVERAGE.OK : COVERAGE.UNAVAILABLE,
  });
}
