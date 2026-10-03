// SOCCER ALGO V2 lane (soccer-algo-v2.1.0 = v2.0.0 model with a frozen input membership, frozen spec algo-v2.json, national teams). UEFA NATIONS LEAGUE GROUP /
// LEAGUE-PHASE MATCHES ONLY. Off unless ALGO_V2 = 'on' AND the spec's status (decided by the committed research,
// never here) is 'forecast' or 'official'. Separate algo_version, separate record: V1 is never read or written.
//
// Each run (self-throttled to hourly):
//   1. issue: every scheduled UNL league-phase fixture inside [kickoff - 7 d, lock_at = kickoff - 60 min] without a V2
//      forecast gets ONE forecast (all markets + Game Best) from the frozen national-team model, using only finished
//      canonical national-team matches (spec.input_competitions) that kicked off strictly before issued_at. Neutral
//      site comes from each match's archived ESPN event capture (competitions[0].neutralSite; unknown = not neutral, as
//      in the research). Official Pick only for a market the holdout activated (status 'official').
//   2. settle: same rules as V1 (canonical final score; cancelled/abandoned/moved > 48 h -> void).
// The ledger triggers (migration 1200) enforce lock, immutability and write-once settlement.
import spec from './algo-v2.json' with { type: 'json' };
import dataset from './algo-v2-dataset.json' with { type: 'json' };
import { ntPredict, marketsFrom } from '../../../scripts/research/national-core.mjs';
import { payloadKey } from '../../shared/archive.js';
import { chunkArr } from './store.js';
import { grade, notify, selectionLabel } from './algo-lane.js';
import { sortInputs, inputHash } from './shadow-lane.js';
import { assertModelInputs, guardModelStore } from './leakage-guard.js';

export const ALGO_V2_LANE = 'algo_v2_international';
export const ALGO_V2_SPEC = spec;
// FROZEN INPUT MEMBERSHIP (soccer-algo-v2.1.0): a match is a model input candidate only if its id was frozen with the
// dataset or it kicks off after frozen_at. A historical match backfilled later is neither, whatever its kickoff.
const FROZEN = { ids: new Set(dataset.match_ids), at: Date.parse(dataset.frozen_at) };
export const v2Member = (m, frozen = FROZEN) => frozen.ids.has(m.id) || Date.parse(m.kickoff_at) > frozen.at;
export const ALGO_V2_DATASET = dataset;
const DAY = 864e5;
const CADENCE_MS = 55 * 60e3;
const NO_RESULT_EXPECTED = new Set(['postponed', 'cancelled', 'abandoned']);
const MOVED_MS = 48 * 3600e3;
const SEL3 = ['home', 'draw', 'away'];
const NEUTRAL_KV = 'algo_v2:neutral:v1';

// Pure: probabilities + Game Best + Official Pick under the frozen V2 policy.
export function v2Forecast(inputs, target) {
  assertModelInputs(inputs, target); // leakage guard: no prediction-market field may reach the model
  const M = spec.model;
  const p = ntPredict(inputs, { t: Date.parse(target.kickoff_at), home_team_id: target.home_team_id, away_team_id: target.away_team_id, neutral: !!target.neutral }, { hl: M.half_life_days, k: M.shrink_k });
  if (!p) return null;
  const probabilities = marketsFrom(p.lh, p.la, M.rho);
  return { lambda_home: p.lh, lambda_away: p.la, home_factor: p.home_factor, probabilities, ...v2Decide(probabilities) };
}
export function v2Decide(probabilities) {
  const P = spec.pick_policy;
  const cands = P.market_order.map((market, order) => {
    const active = market in P.markets;
    const t = active ? P.markets[market].threshold : P.game_best_thresholds[market];
    let selection; let prob;
    if (market === '1x2') { const v = probabilities['1x2']; const k = [v.home, v.draw, v.away].indexOf(Math.max(v.home, v.draw, v.away)); selection = SEL3[k]; prob = [v.home, v.draw, v.away][k]; }
    else { const v = probabilities[market]; const yes = v >= 0.5; selection = market === 'over_2_5' ? (yes ? 'over' : 'under') : yes ? 'yes' : 'no'; prob = yes ? v : 1 - v; }
    return { market, selection, probability: prob, threshold: t, active, margin: prob - t, order };
  }).sort((x, y) => y.margin - x.margin || x.order - y.order);
  const best = cands[0];
  const game_best = { market: best.market, selection: best.selection, probability: best.probability, threshold: best.threshold, qualifies: best.active && best.margin >= 0 };
  const off = cands.find(c => c.active);
  return { game_best, official: spec.status === 'official' && off && off.margin >= 0 ? { market: off.market, selection: off.selection, probability: off.probability, threshold: off.threshold } : null };
}

