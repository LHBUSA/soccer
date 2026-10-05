# Competition desks: hubs + autonomous newsroom lanes (design, 2026-10-04)

Status (reconciled 2026-10-05 from production, not from the 10-04 prose): **phase 1 (runner refactor) CODE COMPLETE +
PRODUCTION LIVE (`2eaf6b80`, 2026-10-05 11:27Z), OBSERVATION PENDING; phases 2-6 not live.** Principle:

> ONE Soccer platform, ONE shared hardened newsroom codebase, ONE logically independent intelligence/news engine per
> competition. No forked Workers, no per-league copies of code.

## 0. Reconciliation 2026-10-05 (what changed since this design was written)

Read from `wrangler deployments status`, production `/health` and git, 2026-10-05 ~10:40Z:

- **Production soccer-news is `c0ec2b50` = RC2.1 (main `2e24eb9`, promoted 2026-10-04 20:28Z), rollback `fc7b1337`.**
  The "held soccer-news deploy" below is RESOLVED: main was reconciled to the RC2 baseline (`10fd267`), Packet V4
  `preview-depth.js`, desk 2.2.0 and `market-freeze.js` are NOT on main (recoverable from tag `soccer-news-rc1`).
  Commits after `9a501ec` up to `909c7db` are footer-only (`src/components/footer.js`).
- **Profiles exist for the five live competitions only.** `COMPETITION_PROFILES` maps mls, premier-league,
  bundesliga (`domestic_league_relegation_playoff` since RC2), uefa-champions-league, uefa-nations-league.
  There is **no `womens_league` profile** and no mapping for LaLiga, Serie A, Ligue 1, UEL, NWSL, WSL, UWCL, Liga F,
  Première Ligue or FIFA (the section 4 claim below described excluded RC1 work). `profileFor` returns null for them:
  each new lane needs its own profile + rules record + gate tests before any canary.
- `UEL_LEAGUE_PHASE_END` / `UWCL_LEAGUE_PHASE_END` ARE Worker vars now, and a missing boundary var fails closed (the
  competition is skipped, `config_missing:<VAR>`).
- The registry `news.blocker` strings for the nine lanes still cite the held deploy; the real remaining blockers are
  profile + rules + the per-competition canary (section "Turning on the nine lanes"). FIFA stays off on policy.
- PL / Bundesliga / UCL 0 candidates on 2026-10-05 = international break (last finished 09-20 / 09-20 / 09-10, next
  10-10 / 10-09 / 10-13), i.e. quiet, not stale; today's health cannot say so per competition (phase 2).

### Phase progress

| Phase | State |
|---|---|
| 1 runner refactor (`runCompetition`, same 5, sequential, in process) | CODE COMPLETE (main `8292d10`, parity proof) · PRODUCTION LIVE soccer-news `2eaf6b80` 2026-10-05 11:27Z (rollback `c0ec2b50`) · OBSERVATION PENDING (gate = several real cron cycles with unchanged newsroom semantics, owner 2026-10-05) |
| 2 per-competition state + health (KV) | code on branch `soccer-news-phase2` only; deploy waits for the phase 1 observation gate |
| 3-6 | design below |

Phase 1 parity proof: `tests/news-runner-parity.test.js` against `tests/fixtures/news/legacy-pipeline.js` (the RC2.1
pipeline verbatim) + a frozen production replay (`tests/fixtures/news/runner-parity-prod.json.gz`, captured read-only by
`scripts/news/runner-parity-capture.mjs`): identical read sequence, summaries, story keys, packets, statuses and writes.

The original design (2026-10-04, main `eb33bf9`, production then `fc7b1337`) follows unchanged.

## 1-3. Product vs newsroom: the exact mismatch

Production soccer-news is **`fc7b1337` = main `6fec521` (soccer-news/1.5.0, 2026-09-29)**. The registry is bundled
into the Worker at deploy time, so production publishes for exactly the competitions enabled in the registry *as of
6fec521*. Main carries 7 undeployed soccer-news commits (`61d35cd` Newsroom V3 previews/Packet V4 ... `dc89c9e` market
freeze), held behind the owner's newsroom gate.

