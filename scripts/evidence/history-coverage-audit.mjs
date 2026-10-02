#!/usr/bin/env node
// HISTORICAL COVERAGE AUDIT (ESPN Core, read-only). Measures, per competition-season in ESPN's own season
// catalog, what the source actually publishes before any historical ingestion:
//   catalog: seasons listed by ESPN for the league
//   season : season types (name, event count), event index size, teams listed
//   sample : K matches spread across the season (first / thirds / last by index order). Per match:
//            date, status, both scores, venue, lineupAvailable / playByPlayAvailable flags, home roster
//            (entries, starters, formation, substitutions, per-player statistics refs), home team
//            statistics (whitelisted keys), play-by-play page 1 (plays, located plays, shots, goals,
//            cards, substitutions)
// Nothing is ingested and nothing is written to the database or R2. Access rules are the discovery
// rules: Core API only, workers/shared/http.js politeFetch (honest UA, >= 700 ms spacing per host,
// 401/403/challenge -> SourceBlockedError, never retried), 5xx max 2 retries.
// Responses are cached on local disk (CACHE dir) so an interrupted audit resumes without refetching.
//
//   node scripts/evidence/history-coverage-audit.mjs [--comps eng.1,usa.1] [--k 4] [--cache D:/Temp/soccer-history-audit-cache] [--out file]
// Bounded concurrency: run at most 3 processes (disjoint --comps, separate --out), each paced >= 700 ms.
// Output: docs/evidence/history/coverage-audit-<date>.json (+ progress lines on stdout)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetch, SourceBlockedError } from '../../workers/shared/http.js';
import { mapPlayType, parseRoster, parseStatus, parseTeamStats, refId, refsOf } from '../../workers/providers/espn.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : d; };
const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const K = Number(arg('--k', '4'));
const CACHE = arg('--cache', 'D:/Temp/soccer-history-audit-cache');
const OUT_DIR = join('docs', 'evidence', 'history');
const TODAY = new Date().toISOString().slice(0, 10);
const OUT = arg('--out', join(OUT_DIR, `coverage-audit-${TODAY}.json`));
const COMPS = [
  { slug: 'premier-league', league: 'eng.1', tier: 1 }, { slug: 'bundesliga', league: 'ger.1', tier: 1 }, { slug: 'mls', league: 'usa.1', tier: 1 },
  { slug: 'uefa-champions-league', league: 'uefa.champions', tier: 1 }, { slug: 'fifa-world-cup', league: 'fifa.world', tier: 1 }, { slug: 'uefa-nations-league', league: 'uefa.nations', tier: 1 },
  { slug: 'la-liga', league: 'esp.1', tier: 2 }, { slug: 'serie-a', league: 'ita.1', tier: 2 }, { slug: 'ligue-1', league: 'fra.1', tier: 2 }, { slug: 'uefa-europa-league', league: 'uefa.europa', tier: 2 },
];
const only = arg('--comps', null)?.split(',');
mkdirSync(CACHE, { recursive: true }); mkdirSync(OUT_DIR, { recursive: true });

let requests = 0; let cacheHits = 0; const errors = [];
const https = u => String(u).replace(/^http:\/\//, 'https://');
async function get(url) {
  url = https(url);
  const f = join(CACHE, `${createHash('sha256').update(url).digest('hex').slice(0, 32)}.json`);
  if (existsSync(f)) { cacheHits += 1; const c = JSON.parse(readFileSync(f, 'utf8')); return c.json; }
  for (let attempt = 0; attempt < 3; attempt++) {
    requests += 1;
    try {
      const r = await politeFetch(url, { minIntervalMs: 700 });
      const text = new TextDecoder().decode(r.bytes);
      if (r.status === 404) { writeFileSync(f, JSON.stringify({ url, status: 404, json: null })); return null; }
      if (r.status >= 500) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); continue; }
      let json = null; try { json = JSON.parse(text); } catch { errors.push({ url, status: r.status, error: 'non_json' }); return null; }
      writeFileSync(f, JSON.stringify({ url, status: r.status, json }));
      return json;
    } catch (e) {
      if (e instanceof SourceBlockedError) { errors.push({ url, status: e.status, error: `blocked:${e.reason}` }); throw e; }
      if (attempt === 2) { errors.push({ url, error: String(e.message || e).slice(0, 200) }); return null; }
    }
  }
  errors.push({ url, error: '5xx_after_retries' });
  return null;
}
const pick = (arr, k) => { if (arr.length <= k) return arr; const out = []; for (let i = 0; i < k; i++) out.push(arr[Math.round((i * (arr.length - 1)) / (k - 1))]); return [...new Set(out)]; };

