#!/usr/bin/env node
// World Coverage source discovery (ESPN Core = owner-approved collection lane). DISCOVERY ONLY: nothing is
// ingested, nothing is written to production. For every candidate competition it records what ESPN Core
// really says: league identity (id, name, gender flag if any), the CURRENT season (year, label, dates), season
// types with their event counts, the team count, and a sample of team records (isNational, names). Slugs are
// never assumed: a slug the listing does not carry is probed once and recorded as found / absent.
//
// Access rules: Core API only, workers/shared/http.js politeFetch (honest UA, sequential >= 700 ms), 401/403/
// challenge -> SourceBlockedError recorded and never retried, hard request budget.
//
//   node scripts/evidence/espn-world-discovery.mjs [--only usa.nwsl,eng.w.1] [--budget 600]
// Output: docs/evidence/world/espn-world-discovery-<date>.json

import { mkdirSync, writeFileSync } from 'node:fs';
import { politeFetch, SourceBlockedError } from '../../workers/shared/http.js';
import { CORE, https, refId, seasonYearOf } from '../../workers/providers/espn.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
let budget = Number(arg('--budget', '600'));

// phase: A = registered men's majors, B = women, C = second-tier / global men, D = cups
export const CANDIDATES = [
  ['A', 'la-liga', 'esp.1', 'men', 'ESP'], ['A', 'serie-a', 'ita.1', 'men', 'ITA'], ['A', 'ligue-1', 'fra.1', 'men', 'FRA'], ['A', 'uefa-europa-league', 'uefa.europa', 'men', null],
  ['B', 'nwsl', 'usa.nwsl', 'women', 'USA'], ['B', 'womens-super-league', 'eng.w.1', 'women', 'ENG'], ['B', 'uefa-womens-champions-league', 'uefa.wchampions', 'women', null],
  ['B', 'liga-f', 'esp.w.1', 'women', 'ESP'], ['B', 'frauen-bundesliga', 'ger.w.1', 'women', 'DEU'], ['B', 'premiere-ligue', 'fra.w.1', 'women', 'FRA'],
  ['B', 'serie-a-women', 'ita.w.1', 'women', 'ITA'], ['B', 'fifa-womens-world-cup', 'fifa.wwc', 'women', null],
  ['C', 'efl-championship', 'eng.2', 'men', 'ENG'], ['C', 'liga-mx', 'mex.1', 'men', 'MEX'], ['C', 'eredivisie', 'ned.1', 'men', 'NLD'], ['C', 'primeira-liga', 'por.1', 'men', 'PRT'],
  ['C', 'copa-libertadores', 'conmebol.libertadores', 'men', null], ['C', 'scottish-premiership', 'sco.1', 'men', 'SCO'], ['C', 'belgian-pro-league', 'bel.1', 'men', 'BEL'],
  ['C', 'argentine-primera', 'arg.1', 'men', 'ARG'], ['C', 'brasileirao', 'bra.1', 'men', 'BRA'], ['C', 'saudi-pro-league', 'ksa.1', 'men', 'SAU'], ['C', 'j1-league', 'jpn.1', 'men', 'JPN'],
  ['D', 'fa-cup', 'eng.fa', 'men', 'ENG'], ['D', 'efl-cup', 'eng.league_cup', 'men', 'ENG'], ['D', 'copa-del-rey', 'esp.copa_del_rey', 'men', 'ESP'], ['D', 'coppa-italia', 'ita.coppa_italia', 'men', 'ITA'],
  ['D', 'dfb-pokal', 'ger.dfb_pokal', 'men', 'DEU'], ['D', 'coupe-de-france', 'fra.coupe_de_france', 'men', 'FRA'], ['D', 'uefa-conference-league', 'uefa.europa.conf', 'men', null],
  ['D', 'leagues-cup', 'concacaf.leagues.cup', 'men', null], ['D', 'us-open-cup', 'usa.open', 'men', 'USA'],
].map(([phase, slug, espn, gender, country]) => ({ phase, slug, espn, gender, country }));

const only = arg('--only', null)?.split(',');
const targets = only ? CANDIDATES.filter(c => only.includes(c.espn) || only.includes(c.slug)) : CANDIDATES;
let used = 0;
const blocked = [];

async function get(url) {
  if (budget <= 0) throw new Error('budget exhausted');
  budget -= 1; used += 1;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await politeFetch(https(url), { minIntervalMs: 700 });
      const text = new TextDecoder().decode(r.bytes);
      if (r.status >= 500 && attempt < 2) { await new Promise(s => setTimeout(s, 2000 * (attempt + 1))); continue; }
      if (r.status !== 200 || !/^\s*[{[]/.test(text)) return { status: r.status, json: null };
      return { status: 200, json: JSON.parse(text) };
    } catch (e) {
      if (e instanceof SourceBlockedError) { blocked.push({ url, error: e.message }); return { status: 'blocked', json: null }; }
      if (attempt === 2) return { status: 'error', error: String(e.message || e), json: null };
    }
  }
}

