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
