// SOCCER ALGO V1 lane (soccer-algo-v1.0.0, frozen spec algo-v1.json). BUNDESLIGA LEAGUE MATCHES ONLY.
// Off unless ALGO_OFFICIAL = 'on' (wrangler var): the public record starts with the first pick issued after
// the switch; nothing is back-filled.
//
// Each run (self-throttled to hourly):
//   1. issue: every scheduled Bundesliga league fixture inside [kickoff - 7 d, lock_at = kickoff - 60 min] that has
//      no forecast gets ONE forecast (all markets, Game Best) from the frozen model, using only finished league
//      results that kicked off strictly before issued_at. If its Game Best meets the frozen threshold, the
//      Official Pick is written in the same run. Any earlier result missing -> HOLD (never guessed). The exact
//      input list is archived write-once in R2 under its sha256.
//   2. settle: pending picks whose canonical match is final are graded from the canonical score; cancelled or
//      abandoned -> void; kickoff moved by more than 48 h -> void; otherwise they stay pending.
//   3. alerts: every issue and settlement is an append-only soccer_algo_events row; Slack is an optional second
//      channel (SLACK_WEBHOOK_URL secret), never carrying secrets.
// The ledger triggers (migration 1200) enforce lock, immutability and write-once settlement.
import spec from './algo-v1.json' with { type: 'json' };
import { predictFrom, dcGrid } from '../../../scripts/research/structural-core.mjs';
import { payloadKey } from '../../shared/archive.js';
import { modelMatch, sortInputs, inputHash } from './shadow-lane.js';
import { assertModelInputs, guardModelStore } from './leakage-guard.js';

export const ALGO_LANE = 'algo_v1_bundesliga';
export const ALGO_SPEC = spec;
const DAY = 864e5;
const CADENCE_MS = 55 * 60e3;
const NO_RESULT_EXPECTED = new Set(['postponed', 'cancelled', 'abandoned']);
const MOVED_MS = 48 * 3600e3;
const SEL3 = ['home', 'draw', 'away'];

// Pure: every market's probability from the frozen model (Dixon-Coles grid, rho from the spec, no calibration).
export function algoForecast(inputs, target) {
  assertModelInputs(inputs, target); // leakage guard: no prediction-market field may reach the model
  const M = spec.model; const ts = M.team_strength;
  const p = predictFrom(inputs, 0, inputs.length, { t: Date.parse(target.kickoff_at), home_team_id: target.home_team_id, away_team_id: target.away_team_id }, { hl: ts.half_life_days, shrink: ts.shrink, homeHl: M.home_half_life_days, minWeight: ts.min_weight });
  if (!p) return null;
  const { g, S } = dcGrid(p.lh, p.la, M.rho);
  let h = 0; let d = 0; let a = 0; let over = 0; let h0 = 0; let a0 = 0; let both = 0;
  for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) {
    const q = g[i * 11 + j] / S;
    if (i > j) h += q; else if (i === j) d += q; else a += q;
    if (i + j >= 3) over += q; if (i === 0) h0 += q; if (j === 0) a0 += q; if (i >= 1 && j >= 1) both += q;
  }
  const s = h + d + a;
  const probabilities = { '1x2': { home: h / s, draw: d / s, away: a / s }, over_2_5: over, home_to_score: 1 - h0, away_to_score: 1 - a0, btts: both };
  return { lambda_home: p.lh, lambda_away: p.la, probabilities, ...decide(probabilities) };
}

// Pure: the Game Best and (if it qualifies) the Official Pick under the frozen policy.
export function decide(probabilities) {
  const P = spec.pick_policy;
  const cands = P.market_order.map((market, order) => {
    const t = P.markets[market].threshold;
    let selection; let prob;
    if (market === '1x2') { const v = probabilities['1x2']; const k = [v.home, v.draw, v.away].indexOf(Math.max(v.home, v.draw, v.away)); selection = SEL3[k]; prob = [v.home, v.draw, v.away][k]; }
    else { const v = probabilities[market]; const yes = v >= 0.5; selection = market === 'over_2_5' ? (yes ? 'over' : 'under') : yes ? 'yes' : 'no'; prob = yes ? v : 1 - v; }
    return { market, selection, probability: prob, threshold: t, margin: prob - t, order };
  }).sort((x, y) => y.margin - x.margin || x.order - y.order);
  const best = cands[0];
  const game_best = { market: best.market, selection: best.selection, probability: best.probability, threshold: best.threshold, qualifies: best.margin >= 0 };
  return { game_best, official: game_best.qualifies ? game_best : null };
}