| Competition | Product (frontend `enabled`) | Newsroom (registry `news.enabled`) | Blocker as recorded in the registry | Profile |
|---|---|---|---|---|
| MLS | live | **on** | — | `mls` |
| Premier League | live | **on** | — | `domestic_european_league` |
| Bundesliga | live | **on** | — | `domestic_european_league` |
| Champions League | live | **on** | — | `ucl_league_phase` -> `knockout` 2027-02-01 |
| Nations League | live | **on** | — | `nations_league` -> `nations_league_knockout` 2026-11-19 |
| LaLiga | live | off | held soccer-news deploy (owner blind-review picks) + per-competition desk canary | `domestic_european_league` |
| Serie A | live | off | same | `domestic_european_league` |
| Ligue 1 | live | off | same | `domestic_european_league` |
| Europa League | live | off | same | `ucl_league_phase` -> `knockout` (`uel_league_phase_end`, defaults 2027-02-01) |
| NWSL | live | off | same | `womens_league` |
| WSL | live | off | same | `womens_league` |
| UWCL | live | off | same | `ucl_league_phase` -> `knockout` 2026-12-19 |
| Liga F | live | off | same | `womens_league` |
| Première Ligue | live | off | same | `womens_league` |
| FIFA World Cup | live (archive) | off | **policy**: 2026 tournament complete; no historical recap/backfill policy | `nations_league` -> `nations_league_knockout` |
| EURO | disabled | off | no canonical competition row; next EURO 2028 | none |

So the nine new lanes are blocked by two things, both owner gates, neither technical debt:
1. **The held soccer-news deploy.** Enabling a competition = a registry flag + a Worker deploy, and the next deploy
   ships everything on main since 6fec521 (Newsroom V3 preview depth, season-view reads, market freeze).
2. **A per-competition desk canary** that does not exist yet as a tool for a *newly enabled* competition.

Live evidence (production `/health`, last run 2026-10-04T18:07:30Z, 45.8 s wall): 5 competitions iterated; Nations
League 8 candidates / 8 duplicates, MLS 3 / 3, the rest 0. Published stories (latest 100): MLS 21, International 11,
Bundesliga 9, Premier League 5; newest 2026-10-03T19:07Z.

## 4. Existing profile coverage

`profiles.js` (soccer-news-profiles/1.1.0) already maps **every** product competition to a format-safe profile (table
above), including `womens_league` (overall table only; zone / play-off / relegation / Champions-League-place language
banned because those rules are not stored) and date-switched league-phase -> knockout profiles for UCL, UEL, UWCL, UNL
and FIFA. Gaps that matter for enablement:

- `uel_league_phase_end` and `uwcl_league_phase_end` exist in code but are not wired as Worker vars (only
  `UCL_LEAGUE_PHASE_END` is); the defaults are correct today but should be explicit vars before UEL/UWCL go live.
- `ucl_league_phase` bans table language because, when written, no verified league-phase table was stored. UCL and UEL
  now have a verified league-phase table (`espn_standings`, World Coverage 10-03). Keep the ban until a profile change
  with its own gate tests; never relax it as a side effect of enablement.
- `domestic_european_league` zones are `top: 4, bottom: 3` for all five leagues. That is true for the Premier League
  and LaLiga, but Bundesliga and Ligue 1 relegate 2 directly + 1 play-off (Ligue 1 has 18 teams), and Serie A's
  European places vary. Per-league `zones` must come from a per-competition rules record before Serie A / Ligue 1 table
  angles are allowed, or those two leagues must start with table angles off.

## 5. Hub / desk route coverage

- **Hub:** `/competitions/:slug` (src/pages/competition.js) is generic over the registry: Overview (LIVE NOW, upcoming,
  results, table / group leaders), Table, Results, Upcoming, Teams, a related-news slot, data coverage. It now carries
  the approved competition logo (13/15) and team crests (313/319 active teams). Missing for a "league hub": a
  competition-scoped news rail with a link to its desk, PBEcast entry for that competition's live / replay matches,
  Player DNA leaders scoped to the competition, and league story categories.
- **Desks:** router.js serves `/news/:desk` + articles for mls, premier-league, la-liga, serie-a, ligue-1,
  champions-league, europa-league, bundesliga, international (Nations League), fifa, nwsl, wsl, uwcl, liga-f,
  premiere-ligue. Every product competition has a desk route; empty desks are `noindex`. Route coverage is not
  permission to publish.
