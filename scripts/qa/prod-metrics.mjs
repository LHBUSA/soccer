#!/usr/bin/env node
// Production metrics straight from the SPORTS project (read-only, PostgREST).
// Writes docs/evidence/proof/production-metrics-<date>.json.
//   node scripts/qa/prod-metrics.mjs [bundesliga,premier-league,uefa-champions-league]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { storeFromEnv } from '../../workers/shared/postgrest.js';
import { chunkArr } from '../../workers/soccer-ingest/src/store.js';
import { espnStoreCanary } from '../../workers/soccer-ingest/src/canary.js';
import { TABLES } from '../backfill/certify.mjs';

const comps = (process.argv[2] || 'bundesliga,premier-league,uefa-champions-league').split(',');
const text = readFileSync('D:/Workers/secrets/soccer-supabase.env', 'utf8').replace(/^\uFEFF/, '');
const store = storeFromEnv(Object.fromEntries(text.split(/\r?\n/).filter(l => l.includes('=')).map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])));
const sel = (t, o) => store.select(t, o);
async function selectIn(t, col, vals, o) { const out = []; for (const p of chunkArr([...new Set(vals)], 150)) out.push(...await sel(t, { ...o, in: { ...(o?.in || {}), [col]: p } })); return out; }

const counts = {};
for (const t of TABLES) counts[t] = await store.count(t);
counts.soccer_competitions_list = (await sel('soccer_competitions', { columns: ['slug'] })).map(c => c.slug);

