#!/usr/bin/env node
// ESPN Core discovery for UEFA Nations League (uefa.nations). DISCOVERY + EVIDENCE only.
// Captures the real league id, current season, season types, the full group tree
// (recursing through `children`), per-group standings shape and the event graph size.
// Nothing is ingested. Same access rules as espn-soccer-discovery.mjs: Core API only,
// politeFetch (honest UA, sequential, >= 700 ms), 401/403/challenge -> recorded, never retried.
//
// Output: docs/evidence/espn/uefa-nations-discovery-<date>.json
// Usage:  node scripts/evidence/espn-nations-discovery.mjs [--year 2026]

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { politeFetch, SourceBlockedError } from '../../workers/shared/http.js';

const LEAGUE = 'uefa.nations';
const CORE = 'https://sports.core.api.espn.com/v2/sports/soccer/leagues';
const MAX_REQUESTS = 300;
let used = 0;
const blocked = [];

const https = u => String(u).replace(/^http:\/\//, 'https://');
const idOf = (ref, kind) => (String(ref || '').match(new RegExp(`/${kind}/(\\d+)`)) || [])[1] || null;

async function get(url) {
  url = https(url);
  if (used >= MAX_REQUESTS) throw new Error('request budget exhausted');
  if (new URL(url).host !== 'sports.core.api.espn.com') throw new Error('host not allowed');
  for (let attempt = 0; ; attempt++) {
    used++;
    try {
      const r = await politeFetch(url, { minIntervalMs: 700, timeoutMs: 45000 });
      if (r.status >= 500 && attempt < 2) { await new Promise(s => setTimeout(s, 3000 * (attempt + 1))); continue; }
      const text = new TextDecoder().decode(r.bytes);
      let json = null; try { json = JSON.parse(text); } catch { /* non-json */ }
      return { status: r.status, json };
    } catch (e) {
      if (e instanceof SourceBlockedError) { blocked.push({ url, status: e.status, reason: e.reason }); return { status: e.status, json: null, blocked: e.reason }; }
      if (attempt < 2) { await new Promise(s => setTimeout(s, 3000 * (attempt + 1))); continue; }
      return { status: 0, json: null, error: e.message };
    }
  }
}

async function listAll(url) {
  const out = []; let page = 1; let pageCount = 1;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const r = await get(`${url}${sep}limit=1000&page=${page}`);
    if (!r.json) return { status: r.status, items: out };
    out.push(...(r.json.items || []));
    pageCount = r.json.pageCount || 1; page++;
  } while (page <= pageCount);
  return { status: 200, items: out };
}

async function walkGroup(ref, depth = 0) {
  const r = await get(ref);
  const g = r.json || {};
  const node = { id: g.id ?? idOf(ref, 'groups'), name: g.name ?? null, abbreviation: g.abbreviation ?? null, short_name: g.shortName ?? null, is_conference: g.isConference ?? null, status: r.status, keys: Object.keys(g), parent_ref: g.parent?.$ref ? https(g.parent.$ref) : null, has_children: !!g.children?.$ref, has_standings: !!g.standings?.$ref, has_teams: !!g.teams?.$ref, children: [] };
  if (g.children?.$ref && depth < 4) {
    const kids = await listAll(https(g.children.$ref));
    for (const k of kids.items) node.children.push(await walkGroup(k.$ref, depth + 1));
  }
  if (g.standings?.$ref && node.children.length === 0) {
    const sl = await get(g.standings.$ref);
    node.standings_list = { status: sl.status, count: sl.json?.count ?? null, items: (sl.json?.items || []).map(i => https(i.$ref)) };
    const first = sl.json?.items?.[0]?.$ref;
    if (first) {
      const s = await get(first);
      const entries = s.json?.standings || [];
      node.standings = {
        status: s.status, name: s.json?.name ?? null, entries: entries.length,
        rows: entries.map(e => {
          const overall = (e.records || []).find(x => x.type === 'total' || x.name === 'overall') || (e.records || [])[0] || {};
          const stat = Object.fromEntries((overall.stats || []).map(x => [x.name, x.value]));
          return { team: idOf(e.team?.$ref, 'teams'), note: e.note?.description ?? null, rank: stat.rank ?? null, gp: stat.gamesPlayed ?? null, w: stat.wins ?? null, d: stat.ties ?? null, l: stat.losses ?? null, gf: stat.pointsFor ?? null, ga: stat.pointsAgainst ?? null, pts: stat.points ?? null, record_types: (e.records || []).map(x => x.type || x.name) };
        }),
      };
    }
  }
  return node;
}

