#!/usr/bin/env node
// READ-ONLY: the per-entity portrait holds of scripts/media/provider-media.mjs, explained.
// Re-walks the same roster payloads with the same guard (espnHeadshotCandidate) and reports every
// birth_date_contradiction (canonical vs ESPN DOB) and every athlete_not_in_crosswalk. Writes nothing.
//   node scripts/media/portrait-holds.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { ESPN_LEAGUE, espnHeadshotCandidate } from '../../workers/soccer-ingest/src/media-provider.js';

const envText = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8');
const store = storeFromEnv(Object.fromEntries(envText.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const selectIn = async (t, col, vals, o = {}) => { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await store.select(t, { ...o, in: { ...(o.in || {}), [col]: p } })); return out; };
let lastAt = 0;
const json = async url => { const w = lastAt + 300 - Date.now(); if (w > 0) await new Promise(r => setTimeout(r, w)); lastAt = Date.now(); const r = await fetch(url, { signal: AbortSignal.timeout(30000) }); if (r.status !== 200) throw new Error(`${r.status}`); return r.json(); };

const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'] });
const order = ['mls', 'premier-league', 'bundesliga', 'uefa-champions-league', 'uefa-nations-league'];
const teamComp = new Map();
for (const slug of order) {
  const c = comps.find(x => x.slug === slug); if (!c) continue;
  const season = (await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1))[0];
  for (const m of await store.select('soccer_matches', { columns: ['home_team_id', 'away_team_id'], eq: { season_id: season.id } })) for (const t of [m.home_team_id, m.away_team_id]) if (t && !teamComp.has(t)) teamComp.set(t, slug);
}
const teams = new Map((await selectIn('soccer_teams', 'id', [...teamComp.keys()], { columns: ['id', 'name', 'team_type'] })).map(t => [t.id, t]));
const ext = await selectIn('soccer_team_external_ids', 'team_id', [...teamComp.keys()], { columns: ['team_id', 'external_id'], eq: { provider: 'espn' } });
const espnOfTeam = new Map(ext.map(x => [x.team_id, String(x.external_id)]));
const px = await store.select('soccer_player_external_ids', { columns: ['player_id', 'external_id'], eq: { provider: 'espn' } });
const playerOfEspn = new Map(); for (const x of px) playerOfEspn.set(String(x.external_id), [...(playerOfEspn.get(String(x.external_id)) || []), x.player_id]);
const seen = new Map();
for (const [teamId, slug] of teamComp) {
  const e = espnOfTeam.get(teamId); if (!e) continue;
  let roster = []; try { roster = (await json(`https://site.api.espn.com/apis/site/v2/sports/soccer/${ESPN_LEAGUE[slug]}/teams/${e}/roster`)).athletes || []; } catch { continue; }
  for (const a of roster) if (a.headshot?.href) seen.set(String(a.id), [...(seen.get(String(a.id)) || []), { a, team: teams.get(teamId), slug }]);
}
const contradictions = []; const missing = [];
const ids = [...seen.keys()].filter(id => playerOfEspn.get(id)?.length === 1);
const players = new Map((await selectIn('soccer_players', 'id', ids.map(id => playerOfEspn.get(id)[0]), { columns: ['id', 'slug', 'display_name', 'birth_date'] })).map(p => [p.id, p]));
for (const [aid, entries] of seen) {
  const pids = playerOfEspn.get(aid) || [];
  if (!pids.length) { missing.push({ espn_athlete_id: aid, espn_name: entries[0].a.displayName, team: entries[0].team?.name, competition: entries[0].slug }); continue; }
  if (pids.length !== 1) continue;
  const p = players.get(pids[0]); if (!p) continue;
  const c = espnHeadshotCandidate(aid, [entries[0].a], p.birth_date);
  if (c.ok || c.reason !== 'birth_date_contradiction') continue;
  const espnDob = String(entries[0].a.dateOfBirth || '').slice(0, 10) || null;
  // club identity: every team this canonical player appears for in sourced lineups
  const lps = await store.select('soccer_lineup_players', { columns: ['lineup_id'], eq: { player_id: p.id } });
  const lus = lps.length ? await selectIn('soccer_lineups', 'id', lps.map(x => x.lineup_id), { columns: ['team_id'] }) : [];
  const tms = lus.length ? await selectIn('soccer_teams', 'id', lus.map(x => x.team_id), { columns: ['name', 'team_type'] }) : [];
  const xw = await store.select('soccer_player_external_ids', { columns: ['provider', 'external_id', 'method'], eq: { player_id: p.id } });
  contradictions.push({
    canonical_player_id: p.id, canonical_name: p.display_name, slug: p.slug, canonical_dob: p.birth_date,
    espn_athlete_id: aid, espn_name: entries[0].a.displayName, espn_dob: espnDob,
    difference_days: espnDob && p.birth_date ? Math.round((Date.parse(espnDob) - Date.parse(p.birth_date)) / 864e5) : null,
    roster_team: entries[0].team?.name, roster_competition: entries[0].slug,
    teams_in_sourced_lineups: [...new Set(tms.map(t => `${t.name} (${t.team_type})`))], crosswalks: xw.map(x => `${x.provider}:${x.external_id}:${x.method}`),
  });
}
const out = { at: new Date().toISOString(), note: 'READ-ONLY. Held per entity by provider-media.mjs; identities and DOBs untouched.', birth_date_contradictions: contradictions, athlete_not_in_crosswalk: { count: missing.length, athletes: missing } };
mkdirSync('docs/evidence/media', { recursive: true });
writeFileSync(`docs/evidence/media/portrait-holds-${out.at.slice(0, 10)}.json`, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(contradictions, null, 1));
console.log('athlete_not_in_crosswalk', missing.length, JSON.stringify(missing.reduce((o, m) => ({ ...o, [m.competition]: (o[m.competition] || 0) + 1 }), {})));
