# Premier League model research — phase 1 report

**Research only.** No live model, no pick, no public number comes from this. Owner brief 2026-10-03.

| Item | Value |
|---|---|
| Protocol | `scripts/research/pl-protocol.mjs` (sha256 `9db6c099…`), committed `ad92ef8` before any PL model number existed |
| Dataset | `dataset.json`: 9,120 finished league matches, 24 published seasons × 380 (2001/02–2025/26), sha256 `f075b67d…` |
| Excluded | 2009/10 (HELD: 357/380, all 23 missing pairings involve Burnley; ESPN catalog gap), 2026/27 (live) |
| Gap handling | 2010/11 features rest on 2008/09 and earlier; no imputation |
| Leakage | strict as-of: each prediction uses only matches that kicked off strictly before it. No odds, no lineups, nothing from the match itself |
| Splits | warm-up 2001/02 (380) · train 2002/03–2012/13 (3,800) · dev 2013/14–2018/19 (2,280) · holdout 2019/20–2025/26 (2,660) |
| Selection | on dev only, frozen and committed (`16892c0`) before the holdout ran once |

## Models

| Family | Dev choice | Dev 1X2 log loss |
|---|---|---|
| B0 baseline (train outcome frequencies) | — | 1.0626 |
| M1 Elo → ordered logit | K 10, home edge 80 | 0.9632 |
| **M2 strict Poisson (candidate)** | **half-life 365 d, shrink 5** | **0.9614** |
| M3 Poisson + Dixon–Coles | same, ρ −0.0561 | 0.9619 |

## Holdout (evaluated once, 2,660 matches, 0 without history)

| 1X2 | Log loss | Brier | Accuracy | ECE |
|---|---|---|---|---|
| B0 | 1.0764 | 0.6517 | 43.4% | 0.037 |
| M1 Elo | 0.9912 | 0.5904 | 52.6% | 0.033 |
| **M2 Poisson (candidate)** | **0.9835** | **0.5852** | **52.4%** | **0.011** |
| M3 Poisson + DC | 0.9835 | 0.5852 | 52.4% | 0.009 |

Candidate log loss per holdout season vs B0: 2019/20 0.973 vs 1.067 · 2020/21 1.012 vs 1.105 · 2021/22 0.952 vs 1.079 ·
2022/23 0.999 vs 1.050 · 2023/24 0.932 vs 1.062 · 2024/25 0.990 vs 1.091 · 2025/26 1.027 vs 1.082. **7/7 seasons.**

**Verdict: PASS** under the pre-registered rule (beats B0 on pooled log loss AND Brier, and on log loss in ≥ 5 of 7 seasons).

Secondary markets (holdout log loss, B0 → M2): over 2.5 0.6947 → 0.6806 · home to score 0.5407 → 0.5078 ·
away to score 0.6071 → 0.5791 · BTTS 0.6922 → 0.6876 (BTTS gain is marginal).

## Limitations and phase-2 questions

- Both dev winners sit at the edge of their declared grids (Elo K 10, Poisson shrink 5). The grids were fixed in advance and were not widened; a wider grid is a phase-2 pre-registration, judged on dev only.
- M3 (Dixon–Coles) adds nothing measurable on 1X2 over M2 on this holdout.
- No archived odds exist: no ROI, units, CLV or edge claim. A pick policy (thresholds, market validation like Algo V1's) is a separate, later protocol.
- Rest/schedule, table context and lineups were deliberately left out (only the Premier League schedule is canonical; no as-of lineup history).
- Passing phase 1 means the model forecasts better than base rates, not that it should issue picks.
