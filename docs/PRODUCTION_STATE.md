# PropBetEdge Soccer — production state

Reconstructed 2026-09-28 from the repository, applied migrations, `docs/deployments.jsonl`, the
production APIs (`/v1/data-health`, `/v1/health`) and the QA/evidence files. The repository and
evidence are the source of truth; nothing here comes only from chat memory.

## Surfaces

| Surface | Where | Release |
|---|---|---|
| Web app | https://soccer.propbetedge.ai — Vercel project `soccer` (prj_3UgFIxhnlVcLmhnnNDc1WoHOtXGn; never `soccer-hs22`) | git-connected: **every push to `main` deploys production** |
| soccer-api | Cloudflare Worker (public read API; reached by the browser only through the same-origin `/api/soccer/*` edge proxy) | `scripts/release/release-worker.mjs` |
| soccer-ingest | Cloudflare Worker, cron `*/5 * * * *` | same |
| soccer-news | Cloudflare Worker, cron `7,37 * * * *`, `NEWS_ENABLED=on`, optional LLM pass `NEWS_LLM=off` | same |
| Data | Supabase SPORTS project `tkmlnhmylqnttmnsnief`, tables `soccer_*`, RLS on, no public policies | migrations below |
| Raw archive | R2 bucket `soccer-source` (write-once captures; content-addressed media) | — |

## Current versions (from docs/deployments.jsonl; release script verifies the live version)

| Worker | Live version | Rollback |
|---|---|---|
| soccer-api | `b7c7fdcb` | `b22668d3` |
| soccer-ingest | `e15074df` | `21ccb770` |
| soccer-news | `a04b2183` | `5c03ee80` |

Rollback: `cd workers/<worker> && npx wrangler versions deploy <rollback>@100% --yes`. Web rollback: Vercel instant rollback to the previous production deployment.

## Migrations (all applied, each after a rollback-only proof with an unchanged catalog fingerprint)

`0100` core graph · `0200` events · `0300` newsroom (append-only evidence) · `0400` attribute_corroborated player crosswalk · `0500` governed media registry · `0600` enrichment ledger + season groups/standings + media discovery/trademark status.

## Competitions and sources

| Competition | Season | Teams | Fixtures (finished / scheduled) | Sources |
|---|---|---|---|---|
| MLS | 2026 | 30 / 30 (All-Star sides excluded) | 510 (401 / 108 at audit) | ESPN Core (secondary) |
| Premier League | 2026/27 | 20 / 20 | 380 (50 / 330) | ESPN Core |
| UEFA Champions League | 2026/27 | 36 / 36 | 144 league phase (18 / 126) | ESPN Core |
| Bundesliga | 23 seasons | 18 / 18 current | 7,000+ historical | OpenLigaDB (ODbL), Wyscout public dataset 2017/18 (CC BY 4.0), ESPN current season |

Finished matches missing a lineup, team statistics or play-by-play: **0** in every competition (data-health). MLS enrichment gaps found by the ledger backfill (2 lineups, 3 play-by-play) were recovered on retry.

## Identity rules

Canonical UUIDv5 ids; provider ids are crosswalks. Never merged by name. Crosswalk methods: founding, exact_id, reviewed, fixture_graph, event_alignment, attribute_corroborated (players: exact name + exact DOB + unique + same club in an overlapping season + no contradiction). Unresolved identities wait in `soccer_identity_queue` (open: 52 ESPN players, 1,912 historical OpenLigaDB scorer ids, 2 Wyscout).

## Tables

- League tables are computed from canonical results (MLS tiebreak: points, wins, GD, GF).
- **MLS Eastern/Western Conference** and **UCL league phase**: membership, official rank and zone notes from ESPN's published standings, shown ONLY when every P W D L GF GA PTS equals our canonical recomputation (`workers/shared/standings.js`); otherwise the table is withheld with the mismatches listed.

## Enrichment, live and health

- `soccer_match_enrichment` tracks lineups (per side), team stats (per side) and play-by-play per match; failures are retried with backoff; a trigger keeps `complete` from ever being downgraded; results are never refetched on retry.
- `espn_live` (every tick) updates status and score of ESPN-owned matches in the live window; the page shows freshness and refreshes every minute. Source cadence is about 5 minutes plus ESPN's delay: not real time.
- `/v1/data-health`: per-competition teams, fixtures, result and optional-component gaps, stale live, identity queue, media coverage, lane state, news generation and held reasons.

## Media (docs/MEDIA.md)

- Portraits: **592 approved**, via exact ESPN FC player id (P3681) or attribute corroboration inside a roster-proven club.
- Crests: **3 approved** (Bayern München, Internazionale, Napoli). 4 held: Barcelona (third-party CC0 on the club crest), plus Inter Miami, AS Roma and Liverpool (wordmarks). Most major club crests are not freely licensed, so no legitimate source exists; the initials mark is the fallback.
- Trademark status is stored separately from copyright; free-licensed crests are used only to identify the club.

## News (docs/NEWS_ENGINE.md)

- Composer `template/soccer-news@2.1.0`, gates `soccer-gates/2.0.0`, with competition profiles (MLS, UCL league phase, knockout, domestic).
- Published: **MLS 19, Premier League 5, Bundesliga 9, UCL 0** (no eligible UCL matchday in the window yet; the pipeline is proven by an end-to-end test).
- Held 1 (MLS, numeric grounding). Withdrawn 3 (MLS own-goal attribution error, 2026-09-28), all re-issued as corrections.

## DNA and research

- Player DNA / Team DNA: descriptive, time-safe profiles with percentiles within the competition-season (`workers/soccer-api/src/dna.js`).
- Prediction research (docs/RESEARCH.md): Elo and Poisson models beat the declared baseline on a 7-season Bundesliga holdout; **not in production**.

## QA (latest, docs/evidence/qa)

- Browser QA: 168/168 checks at 320/360/390/430/768/1024/1440.
- SEO first-response QA: 0 failures.
- axe-core: 0 violations on 10 pages × 2 widths.
- Performance (slow-4G, 4× CPU, cold cache): JS about 25 KB, CSS about 11 KB, first HTML about 2 KB compressed; LCP 1.3–2.7 s; CLS 0–0.041 on every audited page (fonts `display=optional`, main reserves the viewport). DNA season profiles cached in KV (cold Wyscout season 16 s once, then about 1 s) and warmed by a soccer-api cron (`20 */6 * * *`).

## Known gaps

- Crest coverage is limited by licensing, not identity.
- Player photos exist for about 20% of observed players: Wikidata coverage of ESPN ids is the ceiling.
- MLS West table withholds itself whenever a just-finished match is in ESPN's standings before our lane details it (minutes to about 2 h).
- Only the Bundesliga has long history; other competitions have one ESPN season.
- No injury, transfer or quote sources (by design).