// neutral_site per canonical match, from its archived ESPN event capture (cached in KV; unknown stays null).
export async function neutralMap(store, storage, kv, ids) {
  const cache = (kv && await kv.get(NEUTRAL_KV, 'json')) || {};
  const missing = ids.filter(id => !(id in cache));
  let fetched = 0;
  for (const part of chunkArr(missing, 150)) {
    const xw = await store.select('soccer_match_external_ids', { columns: ['match_id', 'capture_id'], eq: { provider: 'espn' }, in: { match_id: part } });
    const caps = xw.filter(x => x.capture_id);
    const rows = caps.length ? await store.select('soccer_source_captures', { columns: ['capture_id', 'raw_key'], in: { capture_id: caps.map(x => x.capture_id) } }) : [];
    const raw = new Map(rows.map(r => [r.capture_id, r.raw_key]));
    for (const id of part) {
      const cap = caps.find(x => x.match_id === id);
      let v = null;
      const key = cap && raw.get(cap.capture_id);
      if (key && storage) { try { const b = await storage.get(key); const j = b ? JSON.parse(new TextDecoder().decode(b)) : null; const n = j?.competitions?.[0]?.neutralSite; v = typeof n === 'boolean' ? n : null; fetched += 1; } catch { v = null; } }
      cache[id] = v;
    }
  }
  if (kv && missing.length) await kv.put(NEUTRAL_KV, JSON.stringify(cache));
  return { map: new Map(ids.map(id => [id, cache[id] ?? null])), fetched };
}

