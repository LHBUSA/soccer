# Soccer Algo V2.1 — owner acceptance and activation

**Owner sign-off (2026-10-03, verbatim):** "Soccer Algo V2.1 — APPROVED FOR PRODUCTION ACTIVATION", forward-only.

## Frozen scope (unchanged by activation)

| Item | Value |
|---|---|
| Algo | `soccer-algo-v2.1.0` (spec `53e6b8d7…`, model `4c40fa9c…`, policy `soccer-algo-v2-pick-policy/1.0`) |
| Competition | UEFA Nations League, league/group phase only |
| Official Pick market | away team to score, model probability ≥ 0.80 |
| Max Official Picks | 1 per match |
| Issue window / lock | kickoff − 7 days … kickoff − 60 minutes |
| Inputs | frozen membership (362 ids, sha `2dc6c0b5…`, frozen_at 2026-10-02T21:51:00Z) + matches after frozen_at |

The only production change is `ALGO_V2 = "on"` in `workers/soccer-ingest/wrangler.toml`, released through
`scripts/release/release-worker.mjs`. No model, threshold, input, market, coefficient or research artifact changes.

## Pre-activation evidence

- Research gate: `docs/evidence/research/algo-v2/holdout-results.json` (holdout evaluated once 2026-09-30).
- Pre-activation preflight PASS (`f635003`, `docs/evidence/algo/v2-preflight.json`): frozen membership intact, history
  complete, 0 contamination, two dry runs bit-for-bit identical (34 forecasts, 4 Official Picks at that time).
- Ledger before activation: 0 V2 events, 0 forecasts, 0 picks (`soccer-algo-v2.1.0` and `soccer-algo-v2.0.0`).

## Record rules

- **No backfill.** No historical V2 forecast or pick enters the public record. The V2 record starts at #1 with the
  first naturally qualifying Official Pick issued after activation.
- **Per-model record numbers** (owner decision 2026-10-03): the public number is a pick's position within its own
  model's ledger; the shared ledger identity is exposed only as `ledger_id`. V1's first pick, ledger id 3 (ids 1–2 were
  consumed by rolled-back ledger-guard proofs), is shown as V1 #1. No ledger row is changed.
- **Research is not the record.** The holdout result (26 picks, 22 hits, 84.6%) is research evidence only. It is never
  presented as a track record, an expected hit rate or a proven rate. Public performance starts at zero.
