// Phase 4 calibration protocol for the frozen Dixon-Coles model. DECLARED BEFORE ANY PHASE 4 RESULT
// (DEV or holdout) WAS COMPUTED. Data only; calibration-v12-research.mjs records its sha256 at the DEV
// stage and refuses to run the holdout stage if it changed.
// Disclosure: the RAW v1.2-dc holdout metrics are already known from Phase 3 (log loss 0.9952, Brier
// 0.5938, ECE 0.0171, bias +1.28/-0.51/-0.78). No calibrated holdout number is known to anyone.
export const PROTOCOL = {
  id: 'soccer-calibration-phase4-protocol-v1',
  declared_at: '2026-09-28',
  frozen_model: { id: 'soccer-research-bundesliga-v1.2-dc', card: 'docs/evidence/research/frozen/model-card-v1.2-dc.json', rho: -0.1099, prediction_hash: '19b72fedee9a60268c4d554d2c8e20adefa6e311b5c73cd7b654b5ff1dfbb13b' },
  splits: { train: '2004/05-2013/14', dev: '2014/15-2018/19', holdout: '2019/20-2025/26' },
  calibrators: {
    note: 'every calibrator maps the raw log-probabilities l = log p to logits z = W l + b and returns softmax(z): outputs are always valid home/draw/away probabilities summing to 1. Home is the reference class for intercepts.',
    none: 'identity (raw v1.2-dc)',
    temperature: '1 parameter: z = l / T',
    bias: '2 parameters: z = l + (0, b_draw, b_away)',
    vector: '5 parameters: z = diag(w_h, w_d, w_a) l + (0, b_draw, b_away)',
    matrix: '11 parameters: z = W l + (0, b_draw, b_away), W full 3x3, L2 penalty 0.01 x mean squared deviation of all parameters from the identity (as in Phase 2)',
    excluded: 'isotonic (per-class maps break the simplex; no principled multiclass version at ~1,530 DEV matches); no other method added',
    fitting: 'multiclass log loss (plus the declared L2 for matrix) minimised by deterministic gradient descent with analytic gradients from the stated initial values (identity); fitted on DEV rows only',
  },
  simplicity_order: ['none', 'temperature', 'bias', 'vector', 'matrix'],
  dev_selection: {
    validation: 'leave-one-season-out within DEV: for each of the 5 DEV seasons, fit on the other 4, score the held-out season; the LOSO score is the mean of the 5 per-season scores',
    primary: 'LOSO multiclass log loss',
    tie_rule: 'walk the simplicity order starting from none; move to a more complex method only if its LOSO log loss is lower than the current choice by more than 0.0005 (the Phase 2 rule)',
    secondary_guard: 'the tie-rule winner is kept only if (a) its LOSO Brier is not worse than none by more than 0.0005 and (b) no more than 1 of the 5 held-out DEV seasons has log loss worse than none by more than 0.002; otherwise none is selected',
    reported_not_used: ['LOSO Brier', 'LOSO mean classwise ECE', 'per-season LOSO log loss'],
    final_fit: 'the selected method is re-fitted on all 5 DEV seasons; that fit is frozen (parameters and calibrated prediction hash) before any holdout evaluation',
  },
  keep_rule: {
    note: 'applies to the DEV-selected calibrator only, calibrated (X) vs raw v1.2-dc (R) on the pooled 2019/20-2025/26 holdout; other calibrators are reported as diagnostics and cannot be adopted',
    K1_log_loss: 'pooled log loss delta <= -0.0005',
    K2_brier: 'pooled Brier delta <= +0.0005',
    K3_ece: 'pooled mean classwise ECE (10 equal bins) decreases',
    K4_seasons: 'at most 1 of 7 holdout seasons has log loss worse by more than 0.002',
    K5_ranking: 'one-vs-rest AUC change < 0.005 for home, draw and away, and Spearman rank correlation with raw >= 0.99 for each class probability',
    K6_ordering: 'favourite identity changes in <= 2% of holdout matches; favourite accuracy change < 1 point; top-10% and top-20% confidence accuracy not lower by more than 2 points',
    K7_pathology: 'every calibrated probability within [0.02, 0.95]; every draw probability within [0.05, 0.45]; no single probability moved by more than 0.10 in any match',
    accepted: 'K1-K7 all pass',
  },
  verdict: {
    'MORE RESEARCH': 'any reproduction or leakage gate fails (the run is invalid until fixed)',
    REJECT: 'raw v1.2-dc does not beat the train-frequency baseline in every holdout season on log loss and Brier',
    'CALIBRATED MODEL READY FOR SHADOW': 'gates pass and the DEV-selected calibrator is not none and is accepted',
    'RAW DIXON-COLES READY FOR SHADOW': 'gates pass and the DEV selection is none, or the selected calibrator is not accepted (owner direction: no calibration is a valid winning result; the Phase 2 raw-ECE <= 0.01 condition is superseded by that direction)',
  },
  fixed_bins: {
    ece: '10 equal-width bins per class',
    reliability_home_away: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0001],
    reliability_draw: [0, 0.15, 0.18, 0.21, 0.24, 0.27, 0.30, 0.35, 1.0001],
    favourite_strength_raw: ['<0.45', '0.45-0.55', '0.55-0.65', '>=0.65'],
    home_team_strength: 'pre-match Elo of the home team, tertiles of the DEV distribution (weak / mid / strong), as in Phases 2-3',
  },
  drift: {
    note: 'diagnostic only, never part of the verdict; no rolling or season-adaptive calibrator is built in Phase 4',
    statistic: 'per holdout season and class, z = (mean predicted - observed) / SE with SE = sqrt(sum p(1-p)) / n; chi-square = sum of the 7 z^2 (7 df) per class',
    static_sufficient: 'a single static calibrator (or raw, if none is selected) is judged sufficient if every class has chi-square p >= 0.05',
  },
  forbidden: ['any structural change (Dixon-Coles rho, team strength, home advantage)', 'new features, Player/Team DNA, odds, injuries, transfers', 'bucket-specific calibrators', 'rolling or season-adaptive calibration', 'any production change or shadow'],
};