export async function runAlgoV2(ctx) {
  const { storage, kv = null, now = Date.now(), force = false, state = {}, env = {}, frozen = FROZEN } = ctx; // frozen: tests only
  const store = guardModelStore(ctx.store); // leakage guard: market/venue tables are never read
  if (env.ALGO_V2 !== 'on') return { skipped: 'algo_v2_off' };
  if (!['forecast', 'official'].includes(spec.status)) return { skipped: `algo_v2_status_${spec.status}` };
  if (!force && state.last_success_at && now - Date.parse(state.last_success_at) < CADENCE_MS) return { skipped: 'cadence' };
  const nowIso = new Date(now).toISOString();
  const V = spec.algo_version; const events = []; const alerts = [];
  const [st] = await store.select('soccer_algo_events', { columns: ['at'], eq: { algo_version: V, event: 'started' }, limit: 1 });
  if (!st) events.push({ algo_version: V, match_id: null, event: 'started', reason: null, detail: { spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, status: spec.status } });

  const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { slug: spec.input_competitions } });
  const target = comps.find(c => c.slug === spec.competition_scope.competition_slug);
  if (!target) throw new Error(`${spec.competition_scope.competition_slug} competition missing`);
  const window = (5 * spec.model.half_life_days + 2) * DAY;
  let matches = [];
  for (const c of comps) matches = matches.concat(await store.select('soccer_matches', { columns: ['id', 'competition_id', 'season_id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], eq: { competition_id: c.id }, gte: { kickoff_at: new Date(now - window).toISOString() }, lte: { kickoff_at: new Date(now + spec.lead_time.issue_window_days * DAY).toISOString() } }));
  matches = matches.filter(m => v2Member(m, frozen));
  const past = matches.filter(m => Date.parse(m.kickoff_at) < now);
  const unavailable = past.filter(m => !NO_RESULT_EXPECTED.has(m.status) && (m.status !== 'finished' || m.home_score === null || m.away_score === null));
  // Research identity rule (protocol data.identity): a match with a side whose ESPN record said isNational=false is
  // not a model input (the national-team contract founds such a side, and its crosswalk evidence records the flag).
  const finished = past.filter(m => m.status === 'finished' && m.home_score !== null && m.away_score !== null);
  const flagged = new Set();
  for (const part of chunkArr([...new Set(finished.flatMap(m => [m.home_team_id, m.away_team_id]))], 150)) for (const x of await store.select('soccer_team_external_ids', { columns: ['team_id', 'evidence'], eq: { provider: 'espn' }, in: { team_id: part } })) if (/isNational=false/.test(x.evidence || '')) flagged.add(x.team_id);
  const done = finished.filter(m => !flagged.has(m.home_team_id) && !flagged.has(m.away_team_id));
  const lockMs = spec.lead_time.lock_minutes_before_kickoff * 60e3;
  const stages = await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { id: [...new Set(matches.filter(m => m.competition_id === target.id).map(m => m.stage_id).filter(Boolean))] } });
  const league = new Set(stages.filter(s => s.stage_type === spec.competition_scope.stage_type).map(s => s.id));
  const fixtures = matches.filter(m => m.competition_id === target.id && league.has(m.stage_id) && m.status === 'scheduled' && Date.parse(m.kickoff_at) - lockMs >= now);
  const have = new Set((fixtures.length ? await store.select('soccer_algo_forecasts', { columns: ['match_id'], eq: { algo_version: V }, in: { match_id: fixtures.map(f => f.id) } }) : []).map(r => r.match_id));
  const todo = fixtures.filter(f => !have.has(f.id));
  const { map: neutral } = await neutralMap(store, storage, kv, [...done, ...todo].map(m => m.id));
  const inputs = sortInputs(done.map(m => ({ id: m.id, kickoff_at: new Date(m.kickoff_at).toISOString(), t: Date.parse(m.kickoff_at), home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_score: m.home_score, away_score: m.away_score, neutral: neutral.get(m.id) === true })));
  const hash = inputs.length ? inputHash(inputs) : null;
  const asOf = inputs.length ? inputs.at(-1).kickoff_at : null;
  const teams = new Map();
  const tids = [...new Set(todo.flatMap(f => [f.home_team_id, f.away_team_id]))];
  if (tids.length) for (const t of await store.select('soccer_teams', { columns: ['id', 'name'], in: { id: tids } })) teams.set(t.id, t.name);

  let forecasts = 0; let picks = 0; const holds = [];
  for (const f of todo) {
    if (unavailable.length) { holds.push({ f, reason: 'prior_result_unavailable', detail: { matches: unavailable.slice(0, 5).map(m => m.id) } }); continue; }
    const fc = inputs.length ? v2Forecast(inputs, { ...f, neutral: neutral.get(f.id) === true }) : null;
    if (!fc) { holds.push({ f, reason: 'insufficient_history' }); continue; }
    if (storage) { const key = payloadKey('algo_inputs', hash); if (!(await storage.head(key))) await storage.put(key, JSON.stringify({ algo_version: V, spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, input_hash: hash, input_as_of: asOf, first_used_at: nowIso, columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score', 'neutral'], inputs: inputs.map(x => [x.id, x.kickoff_at, x.home_team_id, x.away_team_id, x.home_score, x.away_score, x.neutral]) }), 'application/json'); }
    const kickoff = new Date(f.kickoff_at).toISOString();
    const base = { algo_version: V, model_id: spec.model.id, model_hash: spec.model.model_hash, pick_policy_version: spec.pick_policy.version, spec_hash: spec.spec_hash, competition_id: f.competition_id, season_id: f.season_id, match_id: f.id, issued_at: nowIso, kickoff_at: kickoff, input_as_of: asOf, input_hash: hash, lambda_home: fc.lambda_home, lambda_away: fc.lambda_away };
    const fid = crypto.randomUUID();
    try { await store.insert('soccer_algo_forecasts', [{ id: fid, ...base, input_count: inputs.length, probabilities: fc.probabilities, game_best: fc.game_best }]); forecasts++; }
    catch (err) { holds.push({ f, reason: 'forecast_rejected', detail: { error: String(err.message || err).slice(0, 300) } }); continue; }
    events.push({ algo_version: V, match_id: f.id, event: 'forecast', reason: null, detail: { game_best: fc.game_best, input_hash: hash, neutral: neutral.get(f.id), home_factor: fc.home_factor } });
    if (!fc.official) continue;
    const o = fc.official; const lockAt = new Date(Date.parse(kickoff) - lockMs).toISOString();
    try {
      const pid = crypto.randomUUID();
      await store.insert('soccer_algo_picks', [{ id: pid, ...base, forecast_id: fid, model_version: spec.model.version, market: o.market, selection: o.selection, model_probability: o.probability, threshold: o.threshold, lock_at: lockAt }]);
      const [row] = await store.select('soccer_algo_picks', { columns: ['record_no'], eq: { id: pid }, limit: 1 });
      picks++;
      events.push({ algo_version: V, match_id: f.id, event: 'issued', reason: null, detail: { record_no: row?.record_no ?? null, market: o.market, selection: o.selection, probability: o.probability, lock_at: lockAt } });
      alerts.push({ match_id: f.id, text: `SOCCER ALGO V2 PICK LOCKED\nNations League · ${teams.get(f.home_team_id)} v ${teams.get(f.away_team_id)} · ${kickoff.replace('T', ' ').slice(0, 16)} UTC\n${selectionLabel(o.market, o.selection, { home: teams.get(f.home_team_id), away: teams.get(f.away_team_id) })} · model probability ${(100 * o.probability).toFixed(1)}%\n${V}` });
    } catch (err) { holds.push({ f, reason: 'pick_rejected', detail: { error: String(err.message || err).slice(0, 300) } }); }
  }
  if (holds.length) {
    const prev = await store.select('soccer_algo_events', { columns: ['match_id', 'reason'], eq: { algo_version: V, event: 'hold' }, in: { match_id: [...new Set(holds.map(h => h.f.id))] } });
    const seen = new Set(prev.map(p => `${p.match_id}|${p.reason}`));
    for (const h of holds) if (!seen.has(`${h.f.id}|${h.reason}`)) { seen.add(`${h.f.id}|${h.reason}`); events.push({ algo_version: V, match_id: h.f.id, event: 'hold', reason: h.reason, detail: h.detail || {} }); }
  }
  // Settlement: canonical match state only (V2 rows only).
  const open = (await store.select('soccer_algo_picks', { columns: ['id', 'record_no', 'match_id', 'market', 'selection', 'model_probability', 'kickoff_at'], eq: { algo_version: V, status: 'pending' } })).filter(r => Date.parse(r.kickoff_at) < now);
  let settled = 0;
  if (open.length) {
    const byId = new Map((await store.select('soccer_matches', { columns: ['id', 'status', 'kickoff_at', 'home_score', 'away_score'], in: { id: open.map(r => r.match_id) } })).map(m => [m.id, m]));
    for (const r of open) {
      const m = byId.get(r.match_id); if (!m) continue;
      const moved = Math.abs(Date.parse(m.kickoff_at) - Date.parse(r.kickoff_at)) > MOVED_MS;
      let upd = null;
      if (m.status === 'cancelled' || m.status === 'abandoned') upd = { status: 'void', settlement_reason: `match ${m.status}` };
      else if (moved) upd = { status: 'void', settlement_reason: 'kickoff moved by more than 48 h' };
      else if (m.status === 'finished' && m.home_score !== null && m.away_score !== null) upd = { status: grade(r.market, r.selection, m.home_score, m.away_score), final_home_score: m.home_score, final_away_score: m.away_score, settlement_reason: 'canonical final score' };
      if (!upd) continue;
      await store.update('soccer_algo_picks', { ...upd, settled_at: new Date().toISOString() }, { eq: { id: r.id } });
      settled++;
      events.push({ algo_version: V, match_id: r.match_id, event: upd.status === 'void' ? 'void' : 'settled', reason: upd.settlement_reason, detail: { record_no: r.record_no, status: upd.status } });
    }
  }
  for (const a of alerts) { const sent = await notify(env, a.text, ctx.fetchImpl); events.push({ algo_version: V, match_id: a.match_id, event: 'alert', reason: sent ? 'slack_sent' : 'slack_not_configured_or_failed', detail: { text: a.text } }); }
  if (events.length) await store.insert('soccer_algo_events', events.map(e => ({ ...e, at: nowIso })));
  return { observed: fixtures.length, changed: forecasts + picks + settled, parserVersion: `algo-v2/${spec.spec_hash.slice(0, 12)}`, results: { fixtures: fixtures.length, forecasts, picks, holds: holds.map(h => ({ match_id: h.f.id, reason: h.reason })), settled, input_hash: hash, input_count: inputs.length } };
}
