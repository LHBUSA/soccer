# Roadmap

## Milestone 1 — data spine (DONE locally, 2026-09-27)

- [x] Source red team: 26 sources, live evidence, verdicts
- [x] First competition selected on data: Bundesliga
- [x] Canonical schema: 3 migrations, 31 tables, target guard, RLS; rollback-only proof on tkmln
- [x] Wyscout adapter and archive; OpenLigaDB adapter and archive
- [x] One full season end to end: identities, fixtures, results, lineups, substitutions, 519k events with coordinates, derived counts, idempotent re-run
- [x] Cross-source proof: fixture-graph teams, 306/306 scores, event-aligned scorers
- [x] One match through the whole chain: evidence packet, gated article, rendered match page
- [x] Current season 2026/27 on the same graph (OpenLigaDB)

## Next, in order (each needs the approval noted)

1. **Apply migrations to tkmln** — owner approval. Then run the Wyscout backfill against tkmln through a PostgREST/SQL store adapter (not built yet; PGlite is the only backend today).
2. **Create R2 `soccer-source`** — owner approval. Upload the `.raw/` captures, which keeps capture keys unchanged.
3. **`soccer-ingest` Worker** — owner approval for resources and the first deploy:
   - OpenLigaDB lane on a cron (current season every 10 min on matchdays, hourly otherwise);
   - canary in `docs/evidence/source-canary-latest.json`, which flips `production_ready` in the registry;
   - backfill OpenLigaDB results 2004/05–2025/26 and goals from 2009/10.
4. **`soccer-api` Worker plus the first pages** (Milestone 2): Today, Match, Team, Player, Competition, News hub. SSR heads, JSON-LD and sitemaps come from a `soccer-web` edge Worker, following the tennis pattern.
5. **Newsroom Worker:**
   - current-season Bundesliga match recaps from OpenLigaDB. These are results-only packets: the score, goals, table and form, with no event stats. The composer must degrade honestly;
   - competition-intelligence stories: title race, qualification, relegation.
6. **Identity enrichment:**
   - Wikidata QIDs for players and teams, with name+DOB rules and Wikidata-held ids;
   - a legitimate roster source for current-season scorers (131 queued).
7. **Remaining big leagues** — an owner decision on how:
   - Wyscout 2017/18 backfill for EPL, LaLiga, Serie A, Ligue 1, WC 2018 and Euro 2016 (same lane, a registry entry each);
   - openfootball current seasons with a fixture-graph proof per season.
8. **Research** (not published): possession derivation v0, xG v0 on the Wyscout shot pool, and xT v0 from passes only.
9. **PBEcast playback.** Only for matches whose ledger has coordinates, and it never implies tracking.

## Blocked on owner decisions

These are listed in `docs/SOURCE_MATRIX.md#owner-decisions-this-matrix-raises`:
- StatsBomb consent
- Football-Data.co.uk permission
- acceptance of the ODbL obligations
- how current-season event data is acquired
- ESPN for soccer
