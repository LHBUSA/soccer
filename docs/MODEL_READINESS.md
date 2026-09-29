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

**Predictions and Track Record routes stay hidden** until the gates below pass
and the owner signs off (G7).

## Soccer Algo V1 (2026-09-29): LIVE

`soccer-algo-v1.0.0` (spec `workers/soccer-ingest/src/algo-v1.json`, spec hash
`3156f6f9…`): Bundesliga league matches, frozen model
`soccer-research-bundesliga-v1.2-dc`, Official Picks for 1X2 ≥ 0.60 and home team
to score ≥ 0.875 (pick policy 1.1).

| Gate | Status |
|---|---|
| G1 Formula | Frozen spec + model card (`docs/evidence/research/frozen/`), protocol `scripts/research/algo-v1_1-protocol.mjs` |
| G2 Inputs | Canonical finished Bundesliga results only (OpenLigaDB ODbL / ESPN secondary); no research-only data |
| G3 Sample | SELECT 3,978 matches (2006/07–2018/19), holdout 2,142 (2019/20–2025/26) |
| G4 Backtest | `docs/evidence/research/algo-v1_1/holdout-results.json`, evaluated once after the SELECT freeze |
| G5 Calibration | One-sided pick calibration passed on SELECT and holdout (pick hit rate ≥ stated probability − tolerance) |
| G6 Stability | Version pinned; input list archived write-once in R2 under `input_hash`; forecast reproduced bit-for-bit in tests |
| G7 Review | **PASS: explicit owner sign-off 2026-09-29.** The production reproduction canary is a post-activation verification requirement, not a publication gate (`docs/evidence/algo/ACCEPTANCE.md`). |

Live since 2026-09-29: ledger migration 1200 (applied), the ingest lane with
`ALGO_OFFICIAL = "on"`, the read-only API `/v1/algo/{picks,record,research}` and the
pages `/picks` and `/track-record` (in navigation, indexed, in the sitemap). The
record starts with the first qualifying Official Pick issued after activation
(record #1); history is never seeded into it.
