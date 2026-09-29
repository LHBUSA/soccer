#!/usr/bin/env node
// Production certification report for UEFA Nations League (read-only; PostgREST, service role).
//   node scripts/qa/nations-prod.mjs [--write]   -> docs/evidence/espn/uefa-nations-production-<date>.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';

const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const selIn = async (t, col, vals, o = {}) => { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return out; };

const comps = await store.select('soccer_competitions', { columns: ['id', 'slug', 'name', 'comp_type'], eq: { slug: 'uefa-nations-league' } });
const [c] = comps;
const seasons = await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } });
const s = seasons[0];
const stages = await store.select('soccer_stages', { columns: ['id', 'name', 'stage_type'], eq: { season_id: s.id } });
const ms = await store.select('soccer_matches', { columns: ['id', 'status', 'stage_id', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'result_provider'], eq: { season_id: s.id } });
const teamIds = [...new Set(ms.flatMap(m => [m.home_team_id, m.away_team_id]))];
const teams = await selIn('soccer_teams', 'id', teamIds, { columns: ['id', 'name', 'team_type', 'country_code', 'founding_provider'] });
const tx = await selIn('soccer_team_external_ids', 'team_id', teamIds, { columns: ['team_id', 'external_id', 'method'], eq: { provider: 'espn' } });
const fin = ms.filter(m => m.status === 'finished');
const enr = await selIn('soccer_match_enrichment', 'match_id', fin.map(m => m.id), { columns: ['match_id', 'component', 'status'] });
const ok = (m, pre) => enr.some(e => e.match_id === m.id && e.component.startsWith(pre) && e.status === 'complete');
let events = 0; let located = 0;
for (const part of chunkArr(fin.map(m => m.id), 40)) { events += await store.count('soccer_match_events', { eq: { source_family: 'espn' }, in: { match_id: part } }); }
for (const part of chunkArr(fin.map(m => m.id), 40)) { located += await store.count('soccer_match_events', { eq: { source_family: 'espn', source_coordinate_system: 'espn_pct_v1' }, in: { match_id: part } }); }
const groups = await store.select('soccer_season_groups', { columns: ['id', 'group_key', 'name', 'group_type', 'parent_name', 'sort_order'], eq: { season_id: s.id } });
const members = await selIn('soccer_season_group_members', 'group_id', groups.map(g => g.id), { columns: ['group_id', 'team_id'] });
const dupX = tx.length - new Set(tx.map(x => x.external_id)).size;
const report = {
  generated_at: new Date().toISOString(), competition: c, season: s.label,
  stages: stages.map(x => ({ ...x, matches: ms.filter(m => m.stage_id === x.id).length })),
  teams: { total: teams.length, national: teams.filter(t => t.team_type === 'national').length, with_country_code: teams.filter(t => t.country_code).length, espn_crosswalk: tx.length, duplicate_espn_ids: dupX, by_method: tx.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}) },
  matches: { total: ms.length, by_status: ms.reduce((o, m) => ({ ...o, [m.status]: (o[m.status] || 0) + 1 }), {}), finished_with_score: fin.filter(m => m.home_score !== null).length, result_provider: [...new Set(ms.map(m => m.result_provider))] },
  enrichment: { finished: fin.length, lineups_both: fin.filter(m => ok(m, 'lineup_home') && ok(m, 'lineup_away')).length, stats: fin.filter(m => ok(m, 'stats')).length, plays: fin.filter(m => ok(m, 'plays')).length, events, located_events: located },
  groups: groups.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)).map(g => ({ key: g.group_key, name: g.name, type: g.group_type, tier: g.parent_name, members: members.filter(x => x.group_id === g.id).length })),
};
console.log(JSON.stringify(report, null, 1));
if (process.argv.includes('--write')) { mkdirSync('docs/evidence/espn', { recursive: true }); writeFileSync(`docs/evidence/espn/uefa-nations-production-${report.generated_at.slice(0, 10)}.json`, JSON.stringify(report, null, 2) + '\n'); }
