# Model readiness

A metric or model is published only when every gate below is met. The schema
enforces part of this: `soccer_metric_definitions` refuses `validated` or
`published` without a `backtest_ref`.

| Gate | Requirement |
|---|---|
| G1 Formula | Documented in `docs/METHODOLOGY.md` with a version. |
| G2 Inputs | Every input comes from a source with a PASS verdict and legitimate commercial use. Research-only data (StatsBomb) may inform design, never trained weights we ship, unless written consent is obtained. |
| G3 Sample | A minimum sample is declared and met, both for training and per displayed entity. |
| G4 Backtest | Held-out evaluation against a naive baseline, committed under `docs/evidence/models/` and referenced by `backtest_ref`. |
| G5 Calibration | Probabilistic outputs are calibrated on held-out data (reliability curve, ECE). |
| G6 Stability | Version pinned. Outputs are reproducible from the stored ledger and the derivation version. |
| G7 Review | Owner sign-off before the first publication. |

## Current status (2026-09-27)

| Metric | Status | Blocking gates |
|---|---|---|
| pbe_xg | design | G2 pool 45,945 shots < 50k target; G4, G5 |
| pbe_xt | design | possession derivation not built; no carries in the source |
| possession_value | design | depends on possessions + pbe_xg |
| field_tilt | design | descriptive share exists; metric definition not published |
| pressing_intensity | design | G1/G4 |
| transition_threat | design | possessions |
| progressive_action | design | G1 finalisation; no carries |
| set_piece_threat | design | pbe_xg |
| finishing_delta | design | pbe_xg |
| goalkeeper_impact | design | no legitimate shot-placement data |

**Predictions and Track Record routes stay hidden.** There is no model. The
prediction work starts after the descriptive layer is trusted and current-season
event data exists; today no legitimate free source provides it
(`docs/SOURCE_MATRIX.md`).
