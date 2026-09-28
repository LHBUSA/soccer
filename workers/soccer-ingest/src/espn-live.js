// Live lane (PBEcast): ESPN-owned fixtures in the live window, every minute (cron * * * * *).
//
// Per active match, within a per-tick request budget (never all matches at any cost):
//   status (+ the provider's own display clock)            every tick
//   score                                                   every tick while live / at final
//   play-by-play (ONE request: limit=1000)                  every tick while live
//   team statistics                                          every 3rd minute while live
//   lineups / substitutions                                  first live observation, then every 10 minutes
//   final pass (lineups + stats + plays, ledger recorded)    once, when the provider says final
// Every response is archived under the existing source-capture rules (espnClient). The canonical
// state is written through the same parsers as the regular lane; optional components are upserts
// only (a failed component never deletes rows). During live play the enrichment ledger is NOT
// written (a half-played match is not "complete"); the final pass records it.
//
// KV (binding SOCCER_STATE): live:<matchId> = { status, display_clock, detail, period, observed_at,
// capture_id, last_plays_at, last_stats_at, last_roster_at, final_done }. The API shows the clock
// exactly as the provider states it and derives freshness from observed_at; nothing is interpolated.
import * as espn from '../../providers/espn.js';
import { syncRows } from './store.js';
import { espnClient, BudgetExhausted } from './espn-jobs.js';
import { ingestEspnMatch } from './espn-lane.js';

export const LIVE_LANE = 'espn_live';
export const LIVE_BUDGET = 45;
const STATS_EVERY_MS = 3 * 60e3;
const ROSTER_EVERY_MS = 10 * 60e3;

async function kvGet(kv, key) { return kv ? kv.get(key, 'json').catch(() => null) : null; }
async function kvPut(kv, key, val, ttl = 6 * 3600) { if (kv) await kv.put(key, JSON.stringify(val), { expirationTtl: ttl }).catch(() => {}); }

