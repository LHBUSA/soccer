// Live lane (PBEcast), every minute (cron * * * * *). One provider (ESPN Core), three roles:
//
//   OWNER        ESPN owns the canonical result (MLS, Premier League, Champions League): status and
//                score go to soccer_matches; components refresh mid-match; one final pass.
//   ENRICHMENT   another provider owns the canonical result (Bundesliga: OpenLigaDB) and the
//                registry flags the competition `espn.live_enrichment`:
//     'shadow'   INTERNAL VALIDATION ONLY (source rights not cleared for this use). Nothing is
//                written to the database: status / clock / score and the arrival time of every
//                published play go to KV `live:<matchId>` (role, mode, source, fetched_at) and
//                every response is archived to R2 like any capture. soccer-api does not surface
//                shadow state. The regular ESPN lane keeps its existing post-final behaviour.
//     'public'   (after owner rights clearance) the provider's observation goes to
//                soccer_match_source_results, its events join the ledger as source_family 'espn',
//                and soccer-api may serve the enrichment block.
//   In every enrichment mode ESPN NEVER writes soccer_matches: the canonical owner's result is the
//   record; disagreements are logged, never resolved by overwriting. Matches reach the lane only
//   through the proven crosswalk (soccer_match_external_ids provider 'espn'); an ambiguous match
//   has no crosswalk row and is never polled.
//
// Per active match, within a per-tick request budget (never all matches at any cost):
//   status (+ the provider's own display clock)            every tick
//   score                                                   every tick while live / at final
//   play-by-play (ONE request: limit=1000)                  every tick while live
//   team statistics / lineups                               owner + public enrichment only (3 / 10 min)
//   final pass (lineups + stats + plays, ledger recorded)   owner + public enrichment, once
//
// Hardening: one failing match never stops the others. A tick where every polled match fails counts
// against the ESPN circuit breaker (3 ticks -> open 5 min); a SourceBlockedError opens it for 60 min
// and is never retried or routed around. While open, nothing is fetched and live states age into
// the API's DELAYED threshold; nothing is interpolated.
//
// KV (binding SOCCER_STATE), all per match or per provider:
//   live:<matchId>          role, mode, source, status, display_clock, detail, period, score,
//                           observed_at (= fetched_at), changed_at, capture_id, last_*_at,
//                           final_done, reconciled, disagreement, glitch, plays_seen
//   live:breaker:espn       { failed_ticks, open_until, reason }
//   live:metrics            last 120 ticks { at, started_lag_ms, duration_ms, polled, ok, failed, requests, max_age_s }
//   live:disagreements      last 100 { match_id, kind: live_score | final_score, espn, canonical }
//   live:corrections        last 100 ledger retractions / resequences
//   live:glitches           last 100 provider_glitch_suspected holds
import * as espn from '../../providers/espn.js';
import { SourceBlockedError } from '../../shared/http.js';
import { syncRows } from './store.js';
import { espnClient, BudgetExhausted } from './espn-jobs.js';
import { ingestEspnMatch } from './espn-lane.js';

export const LIVE_LANE = 'espn_live';
export const LIVE_BUDGET = 45;
const STATS_EVERY_MS = 3 * 60e3;
const ROSTER_EVERY_MS = 10 * 60e3;
export const BREAKER = { key: 'live:breaker:espn', ticks: 3, open_ms: 5 * 60e3, blocked_ms: 60 * 60e3 };
export const DISAGREE_AFTER_MS = 10 * 60e3; // a live score gap is tolerated this long as source lag, then logged
const PLAYS_SEEN_MAX = 400;

async function kvGet(kv, key) { return kv ? kv.get(key, 'json').catch(() => null) : null; }
async function kvPut(kv, key, val, ttl = 6 * 3600) { if (kv) await kv.put(key, JSON.stringify(val), { expirationTtl: ttl }).catch(() => {}); }
async function kvPush(kv, key, item, keep, ttl = 30 * 86400) { if (!kv) return; const cur = (await kvGet(kv, key)) || []; cur.push(item); await kvPut(kv, key, cur.slice(-keep), ttl); }

