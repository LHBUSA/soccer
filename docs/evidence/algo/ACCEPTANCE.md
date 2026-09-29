# Soccer Algo V1: acceptance report

Status: **BUILT, HIDDEN, NOT LIVE.** `ALGO_OFFICIAL` is unset. No Official Pick, forecast or Algo event exists.
The public record starts with the first Official Pick after go-live (record #1) and is never seeded or back-filled.

## What is frozen

| Item | Value |
|---|---|
| Algo version | `soccer-algo-v1.0.0` (spec `workers/soccer-ingest/src/algo-v1.json`, spec hash `3156f6f9e3f217fb…`) |
| Model | frozen Dixon–Coles Poisson, model hash `d9cf3320842efacf…`, core `scripts/research/structural-core.mjs` sha `c6f296eb…`, no calibration |
| Pick policy | `soccer-algo-pick-policy/1.1`: match result ≥ 0.60, home team to score ≥ 0.875; at most one Official Pick per match; Game Best shown for every forecast match |
| Scope | Bundesliga league matches |
| Lead time | issued once when the match enters the 7-day window; locked at kickoff − 60 min; immutable from issue |
| Settlement | canonical final score; postponed stays pending; cancelled/abandoned or kickoff moved > 48 h = void |
| Prices | none captured in V1: no ROI, units or CLV; no default odds |

## Research (HISTORICAL VALIDATION, never part of the record)

Protocol v1.1 (`scripts/research/algo-v1_1-protocol.mjs`, sha `8f73a080…`) was committed first. Thresholds were
selected on SELECT seasons 2006/07–2018/19 (3,978 matches) and frozen (freeze sha `9e4cf217…`). The holdout
seasons 2019/20–2025/26 (2,142 matches) were then evaluated once (`holdout-results.json`, sha `2a0d324e…`).

| Market | Holdout picks | Hit rate | Mean model probability | Wilson 95% lower | Baseline rate | H1 | H2 | H3 | H4 |
|---|---|---|---|---|---|---|---|---|---|
| Match result ≥ 0.60 | 483 | 72.05% | 69.18% | 67.89% | 41.95% | pass | pass | pass | pass |
| Home to score ≥ 0.875 | 419 | 92.12% | 91.48% | 89.15% | 79.25% | pass | pass | pass | pass |
| Combined (one pick per match) | 548 | 75.73% | 73.94% | 71.97% | 49.29% | | | | |

### Disclosure: holdout coverage above the SELECT cap

The frozen SELECT-stage policy capped threshold selection at **≤ 20% combined coverage** (SELECT: 729 Official
Picks in 3,978 matches = 18.33%).

The untouched holdout later produced **548 Official Picks in 2,142 matches = 25.58% coverage**.

This is **not a gate failure**. The frozen holdout acceptance rule is H1 calibration (pooled hit rate ≥ mean model
probability − 0.04), H2 floor (Wilson 95% lower bound ≥ 0.50), H3 lift (hit rate − baseline ≥ 0.08) and H4
durability (≥ 5 of 7 seasons within 0.08 of the stated probability). It does not reapply the SELECT coverage cap.
Both V1 markets passed H1–H4.

**Nothing was retuned in response to the holdout coverage.** Thresholds, markets and policy are unchanged from the
SELECT freeze.

## Deployed (2026-09-29)

| Component | State |
|---|---|
| Ledger migration `20260929001200_soccer_algo_picks.sql` | APPLIED (sha `7067e203…`) after the rollback-only proof; RLS on, anon/authenticated revoked, triggers enforce lock, immutability, write-once price and settlement, no delete/truncate |
| soccer-ingest `5eb06d3c` | Algo lane present, **OFF** (`ALGO_OFFICIAL` unset) |
| soccer-api `75fe0458` | `/v1/algo/picks`, `/v1/algo/record`, `/v1/algo/research` (read-only; internal model id not exposed) |
| Web `/picks`, `/track-record` | reachable by URL only: `noindex, follow` (meta + `X-Robots-Tag`), no navigation link, not in the sitemap |
| Reproduction canary | `scripts/algo/reproduction-canary.mjs` (R2 archive → input hash → frozen forecast recomputed bit-for-bit) |
| Go-live preflight | `scripts/algo/golive-preflight.mjs` (the seven G7 conditions below) |

## G7: conditional owner approval (2026-09-29)

The owner approved Soccer Algo V1 for go-live **provided that**, on or after **2026-10-02 18:30 UTC**:

1. the production shadow lane has at least one real forecast;
2. `scripts/algo/reproduction-canary.mjs --source shadow` returns PASS;
3. the archived input hash matches;
4. the recomputed forecast matches bit-for-bit;
5. there is no spec / model / pick-policy drift from the frozen versions;
6. all ledger guards remain intact;
7. no previous Official Picks or seeded historical record exist.

Owner clarification (2026-09-29): the conditional approval already stands; nothing about the model, thresholds,
markets or pick policy is revisited or retuned on Oct 2. Procedure: wait for the first real shadow forecast → run
`scripts/algo/golive-preflight.mjs` → if all 7 PASS, report the evidence to the owner → ask for a one-line
operational "go". That "go" is **deployment authorization only**, not another model gate. Until then V1 stays
frozen as-is: `ALGO_OFFICIAL` off, pages hidden/noindex, record empty, V2/expansion parked.

If all pass, G7 becomes PASS with no further model or threshold decision. After the operational "go": mark G7 PASS, set
`ALGO_OFFICIAL=on`, add the navigation links, enable indexing and the sitemap, verify the production API and pages,
and capture the first official forecast/pick evidence. V2 and expansion research wait until V1 go-live acceptance
is closed.

### Preflight 2026-09-29 20:09 UTC (before the canary date): FAIL as expected

| Condition | Result |
|---|---|
| time ≥ 2026-10-02 18:30 UTC | not yet |
| 1 shadow forecast | 0 (international break; the first window opens 2026-10-02 18:30 UTC for Dortmund v Bremen) |
| 2–4 canary / hash / bit-for-bit | NO_FORECASTS |
| 5 no drift | PASS |
| 6 ledger guards | PASS (checks-1200 against production, rolled back) |
| 7 nothing seeded | PASS (0 picks, 0 forecasts, 0 events) |

## Pre-activation page review (2026-09-29)

Verified by `tests/web/algo-pages.test.js` and in production (desktop 1568 px and mobile):

- a Game Best below threshold carries a **MODEL FORECAST** tag and "Not an Official Pick … Not counted in the record"; a qualifying one shows **OFFICIAL PICK #n**;
- HISTORICAL VALIDATION is a separate dashed panel after the public ledger, labelled MODEL RESEARCH, with no research number inside the public record;
- empty record: "The record is empty", Record 0–0, hit rate "—", no NaN/undefined/null;
- no ROI, units or CLV value appears; the reason is shown;
- the internal model id appears on no Algo surface (page, API policy, research summary);
- `noindex, follow`, no navigation or footer link, not in the sitemap.
