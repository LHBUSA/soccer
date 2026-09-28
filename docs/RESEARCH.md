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

---

# Phase 3 (2026-09-28): can the structural model fix the error itself?

## Protocol and discipline

- **Protocol:** `scripts/research/phase3-protocol.mjs` (sha256 `6cc6fa60…50b3`), committed in `e36c558` **before any Phase 3 number existed**. It fixes the candidates, the DEV selection rules, the keep rule and the overall rule.
- **Stage 1 (DEV):** selection, leakage tests and prediction hashes, with no holdout metric computed. Committed in `3bd82f9` (`phase3/dev-selection.json`, sha256 `ea607fee…740a`).
- **Stage 2 (holdout):** refuses to run unless all three of these hold:
  - the protocol hash is unchanged;
  - the DEV selection reproduces exactly;
  - every prediction hash matches the DEV freeze.
- The holdout evaluation code was first exercised on DEV seasons only (`--dry-run-on-dev`), so it could be debugged without seeing the holdout.
- No calibration of any kind was used. The frozen v1 model, `model-core.mjs` and the Phase 2 evidence are unchanged.
- **Reference check:** A reproduces the Phase 2 strict holdout exactly (0.9974 / 0.5948 / 0.0269).

## Formulations

- **A — frozen Poisson v1.1:**
  - λ_home = μH · att_home · def_away;
  - λ_away = μA · att_away · def_home;
  - every term is a 540-day half-life weighted average of matches that kicked off strictly before.
- **B — Dixon–Coles (1997) low-score dependence on the same λs:**
  - P(i,j) = τ(i,j) · Pois(i; λh) · Pois(j; λa);
  - τ(0,0) = 1 − λh·λa·ρ, τ(0,1) = 1 + λh·ρ, τ(1,0) = 1 + λa·ρ, τ(1,1) = 1 − ρ, and 1 otherwise;
  - τ is clamped at 0 (never needed: 0 clamps) and the 0..10 grid is renormalised.
  - Algebraically, draws gain 2|ρ|·λh·λa·e^−(λh+λa), and home and away each lose half of that.
- **C — adaptive league home advantage:**
  - league goal level μ and all team ratios stay at 540 days;
  - the home share of league goals, s, gets its own half-life h (window 5h): μH = 2μs, μA = 2μ(1−s);
  - h = 540 reproduces A bit-for-bit.
- **D — B plus C:** ρ is re-fitted for the D λs.

## DEV selection (2014/15–2018/19 only)

- **B:** ρ = **−0.1099** (maximum DEV scoreline likelihood).
  - Sensitivity check, not used: the ρ that minimises DEV 1X2 log loss is −0.0975.
- **C:** DEV 1X2 log loss by home half-life, with 540 selected:

  | 90 d | 180 d | 270 d | 365 d | 540 d |
  |---|---|---|---|---|
  | 0.99846 | 0.99768 | 0.99744 | 0.99736 | **0.99723** |

  Every faster half-life is worse on DEV, so the rule selects **540 (no change)**.
- **D:** 540 is again selected: 0.99601 against 0.99614 at 365 d. So D = B.

**DEV results:**

| Model | Log loss | Brier | ECE | Draw bias |
|---|---|---|---|---|
| A | 0.9972 | 0.5951 | 0.0277 | −2.0 |
| B | 0.9960 | 0.5946 | 0.0184 | +0.4 |
| C = A, D = B | — | — | — | — |

## Holdout (2019/20–2025/26, 2,142 matches)

| Model | Log loss | Brier | ECE | ECE H/D/A | Bias H/D/A (pts) | AUC H/D/A | Fav. acc. | Top-10% | Top-20% |
|---|---|---|---|---|---|---|---|---|---|
| baseline | 1.0740 | 0.6502 | 0.0144 | — | — | — | — | — | — |
| **A** | 0.9974 | 0.5948 | 0.0269 | .039/.028/.014 | +2.39 / −2.72 / +0.33 | .6983/.5531/.7058 | 51.1% | 74.8% | 73.4% |
| **B** | **0.9952** | **0.5938** | **0.0171** | .026/**.0075**/.018 | +1.28 / **−0.51** / −0.78 | .6982/.5529/.7059 | 51.1% | 74.8% | 73.6% |
| C | = A | | | | | | | | |
| D | = B | | | | | | | | |