async function auditMatch(lg, id) {
  const base = `${CORE}/${lg}/events/${id}/competitions/${id}`;
  const ev = await get(`${CORE}/${lg}/events/${id}`);
  if (!ev?.competitions?.[0]) return { id, error: 'event_unavailable' };
  const c = ev.competitions[0];
  const home = c.competitors?.find(x => x.homeAway === 'home'); const away = c.competitors?.find(x => x.homeAway === 'away');
  const out = { id, date: ev.date, two_sides: !!(home && away && home.id !== away.id), venue: !!c.venue?.fullName, lineup_flag: !!c.lineupAvailable, pbp_flag: !!c.playByPlayAvailable, attendance: Number.isFinite(c.attendance) && c.attendance > 0 };
  const st = await get(`${base}/status`); out.status = st ? parseStatus(st) : null; out.status_name = st?.type?.name || null;
  if (home && away) {
    const hs = await get(`${base}/competitors/${home.id}/score`); const as = await get(`${base}/competitors/${away.id}/score`);
    out.score = { home: Number.isFinite(Number(hs?.value)) ? Number(hs.value) : null, away: Number.isFinite(Number(as?.value)) ? Number(as.value) : null, shootout: Number.isFinite(hs?.shootoutScore) || Number.isFinite(as?.shootoutScore) };
    const ro = await get(`${base}/competitors/${home.id}/roster`);
    if (ro?.entries) {
      const r = parseRoster(ro);
      out.roster = { entries: r.entries.length, starters: r.entries.filter(e => e.starter).length, formation: !!r.formation, subs: r.entries.filter(e => e.sub_out?.replacement_id).length, player_stats_refs: ro.entries.filter(e => e.statistics?.$ref).length };
    } else out.roster = null;
    const ts = await get(`${base}/competitors/${home.id}/statistics`);
    out.team_stats = ts ? Object.keys(parseTeamStats(ts)).length : 0;
  }
  const pl = await get(`${base}/plays?limit=1000&page=1`);
  if (pl?.items) {
    const items = pl.items; const types = items.map(p => mapPlayType(p.type?.text || ''));
    out.plays = { count: pl.count ?? items.length, pages: pl.pageCount || 1, located: items.filter(p => Number.isFinite(p.fieldPositionX) && Number.isFinite(p.fieldPositionY) && (p.fieldPositionX !== 0 || p.fieldPositionY !== 0)).length,
      shots: types.filter(t => t?.event_type === 'shot').length, goals: items.filter(p => p.scoringPlay).length, cards: types.filter(t => t?.event_type === 'card').length, subs: types.filter(t => t?.event_type === 'substitution').length,
      passes: types.filter(t => t?.event_type === 'pass').length, xg: items.filter(p => Number.isFinite(p.expectedGoals)).length };
    const loc = items.filter(p => Number.isFinite(p.fieldPositionX) && Number.isFinite(p.fieldPositionY) && (p.fieldPositionX !== 0 || p.fieldPositionY !== 0));
    out.plays.coordinate_scale = !loc.length ? 'none' : loc.length >= 5 && loc.every(p => Math.abs(p.fieldPositionX) <= 1 && Math.abs(p.fieldPositionY) <= 1) ? 'unit_unverified' : 'pct_0_100';
  } else out.plays = null;
  return out;
}

// Depth tier of one sampled match, from measured fields only (additive).
export function tierOf(m) {
  if (!m || m.error || !m.two_sides) return 'NONE';
  const results = m.status === 'finished' && m.score && m.score.home !== null && m.score.away !== null;
  if (!results) return 'NONE';
  let t = 'RESULTS';
  if (m.venue) t = 'MATCH';
  if (m.roster && m.roster.starters >= 11) t = 'LINEUP';
  if (t === 'LINEUP' && m.team_stats > 0) t = 'STATS';
  if (m.plays && (m.plays.shots + m.plays.goals + m.plays.cards) > 0) t = t === 'STATS' ? 'EVENTS' : t === 'LINEUP' ? 'EVENTS' : t;
  if (t === 'EVENTS' && m.plays.coordinate_scale === 'pct_0_100') t = 'SPATIAL_EVENTS'; // unit-scale (unverified frame) locations do not count
  return t;
}