async function probe(c) {
  const out = { phase: c.phase, slug: c.slug, espn: c.espn, expected_gender: c.gender, country: c.country };
  const lg = await get(`${CORE}/${c.espn}`);
  if (!lg.json) return { ...out, status: 'league_unavailable', http: lg.status };
  const L = lg.json;
  out.league = { id: String(L.id || ''), name: L.name || null, abbreviation: L.abbreviation || null, gender: L.gender ?? null, is_tournament: L.isTournament ?? null, slug_echo: L.slug || null };
  const sref = L.season?.$ref || L.season?.ref || null;
  const year = seasonYearOf(sref) || L.season?.year || null;
  if (!year) return { ...out, status: 'no_current_season' };
  const s = await get(`${CORE}/${c.espn}/seasons/${year}`);
  const S = s.json || {};
  out.season = { year, label: S.displayName || null, start: S.startDate || null, end: S.endDate || null };
  const types = await get(`${CORE}/${c.espn}/seasons/${year}/types`);
  out.types = [];
  for (const it of (types.json?.items || []).slice(0, 10)) {
    const id = refId(it.$ref, 'types');
    const t = await get(`${CORE}/${c.espn}/seasons/${year}/types/${id}`);
    const ev = await get(`${CORE}/${c.espn}/seasons/${year}/types/${id}/events?limit=1`);
    out.types.push({ id, name: t.json?.name || null, abbreviation: t.json?.abbreviation || null, start: t.json?.startDate || null, end: t.json?.endDate || null, has_groups: !!t.json?.hasGroups, has_standings: !!t.json?.hasStandings, events: ev.json?.count ?? null });
  }
  const teams = await get(`${CORE}/${c.espn}/seasons/${year}/teams?limit=200`);
  const refs = (teams.json?.items || []).map(i => refId(i.$ref, 'teams')).filter(Boolean);
  out.teams = { count: teams.json?.count ?? refs.length, sample: [] };
  for (const id of refs.slice(0, 3)) {
    const t = await get(`${CORE}/${c.espn}/seasons/${year}/teams/${id}`);
    if (t.json) out.teams.sample.push({ id, name: t.json.displayName || null, short: t.json.shortDisplayName || null, is_national: !!t.json.isNational, location: t.json.location || null });
  }
  out.team_ids = refs;
  out.events_total = out.types.reduce((n, t) => n + (t.events || 0), 0);
  out.status = out.events_total > 0 ? 'source_present' : 'season_without_events';
  return out;
}

const results = [];
const t0 = Date.now();
for (const c of targets) {
  try { results.push(await probe(c)); } catch (e) { results.push({ ...c, status: 'probe_error', error: String(e.message || e) }); }
  const r = results.at(-1);
  console.log(`${c.espn.padEnd(24)} ${r.status} ${r.league?.name || ''} | ${r.season?.label || ''} | types ${r.types?.length ?? '-'} events ${r.events_total ?? '-'} teams ${r.teams?.count ?? '-'} (${used} req)`);
}

// shared team ids: an ESPN team id seen in two competitions is the same ESPN record (crosswalk reuse, not a merge)
const seen = new Map();
for (const r of results) for (const id of r.team_ids || []) seen.set(id, [...(seen.get(id) || []), r.slug]);
const shared = [...seen].filter(([, s]) => s.length > 1);
const crossGender = shared.filter(([, s]) => new Set(s.map(x => results.find(r => r.slug === x).expected_gender)).size > 1);

const report = {
  generated_at: new Date().toISOString(),
  source: 'ESPN Core API (sports.core.api.espn.com) only; politeFetch, sequential >= 700 ms; no site.api / espn.com pages',
  requests: used, blocked, elapsed_s: Math.round((Date.now() - t0) / 1000),
  shared_espn_team_ids: shared.length,
  cross_gender_shared_team_ids: crossGender.map(([id, s]) => ({ id, competitions: s })),
  results,
};
const day = new Date().toISOString().slice(0, 10);
mkdirSync('docs/evidence/world', { recursive: true });
const out = arg('--out', `docs/evidence/world/espn-world-discovery-${day}.json`);
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log('written', out, 'requests', used, 'blocked', blocked.length, 'cross-gender shared ids', crossGender.length);
