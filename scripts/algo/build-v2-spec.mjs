#!/usr/bin/env node
// Builds the frozen Soccer Algo V2 spec (workers/soccer-ingest/src/algo-v2.json) and the public research summary
// (workers/soccer-api/src/algo-v2-research.json) ONLY from committed research evidence:
//   scripts/research/algo-v2-protocol.mjs (pre-registered), docs/evidence/research/algo-v2/select-freeze.json,
//   docs/evidence/research/algo-v2/holdout-results.json, scripts/research/national-core.mjs (model code).
// status is decided by the evidence, never by hand:
//   official  at least one market passed H0-H5 (Official Picks for those markets only)
//   forecast  the 1X2 display gate passed (SELECT + HOLDOUT market validation) but no market passed H0-H5
//   shadow    the display gate failed: nothing public but the research
//   node scripts/algo/build-v2-spec.mjs [--check]   (--check: fail if the committed files differ)
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { PROTOCOL } from '../research/algo-v2-protocol.mjs';

const sha = b => createHash('sha256').update(b).digest('hex');
const R = 'docs/evidence/research/algo-v2';
const freezeRaw = readFileSync(`${R}/select-freeze.json`); const freeze = JSON.parse(freezeRaw);
const holdRaw = readFileSync(`${R}/holdout-results.json`); const hold = JSON.parse(holdRaw);
const protocolSha = sha(readFileSync('scripts/research/algo-v2-protocol.mjs'));
if (freeze.protocol_sha256 !== protocolSha || hold.protocol_sha256 !== protocolSha) throw new Error('protocol changed after the research');
if (hold.select_freeze_sha256 !== freeze.freeze_sha256) throw new Error('holdout does not reference this SELECT freeze');
const codeSha = sha(readFileSync('scripts/research/national-core.mjs'));
const active = Object.fromEntries(hold.v2_markets.map(x => [x.market, { threshold: x.threshold }]));
const status = hold.v2_markets.length ? 'official' : hold.display_gate.pass ? 'forecast' : 'shadow';
const status_reason = status === 'official' ? `Markets passing the pre-registered holdout gate: ${hold.v2_markets.map(x => `${x.market} >= ${x.threshold}`).join(', ')}.`
  : status === 'forecast' ? 'The 1X2 market beat its baseline on SELECT and HOLDOUT (display gate), but no market passed the Official Pick holdout gate (H0-H5): Game Best forecasts only, labelled MODEL FORECAST — NOT OFFICIAL PICK.'
    : 'The 1X2 market did not beat its baseline on both SELECT and HOLDOUT (display gate failed): V2 stays a private shadow; nothing but the research is public.';
