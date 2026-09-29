# Soccer Algo V1: acceptance report

Status: **LIVE since 2026-09-29 21:00:37 UTC** (explicit owner G7 sign-off 2026-09-29). `ALGO_OFFICIAL = "on"`.
The public record starts with the first qualifying Official Pick issued after activation (record #1) and is never
seeded or back-filled. At activation: 0 Official Picks, 0 forecasts; the first fixture enters the 7-day window on
2026-10-02 18:30 UTC (Borussia Dortmund v Werder Bremen, kickoff 2026-10-09 18:30 UTC).

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
| soccer-ingest **`8fbfedbc`** (commit `bd92675`) | Algo lane **ON**: `env.ALGO_OFFICIAL ("on")` bound; rollback `5eb06d3c` (lane present, off). Kill switch: `ALGO_OFFICIAL = "off"` in `workers/soccer-ingest/wrangler.toml` + release |
| soccer-api `75fe0458` | `/v1/algo/picks`, `/v1/algo/record`, `/v1/algo/research` (read-only; internal model id not exposed); rollback `f71ba1b6` |
| Web `/picks`, `/track-record` (commit `bd92675`) | PICKS in primary navigation, ALGO TRACK RECORD in Intelligence, both in the footer; `index, follow` + canonical; both in `sitemap-static.xml` |
| Reproduction canary | `scripts/algo/reproduction-canary.mjs` (R2 archive → input hash → frozen forecast recomputed bit-for-bit; `--source shadow` and `--source algo`) |
| Post-activation verification | `scripts/algo/golive-preflight.mjs` (the seven conditions below, adapted for a live ledger) |

### Activation proof (2026-09-29 21:00–21:05 UTC)

| Check | Result |
|---|---|
| Lane first run | `started` event 2026-09-29 21:00:37 UTC carrying spec `3156f6f9…`, model `d9cf3320…`, policy `soccer-algo-pick-policy/1.1`; lane health ok, 0 failures |
| Ledger | 0 Official Picks, 0 forecasts: nothing seeded, nothing back-filled |
| `/v1/algo/picks` | 200; `live: true`, coverage ok, 0 open picks, 0 Game Best (no fixture in the window yet), awaiting-forecast list present |
| `/v1/algo/record` | 200; 0 picks, 0–0, hit rate null, ROI/units/CLV null (no stored price) |
| `/v1/algo/research` | 200; HISTORICAL VALIDATION, 548 / 2,142 holdout |
| Model id privacy | no internal model id in any of the three payloads |
| `/picks`, `/track-record` | 200, `index, follow`, no `X-Robots-Tag`, canonical set; robots.txt allows (only `/api/` disallowed) |
| Sitemap | both URLs in `sitemap-static.xml`, listed by `sitemap.xml` |
| Navigation | shipped bundle contains PICKS, ALGO TRACK RECORD and the footer links; PICKS visibly highlighted on /picks |

Frozen and unchanged by activation: model, thresholds, markets, pick policy, holdout interpretation.

## G7: PASS by explicit owner sign-off (2026-09-29)

**G7 is PASS by explicit owner sign-off dated 2026-09-29.** The owner activated V1 without waiting for the canary
date. **The production reproduction canary is a post-activation verification requirement, not a publication gate.**

On or after 2026-10-02 18:30 UTC, once the first real forecast exists, run
`node scripts/algo/golive-preflight.mjs` and `node scripts/algo/reproduction-canary.mjs --source shadow`. The archived
input hash and the bit-for-bit recomputation must pass. **If the verification FAILS: immediately set
`ALGO_OFFICIAL = "off"` and release soccer-ingest, then report the exact mismatch.** If it passes: record the evidence
and continue normally.

History: the owner first gave conditional approval with these conditions, required on or after
**2026-10-02 18:30 UTC** before go-live:

1. the production shadow lane has at least one real forecast;
2. `scripts/algo/reproduction-canary.mjs --source shadow` returns PASS;
3. the archived input hash matches;
4. the recomputed forecast matches bit-for-bit;
5. there is no spec / model / pick-policy drift from the frozen versions;
6. all ledger guards remain intact;
7. no previous Official Picks or seeded historical record exist.

*Superseded the same day by the explicit G7 sign-off above (activation now; these conditions became the
post-activation verification). Kept for the record:* owner clarification (2026-09-29): the conditional approval already stands; nothing about the model, thresholds,
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