// competition slug -> 'shadow' | 'public' (only ESPN-enabled competitions can be enriched)
export function enrichmentModes(registry) {
  const out = new Map();
  for (const c of registry.competitions) { const m = c.espn?.enabled ? c.espn.live_enrichment : null; if (m === 'shadow' || m === 'public') out.set(c.slug, m); }
  return out;
}

export async function runEspnLive({ store, storage, registry, now = Date.now(), fetcher, budget = LIVE_BUDGET, kv = null, components = true }) {
  const started = Date.now();
  const breaker = (await kvGet(kv, BREAKER.key)) || { failed_ticks: 0, open_until: null };
  if (breaker.open_until && now < Date.parse(breaker.open_until)) return { skipped: `circuit open until ${breaker.open_until} (${breaker.reason || 'provider failures'})` };

  const from = new Date(now - 150 * 60e3).toISOString(); const to = new Date(now + 10 * 60e3).toISOString();
  const rows = await store.select('soccer_matches', { columns: ['id', 'competition_id', 'season_id', 'stage_id', 'matchday', 'round_label', 'venue_id', 'kickoff_at', 'home_team_id', 'away_team_id', 'status', 'result_provider', 'home_score', 'away_score'], gte: { kickoff_at: from }, lte: { kickoff_at: to }, order: 'kickoff_at.asc' });
  const NONE = { skipped: 'no ESPN-owned or enriched match in the live window' };
  if (!rows.length) return NONE;
  const comps = new Map((await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { id: [...new Set(rows.map(m => m.competition_id))] } })).map(c => [c.id, c.slug]));
  const modes = enrichmentModes(registry);
  const roleOf = m => (m.result_provider === 'espn' ? 'owner' : modes.has(comps.get(m.competition_id)) ? 'enrichment' : null);
  const candidates = rows.filter(m => roleOf(m) && m.status !== 'postponed' && m.status !== 'cancelled');
  const states = new Map(await Promise.all(candidates.map(async m => [m.id, await kvGet(kv, `live:${m.id}`)])));
  const active = m => {
    const st = states.get(m.id);
    if (roleOf(m) === 'owner') return m.status !== 'finished' || (st && !st.final_done);
    return !st?.final_done || !st?.reconciled; // enrichment: until ESPN's final and the owner's result are reconciled
  };
  const window = candidates.filter(active);
  if (!window.length) return NONE;
  // One tick at a time: a slow tick must not overlap the next minute's.
  const lock = await kvGet(kv, 'live:lock');
  if (lock && now - lock.at < 55e3) return { skipped: 'previous live tick still running' };
  await kvPut(kv, 'live:lock', { at: now }, 120);

  const compOf = id => registry.competitions.find(c => c.slug === comps.get(id));
  const ext = new Map((await store.select('soccer_match_external_ids', { columns: ['match_id', 'external_id'], eq: { provider: 'espn' }, in: { match_id: window.map(m => m.id) } })).map(x => [x.match_id, x.external_id]));
  const teamExt = new Map((await store.select('soccer_team_external_ids', { columns: ['team_id', 'external_id'], eq: { provider: 'espn' }, in: { team_id: [...new Set(window.flatMap(m => [m.home_team_id, m.away_team_id]))] } })).map(x => [x.team_id, x.external_id]));
  const client = espnClient({ storage, store, fetcher, budget, registry });
  let observed = 0; let changed = 0; let polled = 0; let failed = 0; let failedOwner = 0; const results = [];
  // Least recently observed first, so a busy slate rotates fairly within the budget.
  window.sort((a, b) => (states.get(a.id)?.observed_at ? Date.parse(states.get(a.id).observed_at) : 0) - (states.get(b.id)?.observed_at ? Date.parse(states.get(b.id).observed_at) : 0));
  let blocked = null; let fatal = null;
  for (const m of window) {
    const role = roleOf(m); const mode = role === 'enrichment' ? modes.get(comps.get(m.competition_id)) : null;
    const comp = compOf(m.competition_id); const lg = comp?.espn?.league; const ev = ext.get(m.id);
    const hx = teamExt.get(m.home_team_id); const ax = teamExt.get(m.away_team_id);
    if (!lg || !ev || !hx || !ax) { results.push({ match: m.id, role, skipped: 'no proven ESPN crosswalk (never polled)' }); continue; }
    const prev = states.get(m.id) || {};
    if (role === 'enrichment' && prev.final_done) { results.push(await reconcileFinal(kv, m, prev)); continue; }
    if (client.budget - client.used < 3) { results.push({ budget_exhausted: true }); break; }
    polled += 1;
    try {
      const r = await pollMatch({ store, client, kv, m, role, mode, comp, lg, ev, hx, ax, prev, now, components });
      observed += 1; changed += r.changed; results.push(r.result);
    } catch (err) {
      await client.flush().catch(() => {});
      if (err instanceof BudgetExhausted) { polled -= 1; results.push({ budget_exhausted: true }); break; }
      if (err instanceof SourceBlockedError) { blocked = err; break; }
      failed += 1; if (role === 'owner') failedOwner += 1;
      results.push({ match: m.id, role, error: String(err.message).slice(0, 200) });
      if (!(err instanceof Error)) { fatal = err; break; }
    }
  }
  await client.flush().catch(() => {});
  await kvPut(kv, 'live:lock', { at: 0 }, 60);

  // ESPN circuit breaker (provider-scoped key).
  if (blocked) {
    await kvPut(kv, BREAKER.key, { failed_ticks: breaker.failed_ticks + 1, open_until: new Date(now + BREAKER.blocked_ms).toISOString(), reason: `source blocked: ${String(blocked.message).slice(0, 120)}` }, 86400);
    throw blocked; // a lane failure; never retried or routed around
  }
  const allFailed = polled > 0 && failed === polled;
  const nextBreaker = allFailed
    ? { failed_ticks: breaker.failed_ticks + 1, open_until: breaker.failed_ticks + 1 >= BREAKER.ticks ? new Date(now + BREAKER.open_ms).toISOString() : null, reason: 'every polled match failed' }
    : { failed_ticks: 0, open_until: null, reason: null };
  if (allFailed || breaker.failed_ticks || breaker.open_until) await kvPut(kv, BREAKER.key, nextBreaker, 86400);

  // Ingestion observability: cron start lag, duration, the oldest provider observation served.
  const ages = window.map(m => results.find(r => r.match === m.id)?.observed_at || states.get(m.id)?.observed_at).filter(Boolean).map(t => Math.round((now - Date.parse(t)) / 1000));
  const metric = { at: new Date(now).toISOString(), started_lag_ms: Math.max(0, started - now), duration_ms: Date.now() - started, polled, ok: polled - failed, failed, requests: client.used, max_age_s: ages.length ? Math.max(...ages) : null, breaker_failed_ticks: nextBreaker.failed_ticks };
  await kvPush(kv, 'live:metrics', metric, 120, 7 * 86400);
  if (fatal) throw fatal;
  // Only canonical (owner) failures fail the lane: secondary enrichment failures feed the breaker and
  // metrics but never make canonical health unhealthy.
  if (allFailed && failedOwner) throw new Error(`live tick: every polled match failed (${failed}); breaker ${nextBreaker.failed_ticks}/${BREAKER.ticks}`);
  return { observed, changed, results, requests: client.used, metric };
}

