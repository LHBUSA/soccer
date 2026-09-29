// SOCCER ALGO V1 — market validation + Official Pick policy protocol. DECLARED BEFORE ANY RESULT IN THIS
// PROTOCOL WAS COMPUTED (no pick-policy, threshold or secondary-market number for v1.2-dc exists yet).
// Data only; scripts/research/algo-v1-research.mjs records its sha256 at the SELECT stage and refuses to run
// the HOLDOUT stage if it changed.
//
// Disclosure (what is already known): the raw v1.2-dc 1X2 holdout metrics (Phases 3-4: log loss 0.9952,
// Brier 0.5938) and the Phase 1 independent-Poisson secondary-market holdout numbers. No v1.2-dc
// Over 2.5 / team-to-score / BTTS number and no selection-rule number on any split is known to anyone.
export const PROTOCOL = {
  id: 'soccer-algo-v1-pick-policy-protocol',
  declared_at: '2026-09-29',
  frozen_model: { id: 'soccer-research-bundesliga-v1.2-dc', card: 'docs/evidence/research/frozen/model-card-v1.2-dc.json', rho: -0.1099, prediction_hash: '19b72fedee9a60268c4d554d2c8e20adefa6e311b5c73cd7b654b5ff1dfbb13b', calibration: 'none (Phase 4 DEV selection)' },
  rows: 'identical to Phase 4: Bundesliga league-stage matches with a strict v1.1 prediction, seasons 2006/07 onward (2004/05-2005/06 warm-up); every prediction uses only matches that kicked off strictly before it',
  splits: { select: '2006/07-2018/19 (Phase 1-4 train + dev; 13 seasons)', holdout: '2019/20-2025/26 (7 seasons; evaluated ONCE for this protocol)', live: '2026/27 onward: prospective only' },
  probabilities: 'from the Dixon-Coles scoreline grid 0..10 x 0..10 (structural-core dcGrid, rho -0.1099), renormalised; no calibration',
  markets: {
    '1x2': { selections: ['home', 'draw', 'away'], selection_rule: 'argmax of the three probabilities', eligible_for_v1_picks: true },
    over_2_5: { selections: ['over', 'under'], event: 'home_score + away_score >= 3', selection_rule: 'over if P(over) >= 0.5 else under', eligible_for_v1_picks: true },
    home_to_score: { selections: ['yes', 'no'], event: 'home_score >= 1', selection_rule: 'yes if P >= 0.5 else no', eligible_for_v1_picks: true },
    away_to_score: { selections: ['yes', 'no'], event: 'away_score >= 1', selection_rule: 'yes if P >= 0.5 else no', eligible_for_v1_picks: true },
    btts: { selections: ['yes', 'no'], event: 'home_score >= 1 and away_score >= 1', selection_rule: 'yes if P >= 0.5 else no', eligible_for_v1_picks: false, note: 'market validation is reported for research; BTTS is NOT eligible for V1 Official Picks under this protocol whatever its numbers' },
  },
  baselines: {
    '1x2': 'train-set frequencies 2004/05-2013/14 (Phase 1, unchanged)',
    binary: 'train-set event rate 2004/05-2013/14 for the market event (constant prediction)',
  },
  market_validation: {
    metrics: ['log loss', 'Brier', 'per-season log loss and Brier', 'reliability (10 equal bins)'],
    gate_select: 'model beats its baseline on SELECT pooled log loss AND Brier, and on log loss in at least 11 of 13 SELECT seasons',
    gate_holdout: 'model beats its baseline on HOLDOUT pooled log loss AND Brier, and on log loss in at least 6 of 7 holdout seasons',
    eligible: 'a market can carry Official Picks only if it is eligible_for_v1_picks AND passes both gates',
  },
  pick_rule: {
    family: 'ONE rule family: an Official Pick is the market selection when its model probability >= t_market. Probability-gap rules, lambda-separation rules and uncertainty rules are NOT tested in V1 (fewer degrees of freedom).',
    grids: { '1x2': 't in 0.500, 0.525, ..., 0.800', binary: 't in 0.600, 0.625, ..., 0.900' },
    eligibility_on_select: {
      E1_coverage: 'qualifying picks >= 5% of SELECT matches',
      E2_calibration: '|pooled hit rate - mean model probability of the picks| <= 0.025',
      E3_durability: 'every SELECT season with >= 10 picks has hit rate >= its mean model probability - 0.10, and at most 2 such seasons have hit rate < mean model probability - 0.05',
      E4_floor: 'Wilson 95% lower bound of the pooled hit rate >= 0.50',
      E5_lift: 'pooled hit rate - baseline rate of the same selections >= 0.05 (baseline rate = train-set frequency of the selected outcome; picks must say more than the base rate)',
    },
    selection: 'for each market, the LOWEST eligible threshold on the grid (most picks subject to every gate). No eligible threshold -> the market carries no Official Picks in V1.',
  },
  per_match_policy: {
    official_pick: 'at most ONE Official Pick per match: among eligible markets whose selection meets its frozen threshold, the one with the largest (probability - threshold); ties by market order 1x2, over_2_5, home_to_score, away_to_score',
    game_best: 'every forecast match gets a GAME BEST: the selection with the largest (probability - threshold) among eligible markets, whether or not it qualifies; a non-qualifying Game Best is displayed as "did not meet the Algo Pick threshold" and never enters the record',
  },
  holdout_rule: {
    note: 'evaluated ONCE per selected market, and for the combined one-pick-per-match policy; thresholds are frozen from SELECT and never changed',
    H1_calibration: '|pooled hit rate - mean model probability| <= 0.04',
    H2_floor: 'Wilson 95% lower bound of the pooled hit rate >= 0.50',
    H3_lift: 'pooled hit rate - baseline rate of the same selections >= 0.03',
    H4_durability: 'at least 5 of the 7 holdout seasons with >= 10 picks have hit rate >= mean model probability - 0.08',
    pass: 'H1-H4 all pass -> the market is part of Soccer Algo V1; otherwise it is dropped from V1 (never re-tuned)',
  },
  forbidden: ['changing the model, rho, calibration or data', 'looking at any holdout pick number before the SELECT freeze is committed', 'adding rule families or grids after SELECT', 'odds, injuries, Player/Team DNA, event data (V2 challenger only)'],
};
