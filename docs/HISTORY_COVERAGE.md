# Historical depth — coverage audit and ingestion plan

Audit: `docs/evidence/history/coverage-audit-2026-10-02.json` (script `scripts/evidence/history-coverage-audit.mjs`,
read-only ESPN Core, 8,308 requests, 0 errors). Per competition-season: season types with event counts, event index size,
teams listed, and K = 4 sampled matches (first / thirds / last of the index) measured for score, venue, lineup (11 starters),
formation, substitutions, player-statistics refs, team statistics, play-by-play, shots / goals / cards, coordinates and the
coordinate SCALE. Percentages below are sample shares (4 matches per season), not full-season measurements: Pass A measures
every match.

Nothing here is ingested. Catalog availability is not coverage.

## Coordinate formats (decisive for spatial depth)

ESPN publishes two coordinate formats. `0-100` (measured on matches from ~July 2026, plus a few 2003-2011 seasons) maps to the
canonical pitch (`espn_pct_v1`). `0-1` (most seasons since ~2009, all of MLS 2026 to May, Nations League 2018-2025) is a
different, unverified frame: shots sit at x 0..0.43 (a penalty at 0.23, y 0.5 ≈ 12 m from goal on a half-pitch scale) while
other plays span 0..1, and left/right is not established. Parser `espn-core/1.1.0` keeps such locations as source values
only (`espn_unit_unverified`, no canonical point). Calibrating that frame (penalties, goal-kicks, corners, kick-offs; then an
orientation proof) would unlock spatial history for roughly 2009-2026 in every competition.

Production impact found by this audit: 271 matches (MLS 2026-02-21..05-25: 218; Nations League 2024/25: 53), 54,342 event
rows, had been mapped as 0-100 (shots ~0.3 m from a corner flag). Repair: `scripts/db/repair-espn-unit-coords.mjs`
(dry run committed; `--apply` needs owner approval).

## Era bands by competition (sampled)

Bands: RESULTS, MATCH (venue), LINEUP, EVENTS (lineups + goals/cards/shots in play-by-play), EVENTS+unit-coords (events;
locations unverified, not plotted), SPATIAL(0-100) (verified locations).

| Competition | ESPN catalog | Seasons | Events listed | Bands |
|---|---|---|---|---|
| Premier League | 2001/02–2026/27 | 26 | 10,156 | 01/02 EVENTS · 02/03 unit · 03/04–08/09 SPATIAL · 09/10 unit · 10/11–11/12 SPATIAL · 12/13–25/26 EVENTS+unit |
| Bundesliga | 2000/01–2026/27 | 27 | 8,059 | 00/01 RESULTS · 01/02–05/06 EVENTS · 06/07 SPATIAL · 07/08 unit · 08/09 SPATIAL · 09/10–25/26 EVENTS+unit |
| MLS | 1996–2026 | 31 | 8,681 | **1996–2000: 0 events listed (source gap)** · 2001–2003 RESULTS · 2004–2007 EVENTS · 2008–2009 SPATIAL · 2010–2026 EVENTS+unit |
| Champions League | 2001/02–2026/27 | 26 | 5,065 | EVENTS throughout; unit coords 06/07, 10/11, 12/13–25/26 |
| FIFA World Cup | 1930–2026 | 23 | 1,067 | **1930–1998 EVENTS (lineups + goals/cards)** · 2002–2006 SPATIAL · 2010 MATCH · 2014–2022 EVENTS+unit · 2026 SPATIAL |
| Nations League | 2018/19–2026/27 | 5 | 824 | 2018/19–2024/25 EVENTS+unit · 2026/27 in progress |
| LaLiga | 2000/01–2026/27 | 27 | 10,172 | 00/01 RESULTS · 01/02–05/06 EVENTS · mixed SPATIAL/unit to 10/11 · 11/12–25/26 EVENTS+unit |
| Serie A | 2000/01–2026/27 | 27 | 9,960 | 00/01 RESULTS · 01/02–05/06 EVENTS · 07/08 SPATIAL · 08/09–25/26 EVENTS+unit |
| Ligue 1 | 2000/01–2026/27 | 27 | 9,784 | 00/01 RESULTS (9 events listed) · 01/02–05/06 EVENTS · mixed to 09/10 · 10/11–25/26 EVENTS+unit |
| Europa League | 2009/10–2026/27 | 18 | 6,473 | 09/10–13/14 EVENTS · 14/15 MATCH · 15/16–25/26 EVENTS+unit |

Provider xG appears in ~1% of sampled historical matches (MLS/World Cup recent only).

### Women's competitions (2026-10-03, ESPN catalog, K=6 sampled matches per season)