### Season durability

| Season | Baseline LL / Brier | A LL / Brier | B LL / Brier | Δ log loss (B − A) |
|---|---|---|---|---|
| 2019/20 | 1.0820 / .6570 | 0.9895 / .5905 | 0.9906 / .5912 | +0.0011 |
| 2020/21 | 1.0816 / .6552 | 1.0119 / .6048 | 1.0077 / .6026 | −0.0042 |
| 2021/22 | 1.0578 / .6386 | 0.9974 / .5949 | 0.9970 / .5943 | −0.0004 |
| 2022/23 | 1.0563 / .6372 | 0.9982 / .5968 | 0.9961 / .5960 | −0.0021 |
| 2023/24 | 1.0748 / .6502 | 0.9899 / .5898 | 0.9844 / .5872 | −0.0055 |
| 2024/25 | 1.0941 / .6649 | 1.0225 / .6125 | 1.0205 / .6111 | −0.0020 |
| 2025/26 | 1.0712 / .6482 | 0.9721 / .5745 | 0.9698 / .5738 | −0.0023 |

- B improves 6 of 7 seasons, and no season is worse by more than 0.002.
- Without the most-improved season (2023/24), the pooled change is still −0.0017.
- B beats the baseline in every season.

### Draw calibration by season (observed / A / B)

| Season | Observed | A | B | Draw ECE A → B |
|---|---|---|---|---|
| 2019/20 | .222 | .220 | .242 | .004 → .026 |
| 2020/21 | .265 | .223 | .245 | .042 → .024 |
| 2021/22 | .239 | .222 | .245 | .023 → .019 |
| 2022/23 | .245 | .219 | .241 | .028 → .006 |
| 2023/24 | .265 | .215 | .237 | .053 → .032 |
| 2024/25 | .252 | .219 | .240 | .036 → .020 |
| 2025/26 | .245 | .224 | .246 | .044 → .022 |

2019/20, the one low-draw season, is the season B over-corrects and loses log loss.

### Where the draw deficit lives (A bias → B bias, pts)

The deficit is **universal**: under A every group is negative. It is **concentrated in balanced matches and mid-strength home teams**. It is **not purely low-total**.

| Grouping | Groups: A → B |
|---|---|
| Favourite strength | <0.45: −2.9 → −0.4 · 0.45–0.55: −3.6 → −1.3 · 0.55–0.65: −2.0 → +0.1 · ≥0.65: −1.3 → +0.2 |
| Home-team strength | weak: −2.7 → −0.3 · mid: **−4.5 → −2.2** · strong: −1.3 → +0.7 |
| Expected total goals | <2.6: −4.5 → −1.7 (n = 134) · 2.6–3.0: −1.3 → +1.2 · 3.0–3.4: −3.8 → −1.6 · ≥3.4: −2.5 → −0.9 |
| Predicted draw band | 0.21–0.24: **−4.8 → −2.6** (n = 885) · ≥0.27: −5.9 → −3.1 (n = 47) · others within ±1.9 after B |

**Exact scores (holdout share, observed / A / B):**
- 0–0: .050 / .047 / .058
- 1–1: .119 / .101 / .112
- 1–0: .059 / .077 / .066
- 0–1: .055 / .064 / .053

Scoreline log loss 3.0742 → 3.0702. Independent Poisson over-predicts 1–0 and 0–1 at the expense of 1–1. Dixon–Coles moves most of that mass back and slightly overshoots 0–0.

### Home/away calibration by season (A)