async function pollMatch({ store, client, kv, m, role, mode, comp, lg, ev, hx, ax, prev, now, components }) {
  const base = `${espn.CORE}/${lg}/events/${ev}/competitions/${ev}`;
  const { json: st, capture } = await client.get(`${base}/status`);
  const status = espn.parseStatus(st);
  const obsAt = capture.captured_at || new Date(now).toISOString();
  const state = { ...prev, role, mode, source: 'espn', canonical_result_source: m.result_provider, status, display_clock: st.displayClock || null, detail: st.type?.shortDetail || st.type?.detail || null, period: st.period ?? null, observed_at: obsAt, capture_id: capture.capture_id };
  let changed = 0;
  if (status === 'scheduled' || status === 'unknown') { await client.flush(); await kvPut(kv, `live:${m.id}`, state); return { changed, result: { match: m.id, role, mode, status, observed_at: obsAt } }; }
  const score = {};
  for (const [k, tx] of [['h', hx], ['a', ax]]) { const { json } = await client.get(`${base}/competitors/${tx}/score`); score[k] = Number.isFinite(Number(json.value)) ? Number(json.value) : null; }
  await client.flush();
  state.score = { home: score.h, away: score.a };
  if (!prev.score || prev.score.home !== score.h || prev.score.away !== score.a || prev.status !== status) state.changed_at = obsAt;
  const final = status === 'finished';

  if (role === 'owner') {
    const s = await syncRows(store, { table: 'soccer_matches', key: ['id'], provider: 'espn', captureId: capture.capture_id, touch: true, compare: ['status', 'home_score', 'away_score'], rows: [{ ...m, status, home_score: score.h, away_score: score.a, winner_team_id: final && score.h !== score.a ? (score.h > score.a ? m.home_team_id : m.away_team_id) : null }] });
    changed += (s.inserted || 0) + (s.updated || 0);
  } else {
    await trackDisagreement(kv, m, state, prev, new Date(now).toISOString());
    if (mode === 'public') {
      const s = await syncRows(store, { table: 'soccer_match_source_results', key: ['match_id', 'provider'], compare: ['status', 'home_score', 'away_score'], provider: 'espn', captureId: capture.capture_id, rows: [{ match_id: m.id, provider: 'espn', status, home_score: score.h, away_score: score.a, home_score_ht: null, away_score_ht: null, capture_id: capture.capture_id, observed_at: obsAt }] });
      changed += (s.inserted || 0) + (s.updated || 0);
    }
  }

  if (role === 'enrichment' && mode === 'shadow') {
    // Shadow: measure event arrival (first time each published play is seen), write nothing.
    if (status === 'live' || (final && !prev.final_done)) {
      const { json } = await client.get(espn.urls.plays(lg, ev, 1));
      await client.flush();
      const seen = { ...(prev.plays_seen || {}) };
      for (const p of json.items || []) if (p?.id && !seen[p.id]) seen[p.id] = { first_seen_at: obsAt, type: p.type?.text || p.type?.type || null, scoring: !!p.scoringPlay, clock: p.clock?.displayValue || null };
      const published = new Set((json.items || []).map(p => String(p?.id)));
      for (const [id, v] of Object.entries(seen)) if (!published.has(String(id)) && !v.withdrawn_seen_at) seen[id] = { ...v, withdrawn_seen_at: obsAt };
      state.plays_seen = Object.fromEntries(Object.entries(seen).slice(-PLAYS_SEEN_MAX));
      state.last_plays_at = new Date(now).toISOString();
      if (final) state.final_done = true;
    }
    await kvPut(kv, `live:${m.id}`, state);
    return { changed, result: { match: m.id, role, mode, status, score: `${score.h}-${score.a}`, clock: state.display_clock, observed_at: obsAt, plays_seen: Object.keys(state.plays_seen || {}).length } };
  }

  // Components (owner, public enrichment): only where legitimate, only within budget.
  const due = new Set();
  if (components) {
    if (final && !prev.final_done) { due.add('lineups'); due.add('stats'); due.add('plays'); }
    else if (status === 'live') {
      due.add('plays');
      if (!prev.last_stats_at || now - Date.parse(prev.last_stats_at) >= STATS_EVERY_MS) due.add('stats');
      if (!prev.last_roster_at || now - Date.parse(prev.last_roster_at) >= ROSTER_EVERY_MS) due.add('lineups');
    }
  }
  const need = (due.has('plays') ? 1 : 0) + (due.has('stats') ? 2 : 0) + (due.has('lineups') ? 4 : 0);
  let corrections = null;
  if (due.size && client.budget - client.used >= need) {
    const lane = await kvGet(kv, `lane:espn_${comp.slug.replace(/-/g, '_')}`);
    const year = lane?.cursor?.season_year || new Date(m.kickoff_at).getUTCFullYear();
    const teamMap = new Map([[hx, m.home_team_id], [ax, m.away_team_id]]);
    const fixture = { d: m.kickoff_at, h: hx, a: ax };
    const r = await ingestEspnMatch(store, { comp, league: lg, year, eventId: ev, fixture, teamMap, client, now, only: due, recordLedger: final, ledgerContext: { lastSeenAt: prev.last_plays_at || null, glitchStreak: prev.glitch || null } });
    changed += r.changed;
    const iso = new Date(now).toISOString();
    if (due.has('plays')) state.last_plays_at = iso;
    if (due.has('stats')) state.last_stats_at = iso;
    if (due.has('lineups')) state.last_roster_at = iso;
    corrections = r.summary.corrections || null;
    state.glitch = corrections?.held === 'provider_glitch_suspected' ? corrections.glitch : null;
    // A held final read is not a final pass: it is retried next tick.
    if (final && !corrections?.held) state.final_done = true;
    state.components = r.summary.enrichment || null;
    if (corrections?.held === 'provider_glitch_suspected') await kvPush(kv, 'live:glitches', { at: obsAt, match_id: m.id, missing: corrections.missing, existing: corrections.existing, reads: corrections.glitch.reads }, 100);
    if (corrections && (corrections.retracted || corrections.resequenced)) await kvPush(kv, 'live:corrections', { at: obsAt, match_id: m.id, retracted: corrections.retracted_events || [], resequenced: corrections.resequenced, reason: corrections.reason || null }, 100);
  }
  await kvPut(kv, `live:${m.id}`, state);
  return { changed, result: { match: m.id, role, mode, status, score: `${score.h}-${score.a}`, clock: state.display_clock, observed_at: obsAt, components: [...due], ...(corrections && (corrections.retracted || corrections.resequenced || corrections.held) ? { corrections } : {}) } };
}

