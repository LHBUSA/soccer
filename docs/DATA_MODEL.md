# Data model

Migrations: `supabase/migrations/20260927000{100,200,300}_soccer_*.sql`. They are
tested on PGlite (Postgres 17) in `tests/db.test.js`, and proven rollback-only
on the sports project. They are **not applied**.

## Tables (31)

| Group | Tables |
|---|---|
| Evidence | `soccer_source_captures`, `soccer_source_changes` (mutation ledger) |
| Structure | `soccer_competitions`, `soccer_seasons`, `soccer_stages` |
| People and places | `soccer_teams`, `soccer_players`, `soccer_managers`, `soccer_venues` |
| Crosswalks | `soccer_{competition,season,team,player,manager,venue,match}_external_ids` |
| Matches | `soccer_matches`, `soccer_match_source_results`, `soccer_lineups`, `soccer_lineup_players`, `soccer_substitutions` |
| Event ledger | `soccer_match_events`, `soccer_possessions` (derived, versioned) |
| Stats | `soccer_match_stats`, `soccer_team_match_stats`, `soccer_player_match_stats` (`basis` = source \| derived) |
| Intelligence | `soccer_metric_definitions` (10 metrics seeded as `design`) |
| Identity | `soccer_identity_queue` |
| Newsroom | `soccer_news_events`, `soccer_article_evidence` (append-only trigger), `soccer_articles` |

## Identity

- **Canonical ids are PropBetEdge UUIDs.** Each is minted once, as UUIDv5 of `kind:provider:external_id` of the founding record (`workers/shared/ids.js`). Rebuilding on a fresh database reproduces the same ids. The founding reference is only an input to the mint: if the provider renumbers, the id does not change.
- **Provider ids are crosswalk rows only.** The primary key is `(provider, external_id)`, which allows many provider ids to point at one entity; OpenLigaDB really does carry up to 3 ids per player.
- **Allowed crosswalk methods** (enforced by a CHECK constraint):

| Method | Meaning |
|---|---|
| `founding` | The record that minted the entity. |
| `exact_id` | Proven equal through a shared stable id. |
| `reviewed` | A committed, human-reviewed mapping with evidence, e.g. `data/registry/competitions.json`. |
| `fixture_graph` | A team is the only canonical team whose home fixtures cover every one of the provider team's home dates. The whole mapping must then reproduce every fixture of the season, or nothing is written. |
| `event_alignment` | Every goal of a provider player id aligns with exactly one canonical scorer: same match, same team, a ±2-minute window (45/90 stoppage-aware), and zero conflicting votes. |

  **Name matching is not a method.**
- **Founding lanes** may mint new entities. Before minting a player, the lane checks for a strong-attribute collision with entities founded by other providers (normalized full name AND birth date). A collision is queued: the record is neither founded nor merged.
- **OpenLigaDB scorers never found players.** They have abbreviated names and no birth dates. An unresolved scorer is queued, and the goal event keeps `qualifiers.source_player`.
- **Venues from Wyscout have no id**, only a name. They are keyed under a distinct provider tag (`wyscout_venue_name`) and never matched across providers.
- **Merges** set `status='merged'` and `merged_into`, enforced by a CHECK constraint. Rows are never deleted.

## Proof numbers

Bundesliga 2017/18, from `docs/evidence/proof/bundesliga-2017-18.json`:

| Metric | Result |
|---|---|
| Rows written | 18 teams, 535 players, 30 managers, 18 venues, 306 matches, 612 lineups, 11,000 lineup rows, 1,769 substitutions, 519,407 events, 9,792 team-stat rows, 71,434 player-stat rows |
| Idempotency | Second run writes 0 rows |
| Event goals (incl. own goals) vs recorded score | 306/306 |
| OpenLigaDB fixture-graph proof | 18/18 teams, 306/306 fixtures |
| Final score agreement | 306/306 |
| Half-time score agreement | 304/306 |
| OpenLigaDB scorers crosswalked by event alignment | 285, with 0 conflicts |
| Genuine conflicts queued | 10 |
| Provider duplicate ids | 47 players carry 103 ids |
| Identity queue at the end of the proof | 101 open entries: 2 Wyscout player ids referenced but absent from `players.json`, 13 OpenLigaDB 2017/18 scorer ids, and 86 current-season scorer ids with no canonical identity |
| Current season 2026/27 on the same graph | 15/18 teams resolved through the 2017/18 crosswalk, 3 founded, 306 matches, 137 goal events. 131 scorer references are queued (no roster source) |

## Invariants the schema enforces

- `x_m ∈ [0,105]`, `y_m ∈ [0,68]`. An out-of-range source point keeps its source value and gets no canonical one (1 event in 2017/18: y = 101).
- `unique(source_family, source_event_id)` prevents duplicate events. `unique(match_id, source_family, sequence)` prevents ordering collisions.
- A crosswalk method outside the allowed set is rejected, and so is a merged entity with no target.
- A metric cannot be `validated` or `published` without a `backtest_ref`.
- An article cannot be `published` without `published_at` and with hold reasons. An evidence packet cannot be updated or deleted.