| Season | Home win obs / pred | Home goals obs / pred | Away goals obs / pred | Home ECE A → B | Away ECE A → B |
|---|---|---|---|---|---|
| 2019/20 | .402 / .461 | 1.66 / 1.74 | 1.55 / 1.38 | .061 → .050 | .058 → .068 |
| 2020/21 | .422 / .440 | 1.68 / 1.66 | 1.36 / 1.40 | .057 → .056 | .045 → .044 |
| 2021/22 | .467 / .452 | 1.76 / 1.69 | 1.36 / 1.36 | .059 → .052 | .056 → .056 |
| 2022/23 | .474 / .460 | 1.86 / 1.74 | 1.32 / 1.39 | .041 → .041 | .047 → .039 |
| 2023/24 | .438 / .475 | 1.81 / 1.82 | 1.41 / 1.39 | .051 → .068 | .031 → .059 |
| 2024/25 | .386 / .462 | 1.63 / 1.78 | 1.50 / 1.41 | .088 → .083 | .058 → .086 |
| 2025/26 | .438 / .443 | 1.78 / 1.69 | 1.46 / 1.41 | .078 → .062 | .039 → .030 |

- Dixon–Coles takes mass equally from home and away wins. It halves the pooled home bias (+2.39 → +1.28), but it creates a small away deficit (+0.33 → −0.78), and away ECE rises from 0.0137 to 0.0178.
- The home residual is still season-dependent: the SD of the season home bias is 3.27 pts.

### Home advantage through time (`phase3/home-advantage.svg`)

- **The 540-day league ratio lags.**
  - Its season mean correlates **0.81 with the previous season's realised home/away goal ratio** and **0.04 with the same season's**.
  - It barely moved for the 2019/20–2020/21 empty-stadium period: realised 1.07, model 1.27.
  - Nor did it move for 2024/25: realised 1.08, model 1.26.
- **A 90-day half-life tracks better**: 0.70 with the same season, 0.43 with the previous.
- **But it is noisy, and DEV says the noise costs more than the tracking gains.**
- Diagnostic only, not used for any decision: on the holdout, shorter half-lives lower the season home-bias SD (3.26 → 2.32 at 90 d) and ECE, but not log loss (C_90 0.9974, C_180 0.9971).
- As with temperature scaling in Phase 2, this holdout observation **cannot** be adopted.
- 2026/27 is a partial season, shown at the top edge of the plot.

## Leakage (DEV stage, all pass)

| Test | Result |
|---|---|
| L1: h = 540 reproduces frozen model-core strict | 6,768 predictions, 0 bitwise differences; general home-share formula within 6e-16 |
| L2: truncation (predict from strictly earlier matches only) | Phase 2's 60-case gate + 300 cases across dev and holdout, for h = 540 and 90: 0 failures, max diff 0 |
| L3: mutation (scramble every score at or after a cutoff) | 20 cutoffs, including the first kickoff of all 12 dev/holdout seasons: 183,246 predictions compared (90 at the cutoff kickoff itself), 0 changed |
| L4: permutation (reverse the order inside all 960 same-kickoff groups) | 0 failures (max 2e-15, floating summation order) |
| L5: fit inputs | ρ and h fitted only on 2014/15–2018/19 |

No team plays twice on one day. The prediction hash for A (`2de5a94c…`) differs from the frozen card's `fb9d04a7…` by design: the card hashed v1, and A is the strict v1.1.

## Verdicts (protocol keep rule)

| Component | Verdict | Reason |
|---|---|---|
| **B Dixon–Coles** | **KEEP** | K1–K6 all pass: Δ log loss −0.0022, Δ Brier −0.0011, draw bias 2.72 → 0.51 pts, draw ECE 0.028 → 0.0075, 6 of 7 seasons better, none worse by more than 0.002, ranking unchanged (ΔAUC ≤ 0.0002, favourite and top-10% accuracy identical) |
| **C adaptive home** | **REJECT** | DEV selected no change (540); faster half-lives lose DEV log loss monotonically |
| **D = B + C** | **REJECT** | DEV selected no change (D = B) |

**Overall: STRUCTURAL MODEL READY FOR CALIBRATION.**
- Final candidate: `soccer-research-bundesliga-v1.2-dc`, ρ = −0.1099, card `frozen/model-card-v1.2-dc.json`, prediction hash `19b72fed…`.
- Research only: not in production, no shadow.

**Known residuals for the calibration phase:**
- home wins over-predicted by +1.3 pts, varying by season;
- away wins under-predicted by −0.8 pts;
- draws still under-predicted by about −2.2 pts for mid-strength home teams.

