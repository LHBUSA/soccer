# Prediction research (not in production)

Script: `scripts/research/model-research.mjs` · Evidence: `docs/evidence/research/model-research-<date>.json`

## Protocol (declared before results)

- **Data**: Bundesliga league-stage results from the canonical graph, 23 seasons, 6,768 matches (the only competition with long history).
- **Chronological splits**: train 2004/05–2013/14 (fit mappings), dev 2014/15–2018/19 (choose hyperparameters), **holdout 2019/20–2025/26** (reported once, season by season), live 2026/27 (partial).
- **No leakage**: every feature for a match uses only matches that kicked off before it. The first season is warm-up and not evaluated. All models are scored on the identical match set.
- **Declared baseline**: training-set frequencies (1X2 home/draw/away; binary event rates).
- **Gate**: a model passes only if it beats the baseline on the holdout in BOTH log loss and Brier.

## Models

| Model | What it is | Chosen on dev |
|---|---|---|
| `elo_ologit` | Elo ratings (margin-weighted, home edge, 2/3 season carry-over) mapped to H/D/A with an ordered logit fitted on train | K 10, home edge 60 |
| `poisson` | Time-decayed team attack/defence rates (shrunk toward league average) → independent Poisson goals → H/D/A, team-to-score, over 2.5 | half-life 540 days, shrink 10 matches |

## Holdout results (2,142 matches)

| Target | Baseline | Elo | Poisson |
|---|---|---|---|
| 1X2 log loss | 1.074 | 0.999 | **0.997** |
| 1X2 Brier | 0.650 | 0.596 | **0.595** |
| 1X2 accuracy | 43.2% | **51.4%** | 51.1% |
| Home team to score: log loss / Brier | 0.493 / 0.157 | — | **0.468 / 0.150** |
| Away team to score: log loss / Brier | 0.575 / 0.193 | — | **0.542 / 0.181** |
| Over 2.5 goals: log loss / Brier | 0.675 / 0.241 | — | **0.655 / 0.232** |

- **Durability**: both models beat the baseline's log loss in all 7 holdout seasons (worst season 2024/25: Elo 1.029, Poisson 1.022 vs baseline 1.094).
- **Calibration** (P(home win), Poisson): well-ordered, but home wins are **over-predicted by roughly 3–5 points in the 0.2–0.6 bands**, consistent with the post-2020 fall in home advantage that the train period (2004–2014) does not reflect.

## Status: passes the research gate, held from production

It beats the declared baseline out of sample, but it does not ship in this pass because:
1. the home-edge calibration drift must be corrected (e.g. rolling home-edge estimation) and re-proven on a fresh holdout;
2. the only strong external benchmark (closing market prices) is not part of this product, so "beats the baseline" is the only gate evidenced;
3. only the Bundesliga has enough history; MLS, the Premier League and the Champions League have one partial ESPN season each, too little to validate per competition;
4. player goal involvement is not modelled yet: current-season player samples are too small (most players are below 450 nominal minutes).

Nothing on the site calls anything "predictive". Player DNA and Team DNA are descriptive and time-safe.

---

# Phase 2 (2026-09-28): is the signal real, and can it be calibrated safely?

- **Scripts:** `scripts/research/model-core.mjs` (the frozen core, pure functions), `freeze-model.mjs`, `calibration-research.mjs`.
- **Evidence:** `docs/evidence/research/frozen/model-card-v1.json`, `frozen/bundesliga-results-snapshot.json`, `calibration-research-2026-09-28.json`.
- The acceptance rules were written into `calibration-research.mjs` before any holdout calibration number was looked at.
- No feature changed during this phase.

## 1. Frozen model: `soccer-research-bundesliga-v1-frozen`

| Item | Value |
|---|---|
| Source | Commit `6fdf692`. `scripts/research/model-research.mjs` sha256 `9d369da1…5d5e`, unchanged since. |
| Data | 6,768 Bundesliga league-stage results. Snapshot sha256 `6bff57c0…f028`, checked in. `--refresh-snapshot` rebuilds it from the graph. |
| Splits | Train 2004/05–2013/14 · dev 2014/15–2018/19 · holdout 2019/20–2025/26 · 2026/27 unused |
| Elo | K 10, home edge 60, 2/3 carry-over. Ordered logit θ = [0.0085, −0.40, 0.70], fitted on train. |
| Poisson (primary) | Half-life 540 d, 5-half-life window, shrink 10 match-equivalents, all chosen on dev |
| Baseline | Train frequencies H/D/A 0.452 / 0.249 / 0.299 |
| Prediction hashes (6,156 rows) | Poisson `fb9d04a7…`, Elo `373e3f14…`, baseline `de2d8141…` |
| Reproduction | Exact. Holdout log loss / Brier: baseline 1.0740 / 0.6502, Elo 0.9986 / 0.5960, Poisson 0.9972 / 0.5947. |

