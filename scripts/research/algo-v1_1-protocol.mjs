// SOCCER ALGO V1 — pick-policy protocol v1.1. DECLARED BEFORE ANY HOLDOUT NUMBER FOR ANY PICK POLICY WAS
// COMPUTED. Supersedes algo-v1-protocol.mjs (v1.0) for the holdout; v1.0 and its SELECT freeze stay committed.
//
// DISCLOSURE — why v1.1 exists and what was known when it was written:
//   v1.0's SELECT stage (docs/evidence/research/algo-v1/select-freeze.json, commit 496a04e) was computed and
//   READ before this file was written. Under v1.0 the combined policy picked 65% of SELECT matches: v1.0's
//   calibration gate was two-sided and rejected thresholds where the model UNDER-states its probability (a
//   conservative error), and its 5-point lift gate admitted picks barely above the base rate (home to score
//   YES at a 79% base rate). The owner directed a revision (2026-09-29) toward selective Official Picks.
//   v1.1 therefore (a) makes calibration one-sided, (b) raises the lift requirement to 10 points and
//   (c) caps the combined policy at 20% of SELECT matches. Everything else is v1.0 unchanged: model, data,
//   markets, market-validation gates, the single rule family, the grids, one pick per match, Game Best.
//   The holdout (2019/20-2025/26) has not been evaluated for any pick policy; it is evaluated ONCE, under v1.1.
import { PROTOCOL as V10 } from './algo-v1-protocol.mjs';

export const PROTOCOL = {
  ...V10,
  id: 'soccer-algo-v1-pick-policy-protocol-v1.1',
  declared_at: '2026-09-29',
  supersedes: { id: V10.id, commit: '05ff308', select_freeze_commit: '496a04e' },
  params: {
    calibration: 'one_sided', cal_tol: 0.025, lift_min: 0.10, coverage_min: 0.05, max_combined_coverage: 0.20,
    holdout: { calibration: 'one_sided', cal_tol: 0.04, lift_min: 0.08 },
  },
  pick_rule: {
    ...V10.pick_rule,
    eligibility_on_select: {
      E1_coverage: 'qualifying picks >= 5% of SELECT matches',
      E2_calibration: 'ONE-SIDED: pooled hit rate >= mean model probability of the picks - 0.025 (a pick may not overstate its probability; understatement is allowed)',
      E3_durability: 'every SELECT season with >= 10 picks has hit rate >= its mean model probability - 0.10, and at most 2 such seasons have hit rate < mean model probability - 0.05',
      E4_floor: 'Wilson 95% lower bound of the pooled hit rate >= 0.50',
      E5_lift: 'pooled hit rate - baseline rate of the same selections >= 0.10',
    },
    selection: 'markets in protocol order (1x2, over_2_5, home_to_score, away_to_score). For each market that passed the SELECT validation gate: the LOWEST eligible threshold such that the combined one-pick-per-match policy over the markets chosen so far covers <= 20% of SELECT matches. If no eligible threshold keeps the combined coverage <= 20%, the market carries no Official Picks in V1.',
  },
  holdout_rule: {
    note: 'evaluated ONCE per selected market and for the combined policy; thresholds frozen from SELECT',
    H1_calibration: 'ONE-SIDED: pooled hit rate >= mean model probability - 0.04',
    H2_floor: 'Wilson 95% lower bound of the pooled hit rate >= 0.50',
    H3_lift: 'pooled hit rate - baseline rate of the same selections >= 0.08',
    H4_durability: 'at least 5 of the 7 holdout seasons with >= 10 picks have hit rate >= mean model probability - 0.08',
    pass: 'H1-H4 all pass -> the market is part of Soccer Algo V1; otherwise it is dropped (never re-tuned)',
  },
};
