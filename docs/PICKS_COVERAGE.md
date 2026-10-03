# Soccer PBE Picks — competition coverage

Generated 2026-10-03T01:41:54.088Z by `scripts/algo/picks-coverage.mjs` (read-only).

**Data availability is not model validation. A competition enters PBE Picks only with its own research, frozen holdout, approved pick policy and owner activation.** The Bundesliga model is never applied to another competition because its fixtures exist.

| Competition | Published seasons (range) | Held | ≥10 seasons for research | Model research | Frozen holdout | Pick policy | Production |
|---|---|---|---|---|---|---|---|
| bundesliga | 23 (2004/05 – 2026/27) | 0 | yes | docs/evidence/research (Algo V1 protocol: selection seasons + one-shot holdout) | frozen (select_freeze_sha256 in algo-research.json) | soccer-algo-pick-policy/1.1 | soccer-algo-v1.0.0 · LIVE (owner G7 sign-off 2026-09-29) |
| premier-league | 5 (2001/02 – 2026/27) | 1 | no | none | none | none | not eligible (no model) |
| la-liga | not in the canonical graph | – | no | none | none | none | not eligible |
| serie-a | not in the canonical graph | – | no | none | none | none | not eligible |
| ligue-1 | not in the canonical graph | – | no | none | none | none | not eligible |
| fifa-world-cup | 1 (2026 – 2026) | 0 | no | none | none | none | not eligible (no model) |
| uefa-european-championship | not in the canonical graph | – | no | none | none | none | not eligible |
| uefa-champions-league | 1 (2026/27 – 2026/27) | 0 | no | none | none | none | not eligible (no model) |
| uefa-nations-league | 2 (2024/25 – 2026/27) | 0 | no | scripts/research/algo-v2-research.mjs (pre-registered national-team protocol) | frozen; input membership frozen 2026-10-02 (algo-v2-dataset.json) | soccer-algo-v2-pick-policy/1.0 | soccer-algo-v2.1.0 · OFF (never ran; pre-activation preflight + owner sign-off pending) |
| uefa-europa-league | not in the canonical graph | – | no | none | none | none | not eligible |
| mls | 7 (2001 – 2026) | 0 | no | none | none | none | not eligible (no model) |

## Recommended next competition-model research lane

**Premier League**, as its own research lane (never the Bundesliga model reused): its Pass A history lane is running
2001/02 → 2025/26 under the hardened acceptance gate (20 clubs × 38, structure-registered), which would give ~24
complete seasons of canonical results, enough for a selection/holdout split like Algo V1's. Start only after that lane
finishes and every season used is PUBLISHED; then pre-register the protocol, freeze thresholds on the selection
seasons, evaluate the holdout once, and bring the result to the owner. MLS is a later candidate: its format changes
season to season (reviewed manifests, repeat meetings, playoffs), so its research needs per-season structure inputs.
Champions League, World Cup, LaLiga, Serie A and Ligue 1 lack canonical history depth today.