- **Two competition lists remain** (src/lib/competitions.js and data/registry/competitions.json). The hub work must
  read one: the registry is the source of truth for ingest + news; the frontend list should become generated from it
  (desk, mono, accent, nav, spatial, darkPlate as registry fields), not a second hand-kept list.

## 6. Proposed competition-runner architecture

```
cron 7,37 (unchanged, ONE schedule)
  -> orchestrator: global breaker checks -> activity state per enabled competition (one canonical read)
       -> due runners (state + last_run) -> dispatch each runner as its OWN invocation
            runner(slug): loadSeason -> detectors allowed by state + registry stories -> frozen packet
                          -> profile(slug, kickoff) -> desk (competition allowance) -> gates -> publish | HOLD
                          -> write news:comp:<slug>:state
       -> write news:last_tick, news:last_run (aggregate of runner states)
```

- **Same Worker, same code.** The runner is today's per-competition loop body in `runNews`, extracted into
  `runCompetition(store, slug, ctx)`. The orchestrator replaces the `for (const slug of competitions)` loop.
- **Isolation by invocation, not by fork.** The orchestrator dispatches runners through a self Service Binding
  (`POST /v1/runner/:slug`, internal-only, admin-token authenticated). Each runner gets its own CPU budget (60 s) and
  its own subrequest budget (10,000 on Paid; measured 2026-09-11, cf-service-binding-limits), at chain depth 2 (limit 32).
  A slow or failing competition cannot exhaust another's CPU or subrequests or break the tick. Service bindings are
  not a billable resource. **Cloudflare Queues are NOT proposed** (a new paid resource; would need explicit cost approval).
- **Story keys and evidence are unchanged.** `event_id = uuidv5("news_event:" + key)`, the append-only
  `soccer_article_evidence` trigger, and every gate stay exactly as they are, so a runner refactor cannot duplicate or
  rewrite an existing article.
- **Registry stays the single switch.** `news.enabled` + `news.stories` per competition, plus new per-competition
  fields: `news.allowance` (budget share), `news.canary` (`off | canary | live`), `news.rules` (zones etc.).

## 7. Per-competition health / state schema

Phase 1 = KV only (no migration), key `news:comp:<slug>:state`:

```json
{
  "slug": "nwsl", "mode": "live | canary | off", "activity": "quiet|pre_match|matchday|live|final_ready|post_match",
  "last_run_at": "...", "last_run_outcome": "ran|skipped_not_due|failed|breaker_open", "elapsed_ms": 0,
  "next_due_at": "...", "season": "2026",
  "candidates": 0, "new": 0, "duplicates": 0, "published": 0, "held": 0,
  "by_class": {}, "hold_reasons": {}, "existing": { "published": 0, "held": 0 },
  "newest_published_at": "...", "fixtures_next_24h": 0, "live_matches": 0, "awaiting_enrichment": 0,
  "spend_today_usd": 0.0, "allowance_today_usd": 0.0, "desk_calls_today": 0,
  "enabled_story_classes": ["match_recap", "..."], "profile": "womens_league", "engine": "...", "registry_version": "..."
}
```

`/health` gains `competitions[slug]` = that state plus the existing `publicationDiagnostic` per competition
(cron_not_firing / run_failing / publishing / healthy_material_held_by_gates / healthy_no_publishable_material), and a
per-competition `stale` flag (a `live` competition with fixtures but no runner in 2 h is a failure, a quiet one is not).

Phase 2 (owner-approved migration, optional): nullable `competition_slug` on `soccer_news_openai_usage` so spend per
competition is durable, not just in KV. Same rollback-only proof flow as migration 1300.

### Phase 2 as implemented (branch `soccer-news-phase2`; NOT deployed)

- `workers/soccer-news/src/runner-state.js` (soccer-news-comp-state/1.0.0): after each runner of a REAL run (cron or
  non-dry `/v1/run`; never dry / review / forced preview) `news:comp:<slug>:state` = slug, mode, activity, last_run_at,
  last_run_outcome (`ran | failed | skipped_config | no_season`), elapsed_ms, error, next_due_at (next 7,37 tick; every
  competition still runs every tick), season, competition_id, candidates/new/duplicates/published/held, hold_reasons,
  by_class, existing {published, held, other, held_reasons}, new_recaps, desk_calls (non-deterministic routes this run),
  fixtures {live_matches, live_status_stuck, live_kickoffs, fixtures_next_24h, next_fixture_at, upcoming_kickoffs
  (<= 7 days, max 12), last_finished_at, last_match_update}, recaps {finished_in_window, ready, awaiting_enrichment,
  too_soon}, enabled_story_classes, profile, versions {engine, gates, desk, quality, packet, router, state},
  registry_version. Spend per competition is NOT tracked (phase 5).