Evidence: `docs/evidence/history/womens-history-discovery-2026-10-03.json` (2,510 Core requests, 0 errors, read-only).
**Catalog availability, not production coverage.** A band is what the sampled matches of that season carry; Pass A
acceptance decides what is published.

| Competition | ESPN catalog | Seasons | Events listed | Bands |
|---|---|---|---|---|
| NWSL | 2013–2026 | 14 | 1,915 | 2013–2015 RESULTS/MATCH (some listed events unfinished) · 2016–2018 MATCH · 2019 EVENTS (no formations) · **2020: 108 listed, 0/6 sampled finished (season cancelled; HOLD)** · 2021–2023 EVENTS · 2024–2025 EVENTS+unit · 2026 SPATIAL from 2026-05-31 (earlier matches unit) |
| Women's Super League | 2011–2013, 2018/19–2026/27 | 12 | 1,392 | 2011–2013 RESULTS (8 teams, calendar seasons) · **2014–2017/18 not in the ESPN catalog (source gap)** · 2018/19 MATCH · 2019/20 MATCH/EVENTS, unfinished listings (season curtailed; acceptance decides) · 2020/21–2023/24 EVENTS (no formations / team stats) · 2024/25 EVENTS · 2025/26 EVENTS+unit · 2026/27 SPATIAL (current) |
| UEFA Women's Champions League | 2019/20–2026/27 | 8 | 489 | 2019/20–2020/21 EVENTS, **knockout-only format (Round of 32 → Final)** · 2021/22–2024/25 EVENTS, **group stage (4×4) + knockouts** (2024/25 unit coords) · 2025/26 EVENTS+unit, **league phase (18) + knockouts** · 2026/27 SPATIAL (current) |
| Liga F | 2022/23–2026/27 | 5 | 1,200 | 2022/23–2025/26 EVENTS (lineups, formations, team stats; no coordinates) · 2026/27 current |
| Première Ligue (D1 Arkema) | 2022/23–2026/27 | 5 | 670 | 2022/23–2023/24 EVENTS+unit · 2024/25–2025/26 EVENTS (no coordinates) · regular season + play-offs from 2023/24 |
| FIFA Women's World Cup | 2003–2023 | 6 | 266 | 2003 EVENTS (one sampled match SPATIAL) · **2007 SPATIAL(0-100)** · 2011–2023 EVENTS+unit · 1991–1999 not in the ESPN catalog |
| Frauen-Bundesliga | — | 0 | — | **No ESPN Core league** (ger.w.1 absent). OpenLigaDB `ffb1` exists but community-maintained (quality decision pending). Not built. |
| Serie A Women | — | 0 | — | **No ESPN Core league** (ita.w.1 absent), no OpenLigaDB league. No source; not claimed. |

Women's-specific Pass A notes: NWSL and the World Cup are **calendar** seasons (labels `2016`, `2019`); WSL is calendar
2011–2013 and split from 2018/19; UWCL and the World Cup need explicit per-edition stage roles (never the generic league
classifier); team identity reuses the current canonical women's teams by stable ESPN id (never the men's club).

### Women's history in production (Pass A, 2026-10-03/04)

From `docs/evidence/history/womens-history-matrix-2026-10-04.json` (production publication state + per-season acceptance
files `docs/evidence/history/accept-<slug>-<label>.json`; queue logs `queue-<slug>.jsonl`). Published = acceptance PASS
+ promoted; the current season is published by its live lane. Depth tier: MATCH = results + venue (Pass A); lineups,
events and coordinates come with Pass B/C (not yet run).

| Competition | Earliest sourced | Latest | Seasons discovered | Seasons published | Matches (public) | Lineups | Event depth | Spatial depth | Held gaps |
|---|---|---|---|---|---|---|---|---|---|
| NWSL | 2013 | 2026 | 14 | 8 (2018, 2019, 2021-2026) | 1,239 | current season only | current season only | 2026 from 05-31 | 2013-2015 ESPN results incomplete (25+ events without status/score, uneven games); 2016 + 2017 one cancelled match each (19/23 games for two clubs: reviewed manifest needed); 2020 cancelled season (not ingested) |
| Women's Super League | 2011 | 2026/27 | 12 | 11 (2011-2013, 2018/19, 2020/21-2026/27) | 1,252 | current season only | current season only | 2026/27 | 2019/20 curtailed (uneven games / finished count); 2014-2017/18 not in the ESPN catalog |
| UEFA Women's Champions League | 2019/20 | 2026/27 | 8 | 7 | 428 | current season only | current season only | 2026/27 | 2020/21: 1 match without a readable final score (source) |
| Liga F | 2022/23 | 2026/27 | 5 | 5 | 1,200 | current season only | current season only | none (source has no locations) | — |
| Première Ligue | 2022/23 | 2026/27 | 5 | 5 | 670 | current season only | current season only | none (source has no locations) | — |
| FIFA Women's World Cup | 2003 | 2023 | 6 | 0 | 0 | — | — | — | not ingested: needs its registry entry + national-team canary first |
| Frauen-Bundesliga / Serie A Women | — | — | 0 | 0 | 0 | — | — | — | no ESPN Core league |