**Runtime:** DEV stage 61.6 s, holdout stage 19.4 s.

---

# Phase 4 (2026-09-28): calibration of the frozen Dixon–Coles model

## Protocol and discipline

- **Protocol:** `scripts/research/phase4-protocol.mjs` (sha256 `a3509825…67b4`), committed in `a36df3b` before any Phase 4 number existed. It fixes:
  - the calibrators;
  - DEV leave-one-season-out selection, with the Phase 2 rule: a more complex method must win by more than 0.0005, plus a Brier/season guard;
  - keep rule K1–K7;
  - fixed bins;
  - the drift statistic;
  - the verdict mapping.
- The raw v1.2-dc holdout metrics were already known from Phase 3. The protocol says so.
- **DEV freeze:** `0bf387a` (`phase4/dev-selection.json`, sha256 `d4387740…e5e7d`). It holds the selection, every full-DEV parameter set and every calibrated prediction hash, with no holdout metric computed.
- **Holdout stage:** refuses to run unless all of these reproduce exactly:
  - the protocol hash;
  - the frozen card;
  - the raw prediction hash;
  - the DEV selection and parameters;
  - all calibrated hashes.
- **Structural model:** `soccer-research-bundesliga-v1.2-dc` (card sha256 `c79116e6…`, predictions `19b72fed…b13b`), untouched.

## Calibrators

Every calibrator is written as z = W·log p + b, then softmax, so outputs always sum to 1. Each was fitted on the 1,530 DEV matches by deterministic gradient descent with analytic gradients, starting from the identity.

| Method | Parameters | Form |
|---|---|---|
| none | 0 | raw v1.2-dc |
| temperature | 1 | z = l / T |
| bias | 2 | draw and away intercepts |
| vector | 5 | diagonal W plus 2 intercepts |
| matrix | 11 | full W plus 2 intercepts, L2 penalty 0.01 toward the identity |

Isotonic was excluded: it breaks the simplex, and there is too little data.

## DEV leave-one-season-out

| Method | LOSO log loss | LOSO Brier | LOSO ECE | Per-season log loss (2014/15 … 2018/19) |
|---|---|---|---|---|
| **none** | **0.996006** | 0.594609 | 0.0515 | 1.0106, 0.9825, 0.9997, 1.0109, 0.9762 |
| temperature | 0.996243 | 0.594743 | 0.0504 | 1.0114, 0.9822, 0.9998, 1.0118, 0.9760 |
| bias | 0.996826 | 0.595269 | 0.0478 | 1.0102, 0.9861, 0.9981, 1.0114, 0.9783 |
| vector | 0.998892 | 0.596276 | 0.0496 | 1.0139, 0.9877, 1.0001, 1.0113, 0.9814 |
| matrix | 0.997526 | 0.595691 | 0.0459 | 1.0107, 0.9870, 0.9992, 1.0092, 0.9815 |

- **Selected: none.** No calibrator beats raw on DEV, even before the tie rule.
- Full-DEV parameters (frozen; reported for transparency, never applied to the product):
  - T = 0.96289311;
  - bias (draw, away) = (−0.05413728, −0.08572857);
  - vector = (0.82402242, 1.03492684, 1.16078201; 0.14506071, 0.26248508);
  - matrix = [0.8692036, 0.06784234, −0.07808507; 0.35638194, 0.69516971, 0.23249657; −0.22558554, 0.23698795, 0.8455885; 0.26831713, −0.05451087].

## Holdout, pooled (none is adoptable except raw)

