# PropBetEdge Soccer Intelligence

An owned soccer data graph, an event-level model of the field, evidence-backed
soccer journalism and, later, proprietary analytics and market intelligence.

It is not a scores site, an odds scraper, or a frontend wrapped around someone
else's API. **No external data API may become our runtime database.**

```
SOURCE -> RAW CAPTURE -> PARSER -> IDENTITY -> CANONICAL GRAPH -> DERIVED INTELLIGENCE -> PRODUCT
```

## State (2026-09-27)

| Area | State |
|---|---|
| Source red team | 26 sources audited with live evidence: `docs/SOURCE_MATRIX.md` |
| First competition | **Bundesliga**: Wyscout 2017/18 events (CC BY 4.0) plus OpenLigaDB fixtures, results and goals (ODbL), 2004/05 to today |
| Canonical schema | 3 migrations, 31 tables. Rollback-only proof passed on the sports project. **Not applied** (needs owner approval) |
| End-to-end proof | 306 matches, 519,407 events and 535 players, run in a real Postgres engine. The re-run writes 0 rows, and event goals reconcile with the scores on 306/306 matches |
| News | Packet, composer and gates proven on one match. The article is held because it is an archive match. No publishing path exists yet |
| Frontend / Workers | Not deployed. Nothing is live |

## Layout

```
workers/shared/         ids (UUIDv5), coords (105x68), clock, archive (R2 layout), http (honest, stops at access control), render/
workers/providers/      pure parsers: wyscout-figshare, openligadb
workers/soccer-ingest/  store (change-tracked syncRows, PGlite), identity, lanes, derived counts
workers/soccer-news/    evidence packet, deterministic composer, publication gates
supabase/migrations/    0100 core graph, 0200 event ledger + stats + metric registry, 0300 newsroom
data/registry/          reviewed competition metadata + provider crosswalks
data/source-registry/   sources.json (verdicts, capabilities, verbatim terms, evidence)
scripts/evidence/       source-audit.mjs, licenses.py
scripts/backfill/       fetch-wyscout.mjs, proof-bundesliga-2017.mjs
scripts/coverage/       openligadb-depth.mjs
scripts/news/           proof-article.mjs
scripts/db/             rollback-only proof for the sports project
docs/                   operational contracts (below) + evidence/
tests/                  node --test
```

## Commands

```
npm install
npm run check                       # truth guard + 41 tests
node scripts/backfill/fetch-wyscout.mjs          # capture Wyscout into .raw/ (md5-verified)
npm run proof                       # Bundesliga 2017/18 end to end in PGlite + OpenLigaDB 2017 & 2026
npm run proof:article               # packet -> article -> gates -> match page
npm run coverage:openligadb         # historical depth scan
npm run audit:sources && npm run matrix
```

On D: (exFAT), use `NODE_OPTIONS=--require D:/Workers/exfat-readlink.cjs` for installs and builds.

## Contracts

- `docs/VISION.md`
- `docs/ARCHITECTURE.md`
- `docs/DATA_MODEL.md`
- `docs/SOURCE_MATRIX.md`
- `docs/FIELD_COORDINATES.md`
- `docs/NEWS_ENGINE.md`
- `docs/METHODOLOGY.md`
- `docs/MODEL_READINESS.md`
- `docs/ROADMAP.md`
- `docs/RELEASE.md`

## Attribution

- Event data: Pappalardo et al. (2019), Wyscout public soccer-logs dataset (figshare 4415000), CC BY 4.0.
- Fixtures and results: OpenLigaDB (openligadb.de), ODbL.
