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

## Activation (2026-10-03)

| Item | Value |
|---|---|
| Release | soccer-api `a465e92d` (rb `60f66ae8`, per-model record numbers) → soccer-ingest `d4b335bf` (rb `a9bb0f5c`, `ALGO_V2 = "on"`), commit `f89a7e1` |
| Activation (`started` event) | 2026-10-03T12:21:54Z |
| First run | 33 forecasts, 4 Official Picks, 0 holds; input hash `30a8bad7…` (= preflight), 359 inputs. The preflight's 34th forecast fixture had passed its lock by activation |
| Record | V2 #1–#4 (ledger ids 4–7), all away to score ≥ 0.80 (0.906, 0.924, 0.887, 0.837), all pending; V1 shown as #1 (ledger 3), unchanged |
| Post-activation canary | `scripts/algo/v2-postactivation-canary.mjs` → `v2-postactivation-canary.json`: PASS |

**Reproduction note.** 28/33 forecasts recompute bit-for-bit locally; 5 differ by at most 1.1 × 10⁻¹⁶ (one ulp)
because the Cloudflare Workers runtime and local Node may round `Math.exp`/`pow` differently. Every Game Best and
Official Pick decision is identical (33/33). The canary's rule is therefore: decisions identical and probabilities
within 1e-12, with the bit-exact count reported. The stored ledger values are the record.
