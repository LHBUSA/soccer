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