| | Log loss | Brier | ECE | ECE H/D/A | Bias H/D/A (pts) | AUC H/D/A | Favourite changes | Fav. acc. | Top-10% | Top-20% | Spearman vs raw (draw) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **raw v1.2-dc** | **0.9952** | **0.5938** | **0.0171** | .026/.0075/.018 | +1.28/−0.51/−0.78 | .6982/.5529/.7059 | — | 51.1% | 74.8% | 73.6% | 1 |
| temperature | 0.9952 | 0.5938 | 0.0213 | .032/.013/.019 | +1.68/−0.87/−0.81 | same | 0 | 51.1% | 75.2% | 73.6% | 0.99996 |
| bias | 0.9967 | 0.5949 | 0.0267 | .045/.011/.025 | +2.85/−0.84/−2.00 | .6981/.5529/.7058 | 76 | 51.0% | 75.2% | 73.8% | 0.9969 |
| vector | 0.9966 | 0.5948 | 0.0262 | .043/.011/.025 | +2.83/−0.93/−1.90 | .6983/.5495/.7060 | 68 | 51.0% | 74.8% | 73.8% | 0.9726 |
| matrix | 0.9968 | 0.5951 | 0.0247 | .042/.0053/.027 | +2.71/−0.31/−2.41 | .6985/.5484/.7049 | 90 | 51.0% | 75.7% | 73.8% | 0.9479 |

- **Diagnostic only:** every DEV-fitted calibrator makes the holdout worse.
- The DEV period had the opposite home bias to the holdout (Phase 2: −0.4 vs +2.4). So intercept, vector and matrix calibrators push home up and away down on the holdout, and worsen 2019/20 and 2024/25 by more than 0.002.
- Temperature (T < 1 sharpens) is neutral on log loss and worse on ECE.

## Holdout by season (raw v1.2-dc; calibrated = raw, since none was selected)

| Season | Log loss | Brier | ECE | Bias H/D/A (pts) | Baseline LL / Brier |
|---|---|---|---|---|---|
| 2019/20 | 0.9906 | 0.5912 | 0.048 | +4.80 / +2.01 / −6.80 | 1.0820 / .6570 |
| 2020/21 | 1.0077 | 0.6026 | 0.041 | +0.75 / −1.95 / +1.19 | 1.0816 / .6552 |
| 2021/22 | 0.9970 | 0.5943 | 0.042 | −2.61 / +0.61 / +2.01 | 1.0578 / .6386 |
| 2022/23 | 0.9961 | 0.5960 | 0.028 | −2.49 / −0.40 / +2.89 | 1.0563 / .6372 |
| 2023/24 | 0.9844 | 0.5872 | 0.053 | +2.59 / −2.80 / +0.21 | 1.0748 / .6502 |
| 2024/25 | 1.0205 | 0.6111 | 0.063 | +6.55 / −1.15 / −5.39 | 1.0941 / .6649 |
| 2025/26 | 0.9698 | 0.5738 | 0.038 | −0.59 / +0.12 / +0.47 | 1.0712 / .6482 |

Per-season figures for every calibrator are in `phase4/holdout-results.json`.

## Classwise reliability (raw, fixed bins; predicted → observed)

- **Home**, bias +1.28, ECE .026:
  - 0.2–0.3: .253 → .232
  - 0.3–0.4: .354 → .335
  - 0.4–0.5: .451 → .413 (n 516)
  - 0.5–0.6: .546 → .532
  - 0.6–0.7: .645 → .694
  - 0.7–0.8: .747 → .757
  - 0.8–0.9: .836 → .783 (n 46)
- **Draw**, bias −0.51, ECE .0075:
  - 0.18–0.21: .196 → .168
  - 0.21–0.24: .228 → .238
  - 0.24–0.27: .256 → .277 (n 892)
  - 0.27–0.30: .280 → .269
- **Away**, bias −0.78, ECE .018:
  - 0.1–0.2: .156 → .131
  - 0.2–0.3: .252 → .270
  - 0.4–0.5: .445 → .476
  - 0.6–0.7: .642 → .680

## Balanced matches and home-team strength (raw bias H/D/A, pts)

| Group | Raw bias H/D/A | Temperature | Matrix |
|---|---|---|---|
| favourite <0.45 | +2.0 / 0.0 / −2.0 | +2.2 / −0.3 / −1.9 | +3.9 / −0.1 / −3.8 |
| favourite 0.45–0.55 | **+3.2 / −2.5** / −0.7 | +3.5 / −2.8 / −0.7 | +4.8 / −2.3 / −2.5 |
| favourite 0.55–0.65 | −2.3 / +1.3 / +1.0 | −1.7 / +0.9 / +0.9 | −1.2 / +1.9 / −0.6 |
| favourite ≥0.65 | −0.2 / +0.3 / −0.2 | +0.7 / −0.3 / −0.4 | +0.3 / +0.9 / −1.2 |
| weak home | +2.7 / −0.3 / −2.4 | +2.7 / −0.6 / −2.1 | +4.5 / −0.9 / −3.7 |
| mid home | **+3.2 / −2.2** / −1.0 | +3.5 / −2.5 / −1.0 | +4.8 / −2.1 / −2.7 |
| strong home | −1.5 / +0.7 / +0.9 | −0.7 / +0.2 / +0.5 | −0.6 / +1.6 / −1.0 |

