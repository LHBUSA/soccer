// PREMIER LEAGUE MODEL RESEARCH — PRE-REGISTERED PROTOCOL (phase 1). DECLARED AND COMMITTED BEFORE ANY RESULT IN
// THIS PROTOCOL WAS COMPUTED: no Premier League model number on any split exists yet (2026-10-03).
// Research only: nothing here produces a live model, a pick or a public number. Owner brief 2026-10-03.
// scripts/research/pl-research.mjs records this file's sha256 at the SELECT stage and refuses to run the HOLDOUT stage
// if it changed. Data only.
export const PROTOCOL = {
  id: 'soccer-pl-research-phase1',
  competition: 'premier-league',
  data: {
    source: 'canonical soccer_matches (league stage, status finished, both scores) of PUBLISHED Premier League seasons only',
    excluded_seasons: {
      '2009/10': 'HELD: 357/380 canonical (all 23 missing pairings involve Burnley; ESPN catalog gap). Not an input, not evaluated.',
      '2026/27': 'live season in progress: not used in phase 1',
    },
    gap_handling: '2009/10 is absent: 2010/11 features rest on 2008/09 and earlier (Elo season carry is applied once across the gap; Poisson weights decay with real elapsed time). Declared limitation, no imputation.',
    warmup: ['2001/02'],
    leakage: 'strict: every feature for match m uses only matches that kicked off strictly before m (model-core strict=true). No odds of any kind, no closing prices, no lineups, nothing from match m itself.',
  },
  splits: {
    warmup: '2001/02 (features only, never evaluated)',
    train: '2002/03 .. 2012/13 (fit mapping parameters: ordered-logit thresholds, Dixon-Coles rho)',
    dev: '2013/14 .. 2018/19 (choose each model family\'s hyperparameters by 1X2 log loss)',
    holdout: '2019/20 .. 2025/26 (evaluated ONCE, season by season, after the select freeze is committed)',
  },
  markets: { primary: '1x2', secondary: ['over_2_5', 'home_to_score', 'away_to_score', 'btts'] },
  models: {
    B0: 'baseline: train-split outcome frequencies (1X2) and event rates (binary markets)',
    M1_elo: { family: 'Elo rating difference -> ordered logit (model-core eloSeries + fitOlogit, fit on train)', grid: { K: [10, 15, 20, 30], home_edge: [40, 60, 80, 100] }, carry: 2 / 3 },
    M2_poisson: { family: 'time-decayed Poisson team attack/defence strengths, strict (model-core poissonSeries)', grid: { half_life_days: [270, 365, 540, 730], shrink: [5, 10, 20] } },
    M3_poisson_dc: { family: 'M2 lambdas with Dixon-Coles low-score dependence; rho fit on train (structural-core fitRho) at M2\'s dev-chosen hyperparameters', grid: {} },
  },
  selection: 'For each family, the grid point with the lowest DEV 1X2 log loss. Ties: earlier grid order. Then ONE candidate = the family with the lowest dev 1X2 log loss among M1, M2, M3. Nothing is chosen on the holdout.',
  metrics: ['log_loss', 'brier (multiclass for 1X2)', 'accuracy', 'ECE per class (10 bins)', 'reliability bins', 'per-season log loss'],
  pass_rule: 'The selected candidate PASSES phase 1 only if on the HOLDOUT it beats B0 on pooled 1X2 log loss AND Brier, and beats B0 on log loss in at least 5 of the 7 holdout seasons. M1/M2/M3 holdout numbers are reported for transparency but only the pre-selected candidate is judged.',
  not_in_phase_1: 'Rest/schedule (only the Premier League schedule is canonical: cup and European fixtures are missing, so rest days would be wrong), table/season context, opponent-adjusted form beyond the strength models, lineups (no as-of lineup data for history). Each may be a phase-2 increment, pre-registered separately and judged on dev only.',
  prices: 'No archived odds exist for these seasons: no ROI, units, CLV or edge claim of any kind. Null stays null.',
};
