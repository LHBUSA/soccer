// Live status + score for ESPN-owned fixtures in the live window, every tick (5 min).
// Honest by design: the cadence is the cron (5 min) plus ESPN's own delay, and the
// API exposes updated_at so pages show freshness instead of implying real time.
// Match detail (lineups, stats, plays) still comes from the regular lane after the
// final whistle; this lane never writes components and never downgrades a finished match.
import * as espn from '../../providers/espn.js';
import { syncRows } from './store.js';
import { espnClient } from './espn-jobs.js';

export const LIVE_LANE = 'espn_live';

export async function runEspnLive({ store, storage, registry, now = Date.now(), fetcher, budget = 45 }) {
  const from = new Date(now - 150 * 60e3).toISOString(); const to = new Date(now + 10 * 60e3).toISOString();
  const window = (await store.select('soccer_matches', { columns: ['id', 'competition_id', 'season_id', 'stage_id', 'matchday', 'round_label', 'venue_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'result_provider', 'home_score', 'away_score'], gte: { kickoff_at: from }, lte: { kickoff_at: to }, eq: { result_provider: 'espn' }, order: 'kickoff_at.asc' }))
    .filter(m => m.status !== 'finished' && m.status !== 'postponed' && m.status !== 'cancelled');
  if (!window.length) return { skipped: 'no ESPN-owned match in the live window' };
  const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { id: [...new Set(window.map(m => m.competition_id))] } })).map(c => [c.id, c.slug]));
  const league = id => registry.competitions.find(c => c.slug === comps.get(id))?.espn?.league;
  const ext = new Map((await store.select('soccer_match_external_ids', { columns: ['match_id', 'external_id'], eq: { provider: 'espn' }, in: { match_id: window.map(m => m.id) } })).map(x => [x.match_id, x.external_id]));
  const teamExt = new Map((await store.select('soccer_team_external_ids', { columns: ['team_id', 'external_id'], eq: { provider: 'espn' }, in: { team_id: [...new Set(window.flatMap(m => [m.home_team_id, m.away_team_id]))] } })).map(x => [x.team_id, x.external_id]));
  const client = espnClient({ storage, store, fetcher, budget, registry });
  let observed = 0; let changed = 0; const results = [];
  for (const m of window) {
    const lg = league(m.competition_id); const ev = ext.get(m.id);
    if (!lg || !ev) continue;
    if (client.budget - client.used < 3) break;
    const base = `${espn.CORE}/${lg}/events/${ev}/competitions/${ev}`;
    const { json: st, capture } = await client.get(`${base}/status`);
    const status = espn.parseStatus(st);
    observed += 1;
    if (status === 'scheduled' || status === 'unknown') { results.push({ match: m.id, status }); continue; }
    const score = {};
    for (const [k, tid] of [['h', m.home_team_id], ['a', m.away_team_id]]) { const { json } = await client.get(`${base}/competitors/${teamExt.get(tid)}/score`); score[k] = Number.isFinite(Number(json.value)) ? Number(json.value) : null; }
    await client.flush();
    const s = await syncRows(store, { table: 'soccer_matches', key: ['id'], provider: 'espn', captureId: capture.capture_id, touch: true, compare: ['status', 'home_score', 'away_score'], rows: [{ ...m, status, home_score: score.h, away_score: score.a, winner_team_id: status === 'finished' && score.h !== score.a ? (score.h > score.a ? m.home_team_id : m.away_team_id) : null }] });
    changed += (s.inserted || 0) + (s.updated || 0);
    results.push({ match: m.id, status, score: `${score.h}-${score.a}`, clock: st.displayClock || null });
  }
  await client.flush();
  return { observed, changed, results, requests: client.used };
}
