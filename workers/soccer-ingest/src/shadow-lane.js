// Private prospective shadow lane for the frozen research model soccer-research-bundesliga-v1.2-dc
// (owner approval 2026-09-28). BUNDESLIGA LEAGUE MATCHES ONLY. Never read by soccer-api.
//
// Each run (self-throttled to hourly):
//   1. issue: every scheduled Bundesliga league fixture kicking off within 7 days that has no
//      shadow row gets ONE prediction from the frozen model, using only finished Bundesliga league
//      results that kicked off strictly before predicted_at (so strictly before its own kickoff).
//      If any earlier league result is not yet available the fixture is HELD (never guessed).
//      The exact input set is archived write-once in R2 under its sha256 (input_hash).
//   2. settle: rows whose canonical match is finished get the canonical score, once.
//   3. missed: league matches that kicked off after the shadow started without a prediction.
//   4. metrics: a new append-only snapshot whenever the settled count changes.
// The database triggers (migration 0700) enforce first-issue immutability and write-once settlement.
import spec from './shadow-model.json' with { type: 'json' };
import { predictFrom, dc1x2 } from '../../../scripts/research/structural-core.mjs';
import { sha256Hex } from '../../shared/ids.js';
import { payloadKey } from '../../shared/archive.js';
import { shadowMetrics } from './shadow-metrics.js';
import { assertModelInputs } from './leakage-guard.js';

export const SHADOW_LANE = 'model_shadow_bundesliga_dc';
export const SHADOW_SPEC = spec;
const DAY = 864e5;
const CADENCE_MS = 55 * 60e3;
const NO_RESULT_EXPECTED = new Set(['postponed', 'cancelled', 'abandoned']);
const PRED_TABLE = 'soccer_model_shadow_predictions';
const EVENTS = 'soccer_model_shadow_events';

// Same order as the research snapshot: kickoff, then id.
export const modelMatch = m => ({ id: m.id, kickoff_at: new Date(m.kickoff_at).toISOString(), t: Date.parse(m.kickoff_at), home_team_id: m.home_team_id, away_team_id: m.away_team_id, home_score: m.home_score, away_score: m.away_score });
export const sortInputs = xs => [...xs].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
export const inputHash = inputs => sha256Hex(JSON.stringify(inputs.map(x => [x.id, x.kickoff_at, x.home_team_id, x.away_team_id, x.home_score, x.away_score])));

// Frozen model: team strengths are the model's normal time-safe rolling calculation over the
// inputs; rho, half-lives, shrinkage and min weight come from the card. No calibration.
export function predictShadow(inputs, target) {
  assertModelInputs(inputs, target); // leakage guard: no prediction-market field may reach the model
  const ts = spec.team_strength;
  const m = { t: Date.parse(target.kickoff_at), home_team_id: target.home_team_id, away_team_id: target.away_team_id };
  const p = predictFrom(inputs, 0, inputs.length, m, { hl: ts.half_life_days, shrink: ts.shrink, homeHl: spec.home_half_life_days, minWeight: ts.min_weight });
  if (!p) return null;
  const probs = dc1x2(p.lh, p.la, spec.rho);
  const indep = dc1x2(p.lh, p.la, 0);
  const x = p.parts;
  return {
    lambda_home: p.lh, lambda_away: p.la, probs,
    attribution: {
      model: `${spec.model_id} (calibration ${spec.calibration_id})`,
      formula: { lambda_home: 'league_home_rate * home_attack * away_defence', lambda_away: 'league_away_rate * away_attack * home_defence', scorelines: 'independent Poisson x Dixon-Coles tau(rho) on 0-0, 1-0, 0-1, 1-1' },
      league_goal_level: x.mu, league_home_rate: x.muH, league_away_rate: x.muA,
      home_attack: x.attH, home_defence: x.defH, away_attack: x.attA, away_defence: x.defA,
      lambda_home: p.lh, lambda_away: p.la,
      dixon_coles: { rho: spec.rho, independent_poisson_1x2: indep, corrected_1x2: probs, draw_shift: probs[1] - indep[1] },
      recency: `inputs weighted by a ${spec.team_strength.half_life_days}-day half-life (no separate form feature)`,
      not_model_inputs: ['form score', 'Player DNA', 'Team DNA', 'injuries', 'transfers', 'market odds'],
    },
  };
}

async function bundesligaScope(store) {
  const [comp] = await store.select('soccer_competitions', { columns: ['id'], eq: { slug: spec.scope.competition_slug }, limit: 1 });
  if (!comp) throw new Error('bundesliga competition missing');
  const seasons = await store.select('soccer_seasons', { columns: ['id', 'label'], eq: { competition_id: comp.id }, order: 'label.asc' });
  const stages = await store.select('soccer_stages', { columns: ['id', 'stage_type', 'season_id'], in: { season_id: seasons.map(s => s.id) }, order: 'id.asc' });
  return { competitionId: comp.id, seasonLabel: Object.fromEntries(seasons.map(s => [s.id, s.label])), leagueStages: new Set(stages.filter(s => s.stage_type === spec.scope.stage_type).map(s => s.id)) };
}