const perComp = {};
for (const slug of comps) {
  const [c] = await sel('soccer_competitions', { columns: ['id'], eq: { slug }, limit: 1 });
  if (!c) { perComp[slug] = { missing: true }; continue; }
  const seasons = (await sel('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: c.id } })).sort((a, b) => (a.label < b.label ? 1 : -1));
  const cur = seasons[0];
  const matches = await sel('soccer_matches', { columns: ['id', 'status', 'result_provider'], eq: { season_id: cur.id } });
  const ids = matches.map(m => m.id);
  const espnX = await selectIn('soccer_match_external_ids', 'match_id', ids, { columns: ['match_id', 'method'], eq: { provider: 'espn' } });
  const espnIds = espnX.map(x => x.match_id);
  const events = espnIds.length ? await store.count('soccer_match_events', { eq: { source_family: 'espn' }, in: { match_id: espnIds.slice(0, 150) } }) : 0;
  let evAll = 0; let evXY = 0; const withPlays = new Set();
  for (const part of chunkArr(espnIds, 60)) {
    evAll += await store.count('soccer_match_events', { eq: { source_family: 'espn' }, in: { match_id: part } });
    evXY += await store.count('soccer_match_events', { eq: { source_family: 'espn', source_coordinate_system: 'espn_pct_v1' }, in: { match_id: part } });
  }
  const lineups = await selectIn('soccer_lineups', 'match_id', ids, { columns: ['match_id', 'provider', 'formation'] });
  const stats = await selectIn('soccer_team_match_stats', 'match_id', ids, { columns: ['match_id'], eq: { provider: 'espn', basis: 'source' } });
  const sr = await selectIn('soccer_match_source_results', 'match_id', ids, { columns: ['match_id', 'provider', 'home_score', 'away_score', 'status'] });
  const by = new Map(); for (const r of sr) by.set(r.match_id, { ...(by.get(r.match_id) || {}), [r.provider]: r });
  const both = [...by.values()].filter(v => v.espn && v.openligadb && v.espn.status === 'finished' && v.openligadb.status === 'finished');
  perComp[slug] = {
    seasons: seasons.length, current_season: cur.label, current_matches: matches.length, current_finished: matches.filter(m => m.status === 'finished').length,
    historical_matches: slug === 'bundesliga' ? await store.count('soccer_matches', { eq: { competition_id: c.id } }) - matches.length : 0,
    result_owner: matches.reduce((o, m) => ({ ...o, [m.result_provider]: (o[m.result_provider] || 0) + 1 }), {}),
    espn_linked_matches: espnX.length, espn_link_method: espnX.reduce((o, x) => ({ ...o, [x.method]: (o[x.method] || 0) + 1 }), {}),
    duplicate_matches_prevented: espnX.filter(x => x.method === 'fixture_graph').length,
    matches_with_espn_lineups: new Set(lineups.filter(l => l.provider === 'espn').map(l => l.match_id)).size, lineups_with_formation: lineups.filter(l => l.formation).length,
    matches_with_espn_team_stats: new Set(stats.map(s => s.match_id)).size,
    espn_events: evAll, espn_events_with_coordinates: evXY,
    cross_source_finished_compared: both.length,
    cross_source_disagreements: both.filter(v => v.espn.home_score !== v.openligadb.home_score || v.espn.away_score !== v.openligadb.away_score).map(v => ({ match_id: v.espn.match_id, espn: `${v.espn.home_score}-${v.espn.away_score}`, openligadb: `${v.openligadb.home_score}-${v.openligadb.away_score}` })),
  };
  void events; void withPlays;
}

const queue = await sel('soccer_identity_queue', { columns: ['entity_type', 'provider', 'reason', 'status', 'payload', 'external_id'] });
const open = queue.filter(q => q.status === 'open');
const merged = (await sel('soccer_player_external_ids', { columns: ['external_id', 'evidence'], eq: { provider: 'espn', method: 'attribute_corroborated' } })).map(r => ({ ...r, ev: JSON.parse(r.evidence) }));
const espnNameDob = open.filter(q => q.provider === 'espn' && q.entity_type === 'player' && q.reason !== 'athlete_without_dob_or_name');
const conflicting = espnNameDob.filter(q => q.reason.startsWith('contradiction_'));
const why = {}; for (const q of espnNameDob) for (const w of q.payload?.evidence?.unverifiable_windows || []) why[w.why] = (why[w.why] || 0) + 1;
const xwMethods = {};
for (const t of ['soccer_team_external_ids', 'soccer_player_external_ids', 'soccer_match_external_ids']) {
  const rows = await sel(t, { columns: ['provider', 'method', 'external_id'] });
  xwMethods[t] = rows.reduce((o, r) => { const k = `${r.provider}/${r.method}`; o[k] = (o[k] || 0) + 1; return o; }, {});
}
const hoff = await sel('soccer_team_external_ids', { columns: ['provider', 'external_id', 'team_id', 'method', 'evidence'], eq: { provider: 'openligadb' }, in: { external_id: ['123', '175'] } });
const report = {
  generated_at: new Date().toISOString(), target: 'tkmlnhmylqnttmnsnief',
  row_counts: counts, competitions: perComp,
  identity: {
    queue_open_total: open.length,
    queue_open_by_reason: open.reduce((o, q) => { const k = `${q.entity_type}/${q.provider}/${q.reason}`; o[k] = (o[k] || 0) + 1; return o; }, {}),
    queue_resolved: queue.filter(q => q.status === 'resolved').length,
    crosswalk_methods: xwMethods,
    attribute_corroborated: {
      name_dob_candidates: merged.length + espnNameDob.length, auto_resolved: merged.length,
      still_queued: espnNameDob.length - conflicting.length, conflicting: conflicting.length,
      queued_by_reason: espnNameDob.reduce((o, q) => ({ ...o, [q.reason]: (o[q.reason] || 0) + 1 }), {}),
      contradiction_kinds: conflicting.flatMap(q => (q.payload?.evidence?.contradictions || []).map(c => c.kind)).reduce((o, k) => ({ ...o, [k]: (o[k] || 0) + 1 }), {}),
      unverifiable_window_reasons: why,
      corroborating_windows_by_season: merged.flatMap(m => m.ev.corroborating_windows.map(w => w.season)).reduce((o, s) => ({ ...o, [s]: (o[s] || 0) + 1 }), {}),
      nationality_compared_on_merges: merged.filter(m => m.ev.nationality?.compared).length,
      movers_2017_club_differs_from_current_club: merged.filter(m => m.ev.current_club && m.ev.corroborating_windows.some(w => w.canonical_team !== m.ev.current_club)).length,
      conflicting_players: conflicting.map(q => ({ espn_id: q.external_id, name: q.payload?.name, reason: q.reason })),
    },
  },
  hoffenheim: hoff.map(h => ({ ...h, evidence: String(h.evidence).slice(0, 300), same_canonical_team: hoff.every(x => x.team_id === hoff[0].team_id) })),
  store_canary: await espnStoreCanary(store),
  store_requests: store.requests,
};
mkdirSync('docs/evidence/proof', { recursive: true });
const file = `docs/evidence/proof/production-metrics-${report.generated_at.slice(0, 10)}.json`;
writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
console.log(file);
console.log(JSON.stringify({ competitions: perComp, identity: { ...report.identity, attribute_corroborated: { ...report.identity.attribute_corroborated, conflicting_players: report.identity.attribute_corroborated.conflicting_players.length } }, hoffenheim: report.hoffenheim.map(h => [h.external_id, h.method, h.same_canonical_team]), canary: report.store_canary.pass }, null, 1));