// Live disagreement (enrichment): the canonical owner's score lags or differs. Tolerated as source
// lag for DISAGREE_AFTER_MS, then logged once per distinct score pair.
async function trackDisagreement(kv, m, state, prev, tickAt) { // timed on the tick clock
  const canon = m.home_score === null || m.home_score === undefined ? null : { home: m.home_score, away: m.away_score };
  if (!canon || (canon.home === state.score.home && canon.away === state.score.away)) { state.disagreement = null; return; }
  const key = `${state.score.home}-${state.score.away}|${canon.home}-${canon.away}`;
  const same = prev.disagreement?.key === key;
  state.disagreement = { key, since: same ? prev.disagreement.since : tickAt, logged: same ? prev.disagreement.logged : false };
  if (!state.disagreement.logged && Date.parse(tickAt) - Date.parse(state.disagreement.since) >= DISAGREE_AFTER_MS) {
    await kvPush(kv, 'live:disagreements', { at: tickAt, espn_fetched_at: state.observed_at, match_id: m.id, kind: 'live_score', espn: state.score, canonical: canon, canonical_source: m.result_provider, since: state.disagreement.since }, 100);
    state.disagreement.logged = true;
  }
}

// Final reconciliation (enrichment): the canonical owner's result is the record. Once the owner has
// marked the match finished, ESPN's final score is compared with it; a mismatch is logged, never
// written over the canonical result. No provider request is made.
async function reconcileFinal(kv, m, prev) {
  if (m.status !== 'finished') return { match: m.id, role: 'enrichment', waiting: 'canonical owner has not marked the match finished' };
  const canon = { home: m.home_score, away: m.away_score };
  const agree = !!prev.score && prev.score.home === canon.home && prev.score.away === canon.away;
  if (!agree) await kvPush(kv, 'live:disagreements', { at: new Date().toISOString(), match_id: m.id, kind: 'final_score', espn: prev.score || null, canonical: canon, canonical_source: m.result_provider }, 100);
  await kvPut(kv, `live:${m.id}`, { ...prev, reconciled: true, reconciliation: { canonical: canon, agree, canonical_source: m.result_provider } });
  return { match: m.id, role: 'enrichment', reconciled: true, agree };
}
