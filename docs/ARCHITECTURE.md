# Architecture

## Topology

Network rule: GitHub = source, Vercel = frontend, Supabase = data, Cloudflare = runtime.

```
external source ──> soccer-ingest (CF Worker, cron) ──> R2 soccer-source (raw, write-once)
                           │
                           └─> parsers -> identity -> Supabase SPORTS (soccer_* tables)
                                                              │
                     soccer-news (CF Worker) <────────────────┤  packets, gates, articles
                     soccer-api  (CF Worker) <────────────────┘  read-only public API + cache
                           │
browser  ───────────> soccer.propbetedge.ai (Vercel static + soccer-web edge heads/sitemaps)
```

- **The browser only ever calls `soccer-api`.** It never calls a provider or Supabase, and never holds a service role. `scripts/guard-truth.mjs` fails the build on a third-party `fetch` in `src/`.
- **Workers:**
  - They are deployed with Wrangler, never from GitHub Actions.
  - Schedules are Cloudflare Cron.
  - Deploys need `compatibility_flags = ["nodejs_compat"]` (`node:crypto` for UUIDv5 and sha256).
- **Historical backfills run as Node scripts** (`scripts/backfill/`), against the same library code the Workers use. For example, the Wyscout zip is 77 MB and 519k events, which is not a job for a Worker invocation.

None of the Workers exists yet. `workers/soccer-ingest/src` and `workers/soccer-news/src` are the libraries they will wrap. A `wrangler.toml` is only added when a Worker is ready to deploy, and deploys need owner approval.

## Storage decision

Soccer uses the **SPORTS project `tkmlnhmylqnttmnsnief`**, the same project as tennis, UFC, NFL and NBA models. It does not get a soccer-specific project. Checked read-only on 2026-09-27 (`docs/evidence/storage/tkmln-2026-09-27.json`):
- Postgres 17.6
- the guard markers are present
- no identity tables
- no `soccer_*` tables yet

The reasons:
- **The DB-split standard assigns it by duty.** Sports intelligence goes to tkmln; identity and billing go to rlfy. Soccer has no identity or billing tables of its own. Entitlement is All Access, which is served by the existing auth layer.
- **One graph project keeps future cross-sport work possible.** That includes the entity graph, the newsroom and market intelligence, without a service key spanning projects.
- **Table prefix `soccer_`, RLS on everywhere with no anon/authenticated policies.** Only Workers holding the service role read and write.

The migration target guard refuses any project without `ufc_bouts` +
`ufc_model_versions`, and any project with `pbe_sport_entitlements`. A
rollback-only proof passed on the real project:
- 31 tables, all with RLS
- the frozen-packet trigger works
- the catalogue fingerprint is unchanged
- zero residue

**Raw evidence goes to R2**, bucket `soccer-source` (to be created, owner approval). Its layout is mirrored locally under `.raw/` for backfills:
- `soccer-source/<family>/sha256/<aa>/<sha256>`: the payload, written once and never overwritten.
- `soccer-source/<family>/captures/<yyyy-mm-dd>/<capture_id>.json`: the capture record.

`capture_id` = sha256(`METHOD normalizedURL|captured_at`)[:24]. Capture records are mirrored in `soccer_source_captures`, and every canonical row points at one.

## Ingest contract

1. **Fetch** through `workers/shared/http.js`:
   - honest user agent
   - one request at a time per host
   - no cookies
   - access control raises `SourceBlockedError`, with no retry
2. **Archive** the bytes before parsing (`archive.js`).
3. **Parse** with a pure, versioned parser (`workers/providers/*`). Shape drift throws, and nothing is parsed.
4. **Resolve identity** (`identity.js`). See `docs/DATA_MODEL.md#identity`.
5. **Write** with `syncRows`:
   - batch upsert keyed on natural keys
   - identical rows are untouched, so a re-run writes 0 rows
   - changed fields are updated and logged to `soccer_source_changes`
6. **Derive** counts (`derive.js`, `pbe-counts/1.0.0`) from the ledger.

Lanes:
- **`wyscout-lane`:** the founding lane for the historical seasons it covers.
- **`openligadb-lane`:**
  - on seasons that already have canonical fixtures, it proves teams by fixture graph, crosswalks matches and aligns scorers;
  - on other seasons, it resolves through the crosswalk or founds teams by stable id, founds matches, and writes reported goals as `goal` events without coordinates.

## Store contract (2026-09-27)

- **Lanes never issue raw SQL.** They speak only four primitives: `select`, `insert`, `upsert` (on a real unique key) and `count`.
- **Two backends implement them:**
  - PGlite runs the real migrations for tests and rehearsals;
  - PostgREST, with the service role, is production (`workers/shared/postgrest.js`). It refuses any host other than the sports project.
- **`syncRows` sits on top of those primitives:**
  - rows whose key is absent are inserted;
  - rows that changed are upserted, and every changed field is logged to `soccer_source_changes`;
  - identical rows are left alone, so a re-run writes nothing.
  `touch` stamps `updated_at` only on rows that actually changed.
- **Derived counts are computed in JS** from the rows a lane has just written.

## ESPN Core — secondary lane (owner decision 2026-09-27)

- **Access:**
  - Core API only (`sports.core.api.espn.com`). `site.api` is Akamai-blocked and never touched.
  - Sequential requests, 700 ms spacing, an honest user agent, and 30 requests per tick.
  - One competition per cron tick, rotating.
  - Every response is archived to R2 family `espn` before parsing.
- **Structured facts only:**
  - play `text`, headlines and editorial prose are stripped before hashing and never stored;
  - ESPN's own xG is kept as `qualifiers.provider_xg`, labelled `espn`, and is never PBE xG.
- **Identity:**
  - team ids are proven by a fixture-subset graph against fixtures owned by another provider. For the Bundesliga that provider is OpenLigaDB.
  - A contradiction voids the proof.
  - ESPN founds teams and matches only where no other source owns the season.
  - Athletes are founded only with a full name and birth date. A name + DOB match with an existing canonical player is queued, never merged.
- **Precedence:**
  - ESPN attaches its id to an existing canonical match, never creating a duplicate;
  - it records its result in `soccer_match_source_results`, and never rewrites a match whose `result_provider` is another source;
  - lineups and substitutions are written only where no other provider supplied them;
  - plays become the event ledger only where no richer ledger (Wyscout) exists.
  The API shows one event family per match, in the order Wyscout, then ESPN, then OpenLigaDB.
- **Scorer bridge:** OpenLigaDB current-season scorer ids (abbreviated names, no DOB) are crosswalked to ESPN-founded players by goal alignment, under the same zero-conflict rule.
- **Coordinates:** `espn_pct_v1` is 0–100, team-relative, attacking toward x=100, with y=0 on the attacking right (`docs/evidence/espn-soccer-coordinates.json`).

## Source precedence

- **Results.** Every provider's observation is stored in `soccer_match_source_results`. The canonical score on `soccer_matches` comes from the provider that founded the match; for 2017/18 that is Wyscout, because it is also the event source, so ledger goals match the canonical score. Disagreements are never overwritten. They stay visible, e.g. the 2 half-time contradictions in 2017/18.
- **Events.** There is one event family per match. OpenLigaDB goal events are only written for matches with no richer event source.