const prior = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { competitions: {} };
const report = { generated_at: new Date().toISOString(), method: `ESPN Core catalog + per-season index/teams/types; K=${K} sampled matches per season; read-only, nothing ingested`, k: K, competitions: prior.competitions || {} };
for (const comp of COMPS.filter(c => !only || only.includes(c.league) || only.includes(c.slug))) {
  const cat = await get(`${CORE}/${comp.league}/seasons?limit=200`);
  const years = (cat?.items || []).map(i => Number(refId(i.$ref, 'seasons'))).filter(Boolean).sort((a, b) => a - b);
  const R = { slug: comp.slug, league: comp.league, tier: comp.tier, catalog: { seasons: years.length, first: years[0] ?? null, last: years[years.length - 1] ?? null, years }, seasons: {} };
  for (const y of years) {
    const S = { year: y };
    const ty = await get(`${CORE}/${comp.league}/seasons/${y}/types`);
    const typeIds = (ty?.items || []).map(i => refId(i.$ref, 'types')).filter(Boolean);
    S.types = []; const ids = [];
    for (const t of typeIds) {
      const tj = await get(`${CORE}/${comp.league}/seasons/${y}/types/${t}`);
      let page = 1; let pages = 1; let count = 0; const tid = [];
      do { const ej = await get(`${CORE}/${comp.league}/seasons/${y}/types/${t}/events?limit=1000&page=${page}`); if (!ej?.items) break; const r = refsOf(ej); tid.push(...r.ids); pages = r.pageCount; count = r.count; page += 1; } while (page <= pages);
      S.types.push({ id: t, name: tj?.name || null, events: count || tid.length });
      ids.push(...tid);
    }
    S.events_listed = new Set(ids).size;
    S.duplicate_event_ids_across_types = ids.length - S.events_listed;
    const tm = await get(`${CORE}/${comp.league}/seasons/${y}/teams?limit=500`);
    S.teams_listed = tm?.count ?? tm?.items?.length ?? null;
    const sample = pick([...new Set(ids)], K);
    S.sample = [];
    for (const id of sample) { const m = await auditMatch(comp.league, id); m.tier = tierOf(m); S.sample.push(m); }
    const n = S.sample.length || 1; const share = f => Math.round((100 * S.sample.filter(f).length) / n);
    S.measured = {
      sampled: S.sample.length,
      finished_with_score_pct: share(m => m.status === 'finished' && m.score?.home !== null && m.score?.away !== null),
      venue_pct: share(m => m.venue), lineup_pct: share(m => m.roster?.starters >= 11), formation_pct: share(m => m.roster?.formation), subs_pct: share(m => (m.roster?.subs || 0) > 0),
      player_stats_pct: share(m => (m.roster?.player_stats_refs || 0) > 0), team_stats_pct: share(m => m.team_stats > 0),
      pbp_pct: share(m => (m.plays?.count || 0) > 0), events_pct: share(m => m.plays && (m.plays.shots + m.plays.goals + m.plays.cards) > 0), shots_pct: share(m => (m.plays?.shots || 0) > 0),
      spatial_pct: share(m => (m.plays?.located || 0) > 0), spatial_verified_pct: share(m => m.plays?.coordinate_scale === 'pct_0_100'), spatial_unit_unverified_pct: share(m => m.plays?.coordinate_scale === 'unit_unverified'), xg_pct: share(m => (m.plays?.xg || 0) > 0),
      plays_median: [...S.sample.map(m => m.plays?.count || 0)].sort((a, b) => a - b)[Math.floor(S.sample.length / 2)] || 0,
      tiers: S.sample.reduce((o, m) => ({ ...o, [m.tier]: (o[m.tier] || 0) + 1 }), {}),
    };
    R.seasons[y] = S;
    console.log(JSON.stringify({ comp: comp.slug, year: y, types: S.types.map(t => `${t.name}:${t.events}`).join('|'), events: S.events_listed, teams: S.teams_listed, tiers: S.measured.tiers, requests, cacheHits }));
    report.competitions[comp.slug] = R;
    report.requests = requests; report.cache_hits = cacheHits; report.errors = errors;
    writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
  }
}
report.finished_at = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(report, null, 1) + '\n');
console.log(`AUDIT DONE requests=${requests} cache_hits=${cacheHits} errors=${errors.length} -> ${OUT}`);