export async function runShadow(ctx) {
  const { store, storage, now = Date.now(), force = false, state = {} } = ctx;
  if (!force && state.last_success_at && now - Date.parse(state.last_success_at) < CADENCE_MS) return { skipped: 'cadence' };
  const nowIso = new Date(now).toISOString();
  const MODEL = spec.model_id;
  const events = [];

  let [started] = await store.select(EVENTS, { columns: ['at'], eq: { model_id: MODEL, event: 'started' }, order: 'at.asc', limit: 1 });
  if (!started) { events.push({ model_id: MODEL, match_id: null, event: 'started', reason: null, detail: { model_hash: spec.model_hash, spec } }); started = { at: nowIso }; }
  const startedAt = Date.parse(started.at);

  const { competitionId, seasonLabel, leagueStages } = await bundesligaScope(store);
  const window = (5 * spec.team_strength.half_life_days + 2) * DAY;
  const matches = await store.select('soccer_matches', {
    columns: ['id', 'competition_id', 'season_id', 'stage_id', 'kickoff_at', 'status', 'home_team_id', 'away_team_id', 'home_score', 'away_score'],
    eq: { competition_id: competitionId }, gte: { kickoff_at: new Date(now - window).toISOString() }, lte: { kickoff_at: new Date(now + spec.eligibility.window_days * DAY).toISOString() }, order: 'kickoff_at.asc,id.asc',
  });
  const league = matches.filter(m => leagueStages.has(m.stage_id));
  const past = league.filter(m => Date.parse(m.kickoff_at) < now);
  const unavailable = past.filter(m => !NO_RESULT_EXPECTED.has(m.status) && (m.status !== 'finished' || m.home_score === null || m.away_score === null));
  const inputs = sortInputs(past.filter(m => m.status === 'finished' && m.home_score !== null && m.away_score !== null).map(modelMatch));
  const fixtures = matches.filter(m => m.status === 'scheduled' && Date.parse(m.kickoff_at) > now);
  const existing = fixtures.length ? await store.select(PRED_TABLE, { columns: ['match_id'], eq: { model_id: MODEL }, in: { match_id: fixtures.map(f => f.id) }, order: 'match_id.asc' }) : [];
  const have = new Set(existing.map(r => r.match_id));

  const hash = inputs.length ? inputHash(inputs) : null;
  const asOf = inputs.length ? inputs.at(-1).kickoff_at : null;
  const issued = []; const holds = [];
  for (const f of fixtures) {
    if (have.has(f.id)) continue;
    if (!leagueStages.has(f.stage_id)) { holds.push({ f, reason: 'not_league_stage' }); continue; }
    if (unavailable.length) { holds.push({ f, reason: 'prior_result_unavailable', detail: { matches: unavailable.slice(0, 10).map(m => ({ id: m.id, kickoff_at: m.kickoff_at, status: m.status })) } }); continue; }
    if (!inputs.length || !(Date.parse(asOf) < now)) { holds.push({ f, reason: 'no_time_safe_inputs' }); continue; }
    const pred = predictShadow(inputs, f);
    if (!pred) { holds.push({ f, reason: 'insufficient_history' }); continue; }
    issued.push({
      model_id: MODEL, model_version: spec.model_version, calibration_id: spec.calibration_id,
      competition_id: f.competition_id, season_id: f.season_id, match_id: f.id,
      predicted_at: nowIso, kickoff_at: new Date(f.kickoff_at).toISOString(),
      p_home: pred.probs[0], p_draw: pred.probs[1], p_away: pred.probs[2], lambda_home: pred.lambda_home, lambda_away: pred.lambda_away, rho: spec.rho,
      input_hash: hash, model_hash: spec.model_hash, input_as_of: asOf, input_count: inputs.length, attribution: pred.attribution,
    });
  }
  if (issued.length && storage) {
    const key = payloadKey('model_shadow_inputs', hash);
    if (!(await storage.head(key))) await storage.put(key, JSON.stringify({ model_id: MODEL, model_hash: spec.model_hash, input_hash: hash, input_as_of: asOf, first_used_at: nowIso, columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'home_score', 'away_score'], inputs: inputs.map(x => [x.id, x.kickoff_at, x.home_team_id, x.away_team_id, x.home_score, x.away_score]) }), 'application/json');
  }
  let inserted = 0;
  for (const row of issued) {
    try { await store.insert(PRED_TABLE, [row]); inserted += 1; events.push({ model_id: MODEL, match_id: row.match_id, event: 'issued', reason: null, detail: { predicted_at: row.predicted_at, kickoff_at: row.kickoff_at, input_hash: hash, input_count: row.input_count } }); }
    catch (err) { holds.push({ f: { id: row.match_id }, reason: 'insert_rejected', detail: { error: String(err.message || err).slice(0, 300) } }); }
  }
  // Holds are operational evidence; one event per (match, reason).
  if (holds.length) {
    const prev = await store.select(EVENTS, { columns: ['match_id', 'reason'], eq: { model_id: MODEL, event: 'hold' }, in: { match_id: [...new Set(holds.map(h => h.f.id))] }, order: 'match_id.asc' });
    const seen = new Set(prev.map(p => `${p.match_id}|${p.reason}`));
    for (const h of holds) if (!seen.has(`${h.f.id}|${h.reason}`)) { seen.add(`${h.f.id}|${h.reason}`); events.push({ model_id: MODEL, match_id: h.f.id, event: 'hold', reason: h.reason, detail: h.detail || {} }); }
  }

  // Settlement: write once, canonical score only, after the canonical match is final.
  const open = (await store.select(PRED_TABLE, { columns: ['id', 'match_id', 'kickoff_at', 'settled_at'], eq: { model_id: MODEL }, is: { settled_at: null }, order: 'kickoff_at.asc' })).filter(r => Date.parse(r.kickoff_at) < now);
  let settled = 0;
  if (open.length) {
    const final = await store.select('soccer_matches', { columns: ['id', 'status', 'home_score', 'away_score'], in: { id: open.map(r => r.match_id) }, order: 'id.asc' });
    const byId = new Map(final.map(m => [m.id, m]));
    for (const r of open) {
      const m = byId.get(r.match_id);
      if (!m || m.status !== 'finished' || m.home_score === null || m.away_score === null) continue;
      const outcome = m.home_score > m.away_score ? 'home' : m.home_score === m.away_score ? 'draw' : 'away';
      await store.update(PRED_TABLE, { home_score: m.home_score, away_score: m.away_score, outcome, settled_at: nowIso }, { eq: { id: r.id } });
      settled += 1;
      events.push({ model_id: MODEL, match_id: r.match_id, event: 'settled', reason: null, detail: { home_score: m.home_score, away_score: m.away_score, outcome } });
    }
  }

  // Missed / late: league matches that kicked off after the shadow started without a prediction.
  const kicked = league.filter(m => Date.parse(m.kickoff_at) >= startedAt && Date.parse(m.kickoff_at) <= now && !NO_RESULT_EXPECTED.has(m.status));
  const rows = await store.select(PRED_TABLE, { columns: ['match_id', 'season_id', 'predicted_at', 'kickoff_at', 'p_home', 'p_draw', 'p_away', 'outcome', 'settled_at'], eq: { model_id: MODEL }, order: 'kickoff_at.asc,match_id.asc' });
  const predicted = new Set(rows.map(r => r.match_id));
  const missedNow = kicked.filter(m => !predicted.has(m.id));
  const missedPrev = await store.select(EVENTS, { columns: ['match_id'], eq: { model_id: MODEL, event: 'missed' }, order: 'match_id.asc' });
  const missedSeen = new Set(missedPrev.map(e => e.match_id));
  for (const m of missedNow) if (!missedSeen.has(m.id)) { missedSeen.add(m.id); events.push({ model_id: MODEL, match_id: m.id, event: 'missed', reason: 'kicked_off_without_prediction', detail: { kickoff_at: m.kickoff_at } }); }
  if (events.length) await store.insert(EVENTS, events.map(e => ({ ...e, at: nowIso })));

  // Metrics snapshot whenever the settled count changes (append-only; one row per count).
  const settledCount = rows.filter(r => r.settled_at).length;
  const [last] = await store.select('soccer_model_shadow_metrics', { columns: ['settled_count'], eq: { model_id: MODEL }, order: 'settled_count.desc', limit: 1 });
  let snapshot = false;
  if (settledCount > 0 && (!last || last.settled_count !== settledCount)) {
    const metrics = shadowMetrics({ rows, seasonLabel, missed: missedSeen.size, baseline: spec.baseline, now });
    await store.insert('soccer_model_shadow_metrics', [{ model_id: MODEL, settled_count: settledCount, computed_at: nowIso, metrics: { ...metrics, model_hash: spec.model_hash } }]);
    snapshot = true;
  }
  return {
    observed: fixtures.length, changed: inserted + settled, parserVersion: `shadow/${spec.model_hash.slice(0, 12)}`,
    results: { eligible_fixtures: fixtures.length, already_issued: existing.length, issued: inserted, holds: holds.map(h => ({ match_id: h.f.id, reason: h.reason })), settled, missed: missedSeen.size, predictions: rows.length, settled_total: settledCount, metrics_snapshot: snapshot, input_hash: hash, input_count: inputs.length, input_as_of: asOf },
  };
}
