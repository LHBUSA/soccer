#!/usr/bin/env node
// ESPN Core API soccer graph discovery (ESPN = SECONDARY ingestion source, owner-approved).
// DISCOVERY + EVIDENCE only: records what real responses contain. Nothing is ingested.
//
// Access rules (hard):
//   - only https://sports.core.api.espn.com (Core API). site.api / site.web.api / espn.com pages are
//     Akamai-blocked and are never called or bypassed.
//   - every request goes through workers/shared/http.js politeFetch: honest UA, no cookies, sequential,
//     >= 700 ms spacing; 401/403/challenge -> SourceBlockedError, recorded, never retried.
//   - 429 / HTML bodies are recorded as blocked and that endpoint is not followed further.
//   - 5xx: max 2 retries with backoff. Hard budget of MAX_REQUESTS.
//   - Wikidata (www.wikidata.org api + query.wikidata.org SPARQL): 1-4 requests for ESPN id properties.
//
// Output: docs/evidence/espn-soccer-discovery-latest.json
// Usage:  node scripts/evidence/espn-soccer-discovery.mjs

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetch, SourceBlockedError } from '../../workers/shared/http.js';

const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer';
const SPACING_MS = 700;
const MAX_REQUESTS = 400;
const OUT = join('docs', 'evidence', 'espn-soccer-discovery-latest.json');
const TODAY = new Date();

// Target competitions: slug is CONFIRMED against the leagues listing + league detail name at runtime.
const TARGETS = {
  premier_league: { slug: 'eng.1', expect: /premier league/i, deep: true },
  bundesliga: { slug: 'ger.1', expect: /bundesliga/i, deep: true },
  mls: { slug: 'usa.1', expect: /major league soccer|mls/i, deep: true },
  champions_league: { slug: 'uefa.champions', expect: /champions league/i },
  europa_league: { slug: 'uefa.europa', expect: /europa league/i },
  laliga: { slug: 'esp.1', expect: /laliga|la liga|spanish/i },
  serie_a: { slug: 'ita.1', expect: /serie a|italian/i },
  ligue_1: { slug: 'fra.1', expect: /ligue 1|french/i },
  world_cup: { slug: 'fifa.world', expect: /world cup/i },
  euro: { slug: 'uefa.euro', expect: /european championship|euro/i },
  copa_america: { slug: 'conmebol.america', expect: /copa am/i },
};
const HISTORY_YEARS = [2005, 2012, 2017];
const HISTORY_LEAGUES = ['premier_league', 'bundesliga'];

// ---------------------------------------------------------------------------------------------------
let requestCount = 0;
const blocked = [];
const endpoints = new Map();
const statusTally = {};