- Activity from canonical rows the runner already loaded (zero extra reads): `live` (status live, kick-off <= 6 h ago;
  older = `live_status_stuck`, never live) > `final_ready` (a NEW ready recap this run) > `matchday` (kick-off <= 12 h)
  > `pre_match` (<= 26 h) > `post_match` (last result <= 36 h) > `quiet`. Awaiting enrichment is counted, never final_ready.
- `/health` adds `competitions` (aggregate state + status code unchanged): per enabled competition
  `news-health.js competitionDiagnostic` = disabled | cron_not_firing | state_missing | state_malformed |
  state_unreadable | runner_stale (no run within 2 h while active, 6 h while quiet; activity re-derived NOW from the
  stored fixture timeline) | run_failing | blocked_by_runner_failure (no isolation until phase 3) | config_missing |
  no_season | publishing | healthy_material_held_by_gates | healthy_no_publishable_material; newest published per
  competition from articles -> news events -> competition id. `off` lists the 11 OFF competitions with
  `publishing_profile: none` (no profile is invented).
- Failure semantics: the state hook runs after the runner finished; a hook / KV failure is logged and counted
  (`news:last_run.state_writes`), never thrown, never retried into the run; health then reports that competition's
  state as missing/stale. A runner exception still fails the tick (phase 1 semantics); its state records `failed`.
- Proof: tests/news-comp-state.test.js (frozen production replay with the recorder == RC2.1 reads/summary/writes;
  activity, enrichment, live, failure, staleness, persistence-failure, config, /health compatibility);
  dark preview on production data `scripts/news/comp-state-preview.mjs` ->
  docs/evidence/news/comp-state-preview-2026-10-05.json.

## 8. Scheduling model (canonical fixture state; no provider polling)

One canonical read per tick: `soccer_public_matches` for enabled competitions with kickoff in [now - 8 h, now + 26 h],
plus each competition's enrichment ledger for finished matches. State per competition, highest wins:

| State | Condition | Runner cadence | Detectors |
|---|---|---|---|
| `live` | a match `live` | every tick (30 min) | none publish on live (no live stories exist); runner checks readiness only |
| `final_ready` | a match finished and its enrichment ledger final (recapReadiness) | **this tick** | match_recap (+ form / trend fallout) |
| `matchday` | a fixture within 0-12 h | every tick | match_preview, matchday_brief, recaps |
| `pre_match` | a fixture within 12-26 h | hourly | match_preview (1-24 h window as today) |
| `post_match` | last match finished < 36 h ago | every 2 h | team_trend, player_form, table_watch / group_watch |
| `quiet` | none of the above | every 6 h | table_watch weekly windows only |

The cadence never changes WHAT a detector may write (same windows, materiality, dedupe keys), only how often it looks.
A Champions League night wakes UCL; an NWSL matchday wakes NWSL; a quiet Ligue 1 week costs one cheap read per 6 h.

## 9. Budget isolation model

Today: `SOCCER_OPENAI_DAILY_MAX_USD` (default $5) is ONE global, fail-closed ceiling checked per desk call, and
competitions run in registry order with `maxPerCompetition = 12`. A busy first competition can consume the whole
day's ceiling before a later one is reached: that is the starvation path.

Proposed (all in code + KV, no new resource):
- **Global breaker stays** (same var, same fail-closed semantics): nothing passes it.
- **Per-competition allowance** = floor + share: each live competition gets a guaranteed floor
  (`news.allowance.floor_usd`, e.g. 1/N of 60% of the ceiling), the remaining 40% is a shared pool claimed by
  priority (final_ready recaps first, then previews, then form/trend). Canary competitions get a small fixed allowance
  and never touch the shared pool.