export const grade = (market, selection, hs, as) => {
  if (market === '1x2') return (selection === 'home' ? hs > as : selection === 'draw' ? hs === as : as > hs) ? 'win' : 'loss';
  const ev = market === 'home_to_score' ? hs >= 1 : market === 'away_to_score' ? as >= 1 : hs + as >= 3;
  const want = selection === 'yes' || selection === 'over';
  return ev === want ? 'win' : 'loss';
};

export async function notify(env, text, fetchImpl = fetch) {
  if (!env?.SLACK_WEBHOOK_URL) return false;
  try { const r = await fetchImpl(env.SLACK_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: String(text).slice(0, 1500) }) }); return r.ok; } catch { return false; }
}
const pct = p => `${(100 * p).toFixed(1)}%`;
const SEL_WORD = { home: 'HOME WIN', draw: 'DRAW', away: 'AWAY WIN', yes: 'TO SCORE: YES', no: 'TO SCORE: NO', over: 'OVER 2.5', under: 'UNDER 2.5' };
export const selectionLabel = (market, selection, teams) => (market === 'home_to_score' ? `${teams.home} to score: ${selection.toUpperCase()}` : market === 'away_to_score' ? `${teams.away} to score: ${selection.toUpperCase()}` : market === '1x2' && selection !== 'draw' ? `${selection === 'home' ? teams.home : teams.away} WIN` : SEL_WORD[selection]);