## 2. Leakage checks

- **Found:** v1 let matches with the *same kickoff* into the Poisson league-average term when they came earlier in the list.
  - 4,503 of the 6,768 matches share a kickoff with another match.
  - The leak changed 3,072 predictions, by at most 0.55 probability points.
- **Truncation-invariance test** (predict a match with every simultaneous or later match removed; the prediction must not change): v1 fails 23 of 60 sampled matches; the strict **v1.1 passes 60 of 60**.
- **Effect on the headline:** holdout log loss moves from 0.9972 to 0.9974.
- Everything below uses v1.1. That is a bug fix, not a feature change.
- Elo cannot leak this way: no team plays twice on the same day anywhere in the data (checked: 0).
- What was fitted where:
  - ordered logit: train;
  - Poisson hyperparameters: dev (frozen);
  - baseline: train;
  - calibrators: dev only.
- The holdout was never used for a decision.

## 3. Diagnostics (strict Poisson, holdout, 306 matches per season)

| Season | Predicted H/D/A | Observed H/D/A | Bias H/D/A (pts) | Log loss | Brier | ECE |
|---|---|---|---|---|---|---|
| 2019/20 | .461/.220/.319 | .402/.222/.376 | +5.9 / −0.2 / −5.7 | 0.9895 | 0.5905 | 0.041 |
| 2020/21 | .440/.223/.337 | .422/.265/.314 | +1.9 / −4.2 / +2.3 | 1.0119 | 0.6048 | 0.048 |
| 2021/22 | .452/.222/.325 | .467/.239/.294 | −1.5 / −1.6 / +3.1 | 0.9974 | 0.5949 | 0.046 |
| 2022/23 | .460/.219/.321 | .474/.245/.281 | −1.4 / −2.6 / +4.0 | 0.9982 | 0.5968 | 0.039 |
| 2023/24 | .475/.215/.310 | .438/.265/.297 | +3.7 / −4.9 / +1.3 | 0.9899 | 0.5898 | 0.045 |
| 2024/25 | .462/.219/.320 | .386/.252/.363 | +7.6 / −3.3 / −4.3 | 1.0225 | 0.6125 | 0.061 |
| 2025/26 | .443/.224/.333 | .438/.245/.317 | +0.5 / −2.1 / +1.6 | 0.9721 | 0.5745 | 0.053 |

Pooled holdout: log loss 0.9974, Brier 0.5948, mean classwise ECE 0.0269. Home reliability bands are in the evidence JSON.

**Classification of the reported "home over-prediction":**
- **Not global.** Pooled home bias is +2.4 pts, but on dev it was −0.4.
- **Season-specific.** Large in 2019/20 (+5.9), 2024/25 (+7.6) and 2023/24 (+3.7); negative in 2021/22 and 2022/23.
- **Club-strength specific.**
  - The bias is carried by mid (+4.3) and weak (+3.9) home teams.
  - Strong home teams are on target (−0.5).
  - A single league-wide home rate, adapting over 540 days, overstates home advantage for non-elite hosts whenever that rate falls.
- **Favourite-strength specific.**
  - About +3.5 pts when the favourite is below 55%.
  - About 0 when the favourite is at 65% or more (+0.7 in the 55–65% band).
- **The stable error is draws, not home wins.**
  - Draws are under-predicted by 2.7 pts pooled, negative in every holdout season, and −2.0 on dev.
  - This is the known weakness of independent-Poisson scorelines.

## 4. Calibration (fitted on dev; chosen by leave-one-season-out within dev)

| Method | LOSO dev log loss | Holdout log loss / Brier / ECE | Holdout seasons worse by more than 0.002 | Accept |
|---|---|---|---|---|
| none (raw) | **0.99723** | 0.9974 / 0.5948 / 0.0269 | — | — |
| temperature (T 1.0152) | 0.99761 | 0.9973 / 0.5948 / 0.0259 | none | yes |
| bias shift | 0.99678 | 0.9970 / 0.5951 / 0.0260 | 2019/20, 2024/25 | no |
| vector scaling | 0.99794 | 0.9965 / 0.5948 / 0.0264 | 2019/20, 2024/25 | no |
| matrix scaling (L2) | 0.99729 | 0.9966 / 0.5950 / 0.0251 | 2019/20, 2024/25 | no |