- The residual error is concentrated in **balanced matches with a weak or mid-strength home team**: home is over-predicted, and draws (balanced) or away wins (weak hosts) are under-predicted.
- No global calibrator can fix that without hurting the strong-home and clear-favourite groups.

## Calibration drift (diagnostic; the declared statistic)

| Class | Season z-scores (2019/20 … 2025/26) | χ² (7 df) | p |
|---|---|---|---|
| home | 1.78, 0.28, −0.98, −0.93, 0.96, **2.43**, −0.22 | 11.95 | 0.102 |
| draw | 0.82, −0.79, 0.25, −0.16, −1.16, −0.47, 0.05 | 2.95 | 0.889 |
| away | **−2.71**, 0.47, 0.80, 1.15, 0.08, **−2.15**, 0.18 | 14.19 | **0.048** |

- **Answer: after Dixon–Coles, a single static calibrator is NOT sufficient.**
- The draw residual is now consistent with noise.
- The home/away residual drifts by season, driven by 2019/20 (the empty-stadium period) and 2024/25. In both, home advantage collapsed and the model over-predicted home wins by about 5–7 points.
- Every static calibrator makes this drift *worse*: away p falls to 0.003–0.043.
- As directed, no rolling calibrator was built. That remains a separate experiment needing approval.

## Leakage and reproduction (all pass)

| Gate | Result |
|---|---|
| G1 frozen reproduction | 6,768 λ bitwise equal to model-core strict; 6,156 probabilities bitwise equal; raw hash equals the card's `19b72fed…` |
| G2 truncation | 60 + 300 cases, 0 failures |
| G3 future-score mutation | 20 cutoffs, 91,623 predictions, 0 changed |
| G4 same-kickoff permutation | 0 failures (max 1.8e-15) |
| G5 DEV-only calibration | every one of the 4,626 non-DEV outcomes scrambled, then the whole LOSO selection and every fit re-run: identical output |

The holdout stage re-derived the selection, the parameters and all five calibrated hashes before evaluating.

**Calibrated prediction hash:** none was selected, so the shipped candidate is the raw hash `19b72fed…b13b`. The diagnostic hashes are:
- temperature `ce95ebb2…`
- bias `aa783086…`
- vector `9dffd501…`
- matrix `74abda77…`

## Disclosures

1. **Bug in the first holdout run.** The first run reported REJECT because of a bug. The per-season records omitted the exact Brier field, so the "raw beats baseline in every season" check compared `undefined < undefined` and always failed.
   - The fix adds that field, and adds raw's own range to the pathology output as a reference.
   - No rule, threshold, protocol line, DEV selection or parameter changed. The protocol hash is unchanged, and the holdout stage re-verified every freeze.
   - The printed per-season numbers show raw beating the baseline in all 7 seasons, as Phase 3 found.
2. **K7 bounds are narrower than raw's own range.** The absolute probability bounds in K7 ([0.02, 0.95]) are narrower than raw v1.2-dc's own range (minimum 0.0193). That contributed to temperature failing K7, but it is immaterial: every calibrator also fails K1 (log loss) and K3 (ECE).

## Verdict: **RAW DIXON-COLES READY FOR SHADOW**

- Gates pass.
- Raw v1.2-dc beats the baseline in every holdout season.
- The DEV selection is none.
- No calibrator beats raw on DEV or, diagnostically, on the holdout.

The remaining residual is season-level home/away drift, which static calibration cannot fix. The shadow is **not built**: it needs owner approval.

**Runtime:** DEV stage 85.3 s, holdout stage 25.9 s.
