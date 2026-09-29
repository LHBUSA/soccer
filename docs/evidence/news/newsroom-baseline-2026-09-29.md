# Newsroom baseline and diagnosis (2026-09-29, captured 12:20–12:56 UTC, before any change)

## Production state at baseline

| Item | Value |
|---|---|
| main (origin) | `f0599d4` (local checkout was 15 commits behind; fast-forwarded before work) |
| soccer-api live | `2f8a5b0d` (bundle byte-equivalent to `f0599d4`), rollback `6a20e342` |
| soccer-news live | `abc1fe23` — a **direct, non-script deploy** (02:17Z, no message) of an uncommitted tree: `soccer-news/1.3.1-backfill` = HEAD minus the `*/10` migration cron plus a TEMP operator route `/__pbe_backfill_now_7f3b19e2` authenticated by a header value hard-coded in source (not `NEWS_ADMIN_TOKEN`). Not in `docs/deployments.jsonl`. The uncommitted source is preserved in `git stash` ("preexisting worktree before pbecast/news mission"). |
| soccer-news /health | ok, desk `soccer-desk/2.1.1` required + available (OPENAI key present) |
| news:last_run | 12:20Z (the `7,37` cron is firing), 18 s |
| NEWS_ENABLED | `on` |
| Articles | 40: 34 published, 3 held, 3 withdrawn |
| Newest published | 2026-09-28 01:37Z (MLS table race) — **34.9 h old** |
| Newest per desk | MLS 34.9 h · Bundesliga 38.6 h · Premier League 38.6 h · UCL none · International none published |
| Held | Finland 7-0 San Marino (`editorial:new_number_not_in_packet`, `editorial:unsupported_top_claim`); Columbus v Inter Miami (`goal_sequence_matches_score`); Colorado v Seattle (`numeric_grounding`) |
| Legacy template stories not yet re-edited | 16 (last backfill write 01:12Z; idle since) |
| API/browser cache | `/api/soccer/news` → `public, max-age=60, s-maxage=60` (Worker cache 60 s → Vercel edge 60 s → browser 60 s; worst case ~3 min). No service worker. Not a cause. |

## Last run (12:20Z) per competition

| Competition | candidates | new | published | held |
|---|---|---|---|---|
| MLS | 18 | 0 | 0 | 0 |
| Premier League | 0 | 0 | 0 | 0 |
| Champions League | 0 | 0 | 0 | 0 |
| Bundesliga | 0 | 0 | 0 | 0 |
| Nations League | 1 | 0 | 0 | 0 |

## Last 72 h per competition (canonical graph)

| Competition | finished | eligible | candidates | duplicates | published | held | next 72 h fixtures |
|---|---|---|---|---|---|---|---|
| MLS | 14 | 14 | 18 | 18 (all already stories) | 0 new | 0 new | 2 (from 2026-09-30 23:30Z) |
| Premier League | 0 | 0 | 0 | 0 | 0 | 0 | 0 (international break) |
| Bundesliga | 0 | 0 | 0 | 0 | 0 | 0 | 0 (international break) |
| Champions League | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| Nations League | 26 | 26 | 1 (Finland 7-0) | 1 | 0 | 1 (Finland, 02:08Z) | 18 (from 2026-09-29 16:00Z) |

## Failure-class verdicts

| # | Class | Verdict |
|---|---|---|
| 1 | cron not firing | **No** — last_run 12:20Z; runs every 30 min |
| 2 | NEWS_ENABLED off | **No** — `on` |
| 3 | editorial desk unavailable | **No** — available |
| 4 | candidates = 0 | **Yes for PL / BL / UCL** — international break, nothing finished |
| 5 | candidates found but already existing | **Yes for MLS** — 18/18 duplicates (the last MLS round is fully covered) |
| 6 | candidates held by gates | **Partly** — the only new candidate (Finland 7-0) held on two desk gates |
| 7 | competition not in NEWS_COMPETITIONS | No — all five in the hard-coded array (now registry-driven) |
| 8 | current season missing from canonical ingest | No for the five; every other audited competition has no canonical row |
| 9 | API has new stories, frontend hides them | No — API newest = DB newest; 60 s caches |
| 10 | detection too narrow | **YES — the root cause.** The desk only wrote *after* a finished match, and only material ones. During an international break the product leagues have no matches; Nations League produced 26 results but only 1 was material; 18 fixtures in 72 h produced nothing because previews did not exist. |

The "2 h after kick-off" rule is ~15 min after full time, not a staleness cause. It is now replaced by
evidence readiness (`recapReadiness`): ledger complete → immediately; a component still retrying → wait (a
recap built before its goal sequence exists would hold permanently, since event ids are written once).

## Dry run of the new desk on production data (12:56Z, 3-day window, nothing written)

Nations League: 26 finished / 26 eligible; 10 fixtures in the 1–24 h preview window; would draft
"UEFA Nations League matchday: 10 fixtures on 29 September 2026", "Spain v Croatia: the top two in Group A3 meet",
"Scotland v Switzerland: the top two in Group B1 meet", "Slovakia v Kazakhstan: the top two in Group C3 meet".
MLS: 14 finished, 18 candidates, 18 duplicates. PL / BL / UCL: nothing in window.

## Competition coverage matrix (verified against the registry and the production database)

| Competition | Canonical registry | Current season | Current match data | News enabled | PBEcast capable | Ready to promote now |
|---|---|---|---|---|---|---|
| Bundesliga | yes | yes (2026/27) | yes | yes | yes (ESPN plays; OpenLigaDB-only matches result-only) | live |
| Premier League | yes | yes (2026/27) | yes | yes | yes | live |
| MLS | yes | yes (2026) | yes | yes | yes | live |
| UEFA Champions League | yes | yes (2026/27) | yes | yes | yes | live |
| UEFA Nations League | yes | yes (2026/27) | yes (156 fixtures, 42+ finished enriched) | yes | yes | live |
| UEFA Europa League | yes (espn 776 crosswalk) | no | no | no | no | **no** — no canonical row/season/matches; ESPN lane disabled, needs lane canary + identity certification |
| LaLiga | yes (espn 740) | no | no | no | no | **no** — same blocker |
| Serie A | yes (espn 730) | no | no | no | no | **no** — same blocker |
| Ligue 1 | yes (espn 710) | no | no | no | no | **no** — same blocker |
| UEFA European Championship | yes (espn 781) | no (next 2028) | no | no | no | **no** — no canonical row; no current tournament |
| FIFA World Cup | yes (wyscout 28, espn `fifa.world` 606) | no (2026 ended July 2026; next 2030) | no | no | no | **no** — nothing ingested: no competition row, seasons, teams, matches or events in production. Historical World Cup 2018 exists only in the Wyscout public dataset (not ingested); needs national-team identity certification + backfill proof + owner approval, and an ESPN `fifa.world` lane canary |
| FIFA Club World Cup | **no** (ESPN discovery listing `fifa.cwc` only) | no | no | no | no | **no** — not in the registry (needs an entry with evidence), no lane, no canary, no club identity crosswalks across confederations |

Other FIFA competitions seen only in the ESPN discovery listing (not in the registry, not canonical):
`fifa.wwc` (Women's World Cup), World Cup qualifiers (six confederations + play-offs), `fifa.friendly`,
`fifa.world.u20`, `fifa.world.u17`, `fifa.olympics`, `fifa.intercontinental_cup`. FIFA's own API
(`api.fifa.com`) is registered as RESTRICTS_COMMERCIAL_USE (not production-ready).