- **Per-competition story cap per day** (`news.allowance.max_stories_day`) in addition to the per-run cap.
- A runner over its allowance HOLDS with `budget_competition_allowance` (a recorded hold, retried next day), never
  spills into another competition's floor.
- Spend accounting per competition: KV day log keyed by slug (phase 1), ledger column (phase 2).

## 10. Migration / deploy sequence (preserves every article and frozen packet)

Nothing below touches `soccer_articles`, `soccer_news_events` or `soccer_article_evidence` rows; story keys are
unchanged, so every existing article is a duplicate to the new runners, never a rewrite.

0. **DONE 2026-10-04: RC2.1 promoted (c0ec2b50).** ~~Owner decision on the held newsroom deploy~~ (the 7 commits since 6fec521). The runner refactor should ship
   AFTER that deploy is accepted, never bundled with it, so each release has one reason to roll back.
1. **Refactor, behaviour-identical** (one PR-sized commit): extract `runCompetition`; orchestrator runs the same 5
   competitions **sequentially in-process** first. Parity test: for a frozen PGlite fixture, old `runNews` and new
   orchestrator produce identical candidates, keys, packets and statuses (dry). Deploy; compare `/health` for 24 h.
2. **Per-competition state + health** (KV), still the same 5 competitions. Deploy.
3. **Self-binding dispatch** (runner per invocation). Deploy; rollback = previous version (cron unchanged).
4. **Activity-aware scheduling** for the 5 live competitions. Deploy; verify recaps still fire on `final_ready` the
   same tick (compare publication latency before/after on real matchdays).
5. **Allowance model** with allowances that equal today's behaviour (floor 0, pool 100%), then tighten.
6. **Per-competition enablement**, one at a time (below). Each is a registry change + deploy, rollback = previous
   version; its articles stay published (never deleted by a rollback).

Every Worker release goes through `scripts/release/release-worker.mjs` (exact-version promote, canary, ledger);
every source change through `scripts/release/push-main.mjs`.

## Turning on the nine lanes, one at a time

Per competition (order proposal: LaLiga -> Serie A -> Ligue 1 -> Europa League -> WSL -> UWCL -> NWSL -> Liga F ->
Première Ligue; men's then women's, matching the ingest rollout):

1. **Rules record**: `news.rules` (zones, tiebreak) verified for that league; Serie A / Ligue 1 start with table
   angles OFF until verified. UEL / UWCL league-phase end dates as explicit vars.
2. **Dry canary** (`news.canary: "canary"`): runner runs with `dry=1` semantics (zero model calls, zero writes) for one
   real matchday; evidence = candidates, packets, profile, gate results, would-be holds. Requires a script
   `scripts/canary/news-competition.mjs --slug X` (does not exist yet; same shape as the ingest competition canary).
3. **Desk canary**: 3 stories through `/v1/admin/reedit?canary=1` style forced-dry desk runs (non-publishing) for
   recap / preview / form; owner blind review of the outputs.
4. **Live with allowance**: `news.enabled: true`, small allowance, 7-day watch on holds, cost and
   duplicates; then the normal allowance.
5. **Hub**: competition news rail + desk link turn on only when that desk holds a published story (no empty modules).

Known per-lane cautions:
- **NWSL**: 92 early-season matches have only 0-1-scale coordinates (no event map); recaps must not depend on shot maps
  (visuals already drop when shots < 6).
- **Liga F, Première Ligue**: `spatial: false`; no shot maps at all. 6 Première Ligue clubs have no crest.
- **UWCL / UEL**: verified league-phase table exists; keep `ucl_league_phase` table bans until a profile change is gated.
- **Women's names**: ESPN names women's sides like the men's club; identity is already gender-safe in ingest and crests.
  Headlines must use the canonical team name ("Barcelona Women"), which the entity-grounding gate already enforces.
- **FIFA World Cup**: stays off until a historical / current-tournament policy exists (no backfill spam).

## Global `/news`

`/news` becomes an aggregator over published articles of all live desks: a LIVE INTELLIGENCE strip from the
per-competition states (new stories, live matches, next matchday), then TOP STORIES (materiality x recency, max 2
per competition in the top 6 so one busy league cannot take the page), BY COMPETITION rails, and class rails
(match reports, previews, form & trends, table watch). It owns ranking and layout only; detection, profiles and
publication stay in the competition runners.