- **The dev rule selects no calibration.** The best candidate, bias shift, beats raw by only 0.00045, which is inside the pre-declared 0.0005 tie margin.
- **Temperature scaling is not adopted.** It passes every holdout test, but it was not the dev choice, and adopting it now would be choosing on the holdout.
- **Isotonic was not tested.** Per-class step functions break the coherence of the three probabilities at this sample size.
- **Every method preserves ranking** (holdout pooled):
  - one-vs-rest AUC home/draw/away about 0.698 / 0.553 / 0.706 (every change 0.0033 or less);
  - favourite accuracy 51.0–51.1%;
  - top-10% confidence accuracy 74.8–75.2%;
  - top-20% confidence accuracy 73.4–73.8%;
  - upset AUC 0.637–0.641.
- Calibration neither creates nor destroys ranking signal.

## 5. Season durability (log loss)

| Season | Baseline | Raw | Temperature | Bias shift |
|---|---|---|---|---|
| 2019/20 | 1.0820 | 0.9895 | 0.9895 | 0.9968 |
| 2020/21 | 1.0816 | 1.0119 | 1.0117 | 1.0086 |
| 2021/22 | 1.0578 | 0.9974 | 0.9972 | 0.9950 |
| 2022/23 | 1.0563 | 0.9982 | 0.9981 | 0.9944 |
| 2023/24 | 1.0748 | 0.9899 | 0.9898 | 0.9870 |
| 2024/25 | 1.0941 | 1.0225 | 1.0221 | 1.0262 |
| 2025/26 | 1.0712 | 0.9721 | 0.9725 | 0.9710 |

- The raw strict model beats the baseline in all 7 seasons, on both log loss and Brier.
- Static calibrators fitted on 2014–2019 cannot follow season-level shifts in home advantage.
- Every calibrator that moves probabilities materially makes 2019/20 and 2024/25 worse. Those are exactly the seasons with the largest home swings.

## Verdict: **MORE RESEARCH** (by the pre-declared rules)

- **The signal is real:** it passes the leakage checks, beats the baseline in every season, and its ranking is stable.
- **It cannot be calibrated safely with dev-fitted static methods.** The dominant errors are:
  1. a structural draw deficit;
  2. drift in the home-advantage level.
- **No shadow candidate was created. Production is untouched.**

**Next experiments** (each needs approval; 1 and 2 change the model, 3 needs an exception to the dev-only rule):
1. A draw-aware scoreline likelihood (Dixon–Coles low-score correlation), same inputs.
2. A faster-adapting league home/away rate: a shorter half-life for the base rates only, chosen on dev.
3. Prospective recalibration: re-fit the bias each season on the previous N seasons, with N chosen on dev.
   - It is time-safe.
   - It uses post-dev seasons as training, which needs an explicit exception.
4. A market benchmark, only from a legitimately licensed odds source. None has been obtained, and nothing was scraped.

## Shadow architecture (designed, NOT built; only if a later verdict is SHADOW READY)

- **Storage:** a new table `soccer_model_shadow_predictions`.
  - Columns: `model_id`, `calibration_id`, `match_id`, `predicted_at`, `kickoff_at`, `p_home`/`p_draw`/`p_away`, `lambda_home`/`lambda_away`, `input_hash`, `attribution jsonb`, and the outcome, filled in after full time.
  - A trigger blocks any change to a stored prediction.
  - RLS is on with no policies. soccer-api never reads the table; nothing is public.
- **Runtime:** a daily soccer-ingest lane.
  - It scores Bundesliga fixtures entering a 7-day window from the canonical graph, using strict features, and writes each prediction once.
  - A nightly job records outcomes and rolling log loss, Brier and ECE against the baseline.
- **Attribution:** the model's own multiplicative decomposition, nothing invented.
  - League base rate μ.
  - Home and away components μH/μ and μA/μ.
  - Team strength as attack and defence ratios (home attack × away defence, away attack × home defence).
  - Recency enters only through the 540-day time decay; there is no separate form feature.
  - Elo difference, for the Elo variant only.
  - Player DNA and Team DNA are **not used** by the model, and attribution would say so.
