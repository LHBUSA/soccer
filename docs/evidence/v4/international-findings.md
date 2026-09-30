# International and World Cup coverage audit (2026-09-30)

Audit source: `international-audit.json`, generated with read-only GETs against the canonical SPORTS graph and the existing API registry. No source rows were added or changed.

## What the canonical graph contains

- Canonical international competition identity: UEFA Nations League (`uefa-nations-league`), format `groups`.
- Current stored Nations League season: 2026/27; 156 matches (52 finished, 104 scheduled), 54 national-team identities, 104 sourced lineups, 1,323 canonical players, 75,692 events, 1,456 team-stat rows, 14 groups and 54 standings rows. Stored matches span 2026-09-24 through 2026-11-17.
- National teams and groups are real canonical entities. Country codes are absent on the audited team identities, so the UI must not manufacture flags from guessed country mappings.
- FIFA World Cup identity: absent. Canonical 2026 World Cup matches: 0. Canonical 2018 World Cup matches: 0. No World Cup groups/bracket, lineup, tournament-player, event or stats dataset is exposed by this graph audit.
- FIFA ranking data: unsupported; no approved ranking source or ingestion/table contract exists.

## Existing sources and decisions

The source matrix documents the frozen Wyscout 2018 World Cup archive as CC BY 4.0, and openfootball's 2026 World Cup fixtures/results as CC0. Wyscout's existing parser/lane accepts registry-listed competitions, but its current tournament lane does not separate group matches from knockout rounds or create group-scoped standings. The openfootball path has no established ingestion adapter. Neither source is marked production-ready in the registry.

ESPN Core's World Cup competition crosswalk (league `fifa.world`, id 606) already exists and ESPN is owner-approved as a secondary source. I added a disabled lane definition and stage/group configuration using the existing 2026 ESPN discovery evidence. A bounded local rehearsal reached the World Cup event index (first 150-request slice: 32 fixture identities, one detailed match), then stopped when ESPN Core returned a non-JSON response for the season-athlete URL ending `/seasons/2026/athletes/274277`. No production writes occurred; `fifa.world` remains disabled. The exact rehearsal stop is recorded in `espn-world-cup-canary.json`.

Before World Cup rows can be ingested, the 2018 Wyscout path needs explicit group/knockout stage mapping and verified identity/group reconciliation; the 2026 ESPN path needs a passing canary including robust handling of that season-athlete endpoint response, national-team identity checks, and verified group tables. Until one path passes those checks, the product must not expose World Cup fixtures or a bracket.

The matrix also records FIFA's official source as restricting commercial use. Do not use FIFA endpoints to fill the gap. For the completed 2026 tournament, openfootball's audited option is fixtures/results only; it cannot support lineups, players, events or stats. FIFA rankings remain a separate source-audit and rights decision.

There is enough real Nations League data to make the International navigation first-class and to render group-scoped tables and canonical match intelligence there. A World Cup hub, bracket and tournament profiles must wait for canonical World Cup rows. No FIFA marks or trade dress are used.