const TOP = { '1x2': 0.8, over_2_5: 0.9, home_to_score: 0.9, away_to_score: 0.9 };
const model = { id: PROTOCOL.model.id, version: '2.0.0', half_life_days: freeze.chosen.half_life_days, shrink_k: freeze.chosen.shrink_k, rho: freeze.chosen.rho, calibration: 'none', code: { path: 'scripts/research/national-core.mjs', sha256: codeSha } };
model.model_hash = sha(JSON.stringify({ id: model.id, hl: model.half_life_days, k: model.shrink_k, rho: model.rho, code: codeSha }));
const spec = {
  algo_version: PROTOCOL.algo_version, name: 'Soccer Algo V2 (International)', profile: 'national_team_group', status, status_reason,
  model,
  research: { protocol: { path: 'scripts/research/algo-v2-protocol.mjs', sha256: protocolSha }, dataset_sha256: freeze.dataset_sha256, select_freeze: { path: `${R}/select-freeze.json`, freeze_sha256: freeze.freeze_sha256, prediction_hash: freeze.prediction_hash }, holdout: { path: `${R}/holdout-results.json`, sha256: sha(holdRaw), evaluated_at: hold.evaluated_at }, display_gate: hold.display_gate },
  pick_policy: {
    version: 'soccer-algo-v2-pick-policy/1.0', markets: active, market_order: ['1x2', 'over_2_5', 'home_to_score', 'away_to_score'],
    game_best_thresholds: Object.fromEntries(Object.entries(TOP).map(([m, t]) => [m, active[m]?.threshold ?? freeze.markets[m]?.selected_threshold ?? t])),
    rule: PROTOCOL.per_match_policy.official_pick + ' Game Best: ' + PROTOCOL.per_match_policy.game_best,
  },
  competition_scope: { competition_slug: 'uefa-nations-league', stage_type: 'league' },
  input_competitions: ['uefa-nations-league', 'fifa-world-cup'],
  input_contract: PROTOCOL.live_contract.inputs,
  lead_time: { issue_window_days: 7, lock_minutes_before_kickoff: 60, rule: PROTOCOL.live_contract.lead_time },
  settlement: { finished: 'graded from the canonical final score (soccer_algo_grade)', postponed: 'stays pending; void if the canonical kickoff moved by more than 48 h', cancelled: 'void', abandoned: 'void' },
  prices: 'none: no sportsbook price is captured, so ROI, units and CLV are unavailable; no default odds.',
  no_backfill: PROTOCOL.live_contract.no_backfill,
};
spec.spec_hash = sha(JSON.stringify(spec));
const pm = m => { const x = hold.markets[m]; const f = freeze.markets[m]; return { market: m, gate_select: f.gate_select, gate_holdout: x.gate_holdout, log_loss_holdout: x.validation_holdout.log_loss, baseline_log_loss_holdout: x.validation_holdout.baseline_log_loss, brier_holdout: x.validation_holdout.brier, baseline_brier_holdout: x.validation_holdout.baseline_brier, selected_threshold: f.selected_threshold, holdout_picks: x.picks_holdout ? { picks: x.picks_holdout.picks, hit_rate: x.picks_holdout.hit_rate, mean_probability: x.picks_holdout.mean_prob, wilson_lo: x.picks_holdout.wilson_lo, baseline_rate: x.picks_holdout.baseline_rate } : null, holdout_rule: x.holdout_rule || null, active: !!active[m] }; };
const researchOut = {
  algo_version: spec.algo_version, status, status_reason, protocol_sha256: protocolSha, select_freeze_sha256: freeze.freeze_sha256, holdout_evaluated_at: hold.evaluated_at,
  disclaimer: 'MODEL RESEARCH on past national-team seasons. Not a track record: no pick here was issued before its match. The V2 public record starts with the first V2 Official Pick after activation.',
  data: { source: 'ESPN Core (owner-approved secondary source), archived captures', rows: freeze.dataset_rows, splits: PROTOCOL.splits, primary_population: PROTOCOL.populations.primary },
  model: { half_life_days: model.half_life_days, shrink_k: model.shrink_k, rho: model.rho, home_effect_select: freeze.home_effect_select, home_effect_holdout: hold.home_effect_holdout },
  select: { rows: freeze.rows.select_primary_predicted, combined: freeze.combined_select }, holdout: { rows: hold.rows.holdout_primary, combined: hold.combined_holdout_v2_markets, secondary_all_national: { rows: hold.secondary_holdout.rows, log_loss_1x2: hold.secondary_holdout.validation_1x2.log_loss, baseline: hold.secondary_holdout.validation_1x2.baseline_log_loss } },
  markets: ['1x2', 'over_2_5', 'home_to_score', 'away_to_score'].map(pm),
};
const outSpec = `${JSON.stringify(spec, null, 2)}\n`; const outRes = `${JSON.stringify(researchOut, null, 2)}\n`;
if (process.argv.includes('--check')) {
  if (readFileSync('workers/soccer-ingest/src/algo-v2.json', 'utf8') !== outSpec || readFileSync('workers/soccer-api/src/algo-v2-research.json', 'utf8') !== outRes) throw new Error('committed V2 spec differs from the evidence');
  console.log('algo-v2 spec reproduced from evidence', spec.spec_hash);
} else {
  writeFileSync('workers/soccer-ingest/src/algo-v2.json', outSpec); writeFileSync('workers/soccer-api/src/algo-v2-research.json', outRes);
  console.log('status', status, 'spec', spec.spec_hash, JSON.stringify(active));
}