async function main() {
  const yearArg = process.argv.indexOf('--year');
  const lg = await get(`${CORE}/${LEAGUE}`);
  if (!lg.json) throw new Error(`league detail failed: ${lg.status}`);
  const L = lg.json;
  const year = yearArg > 0 ? Number(process.argv[yearArg + 1]) : Number((String(L.season?.$ref || '').match(/seasons\/(\d{4})/) || [])[1]);
  const season = (await get(`${CORE}/${LEAGUE}/seasons/${year}`)).json || {};
  const typesList = await listAll(`${CORE}/${LEAGUE}/seasons/${year}/types`);
  const types = [];
  for (const t of typesList.items) {
    const tj = (await get(t.$ref)).json || {};
    const type = { id: tj.id ?? idOf(t.$ref, 'types'), name: tj.name ?? null, abbreviation: tj.abbreviation ?? null, start: tj.startDate ?? null, end: tj.endDate ?? null, has_groups: !!tj.groups?.$ref, has_standings: !!tj.hasStandings, keys: Object.keys(tj) };
    const ev = await get(`${CORE}/${LEAGUE}/seasons/${year}/types/${type.id}/events?limit=1`);
    type.event_count = ev.json?.count ?? null;
    if (tj.groups?.$ref) {
      const gl = await listAll(https(tj.groups.$ref));
      type.top_groups = [];
      for (const g of gl.items) type.top_groups.push(await walkGroup(g.$ref));
    }
    types.push(type);
  }
  const teams = await listAll(`${CORE}/${LEAGUE}/seasons/${year}/teams`);
  const teamIds = teams.items.map(t => idOf(t.$ref, 'teams')).filter(Boolean);
  // One team payload to prove isNational + any country / area identity fields.
  const sampleTeam = teamIds[0] ? (await get(`${CORE}/${LEAGUE}/seasons/${year}/teams/${teamIds[0]}`)).json : null;
  const out = {
    generated_at: new Date().toISOString(), source: 'ESPN Core API (secondary source)', league: LEAGUE,
    league_detail: { id: L.id, uid: L.uid, name: L.name, abbreviation: L.abbreviation, slug: L.slug, is_tournament: L.isTournament ?? null, season_ref: https(L.season?.$ref || ''), keys: Object.keys(L) },
    season: { year, display_name: season.displayName ?? null, start: season.startDate ?? null, end: season.endDate ?? null, type_ref: https(season.type?.$ref || '') },
    types, teams: { count: teamIds.length, ids: teamIds },
    sample_team: sampleTeam ? { id: sampleTeam.id, displayName: sampleTeam.displayName, abbreviation: sampleTeam.abbreviation, isNational: sampleTeam.isNational ?? null, keys: Object.keys(sampleTeam), country_like: Object.fromEntries(Object.entries(sampleTeam).filter(([k]) => /country|nation|area|iso|flag|alternate/i.test(k))) } : null,
    requests: used, blocked,
  };
  mkdirSync(join('docs', 'evidence', 'espn'), { recursive: true });
  const file = join('docs', 'evidence', 'espn', `uefa-nations-discovery-${out.generated_at.slice(0, 10)}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
  console.log(file, 'requests', used, 'blocked', blocked.length);
}

main().catch(e => { console.error(e); process.exit(1); });