export async function runAlgo(ctx) {
  const { storage, now = Date.now(), force = false, state = {}, env = {} } = ctx;
  const store = guardModelStore(ctx.store); // leakage guard: market/venue tables are never read
  if (env.ALGO_OFFICIAL !== 'on') return { skipped: 'algo_official_off' };
  if (!force && state.last_success_at && now - Date.parse(state.last_success_at) < CADENCE_MS) return { skipped: 'cadence' };
  const nowIso = new Date(now).toISOString();
  const V = spec.algo_version;
  const events = []; const alerts = [];

  const [started] = await store.select('soccer_algo_events', { columns: ['at'], eq: { algo_version: V, event: 'started' }, limit: 1 });
  if (!started) events.push({ algo_version: V, match_id: null, event: 'started', reason: null, detail: { spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, pick_policy: spec.pick_policy.version } });

  const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: spec.competition_scope.competition_slug }, limit: 1 });
  if (!comp) throw new Error('bundesliga competition missing');
  const seasons = await store.select('soccer_seasons', { columns: ['id'], eq: { competition_id: comp.id } });
  const stages = await store.select('soccer_stages', { columns: ['id', 'stage_type'], in: { season_id: seasons.map(s => s.id) } });
  const leagueStages = new Set(stages.filter(s => s.stage_type === spec.competition_scope.stage_type).map(s => s.id));
  const window = (5 * spec.model.team_strength.half_life_days + 2) * DAY;
  const matches = await store.select('soccer_matches', {
    columns: ['id', 'competition_id', 'season_id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'],
    eq: { competition_id: comp.id }, gte: { kickoff_at: new Date(now - window).toISOString() }, lte: { kickoff_at: new Date(now + spec.lead_time.issue_window_days * DAY).toISOString() }, order: 'kickoff_at.asc,id.asc',
  });
  const league = matches.filter(m => leagueStages.has(m.stage_id));
  const past = league.filter(m => Date.parse(m.kickoff_at) < now);
  const unavailable = past.filter(m => !NO_RESULT_EXPECTED.has(m.status) && (m.status !== 'finished' || m.home_score === null || m.away_score === null));
  const inputs = sortInputs(past.filter(m => m.status === 'finished' && m.home_score !== null && m.away_score !== null).map(modelMatch));
  const lockMs = spec.lead_time.lock_minutes_before_kickoff * 60e3;
  const fixtures = league.filter(m => m.status === 'scheduled' && Date.parse(m.kickoff_at) - lockMs >= now);
  const have = new Set((fixtures.length ? await store.select('soccer_algo_forecasts', { columns: ['match_id'], eq: { algo_version: V }, in: { match_id: fixtures.map(f => f.id) } }) : []).map(r => r.match_id));
  const hash = inputs.length ? inputHash(inputs) : null;
  const asOf = inputs.length ? inputs.at(-1).kickoff_at : null;
  const teams = new Map();
  const tids = [...new Set(fixtures.flatMap(f => [f.home_team_id, f.away_team_id]))];
  if (tids.length) for (const t of await store.select('soccer_teams', { columns: ['id', 'name'], in: { id: tids } })) teams.set(t.id, t.name);

  let forecasts = 0; let picks = 0; const holds = [];
  for (const f of fixtures) {
    if (have.has(f.id)) continue;
    if (unavailable.length) { holds.push({ f, reason: 'prior_result_unavailable' }); continue; }
    if (!inputs.length || !(Date.parse(asOf) < now)) { holds.push({ f, reason: 'no_time_safe_inputs' }); continue; }
    const fc = algoForecast(inputs, f);
    if (!fc) { holds.push({ f, reason: 'insufficient_history' }); continue; }
    if (storage) { const key = payloadKey('algo_inputs', hash); if (!(await storage.head(key))) await storage.put(key, JSON.stringify({ algo_version: V, spec_hash: spec.spec_hash, model_hash: spec.model.model_hash, input_hash: hash, input_as_of: asOf, first_used_at: nowIso, columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], inputs: inputs.map(x => [x.id, x.kickoff_at, x.home_team_id, x.away_team_id, x.home_score, x.away_score]) }), 'application/json'); }
    const kickoff = new Date(f.kickoff_at).toISOString();
    const base = { algo_version: V, model_id: spec.model.id, model_hash: spec.model.model_hash, pick_policy_version: spec.pick_policy.version, spec_hash: spec.spec_hash, competition_id: f.competition_id, season_id: f.season_id, match_id: f.id, issued_at: nowIso, kickoff_at: kickoff, input_as_of: asOf, input_hash: hash, lambda_home: fc.lambda_home, lambda_away: fc.lambda_away };
    const fid = crypto.randomUUID();
    try { await store.insert('soccer_algo_forecasts', [{ id: fid, ...base, input_count: inputs.length, probabilities: fc.probabilities, game_best: fc.game_best }]); forecasts++; }
    catch (err) { holds.push({ f, reason: 'forecast_rejected', detail: { error: String(err.message || err).slice(0, 300) } }); continue; }
    events.push({ algo_version: V, match_id: f.id, event: 'forecast', reason: null, detail: { game_best: fc.game_best, input_hash: hash } });
    if (!fc.official) continue;
    const o = fc.official;
    const lockAt = new Date(Date.parse(kickoff) - lockMs).toISOString();
    try {
      const pid = crypto.randomUUID();
      await store.insert('soccer_algo_picks', [{ id: pid, ...base, forecast_id: fid, model_version: spec.model.version, market: o.market, selection: o.selection, model_probability: o.probability, threshold: o.threshold, lock_at: lockAt }]);
      const [row] = await store.select('soccer_algo_picks', { columns: ['record_no'], eq: { id: pid }, limit: 1 });
      picks++;
      const label = selectionLabel(o.market, o.selection, { home: teams.get(f.home_team_id), away: teams.get(f.away_team_id) });
      events.push({ algo_version: V, match_id: f.id, event: 'issued', reason: null, detail: { record_no: row?.record_no ?? null, market: o.market, selection: o.selection, probability: o.probability, lock_at: lockAt } });
      alerts.push({ match_id: f.id, text: `SOCCER ALGO PICK LOCKED\nBundesliga · ${teams.get(f.home_team_id)} v ${teams.get(f.away_team_id)} · ${kickoff.replace('T', ' ').slice(0, 16)} UTC\n${label} · model probability ${pct(o.probability)}\n${V} (${spec.pick_policy.version}) · locked ${lockAt.replace('T', ' ').slice(0, 16)} UTC` });
    } catch (err) { holds.push({ f, reason: 'pick_rejected', detail: { error: String(err.message || err).slice(0, 300) } }); }
  }
  if (holds.length) {
    const prev = await store.select('soccer_algo_events', { columns: ['match_id', 'reason'], eq: { algo_version: V, event: 'hold' }, in: { match_id: [...new Set(holds.map(h => h.f.id))] } });
    const seen = new Set(prev.map(p => `${p.match_id}|${p.reason}`));
    for (const h of holds) if (!seen.has(`${h.f.id}|${h.reason}`)) { seen.add(`${h.f.id}|${h.reason}`); events.push({ algo_version: V, match_id: h.f.id, event: 'hold', reason: h.reason, detail: h.detail || {} }); }
  }

  // Settlement: canonical match state only.
  const open = (await store.select('soccer_algo_picks', { columns: ['id', 'record_no', 'match_id', 'market', 'selection', 'model_probability', 'kickoff_at'], eq: { algo_version: V, status: 'pending' } })).filter(r => Date.parse(r.kickoff_at) < now);
  let settled = 0;
  if (open.length) {
    const byId = new Map((await store.select('soccer_matches', { columns: ['id', 'status', 'kickoff_at', 'home_score', 'away_score', 'home_team_id', 'away_team_id'], in: { id: open.map(r => r.match_id) } })).map(m => [m.id, m]));
    const names = new Map((await store.select('soccer_teams', { columns: ['id', 'name'], in: [...byId.values()].flatMap(m => [m.home_team_id, m.away_team_id]).length ? { id: [...new Set([...byId.values()].flatMap(m => [m.home_team_id, m.away_team_id]))] } : { id: ['00000000-0000-0000-0000-000000000000'] } })).map(t => [t.id, t.name]));
    for (const r of open) {
      const m = byId.get(r.match_id); if (!m) continue;
      const moved = Math.abs(Date.parse(m.kickoff_at) - Date.parse(r.kickoff_at)) > MOVED_MS;
      let upd = null;
      if (m.status === 'cancelled' || m.status === 'abandoned') upd = { status: 'void', settlement_reason: `match ${m.status}` };
      else if (moved) upd = { status: 'void', settlement_reason: 'kickoff moved by more than 48 h' };
      else if (m.status === 'finished' && m.home_score !== null && m.away_score !== null) upd = { status: grade(r.market, r.selection, m.home_score, m.away_score), final_home_score: m.home_score, final_away_score: m.away_score, settlement_reason: 'canonical final score' };
      if (!upd) continue;
      // settled_at = the actual wall-clock time the settlement is written (the trigger refuses future stamps)
      await store.update('soccer_algo_picks', { ...upd, settled_at: new Date().toISOString() }, { eq: { id: r.id } });
      settled++;
      events.push({ algo_version: V, match_id: r.match_id, event: upd.status === 'void' ? 'void' : 'settled', reason: upd.settlement_reason, detail: { record_no: r.record_no, status: upd.status, final: upd.final_home_score !== undefined ? `${upd.final_home_score}-${upd.final_away_score}` : null } });
      if (upd.status !== 'void') alerts.push({ match_id: r.match_id, settle: true, text: `SOCCER ALGO PICK ${upd.status === 'win' ? 'HIT' : 'MISS'}\n${names.get(m.home_team_id)} ${m.home_score}-${m.away_score} ${names.get(m.away_team_id)}\n${selectionLabel(r.market, r.selection, { home: names.get(m.home_team_id), away: names.get(m.away_team_id) })} · model probability ${pct(r.model_probability)}` });
    }
  }
  if (alerts.some(a => a.settle)) {
    const all = await store.select('soccer_algo_picks', { columns: ['status'], eq: { algo_version: V } });
    const c = s => all.filter(x => x.status === s).length;
    const rec = `Record ${c('win')}-${c('loss')}${c('void') ? ` (${c('void')} void)` : ''}${c('pending') ? `, ${c('pending')} pending` : ''}`;
    for (const a of alerts) if (a.settle) a.text += `\n${rec}`;
  }
  for (const a of alerts) { const sent = await notify(env, a.text, ctx.fetchImpl); events.push({ algo_version: V, match_id: a.match_id, event: 'alert', reason: sent ? 'slack_sent' : 'slack_not_configured_or_failed', detail: { text: a.text } }); }
  if (events.length) await store.insert('soccer_algo_events', events.map(e => ({ ...e, at: nowIso })));
  return { observed: fixtures.length, changed: forecasts + picks + settled, parserVersion: `algo/${spec.spec_hash.slice(0, 12)}`, results: { fixtures: fixtures.length, forecasts, picks, holds: holds.map(h => ({ match_id: h.f.id, reason: h.reason })), settled, input_hash: hash, input_count: inputs.length } };
}
