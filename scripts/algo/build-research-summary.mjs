// Soccer Algo V1 — HISTORICAL VALIDATION summary for the public API, derived ONLY from the committed research
// evidence (select-freeze.json + holdout-results.json, both sha-pinned by the frozen spec). Nothing here is a
// track record: the public record is the Official Pick ledger, which starts empty at go-live.
//   node scripts/algo/build-research-summary.mjs          -> writes workers/soccer-api/src/algo-research.json
//   node scripts/algo/build-research-summary.mjs --check  -> fails if the committed summary is stale
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const ROOT = new URL('../../', import.meta.url);
const OUT = new URL('workers/soccer-api/src/algo-research.json', ROOT);
const read = p => readFileSync(new URL(p, ROOT));
const sha = b => createHash('sha256').update(b).digest('hex');

const spec = JSON.parse(read('workers/soccer-ingest/src/algo-v1.json'));
const holdoutBuf = read(spec.pick_policy.holdout.path);
if (sha(holdoutBuf) !== spec.pick_policy.holdout.sha256) throw new Error('holdout evidence does not match the frozen spec');
const holdout = JSON.parse(holdoutBuf);
const select = JSON.parse(read(spec.pick_policy.select_freeze.path));
if (select.freeze_sha256 !== spec.pick_policy.select_freeze.freeze_sha256 || holdout.select_freeze_sha256 !== select.freeze_sha256) throw new Error('select freeze does not match the frozen spec');

const pickStats = p => p && { threshold: p.threshold, picks: p.picks, coverage: p.coverage, hits: p.hits, hit_rate: p.hit_rate, mean_probability: p.mean_prob, wilson_lower_95: p.wilson_lo, per_season: p.per_season.map(s => ({ season: s.season, picks: s.picks, hit_rate: s.hit_rate, mean_probability: s.mean_prob })) };
const validation = v => ({ matches: v.n, log_loss: v.log_loss, baseline_log_loss: v.baseline_log_loss, brier: v.brier, baseline_brier: v.baseline_brier, seasons_beating_baseline: v.seasons_beating_baseline_log_loss, seasons: v.seasons });
const selectedAt = (m, t) => m.thresholds?.find(x => x.threshold === t);

const markets = Object.fromEntries(Object.entries(holdout.markets).map(([k, h]) => {
  const s = select.markets[k];
  const official = Boolean(spec.pick_policy.markets[k]);
  return [k, {
    official_market: official,
    select_reason: s.reason,
    validation_holdout: validation(h.validation_holdout),
    ...(official ? { select_picks: pickStats(selectedAt(s, s.selected_threshold)), holdout_picks: pickStats(h.picks_holdout) } : {}),
  }];
}));
const combined = c => ({ matches: c.matches, official_picks: c.official_picks, coverage: c.coverage, hit_rate: c.hit_rate, mean_probability: c.mean_prob, wilson_lower_95: c.wilson_lo, by_market: c.by_market });

const summary = {
  label: 'HISTORICAL VALIDATION',
  disclaimer: 'Model research on past seasons, evaluated after the fact under a pre-registered protocol. Not picks, not a track record, and never counted in the Official Pick record.',
  algo_version: spec.algo_version,
  spec_hash: spec.spec_hash,
  model_hash: spec.model.model_hash,
  pick_policy_version: spec.pick_policy.version,
  protocol_sha256: holdout.protocol_sha256,
  select_freeze_sha256: holdout.select_freeze_sha256,
  holdout_sha256: spec.pick_policy.holdout.sha256,
  holdout_evaluated_at: holdout.evaluated_at,
  select: { seasons: select.rows.seasons, matches: select.rows.select, combined: combined(select.combined_select) },
  holdout: { seasons: holdout.rows.seasons, matches: holdout.rows.holdout, combined: combined(holdout.combined_holdout_v1_markets) },
  markets,
  prices: 'No sportsbook prices exist for these seasons in the research data: no ROI, units or CLV are stated.',
};
const text = `${JSON.stringify(summary, null, 2)}\n`;
if (process.argv.includes('--check')) {
  const cur = readFileSync(OUT, 'utf8');
  if (cur !== text) { console.error('algo-research.json is stale: run node scripts/algo/build-research-summary.mjs'); process.exit(1); }
  console.log('algo research summary ok', sha(text).slice(0, 8));
} else {
  writeFileSync(OUT, text);
  console.log('wrote', OUT.pathname, sha(text).slice(0, 8));
}
