#!/usr/bin/env node
// SOCCER ALGO V2 national-team research dataset (protocol scripts/research/algo-v2-protocol.mjs, committed c4f3520
// before this file). Results-only rows from ESPN Core (owner-approved secondary source), every response archived
// to .raw (write-once captures, same archive as the lanes). No model is fitted here and no number is computed.
//
//   node scripts/research/algo-v2-dataset.mjs [--budget 6000]
// Output: docs/evidence/research/algo-v2/national-dataset.json (+ sha256 in the manifest)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fsStorage } from '../../workers/shared/archive.js';
import { espnClient } from '../../workers/soccer-ingest/src/espn-jobs.js';
import * as espn from '../../workers/providers/espn.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const SEASONS = [['uefa.nations', 'uefa-nations-league', [2018, 2020, 2022, 2024, 2026]], ['fifa.world', 'fifa-world-cup', [2018, 2022, 2026]]];
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
const storage = await fsStorage('.raw');
const client = espnClient({ storage, store: { insert: async () => {} }, budget: Number(arg('--budget', '6000')) });
const cachePath = '.proof/algo-v2-dataset-cache.json'; // resumable: event-level results already read
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : { events: {}, teams: {}, types: {} };
const save = () => writeFileSync(cachePath, JSON.stringify(cache));

// Stage of an ESPN season type, from its name only.
export function stageOf(name) {
  const n = String(name || '');
  if (/^(Group Stage|League Phase|League [A-D])$/i.test(n)) return 'group';
  if (/relegation|play-?off/i.test(n)) return 'playoff';
  return 'knockout';
}

for (const [league, comp, years] of SEASONS) for (const year of years) {
  const key = `${league}:${year}`;
  if (!cache.types[key]) {
    const { json } = await client.get(espn.urls.seasonTypes(league, year));
    const types = [];
    for (const it of json.items || []) { const t = espn.refId(it.$ref, 'types'); const { json: tj } = await client.get(`${espn.CORE}/${league}/seasons/${year}/types/${t}`); types.push({ id: t, name: tj.name }); }
    for (const t of types) { const ids = []; let page = 1; let pages = 1; do { const { json: ej } = await client.get(espn.urls.seasonEvents(league, year, t.id, page)); const r = espn.refsOf(ej); ids.push(...r.ids); pages = r.pageCount; page += 1; } while (page <= pages); t.events = [...new Set(ids)]; }
    cache.types[key] = types; save();
  }
  let n = 0;
  for (const t of cache.types[key]) for (const id of t.events) {
    if (cache.events[id]) continue;
    const { json: ev, capture } = await client.get(espn.urls.event(league, id));
    const e = espn.parseEvent(ev, league);
    const neutral = ev.competitions?.[0]?.neutralSite;
    const base = `${espn.CORE}/${league}/events/${id}/competitions/${id}`;
    const { json: st, capture: stCap } = await client.get(`${base}/status`);
    const status = espn.parseStatus(st);
    const row = { match_key: `espn:${id}`, competition_id: comp, season_id: key, stage_type: stageOf(t.name), stage_name: t.name, espn_home: e.home.team_id, espn_away: e.away.team_id, kickoff_at: e.kickoff_utc, status, neutral_site: typeof neutral === 'boolean' ? neutral : null, captures: [capture.capture_id, stCap.capture_id] };
    if (status === 'finished') {
      for (const [side, tid] of [['home', e.home.team_id], ['away', e.away.team_id]]) { const { json: sj, capture: sc } = await client.get(`${base}/competitors/${tid}/score`); row[`${side}_score`] = Number.isFinite(Number(sj.value)) ? Number(sj.value) : null; row[`${side}_pens`] = Number.isFinite(sj.shootoutScore) ? sj.shootoutScore : null; row.captures.push(sc.capture_id); }
      row.duration = espn.parseDuration(st);
    }
    for (const tid of [e.home.team_id, e.away.team_id]) if (!cache.teams[tid]) { const { json: tj } = await client.get(`${espn.CORE}/${league}/seasons/${year}/teams/${tid}`); const p = espn.parseTeam(tj); cache.teams[tid] = { name: p.name, is_national: p.is_national }; }
    cache.events[id] = row; n += 1;
    if (n % 20 === 0) { save(); log(key, n, 'events', client.used, 'requests'); }
  }
  save(); log(key, 'done', client.used, 'requests');
}

// Teams are keyed by their stable ESPN team id (the model uses ids as labels only); the production crosswalk is
// deliberately not part of the frozen research rows.
const all = Object.values(cache.events);
const rows = all.filter(r => r.status === 'finished' && r.home_score !== null && r.away_score !== null && cache.teams[r.espn_home]?.is_national && cache.teams[r.espn_away]?.is_national)
  .map(r => ({ ...r, home_team_id: `espn:${r.espn_home}`, away_team_id: `espn:${r.espn_away}` }))
  .sort((a, b) => Date.parse(a.kickoff_at) - Date.parse(b.kickoff_at) || a.match_key.localeCompare(b.match_key));
const excluded = { not_finished: all.filter(r => r.status !== 'finished').length, missing_score: all.filter(r => r.status === 'finished' && (r.home_score == null || r.away_score == null)).length, non_national_side: all.filter(r => r.status === 'finished' && !(cache.teams[r.espn_home]?.is_national && cache.teams[r.espn_away]?.is_national)).length };
const body = JSON.stringify(rows);
const manifest = {
  protocol: 'soccer-algo-v2-national-team-protocol', built_at: new Date().toISOString(), source: 'ESPN Core (secondary, owner-approved); captures archived under .raw/soccer-source/espn', requests: client.used,
  seasons: SEASONS.flatMap(([l, , ys]) => ys.map(y => `${l}:${y}`)), rows: rows.length, excluded,
  by_season: rows.reduce((o, r) => ({ ...o, [r.season_id]: (o[r.season_id] || 0) + 1 }), {}), by_stage: rows.reduce((o, r) => ({ ...o, [r.stage_type]: (o[r.stage_type] || 0) + 1 }), {}),
  neutral_site: { true: rows.filter(r => r.neutral_site === true).length, false: rows.filter(r => r.neutral_site === false).length, unknown: rows.filter(r => r.neutral_site === null).length },
  teams: { espn_ids: new Set(rows.flatMap(r => [r.espn_home, r.espn_away])).size },
  rows_sha256: createHash('sha256').update(body).digest('hex'),
};
mkdirSync('docs/evidence/research/algo-v2', { recursive: true });
writeFileSync('docs/evidence/research/algo-v2/national-dataset.json', JSON.stringify({ manifest, rows }, null, 1) + '\n');
log('written', JSON.stringify(manifest));