Growth (production, baseline 2026-10-03 22:06Z -> 2026-10-04 00:45Z): +4,673 matches, +38 seasons, +63 teams (all women's;
women's teams 68 -> 131), +0 players (Pass A writes no lineups), +19,344 source capture rows, R2 soccer-source
+35,489 objects / +0.47 GB (5.78 -> 6.25 GB).
Guards: no live model reads a women's competition (tests/womens-history-guards.test.js; model specs + Algo V2.1 frozen
dataset unchanged since 446d545); 31 promoted seasons, each smoke-checked, 0 news events created.

## Data-quality flags for Pass A (must be resolved before a season is canonical)

- **Over-listed seasons** (more events than a round robin): Premier League 2001/02–2007/08 (403–495 vs 380), Bundesliga
  2001/02–2009/10 (308–367 vs 306), LaLiga 2001/02–2004/05, Serie A 2004/05–2006/07, Ligue 1 2002/03–2006/07 (up to 492).
  Rule: one canonical match per (season, stage, home, away) chosen by the FINISHED event; duplicates recorded, never merged
  blind; games-per-team and team-count checks must pass.
- **Under-listed seasons**: Ligue 1 2000/01 (9), Bundesliga 2010/11 (5), Serie A 2000/01 (208), LaLiga 2000/01 (259),
  Bundesliga 2000/01 (191): held, disclosed as gaps.
- **Tournament formats**: World Cup 1934/1938 "Preliminary Round" (a knockout round), 1950 "Final Stage" (a round-robin
  group), later second group stages; UCL qualifying rounds and old second group stages. The generic type classifier drops
  or misfiles these: per-edition `type_roles` must be explicit before ingest.
- **Bundesliga 2000/01–2003/04** exist only in ESPN (OpenLigaDB starts 2004/05); registry `may_found: false` forbids ESPN
  founding. Needs an owner decision (ESPN-secondary-only seasons, labelled as such).

## Model and newsroom guards

- Newsroom: detection reads only the latest season and only matches kicked off in the last 4 days.
  `tests/history-newsroom.test.js` proves historical rows written today create no story.
- **Soccer Algo V2 (Nations League, national teams) reads every finished Nations League + World Cup match from the last
  ~20 years (5 × 1,460-day half-life).** Backfilling World Cup 2006–2022 or Nations League 2018–2022 history would change its
  live forecast inputs. World Cup / Nations League history must not be ingested until V2's inputs are frozen to the dataset
  it was validated on (owner decision; a spec change is a new model version).
- V1 (Bundesliga) and the Bundesliga shadow read ~7.4 years of Bundesliga only: unaffected by ESPN 2000–2003.

## Cost estimate (Tier 1: EPL, Bundesliga 2000–03 + enrichment, MLS 2001+, UCL, World Cup, Nations League; ~34k events)

| Pass | Requests | Wall clock (2.3 s/request measured, 3 polite lanes) | DB growth | R2 |
|---|---|---|---|---|
| A skeleton (event + status + 2 scores) | ~136k | ~29 h | matches ~35 MB, captures ~95 MB | ~3 GB |
| B match depth (rosters, stats, athletes) | ~270k (athlete lookups fall as players repeat) | ~60 h | lineup players ~1.2 M rows ≈ 0.4 GB | ~6 GB |
| C events, key types only (shots, goals, cards, subs) | ~50k | ~11 h | ~1.4 M rows ≈ 1.6 GB | ~14 GB raw plays |
| C full play-by-play in the database | — | — | ~24 M rows ≈ 25–30 GB (**not recommended**: keep raw in R2) | — |

## Release order (unchanged from the brief, with the blockers above)

1. Bundesliga reconciliation (2004/05+ OpenLigaDB canonical; ESPN enrichment) — 2000/01–2003/04 after the owner decision.
2. Premier League 2001/02+ (Pass A with the dedupe rule; spatial only where 0-100).
3. MLS 2001+ (1996–2000 not in the source).
4. Champions League 2001/02+ (explicit type roles; qualifying excluded as today).
5. World Cup 1930+ and Nations League 2018+ — after the Algo V2 input freeze.
6. Tier 2.

Before any historical season reaches production, every public read path needs a publication gate (a held season must not
appear in competition seasons, team history, sitemaps or data-health) — proposed as a `soccer_seasons.publication` column
(migration, owner approval) rather than code allowlists.