export async function runEspnLive({ store, storage, registry, now = Date.now(), fetcher, budget = LIVE_BUDGET, kv = null, components = true }) {
  const from = new Date(now - 150 * 60e3).toISOString(); const to = new Date(now + 10 * 60e3).toISOString();
  const rows = await store.select('soccer_matches', { columns: ['id', 'competition_id', 'season_id', 'stage_id', 'matchday', 'round_label', 'venue_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'result_provider', 'home_score', 'away_score'], gte: { kickoff_at: from }, lte: { kickoff_at: to }, eq: { result_provider: 'espn' }, order: 'kickoff_at.asc' });
  const states = new Map(await Promise.all(rows.map(async m => [m.id, await kvGet(kv, `live:${m.id}`)])));
  // Active: not finished/postponed/cancelled, or finished by this lane but the final pass is still owed.
  const window = rows.filter(m => (m.status !== 'finished' && m.status !== 'postponed' && m.status !== 'cancelled') || (m.status === 'finished' && states.get(m.id) && !states.get(m.id).final_done));
  if (!window.length) return { skipped: 'no ESPN-owned match in the live window' };
  // One tick at a time: a slow tick must not overlap the next minute's.
  const lock = await kvGet(kv, 'live:lock');
  if (lock && now - lock.at < 55e3) return { skipped: 'previous live tick still running' };
  await kvPut(kv, 'live:lock', { at: now }, 120);

  const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { id: [...new Set(window.map(m => m.competition_id))] } })).map(c => [c.id, c.slug]));
  const compOf = id => registry.competitions.find(c => c.slug === comps.get(id));
  const ext = new Map((await store.select('soccer_match_external_ids', { columns: ['match_id', 'external_id'], eq: { provider: 'espn' }, in: { match_id: window.map(m => m.id) } })).map(x => [x.match_id, x.external_id]));
  const teamExt = new Map((await store.select('soccer_team_external_ids', { columns: ['team_id', 'external_id'], eq: { provider: 'espn' }, in: { team_id: [...new Set(window.flatMap(m => [m.home_team_id, m.away_team_id]))] } })).map(x => [x.team_id, x.external_id]));
  const client = espnClient({ storage, store, fetcher, budget, registry });
  let observed = 0; let changed = 0; const results = [];
  // Least recently observed first, so a busy slate rotates fairly within the budget.
  window.sort((a, b) => (states.get(a.id)?.observed_at ? Date.parse(states.get(a.id).observed_at) : 0) - (states.get(b.id)?.observed_at ? Date.parse(states.get(b.id).observed_at) : 0));
  try {
    for (const m of window) {
      const comp = compOf(m.competition_id); const lg = comp?.espn?.league; const ev = ext.get(m.id);
      const hx = teamExt.get(m.home_team_id); const ax = teamExt.get(m.away_team_id);
      if (!lg || !ev || !hx || !ax) continue;
      if (client.budget - client.used < 3) break;
      const prev = states.get(m.id) || {};
      const base = `${espn.CORE}/${lg}/events/${ev}/competitions/${ev}`;
      const { json: st, capture } = await client.get(`${base}/status`);
      const status = espn.parseStatus(st);
      observed += 1;
      const obsAt = capture.captured_at || new Date(now).toISOString();
      const state = { ...prev, status, display_clock: st.displayClock || null, detail: st.type?.shortDetail || st.type?.detail || null, period: st.period ?? null, observed_at: obsAt, capture_id: capture.capture_id };
      if (status === 'scheduled' || status === 'unknown') { await kvPut(kv, `live:${m.id}`, state); results.push({ match: m.id, status }); continue; }
      const score = {};
      for (const [k, tx] of [['h', hx], ['a', ax]]) { const { json } = await client.get(`${base}/competitors/${tx}/score`); score[k] = Number.isFinite(Number(json.value)) ? Number(json.value) : null; }
      await client.flush();
      const s = await syncRows(store, { table: 'soccer_matches', key: ['id'], provider: 'espn', captureId: capture.capture_id, touch: true, compare: ['status', 'home_score', 'away_score'], rows: [{ ...m, status, home_score: score.h, away_score: score.a, winner_team_id: status === 'finished' && score.h !== score.a ? (score.h > score.a ? m.home_team_id : m.away_team_id) : null }] });
      changed += (s.inserted || 0) + (s.updated || 0);
      // Components: only where legitimate, only within budget.
      const due = new Set();
      const final = status === 'finished';
      if (components) {
        if (final && !prev.final_done) { due.add('lineups'); due.add('stats'); due.add('plays'); }
        else if (status === 'live') {
          due.add('plays');
          if (!prev.last_stats_at || now - Date.parse(prev.last_stats_at) >= STATS_EVERY_MS) due.add('stats');
          if (!prev.last_roster_at || now - Date.parse(prev.last_roster_at) >= ROSTER_EVERY_MS) due.add('lineups');
        }
      }
      const need = (due.has('plays') ? 1 : 0) + (due.has('stats') ? 2 : 0) + (due.has('lineups') ? 4 : 0);
      if (due.size && client.budget - client.used >= need) {
        const lane = await kvGet(kv, `lane:espn_${comp.slug.replace(/-/g, '_')}`);
        const year = lane?.cursor?.season_year || new Date(m.kickoff_at).getUTCFullYear();
        const teamMap = new Map([[hx, m.home_team_id], [ax, m.away_team_id]]);
        const fixture = { d: m.kickoff_at, h: hx, a: ax };
        const r = await ingestEspnMatch(store, { comp, league: lg, year, eventId: ev, fixture, teamMap, client, now, only: due, recordLedger: final });
        changed += r.changed;
        const iso = new Date(now).toISOString();
        if (due.has('plays')) state.last_plays_at = iso;
        if (due.has('stats')) state.last_stats_at = iso;
        if (due.has('lineups')) state.last_roster_at = iso;
        if (final) state.final_done = true;
        state.components = r.summary.enrichment || null;
      }
      await kvPut(kv, `live:${m.id}`, state);
      results.push({ match: m.id, status, score: `${score.h}-${score.a}`, clock: state.display_clock, components: [...due] });
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) { await client.flush().catch(() => {}); await kvPut(kv, 'live:lock', { at: 0 }, 60); throw err; }
    results.push({ budget_exhausted: true });
  }
  await client.flush();
  await kvPut(kv, 'live:lock', { at: 0 }, 60);
  return { observed, changed, results, requests: client.used };
}
