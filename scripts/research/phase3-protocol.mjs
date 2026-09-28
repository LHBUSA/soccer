// Phase 3 structural research protocol. DECLARED BEFORE ANY PHASE 3 RESULT (DEV or holdout) WAS
// COMPUTED. This file is data only; structural-research.mjs records its sha256 at the DEV stage and
// refuses to run the holdout stage if it changed. Do not edit after the DEV stage is committed.
export const PROTOCOL = {
  id: 'soccer-structural-phase3-protocol-v1',
  declared_at: '2026-09-28',
  reference: 'A = soccer-research-bundesliga-v1-frozen, strict v1.1 Poisson (model-core.mjs, strict: true). Frozen; not modified.',
  splits: { train: '2004/05-2013/14', dev: '2014/15-2018/19', holdout: '2019/20-2025/26' },
  candidates: {
    A: 'frozen Poisson v1.1: lambda_home = muH * att_home * def_away, lambda_away = muA * att_away * def_home; every term a 540-day half-life, strictly-before-kickoff weighted average; independent Poisson scorelines',
    B: 'A + Dixon-Coles low-score dependence: P(i,j) = tau(i,j) * Pois(i; lh) * Pois(j; la), tau(0,0) = 1 - lh*la*rho, tau(0,1) = 1 + lh*rho, tau(1,0) = 1 + la*rho, tau(1,1) = 1 - rho, otherwise 1 (Dixon & Coles 1997); tau clamped at 0, grid 0..10 goals renormalised; lambdas identical to A',
    C: 'A with an adaptive league home advantage: league goal level mu and every team attack/defence ratio unchanged (540 d); the home share of league goals s uses its own half-life h (window 5h): muH = 2*mu*s, muA = 2*mu*(1-s). h = 540 reproduces A exactly',
    D: 'B + the adaptive league home advantage of C (rho re-fitted for the D lambdas)',
  },
  selection: {
    team_strength: 'half-life 540 d, shrink 10, window 5 half-lives, min weight 50: frozen from Phase 1, not re-selected',
    B_rho: 'maximum DEV scoreline log-likelihood (the Dixon-Coles objective) with A lambdas fixed; rho grid [-0.30, 0.15] step 0.0025, then refined to 0.0001 around the best grid point',
    C_home_half_life: 'grid {90, 180, 270, 365, 540} days; argmin DEV 1X2 log loss; if no candidate beats 540 (= A) by more than 0.0005, 540 is selected (no change)',
    D: 'for each home half-life in the same grid, rho re-fitted by DEV scoreline likelihood on those lambdas; argmin DEV 1X2 log loss; if no candidate beats 540 (= B) by more than 0.0005, 540 is selected (D = B, no change)',
    final_candidate: 'D if D is KEEP; otherwise the KEEP component among B and C with the lower DEV 1X2 log loss; none if no component is KEEP',
    holdout_may_not_influence: ['Dixon-Coles rho', 'any decay / half-life', 'model selection', 'calibration selection', 'acceptance thresholds'],
  },
  comparisons: { B: ['A'], C: ['A'], D: ['B', 'C'] },
  keep_rule: {
    note: 'Evaluated on the pooled 2019/20-2025/26 holdout for candidate X vs reference R (delta = X - R). D must pass against BOTH B and C; its verdict is the worse of the two.',
    K1_log_loss: 'pooled 1X2 log loss delta <= -0.0005 -> pass; -0.0005 < delta < 0 -> INCONCLUSIVE; delta >= 0 -> REJECT',
    K2_brier: 'pooled Brier delta <= +0.0005 -> pass; +0.0005 < delta <= +0.002 -> INCONCLUSIVE; delta > +0.002 -> REJECT',
    K3_targeted_fix: 'Dixon-Coles comparisons (B vs A, D vs C): |pooled draw bias| AND draw classwise ECE both decrease. Home comparisons (C vs A, D vs B): the standard deviation across the 7 holdout seasons of the home-win bias decreases. Fail -> INCONCLUSIVE',
    K4_durability: 'seasons with log loss delta > +0.002: at most 1 (2+ -> REJECT); seasons with log loss delta < 0: at least 4 of 7 (fewer -> INCONCLUSIVE)',
    K5_not_one_season: 'the pooled log loss delta stays < 0 after removing the single most-improved season (else INCONCLUSIVE)',
    K6_ranking: 'one-vs-rest AUC change < 0.005 for home, draw and away; favourite accuracy change < 1 point; top-10% confidence accuracy not lower by more than 2 points (any failure -> REJECT)',
    dev_no_change: 'a component whose DEV selection is the no-change value (C or D at 540) is REJECT',
    verdict: 'KEEP only if K1-K6 all pass; REJECT if any REJECT condition fires; otherwise INCONCLUSIVE',
  },
  overall: {
    leakage: 'every leakage test must pass; any failure -> MORE RESEARCH (run invalid until fixed)',
    baseline: 'the final candidate must beat the train-frequency baseline in every holdout season on log loss and Brier, else REJECT',
    STRUCTURAL_MODEL_READY_FOR_CALIBRATION: 'a final candidate exists and passes the leakage and baseline conditions',
    MORE_RESEARCH: 'no component is KEEP and at least one is INCONCLUSIVE',
    REJECT: 'every component is REJECT (frozen v1.1 stays the reference; the structural hypotheses are rejected)',
  },
  forbidden: ['Platt, temperature, vector, matrix, isotonic or rolling calibration', 'new team or player features', 'Player DNA / Team DNA inputs', 'market data', 'any production change'],
};