function https(u) { return String(u).replace(/^http:\/\//, 'https://'); }
function template(u) {
  const x = new URL(https(u));
  x.searchParams.delete('lang'); x.searchParams.delete('region');
  const path = x.pathname.replace(/\/\d{3,}(?=\/|$)/g, '/{id}').replace(/\/(19|20)\d{2}(?=\/|$)/g, '/{year}');
  const q = [...x.searchParams.keys()].sort().map(k => `${k}=`).join('&');
  return `${x.host}${path}${q ? '?' + q : ''}`;
}
const topKeys = j => (j && typeof j === 'object' && !Array.isArray(j) ? Object.keys(j) : []);
const itemCount = j => (j && typeof j === 'object' ? (j.count ?? (Array.isArray(j.items) ? j.items.length : undefined)) : undefined);

/** One request. Returns { ok, status, bytes, json, blocked } and never throws. */
async function get(url, { minIntervalMs = SPACING_MS, note } = {}) {
  url = https(url);
  if (requestCount >= MAX_REQUESTS) return { ok: false, status: 0, budget: true };
  const host = new URL(url).host;
  if (host === 'sports.core.api.espn.com' ? false : !/(^|\.)wikidata\.org$/.test(host)) throw new Error(`host not allowed: ${host}`);
  let attempt = 0;
  for (;;) {
    requestCount++;
    let res;
    try {
      res = await politeFetch(url, { minIntervalMs, timeoutMs: 45000 });
    } catch (e) {
      if (e instanceof SourceBlockedError) {
        blocked.push({ url, status: e.status, reason: e.reason });
        record(url, e.status, 0, null, 'blocked:' + e.reason);
        return { ok: false, status: e.status, blocked: e.reason };
      }
      if (attempt < 2 && requestCount < MAX_REQUESTS) { attempt++; await sleep(3000 * attempt); continue; }
      record(url, 0, 0, null, 'network:' + e.message);
      return { ok: false, status: 0, error: e.message };
    }
    if (res.status >= 500 && attempt < 2 && requestCount < MAX_REQUESTS) { attempt++; await sleep(3000 * attempt); continue; }
    const text = new TextDecoder().decode(res.bytes);
    const ct = res.contentType || '';
    if (res.status === 429 || (/html/i.test(ct) && !/json/i.test(ct)) || /^\s*</.test(text)) {
      blocked.push({ url, status: res.status, reason: res.status === 429 ? 'rate_limited' : 'html_body' });
      record(url, res.status, res.bytes.length, null, 'blocked');
      return { ok: false, status: res.status, blocked: 'html_or_429' };
    }
    let json = null;
    try { json = JSON.parse(text); } catch { /* keep null */ }
    record(url, res.status, res.bytes.length, json, note);
    return { ok: res.status === 200 && json != null, status: res.status, bytes: res.bytes.length, json };
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

function record(url, status, bytes, json, note) {
  statusTally[status] = (statusTally[status] || 0) + 1;
  const t = template(url);
  const e = endpoints.get(t);
  if (e) { e.hits++; if (!e.statuses.includes(status)) e.statuses.push(status); return; }
  endpoints.set(t, { url_template: t, example: url, status, statuses: [status], bytes, keys: topKeys(json), count: itemCount(json), hits: 1, ...(note ? { note } : {}) });
}

/** Summary of a fetched sub-resource. */
function summary(r, extra = {}) {
  if (!r) return { fetched: false };
  return { status: r.status, bytes: r.bytes ?? 0, keys: topKeys(r.json), items: itemCount(r.json), ...(r.blocked ? { blocked: r.blocked } : {}), ...extra };
}

/** Collect every key path in an object tree (arrays collapsed to []). */
function keyPaths(obj, prefix = '', out = new Set(), depth = 0) {
  if (depth > 8 || obj == null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { for (const x of obj.slice(0, 30)) keyPaths(x, prefix + '[]', out, depth + 1); return out; }
  for (const [k, v] of Object.entries(obj)) { const p = prefix ? `${prefix}.${k}` : k; out.add(p); keyPaths(v, p, out, depth + 1); }
  return out;
}
const COORD_RE = /(^|\.)(coordinate[s]?|fieldPosition\w*|x|y|x2|y2|startX|startY|endX|endY|fieldpositionx|fieldpositiony|location)$/i;

const refOf = v => (v && typeof v === 'object' && v.$ref ? v.$ref : null);
const idFromRef = (u, seg) => { const m = new RegExp(`/${seg}/(\\d+)`).exec(u || ''); return m ? m[1] : null; };
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
const addDays = (d, n) => new Date(d.getTime() + n * 864e5);
const withQuery = (u, q) => { const x = new URL(https(u)); for (const [k, v] of Object.entries(q)) x.searchParams.set(k, v); return x.toString(); };

// ---------------------------------------------------------------------------------------------------
async function main() {
  const out = {
    generated_at: new Date().toISOString(),
    source: 'sports.core.api.espn.com (ESPN Core API, secondary source)',
    spacing_ms: SPACING_MS,
    request_budget: MAX_REQUESTS,
    access: {},
    leagues_total: null,
    league_slugs: [],
    other_majors_seen: [],
    competitions: {},
    identity: {},
    endpoints: [],
  };

  // 1. leagues listing (paginated)
  const slugs = [];
  let page = 1; let pageCount = 1;
  do {
    const r = await get(`${CORE}/leagues?limit=500&page=${page}`);
    if (!r.ok) break;
    out.leagues_total = r.json.count;
    pageCount = r.json.pageCount || 1;
    for (const it of r.json.items || []) { const m = /\/leagues\/([^/?]+)/.exec(it.$ref || ''); if (m) slugs.push(m[1]); }
    page++;
  } while (page <= pageCount);
  out.league_slugs = slugs;
  const MAJOR_RE = /^(uefa\.euro|conmebol\.america|fifa\.cwc|uefa\.nations|concacaf\.gold|caf\.nations|afc\.asian\.cup|fifa\.wwc|uefa\.europa\.conf|conmebol\.libertadores|eng\.fa|ger\.dfb_pokal|fifa\.olympics)$/;
  out.other_majors_seen = slugs.filter(s => MAJOR_RE.test(s));

  // 2. per competition
  for (const [key, t] of Object.entries(TARGETS)) {
    const c = { slug: t.slug, in_listing: slugs.includes(t.slug) };
    out.competitions[key] = c;
    if (!c.in_listing) { c.error = 'slug not in leagues listing'; continue; }
    const L = await get(`${CORE}/leagues/${t.slug}`);
    if (!L.ok) { c.error = `league ${L.status}`; continue; }
    const lg = L.json;
    Object.assign(c, { id: lg.id, uid: lg.uid, guid: lg.guid, alternateId: lg.alternateId, name: lg.name, displayName: lg.displayName, isTournament: lg.isTournament, gender: lg.gender, name_matches: t.expect.test(`${lg.name} ${lg.displayName}`), league_keys: Object.keys(lg) });

    // seasons
    const S = await get(`${CORE}/leagues/${t.slug}/seasons?limit=500`);
    if (S.ok) {
      const years = (S.json.items || []).map(i => Number((/\/seasons\/(\d{4})/.exec(i.$ref || '') || [])[1])).filter(Boolean).sort((a, b) => a - b);
      c.seasons = { count: S.json.count, earliest: years[0] ?? null, latest: years.at(-1) ?? null };
    } else c.seasons = { status: S.status };

    // current season (from league.season inline)
    const season = lg.season || {};
    const year = season.year;
    const types = (season.types?.items || []).map(x => ({ id: x.id, name: x.name, abbreviation: x.abbreviation, startDate: x.startDate, endDate: x.endDate, hasGroups: x.hasGroups, hasStandings: x.hasStandings, hasStats: x.hasStats, hasLegs: x.hasLegs }));
    c.current = { year, displayName: season.displayName, startDate: season.startDate, endDate: season.endDate, types_count: season.types?.count ?? types.length, types };

    // events per type (count from paginated listing)
    let evTotal = 0; const perType = [];
    for (const ty of types.slice(0, 25)) {
      const E = await get(`${CORE}/leagues/${t.slug}/seasons/${year}/types/${ty.id}/events?limit=1`);
      perType.push({ type: ty.id, name: ty.name, status: E.status, count: E.json?.count ?? null, pageCount: E.json?.pageCount ?? null });
      if (E.ok) evTotal += E.json.count || 0;
    }
    c.current.events_by_type = perType;
    c.current.events_count = evTotal;
    if (types.length > 25) c.current.events_count_note = `only first 25 of ${types.length} types counted`;

    // teams
    const T = await get(`${CORE}/leagues/${t.slug}/seasons/${year}/teams?limit=1`);
    c.current.teams_count = T.json?.count ?? null;
    c.current.teams_status = T.status;
    const teamRef = T.json?.items?.[0]?.$ref;

    // standings: follow league.group / groups refs -> standings refs
    c.standings = await probeStandings(t.slug, year, lg, types);

    // light event sample for every competition: last completed in the past 10 days (or last season's final window)
    c.light_sample = await lightSample(t.slug, year, perType, !t.deep);

    // deep samples
    if (t.deep) {
      c.samples = {};
      c.samples.completed_event = await deepEvent(t.slug, 'completed');
      c.samples.upcoming_event = await deepEvent(t.slug, 'upcoming');
      if (teamRef) c.team_sample = await probeTeam(teamRef);
    }

    if (HISTORY_LEAGUES.includes(key)) {
      c.historical = {};
      for (const y of HISTORY_YEARS) c.historical[y] = await probeHistory(t.slug, y);
    }
    c.capabilities = grade(c);
    console.log(`[${requestCount}] ${key} ${c.slug} id=${c.id} seasons=${c.seasons?.earliest}-${c.seasons?.latest} events=${c.current.events_count} teams=${c.current.teams_count}`);
  }

  // 3. identity: athlete from the EPL completed sample (already fetched there), Wikidata properties
  const epl = out.competitions.premier_league?.samples?.completed_event;
  out.identity.athlete_sample = epl?.athlete_sample ?? null;
  out.identity.team_sample = out.competitions.premier_league?.team_sample ?? null;
  out.identity.wikidata = await probeWikidata();

  out.request_count = requestCount;
  out.access = {
    core_status_summary: statusTally,
    blocked,
    rules: 'Core API only; site.api/site.web.api/espn.com never called; politeFetch UA PropBetEdgeSoccer/0.1; sequential >=700ms; no cookies',
  };
  out.endpoints = [...endpoints.values()].sort((a, b) => a.url_template.localeCompare(b.url_template));
  mkdirSync(join('docs', 'evidence'), { recursive: true });
  writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${OUT}; requests=${requestCount}; blocked=${blocked.length}`);
}

// ---------------------------------------------------------------------------------------------------
async function probeStandings(slug, year, lg, types) {
  const res = { tried: [] };
  const groupRef = refOf(lg.group) || refOf(lg.groups);
  if (groupRef) {
    const G = await get(groupRef);
    res.tried.push({ url: https(groupRef), ...summary(G) });
    let standingsRef = refOf(G.json?.standings);
    // groups listing -> first group
    if (!standingsRef && G.json?.items?.[0]?.$ref) {
      const G1 = await get(G.json.items[0].$ref);
      res.tried.push({ url: https(G.json.items[0].$ref), ...summary(G1) });
      standingsRef = refOf(G1.json?.standings);
    }
    if (standingsRef) {
      const ST = await get(standingsRef);
      res.tried.push({ url: https(standingsRef), ...summary(ST) });
      const firstRef = ST.json?.items?.[0]?.$ref;
      if (firstRef) {
        const S1 = await get(firstRef);
        const entries = S1.json?.standings || [];
        res.table = { url: https(firstRef), ...summary(S1), name: S1.json?.name, entries: entries.length, stat_names: [...new Set((entries[0]?.records?.[0]?.stats || []).map(s => s.name))] };
      }
    }
  }
  if (!res.table) {
    const u = `${CORE}/leagues/${slug}/seasons/${year}/types/${types[0]?.id ?? 1}/standings`;
    const R = await get(u);
    res.tried.push({ url: u, ...summary(R) });
    const firstRef = R.json?.items?.[0]?.$ref;
    if (firstRef) {
      const S1 = await get(firstRef);
      const entries = S1.json?.standings || [];
      res.table = { url: https(firstRef), ...summary(S1), name: S1.json?.name, entries: entries.length, stat_names: [...new Set((entries[0]?.records?.[0]?.stats || []).map(s => s.name))], first_row_keys: entries[0] ? Object.keys(entries[0]) : [] };
    }
  }
  // group-level table for the previous (completed) season: rows exist, but check whether records carry stats
  if (lg.id) {
    const u = `${CORE}/leagues/${slug}/seasons/${year - 1}/types/${types[0]?.id ?? 1}/groups/${lg.id}/standings/0`;
    const R = await get(u);
    const entries = R.json?.standings || [];
    res.previous_season_group_table = { url: u, ...summary(R), entries: entries.length, entries_with_records: entries.filter(e => (e.records || []).length).length };
  }
  res.available = Boolean(res.table && res.table.entries > 0);
  return res;
}

async function listEvents(slug, from, to) {
  const r = await get(`${CORE}/leagues/${slug}/events?dates=${ymd(from)}-${ymd(to)}&limit=100`);
  return { status: r.status, count: r.json?.count ?? 0, refs: (r.json?.items || []).map(i => i.$ref) };
}

/** Most recent completed event: date window first, else the last event of the latest type with events (current season, then previous). */
async function lightSample(slug, year, perType, probeContent) {
  const L = await listEvents(slug, addDays(TODAY, -10), addDays(TODAY, -1));
  let window = 'last 10 days';
  let ref = L.refs.at(-1);
  let E = null; let st = null;
  if (ref) {
    E = await get(ref);
  } else {
    for (const y of [year, year - 1]) {
      let typesWithEvents = y === year ? perType.filter(x => x.count > 0) : [];
      if (y !== year) {
        const S = await get(`${CORE}/leagues/${slug}/seasons/${y}`);
        for (const ty of (S.json?.types?.items || []).slice().reverse()) {
          const X = await get(`${CORE}/leagues/${slug}/seasons/${y}/types/${ty.id}/events?limit=1`);
          if (X.json?.count > 0) { typesWithEvents = [{ type: ty.id, name: ty.name, count: X.json.count }]; break; }
        }
      }
      const last = typesWithEvents.at(-1);
      if (!last) continue;
      const X = await get(`${CORE}/leagues/${slug}/seasons/${y}/types/${last.type}/events?limit=1&page=${last.count}`);
      ref = X.json?.items?.[0]?.$ref;
      if (!ref) continue;
      E = await get(ref);
      const c0 = E.json?.competitions?.[0];
      st = refOf(c0?.status) ? await get(c0.status.$ref) : null;
      window = `season ${y} type "${last.name}" last event`;
      if (st?.json?.type?.state === 'post') break;
    }
  }
  if (!E?.json) return { window, events_in_window: L.count, window_status: L.status, event: null };
  const comp = E.json.competitions?.[0] || {};
  const res = {
    window, events_in_window: L.count, window_status: L.status, event_id: E.json.id, name: E.json.name, date: E.json.date,
    status: st?.json?.type ? pick(st.json.type, ['name', 'state', 'completed']) : undefined,
    flags: pick(comp, ['boxscoreAvailable', 'lineupAvailable', 'playByPlayAvailable', 'commentaryAvailable', 'shotChartAvailable', 'recapAvailable']),
    boxscoreSource: comp.boxscoreSource ?? null, playByPlaySource: comp.playByPlaySource ?? null,
    competition_refs: Object.entries(comp).filter(([, v]) => refOf(v)).map(([k]) => k),
    venue_inline: comp.venue ? pick(comp.venue, ['id', 'fullName', 'address']) : null,
  };
  if (!probeContent) return res;
  // content probe for competitions without a deep sample: home score, roster, team stats, plays page 1, officials
  const home = comp.competitors?.[0];
  if (home && refOf(home.score)) { const R = await get(home.score.$ref); res.score = summary(R, { body: R.json ? pick(R.json, ['value', 'displayValue', 'winner']) : null }); }
  if (home && refOf(home.roster)) {
    const R = await get(home.roster.$ref); const en = R.json?.entries || [];
    res.roster = summary(R, { entries: en.length, starters: en.filter(e => e.starter === true).length, bench: en.filter(e => e.starter === false).length, subbed_in: en.filter(e => e.subbedIn?.didSub).length, formation: R.json?.formation?.name ?? null, has_player_stats_ref: en.some(e => refOf(e.statistics)) });
  }
  if (home && refOf(home.statistics)) { const R = await get(home.statistics.$ref); const cats = R.json?.splits?.categories || []; res.team_statistics = summary(R, { stat_count: cats.flatMap(k => k.stats || []).length, has_possession: cats.some(k => (k.stats || []).some(x => x.name === 'possessionPct')) }); }
  if (refOf(comp.details)) {
    const P = await get(withQuery(comp.details.$ref, { limit: 1000 })); const it = P.json?.items || [];
    res.plays = summary(P, { pageCount: P.json?.pageCount, coordinate_fields: [...keyPaths(it)].filter(p => COORD_RE.test(p)), has_goals: it.some(p => p.scoringPlay === true), has_cards: it.some(p => /card/i.test(p.type?.text || '')), has_substitutions: it.some(p => /substitution/i.test(p.type?.text || '')) });
  }
  if (refOf(comp.officials)) { const R = await get(comp.officials.$ref); res.officials = summary(R); }
  return res;
}
const pick = (o, ks) => Object.fromEntries(ks.map(k => [k, o?.[k]]));

/** Find one completed or upcoming event and walk its competition graph. */
async function deepEvent(slug, which) {
  const L = which === 'completed'
    ? await listEvents(slug, addDays(TODAY, -8), addDays(TODAY, -1))
    : await listEvents(slug, addDays(TODAY, 1), addDays(TODAY, 21));
  if (!L.refs.length) return { error: 'no events in window', window_count: L.count };
  const refs = which === 'completed' ? [...L.refs].reverse() : L.refs;
  let E = null; let status = null;
  for (const ref of refs.slice(0, 3)) {
    E = await get(ref);
    const comp = E.json?.competitions?.[0];
    const st = refOf(comp?.status) ? await get(comp.status.$ref) : null;
    status = st;
    const state = st?.json?.type?.state;
    if ((which === 'completed' && state === 'post') || (which === 'upcoming' && state === 'pre')) break;
  }
  const ev = E?.json;
  if (!ev) return { error: 'event fetch failed' };
  const comp = ev.competitions?.[0] || {};
  const out = {
    event_id: ev.id, uid: ev.uid, name: ev.name, date: ev.date, event_keys: Object.keys(ev),
    competition_keys: Object.keys(comp),
    flags: pick(comp, ['attendance', 'neutralSite', 'boxscoreAvailable', 'lineupAvailable', 'playByPlayAvailable', 'commentaryAvailable', 'shotChartAvailable', 'gamecastAvailable', 'pickcenterAvailable']),
    boxscoreSource: comp.boxscoreSource ?? null, playByPlaySource: comp.playByPlaySource ?? null,
    format: comp.format ?? null,
    venue_inline: comp.venue ? pick(comp.venue, ['id', 'fullName', 'address', 'capacity', 'grass', 'indoor']) : null,
    status: status ? summary(status, { type: status.json?.type ? pick(status.json.type, ['name', 'state', 'completed', 'detail']) : null, clock: status.json?.displayClock, period: status.json?.period }) : null,
    sub: {},
  };
  // competition-level refs
  for (const k of ['situation', 'odds', 'officials', 'leaders']) {
    const ref = refOf(comp[k]);
    if (!ref) { out.sub[k] = { present: false }; continue; }
    const R = await get(ref);
    const x = summary(R);
    if (k === 'officials' && R.json?.items) x.sample = R.json.items.slice(0, 4).map(o => ({ displayName: o.displayName, position: o.position?.name ?? o.position?.displayName, keys: Object.keys(o) }));
    if (k === 'odds' && R.json?.items) x.providers = R.json.items.map(o => o.provider?.name).filter(Boolean);
    if (k === 'situation' && R.json) x.body = R.json;
    out.sub[k] = x;
  }
  // details / plays
  const playsRef = refOf(comp.details);
  if (playsRef) {
    const P = await get(withQuery(playsRef, { limit: 1000 }));
    const items = [...(P.json?.items || [])];
    for (let pg = 2; pg <= Math.min(P.json?.pageCount || 1, 3); pg++) { const Q = await get(withQuery(playsRef, { limit: 1000, page: pg })); items.push(...(Q.json?.items || [])); }
    const paths = [...keyPaths(items)];
    const types = {};
    for (const p of items) { const n = p.type?.text || p.type?.type || '?'; types[n] = (types[n] || 0) + 1; }
    out.sub.plays = {
      ...summary(P), pageCount: P.json?.pageCount, items_read: items.length,
      play_types: types,
      item_key_paths: paths.slice(0, 120),
      coordinate_fields: paths.filter(p => COORD_RE.test(p)),
      coordinate_example: items.find(p => p.fieldPositionX !== undefined || p.coordinate || p.fieldPosition) ? pick(items.find(p => p.fieldPositionX !== undefined || p.coordinate || p.fieldPosition), ['type', 'text', 'fieldPositionX', 'fieldPositionY', 'fieldPosition2X', 'fieldPosition2Y', 'coordinate', 'coordinate2', 'clock', 'scoringPlay']) : null,
      has_goals: items.some(p => p.scoringPlay === true),
      goal_plays: items.filter(p => p.scoringPlay === true).map(p => p.text).slice(0, 6),
      has_cards: items.some(p => /card/i.test(p.type?.text || '')),
      has_substitutions: items.some(p => /substitution/i.test(p.type?.text || '')),
      first_items: items.slice(0, 2),
    };
  } else out.sub.plays = { present: false };
  const commRef = refOf(comp.commentaries);
  out.sub.commentaries = { present: Boolean(commRef), note: 'ref existence only; not fetched (editorial text)' };

  // competitors
  const comps = comp.competitors || [];
  out.competitor_keys = comps[0] ? Object.keys(comps[0]) : [];
  out.competitors = comps.map(x => ({ id: x.id, homeAway: x.homeAway, winner: x.winner, form: x.form, refs: Object.entries(x).filter(([, v]) => refOf(v)).map(([k]) => k) }));
  const home = comps[0];
  if (home) {
    if (refOf(home.score)) { const R = await get(home.score.$ref); out.sub.score = summary(R, { body: R.json ? pick(R.json, ['value', 'displayValue', 'winner', 'source']) : null }); }
    if (refOf(home.statistics)) {
      const R = await get(home.statistics.$ref);
      const cats = R.json?.splits?.categories || [];
      out.sub.team_statistics = summary(R, { categories: cats.map(k => k.name), stat_names: cats.flatMap(k => (k.stats || []).map(s => s.name)), stat_example: cats[0]?.stats?.slice(0, 3) });
    }
    if (refOf(home.leaders)) { const R = await get(home.leaders.$ref); out.sub.competitor_leaders = summary(R, { categories: (R.json?.categories || []).map(k => k.name) }); }
    if (refOf(home.roster)) {
      const R = await get(home.roster.$ref);
      const entries = R.json?.entries || [];
      const entryPaths = [...keyPaths(entries)];
      out.sub.roster = summary(R, {
        entries: entries.length,
        starters: entries.filter(e => e.starter === true).length,
        bench: entries.filter(e => e.starter === false).length,
        subbed_in: entries.filter(e => e.subbedIn === true || e.subbedIn?.didSub).length,
        subbed_out: entries.filter(e => e.subbedOut === true || e.subbedOut?.didSub).length,
        formation: R.json?.formation ?? null,
        formation_place_present: entries.some(e => e.formationPlace !== undefined),
        entry_key_paths: entryPaths.slice(0, 80),
        entry_example: entries[0] ? stripLinks(entries[0]) : null,
      });
      // one player's match statistics + the athlete
      const e0 = entries.find(e => e.starter) || entries[0];
      if (e0 && refOf(e0.statistics)) {
        const PS = await get(e0.statistics.$ref);
        const cats = PS.json?.splits?.categories || [];
        out.sub.player_statistics = summary(PS, { categories: cats.map(k => k.name), stat_names: cats.flatMap(k => (k.stats || []).map(s => s.name)) });
      } else out.sub.player_statistics = { present: false, note: e0 ? 'roster entry has no statistics ref' : 'no roster entries' };
      if (e0 && refOf(e0.athlete) && which === 'completed') out.athlete_sample = await probeAthlete(e0.athlete.$ref);
    } else out.sub.roster = { present: false };
  }
  return out;
}
function stripLinks(o) { const c = { ...o }; delete c.links; return c; }

async function probeAthlete(ref) {
  const A = await get(ref);
  const a = A.json || {};
  return {
    ...summary(A), url: https(ref),
    fields: pick(a, ['id', 'uid', 'guid', 'alternateIds', 'sdr', 'externalIds', 'displayName', 'fullName', 'firstName', 'lastName', 'dateOfBirth', 'birthPlace', 'citizenship', 'citizenshipCountry', 'height', 'weight', 'gender', 'jersey']),
    position: a.position ? pick(a.position, ['id', 'name', 'displayName', 'abbreviation']) : null,
    identity_like_keys: Object.keys(a).filter(k => /id$|ids$|uid|guid|sdr|external|slug/i.test(k)),
  };
}

async function probeTeam(ref) {
  const T = await get(ref);
  const t = T.json || {};
  const res = {
    ...summary(T), url: https(ref),
    fields: pick(t, ['id', 'uid', 'guid', 'alternateIds', 'sdr', 'slug', 'location', 'name', 'displayName', 'abbreviation', 'isActive', 'isAllStar']),
    identity_like_keys: Object.keys(t).filter(k => /id$|ids$|uid|guid|sdr|external|slug/i.test(k)),
    ref_keys: Object.entries(t).filter(([, v]) => refOf(v)).map(([k]) => k),
  };
  const coachRef = refOf(t.coaches);
  if (coachRef) {
    const C = await get(coachRef);
    res.coaches = summary(C);
    const c0 = C.json?.items?.[0]?.$ref;
    if (c0) { const C1 = await get(c0); res.coach_sample = summary(C1, { fields: pick(C1.json || {}, ['id', 'uid', 'firstName', 'lastName', 'dateOfBirth', 'experience']), team_ref: refOf(C1.json?.team), previous_teams: (C1.json?.previousTeams || []).length }); }
  } else res.coaches = { present: false };
  const athRef = refOf(t.athletes);
  if (athRef) { const R = await get(withQuery(athRef, { limit: 1 })); res.squad = summary(R); }
  return res;
}

async function probeHistory(slug, year) {
  const S = await get(`${CORE}/leagues/${slug}/seasons/${year}`);
  if (!S.ok) return { season_status: S.status };
  const types = (S.json.types?.items || []).map(x => ({ id: x.id, name: x.name }));
  const res = { season: S.json.displayName, types };
  const ty = types[0]?.id ?? 1;
  const E = await get(`${CORE}/leagues/${slug}/seasons/${year}/types/${ty}/events?limit=1`);
  res.events_count = E.json?.count ?? null; res.events_status = E.status;
  if (!E.json?.count) return res;
  const mid = Math.max(1, Math.floor(E.json.count / 2));
  const M = await get(`${CORE}/leagues/${slug}/seasons/${year}/types/${ty}/events?limit=1&page=${mid}`);
  const ref = M.json?.items?.[0]?.$ref || E.json.items?.[0]?.$ref;
  const ev = (await get(ref)).json || {};
  const comp = ev.competitions?.[0] || {};
  res.sample_event = {
    id: ev.id, name: ev.name, date: ev.date,
    flags: pick(comp, ['boxscoreAvailable', 'lineupAvailable', 'playByPlayAvailable', 'commentaryAvailable']),
    boxscoreSource: comp.boxscoreSource ?? null, playByPlaySource: comp.playByPlaySource ?? null,
  };
  const home = comp.competitors?.[0];
  if (home && refOf(home.roster)) { const R = await get(home.roster.$ref); const en = R.json?.entries || []; res.roster = summary(R, { entries: en.length, starters: en.filter(e => e.starter).length, has_player_stats_ref: en.some(e => refOf(e.statistics)) }); }
  if (home && refOf(home.statistics)) { const R = await get(home.statistics.$ref); const cats = R.json?.splits?.categories || []; res.team_statistics = summary(R, { stat_names: cats.flatMap(k => (k.stats || []).map(s => s.name)).slice(0, 40) }); }
  if (refOf(comp.details)) { const P = await get(withQuery(comp.details.$ref, { limit: 1000 })); const it = P.json?.items || []; res.plays = summary(P, { types: [...new Set(it.map(p => p.type?.text))], coordinate_fields: [...keyPaths(it)].filter(p => COORD_RE.test(p)) }); }
  return res;
}

async function probeWikidata() {
  const res = { properties: [] };
  const W = await get('https://www.wikidata.org/w/api.php?action=wbsearchentities&type=property&search=ESPN&language=en&format=json&limit=50', { minIntervalMs: 1000 });
  for (const p of W.json?.search || []) res.properties.push({ id: p.id, label: p.label, description: p.description });
  res.search_status = W.status;
  const soccer = res.properties.filter(p => /soccer|association football|espn fc/i.test(`${p.label} ${p.description}`) && !/nfl|college football|american football/i.test(`${p.label} ${p.description}`));
  res.soccer_properties = soccer.map(p => ({ id: p.id, label: p.label, description: p.description }));
  for (const p of soccer.slice(0, 3)) {
    const q = `SELECT (COUNT(DISTINCT ?item) AS ?n) WHERE { ?item wdt:${p.id} ?v . }`;
    const R = await get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { minIntervalMs: 1000 });
    res[`count_${p.id}`] = { status: R.status, sparql: q, count: Number(R.json?.results?.bindings?.[0]?.n?.value ?? NaN) };
  }
  if (soccer.some(p => p.id === 'P3681')) {
    // format check: do Wikidata P3681 values look like Core API athlete ids? (Fulham FC = Q18656)
    const q = 'SELECT ?item ?itemLabel ?v WHERE { ?item wdt:P3681 ?v . ?item wdt:P54 wd:Q18656 . SERVICE wikibase:label { bd:serviceParam wikibase:language "en". } } LIMIT 5';
    const R = await get('https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(q), { minIntervalMs: 1000 });
    res.P3681_examples = { status: R.status, sparql: q, rows: (R.json?.results?.bindings || []).map(b => ({ item: b.item?.value, label: b.itemLabel?.value, espn_id: b.v?.value })) };
  }
  return res;
}

// ---------------------------------------------------------------------------------------------------
/** Y = proven in a real response here, P = partial / only some events / only flags, N = probed and absent, U = not probed. */
function grade(c) {
  const s = c.samples?.completed_event;
  const up = c.samples?.upcoming_event;
  const ls = c.light_sample;
  const g = (v, note) => ({ v, note });
  const cap = {};
  cap.schedule = c.current?.events_count > 0 ? g('Y', `${c.current.events_count} events in ${c.current.year} season types`) : g('N', 'no events in current season');
  cap.results = s?.sub?.score?.status === 200 ? g('Y', `score ref ${JSON.stringify(s.sub.score.body)}`) : ls?.event_id ? g('P', 'events listed; score not fetched (light sample)') : g('U', '');
  if (s) {
    const r = s.sub.roster || {};
    cap.rosters = r.entries > 0 ? g('Y', `${r.entries} roster entries (home)`) : g('N', `roster ${r.status ?? 'absent'}`);
    cap.lineups = r.starters > 0 ? g('Y', `${r.starters} starters / ${r.bench} bench`) : g('N', 'no starter flags');
    cap.formations = r.formation ? g('Y', `formation=${JSON.stringify(r.formation)}`) : r.formation_place_present ? g('P', 'formationPlace per entry, no formation string') : g('N', 'no formation field');
    const subs = (r.subbed_in || 0) + (r.subbed_out || 0);
    cap.substitutions = subs > 0 || s.sub.plays?.has_substitutions ? g('Y', `roster subbedIn/Out=${r.subbed_in}/${r.subbed_out}; plays substitution=${s.sub.plays?.has_substitutions}`) : g('N', 'none found');
    cap.goals = s.sub.plays?.has_goals ? g('Y', 'scoring plays in details/plays') : g('N', 'no goal plays');
    cap.cards = s.sub.plays?.has_cards ? g('Y', 'card plays in details/plays') : g('N', 'no card plays in this match (may be none)');
    cap.team_stats = (s.sub.team_statistics?.stat_names || []).length ? g('Y', `${s.sub.team_statistics.stat_names.length} stat names`) : g('N', `team statistics ${s.sub.team_statistics?.status ?? 'absent'}`);
    cap.player_stats = (s.sub.player_statistics?.stat_names || []).length ? g('Y', `${s.sub.player_statistics.stat_names.length} stat names`) : g('N', s.sub.player_statistics?.note || `status ${s.sub.player_statistics?.status}`);
    cap.plays = s.sub.plays?.items > 0 ? g('Y', `${s.sub.plays.items} plays`) : g('N', `plays ${s.sub.plays?.status ?? 'absent'}`);
    cap.coordinates = (s.sub.plays?.coordinate_fields || []).length ? g('Y', s.sub.plays.coordinate_fields.join(',')) : g('N', 'no coordinate-like fields in play items');
    cap.officials = s.sub.officials?.items > 0 ? g('Y', `${s.sub.officials.items} officials`) : g('N', `officials ${s.sub.officials?.status ?? 'absent'}`);
    cap.odds = s.sub.odds?.items > 0 || up?.sub?.odds?.items > 0 ? g('Y', `odds items completed=${s.sub.odds?.items} upcoming=${up?.sub?.odds?.items} (existence only, not ingested)`) : g('N', 'no odds items');
    cap.venues = s.venue_inline ? g('Y', `venue ${s.venue_inline.fullName}`) : g('N', 'no venue');
  } else {
    const ev = ls?.event_id ? `event ${ls.event_id}` : 'no sample event';
    const r = ls?.roster || {}; const p = ls?.plays || {};
    const NU = present => (present ? 'N' : 'U');
    cap.results = ls?.score?.status === 200 ? g('Y', `${ev} score ${JSON.stringify(ls.score.body)}`) : g('U', ev);
    cap.rosters = r.entries > 0 ? g('Y', `${ev}: ${r.entries} roster entries`) : g(NU(r.status), `${ev} roster ${r.status ?? 'not probed'}`);
    cap.lineups = r.starters > 0 ? g('Y', `${ev}: ${r.starters} starters / ${r.bench} bench`) : g(NU(r.status), ev);
    cap.formations = r.formation ? g('Y', `${ev}: ${r.formation}`) : g(NU(r.status), ev);
    cap.substitutions = r.subbed_in > 0 || p.has_substitutions ? g('Y', `${ev}: subbedIn=${r.subbed_in}`) : g(NU(r.status), ev);
    cap.goals = p.has_goals ? g('Y', `${ev}: scoringPlay in plays`) : g(NU(p.status), `${ev} (0-0 or none on page 1)`);
    cap.cards = p.has_cards ? g('Y', `${ev}: card plays`) : g(NU(p.status), ev);
    cap.team_stats = ls?.team_statistics?.stat_count > 0 ? g('Y', `${ev}: ${ls.team_statistics.stat_count} stats, possessionPct=${ls.team_statistics.has_possession}`) : g('U', ev);
    cap.player_stats = r.has_player_stats_ref ? g('P', `${ev}: roster entries carry statistics refs (not fetched)`) : g(NU(r.status), ev);
    cap.plays = p.items > 0 ? g('Y', `${ev}: ${p.items} plays`) : g(NU(p.status), ev);
    cap.coordinates = (p.coordinate_fields || []).length ? g('Y', `${ev}: ${p.coordinate_fields.join(',')}`) : g(NU(p.status), ev);
    cap.officials = ls?.officials?.items > 0 ? g('Y', `${ev}: ${ls.officials.items} officials`) : g(NU(ls?.officials), ev);
    cap.odds = g('U', 'not probed for this competition');
    cap.venues = ls?.venue_inline ? g('Y', `${ev}: ${ls.venue_inline.fullName}`) : g('U', ev);
  }
  const pg = c.standings?.previous_season_group_table;
  cap.standings = !c.standings?.available && pg?.entries > 0 ? g('P', `current table empty; previous-season group table lists ${pg.entries} team refs, ${pg.entries_with_records} with records`) : c.standings?.available ? g('Y', `${c.standings.table.entries} rows; stats ${c.standings.table.stat_names.slice(0, 8).join(',')}`) : g('N', `standings not found via refs (${(c.standings?.tried || []).map(x => x.status).join('/')})`);
  const coaches = c.team_sample?.coaches;
  cap.coaches = coaches?.items > 0 ? g('P', `${coaches.items} coach item(s) on team; currency not verified (see team_sample.coach_sample)`) : c.team_sample ? g('N', `coaches ${coaches?.status ?? 'no ref'}`) : g('U', 'not probed');
  return cap;
}

main().catch(e => { console.error(e); process.exit(1); });
