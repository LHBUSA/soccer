# PropBetEdge Soccer — production state

Reconstructed 2026-09-28 from the repository, applied migrations, `docs/deployments.jsonl`, the
production APIs (`/v1/data-health`, `/v1/health`) and the QA/evidence files. The repository and
evidence are the source of truth; nothing here comes only from chat memory.

## Surfaces

| Surface | Where | Release |
|---|---|---|
| Web app | https://soccer.propbetedge.ai — Vercel project `soccer` (prj_3UgFIxhnlVcLmhnnNDc1WoHOtXGn; never `soccer-hs22`) | git-connected: **every push to `main` deploys production** |
| soccer-api | Cloudflare Worker (public read API; reached by the browser only through the same-origin `/api/soccer/*` edge proxy) | `scripts/release/release-worker.mjs` |
| soccer-ingest | Cloudflare Worker, cron `* * * * *` (live lane every minute; every other lane on the 5-minute boundary) | same (the script also deploys + verifies cron triggers, which `versions deploy` does not) |
| soccer-news | Cloudflare Worker, cron `7,37 * * * *`, `NEWS_ENABLED=on`, optional LLM pass `NEWS_LLM=off` | same |
| Data | Supabase SPORTS project `tkmlnhmylqnttmnsnief`, tables `soccer_*`, RLS on, no public policies | migrations below |
| Raw archive | R2 bucket `soccer-source` (write-once captures; content-addressed media) | — |

## Current versions (from docs/deployments.jsonl; release script verifies the live version)

| Worker | Live version | Rollback |
|---|---|---|
| soccer-api | `a9970370` (2026-09-29, main 7d48824: serves frozen article visuals only while intact; + news-subject rule, newsroom health) | `2fd0e5e9` (then `2f8a5b0d`) |
| soccer-ingest | unchanged by the 2026-09-29 newsroom / PBEcast release (see docs/deployments.jsonl) | — |
| soccer-news | `770e2e5a` (2026-10-06 02:06Z, main 5bc79e9 = phase 5A competition budget control plane, soccer-news-budget/1.0.0, behaviour-identical policy floor 0 / pool 100 %; first real tick acceptance PENDING; rollback `25bb40ac`) on top of `25bb40ac` (2026-10-05 19:52Z, main 4f62bf8 = phase 4 activity-aware scheduling, soccer-news-schedule/1.0.0; ACCEPTED on the first real scheduled tick 2026-10-05 20:07:38Z; rollback `03666f90`) on top of `03666f90` (2026-10-05 15:15Z, main 09ef93f = phase 3 patched: isolation 1.1.0, soccer-news/1.6.0, sequential real dispatch + cooperative runner time budget; ACCEPTED 2026-10-05 on the real scheduled tick 15:37:38Z (5 sequential runners ran, 0 failed, state_writes 5/0, fingerprints unchanged); SAFE rollback `179e4499` (phase 2), release-script rollback `3151b3e6` carries the concurrency regression) on top of `3151b3e6` (2026-10-05 14:18Z, main 641b279 = phase 3 competition runner isolation: cron dispatches each enabled competition through the loopback WorkerEntrypoint ctx.exports.NewsRunner, flag enable_ctx_exports; first cron 14:37:50Z ran, 5/5 runners ran, state_writes 5/0; rollback `179e4499`) on top of `179e4499` (2026-10-05 13:12Z, main ab54f62 = phase 2 per-competition state `news:comp:<slug>:state` + /health `competitions`; first production tick state_writes ok=5 failed=0; ACCEPTED by owner) on top of `2eaf6b80` (2026-10-05 11:27Z, main 8292d10 = RC2.1 + phase 1 competition runner, behaviour-identical; 3 clean cron cycles) on top of `c0ec2b50` (2026-10-04 20:28Z, RC2.1 = main 2e24eb9: published-season reads, newsroom health truth, explicit league-phase vars fail closed, domestic claim bans, admin review mode, soccer-quality/2.1.1 + soccer-desk/2.1.1; 5 publishing competitions) | `fc7b1337` |

Rollback: `cd workers/<worker> && npx wrangler versions deploy <rollback>@100% --yes`. Web rollback: Vercel instant rollback to the previous production deployment.

## Migrations (all applied, each after a rollback-only proof with an unchanged catalog fingerprint)

`0100` core graph · `0200` events · `0300` newsroom (append-only evidence) · `0400` attribute_corroborated player crosswalk · `0500` governed media registry · `0600` enrichment ledger + season groups/standings + media discovery/trademark status · `0700` private model shadow (predictions frozen by trigger, append-only events/metrics). · `0800` owner-approved identification media (APPLIED 2026-09-28, sha256 12f2ec07…; rollback docs/evidence/storage/rollback-0800-2026-09-28.sql). · `1300` soccer-news OpenAI usage ledger V4 routing columns (APPLIED 2026-09-29, sha256 4e7ef213…: 9 nullable columns + index `soccer_news_openai_usage_lane`; rollback-only proof: all checks passed in-txn, fingerprint 7dc26dab unchanged, zero residue; after apply RLS on, 0 policies, no anon/authenticated privilege, the 2 historical rows byte-identical on their original columns with NULL routing). Rollback: `alter table public.soccer_news_openai_usage drop column sport, drop column worker, drop column story_class, drop column routing_lane, drop column routing_reason, drop column pool, drop column router_version, drop column latency_ms, drop column nominal_standard_cost;` (drops the index with it) after setting `SOCCER_LEDGER_ROUTING` off.

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
- `espn_live` (soccer-ingest 1.2.0, cron `* * * * *`) runs every minute for ESPN-owned matches in the live window, within a 45-request budget per tick: status + provider clock + score every tick, play-by-play every tick, team stats every 3 min, lineups every 10 min, one final pass (ledger recorded) at full time. State in KV `live:<matchId>`; one tick at a time (`live:lock`). The enrichment ledger is not written mid-match. Not real time: about one source check a minute plus ESPN's delay.
- **Bundesliga live (V3.1, SHADOW)**: OpenLigaDB owns and publishes Bundesliga results (~5 min lane cadence, no provider clock; PBEcast says so). The live lane also polls proven-crosswalk Bundesliga matches from ESPN as **shadow enrichment**: KV `live:<id>` (role enrichment, mode shadow, fetched_at, score, clock, first-seen time of every play) + R2 captures only; never `soccer_matches`, source_results or the ledger mid-match; soccer-api serves it only when the registry mode is `public` AND `LIVE_ENRICHMENT_PUBLIC=on` (both off). Disagreements (>10 min) and final mismatches are logged in KV `live:disagreements`; the canonical result is never overwritten. Internal view: `GET soccer-ingest /v1/admin/live[?match=]` (admin token).
- **Hardening (1.3.0)**: per-match error isolation; ESPN breaker `live:breaker:espn` (3 failed ticks -> 5 min; SourceBlockedError -> 60 min, never retried); enrichment-only failures never fail the lane or `/health` `ok`; ledger corrections: withdrawn plays archived to R2 `soccer-source/espn/retractions/` then removed, moved plays re-sequenced, >50% disappearance held as `provider_glitch_suspected` (confirmed only after 3 identical reads); tick metrics `live:metrics`. `/health` reports `canonical` and `live_enrichment` separately (`?detail=1` adds fixture coverage).
- **First-live proof**: `node scripts/canary/first-live.mjs --match <uuid>` (run ~20 min before kick-off; refuses finished matches).
- **Live acceptance PENDING**: the per-minute lane has not yet worked a real match (international break). First window: MLS Red Bull New York v St. Louis, 2026-09-30 23:30Z. Check: `/v1/live` shows `live[].live.display_clock`, `/v1/matches/:id/cast` `live.stale=false`, soccer-ingest `/health` `espn_live` runs advancing each minute, and a final pass (`final_done`) at full time.
- `/v1/data-health`: per-competition teams, fixtures, result and optional-component gaps, stale live, identity queue, media coverage, lane state, news generation and held reasons.

## Media (docs/MEDIA.md)

- Portraits: 789 free-licensed (Wikidata/Commons: exact ESPN FC player id P3681 or attribute corroboration in a proven club) + 344 ESPN headshots (exact ESPN athlete id from the team roster payload, birth date checked; owner_approved_identification).
- Crests LIVE 2026-09-28 (measured in production): 95/95 unique active clubs (MLS 30/30, PL 20/20, BL 18/18, UCL 36/36): 8 free-licensed Commons (`approved`) + 87 ESPN crests by exact ESPN team id (`owner_approved_identification`, licence text "Not free-licensed", provider espn, policy owner-identification/2026-09-28). OWNER MEDIA DECISION 2026-09-28: crests and player media approved for product identification; no internal holds. Portraits: 1,133 unique players (789 free + 344 ESPN by exact athlete id + birth date). Proof: docs/evidence/media/crest-api-2026-09-28.json, crest-ui-2026-09-28.json, provider-media-2026-09-28.json. Re-run: `node scripts/media/provider-media.mjs` (free Commons primaries always win).
- Competition logos LIVE 2026-09-28 (main 79c7885): MLS, Premier League, Champions League, Bundesliga by exact ESPN league id (canonical `soccer_competition_external_ids` espn id == ESPN payload league slug); default + ESPN dark variant, owner_approved_identification; ONE component `competitionMark()` (src/components/media.js) on 11/11 surfaces, mono only as fallback. Re-run: `node scripts/media/competition-logos.mjs` (rewrites src/lib/competition-media.js).
- PBEcast replay contract (main 79c7885): `replayView()` over `stateAt()` is the single replay state (score, clock, NOW line, pitch marks, feed, timeline, caption); nothing after the cursor is in the markup. Browser contract `node scripts/qa/replay.mjs` (163/163 production, Dallas 1-0 LAFC, 1440 + 390).
- Player photos 2026-09-28: +67 free-licensed portraits via exact ESPN athlete id == TheSportsDB idESPN (id crosswalk only) -> idWikidata -> Wikidata birth date equal + no different P3681 -> Commons classifier (`node scripts/media/crosswalk-portraits.mjs`, `--active` for all active players). Portrait primaries: 856 free-licensed + 344 owner-approved ESPN = 1,200 players. PBEcast audit (`node scripts/media/pbecast-portraits.mjs`, 14 matches): 286/508 visible players real, 222 silhouettes, all 'no approved photo' (0 API bugs, 0 UI bugs).
- SOCCER NEWSROOM V2 + OFFICIAL VIDEO (2026-09-29): /news redesigned (src/components/newscard.js one NewsCard system: featured / rail / standard / compact; modules on the navy shell; title-case headlines; photo-panel imagery; sections Match reports / Form & trends / Table watch / More stories / By competition; template metadata never shown as a dek). Official video: migration 0900 APPLIED (soccer_video_channels / soccer_videos / soccer_video_links), 35 channels verified by Wikidata P2397 + canonical channel page (4 competition / governing body, 31 clubs), keyless ingest `node scripts/videos/ingest.mjs` (manual; no schedule yet), matcher soccer-video-match/1.0.0 threshold 75 (docs/VIDEO.md), API `media.videos` on articles + GET /v1/videos, poster-first youtube-nocookie player with 100/101/150 fallback, VideoObject only for validated links. CSP adds img-src i.ytimg.com + frame-src youtube-nocookie.com only.
- Trademark status is stored separately from copyright; free-licensed crests are used only to identify the club.

## News (docs/NEWS_ENGINE.md)

- Composer `template/soccer-news@2.1.0`, gates `soccer-gates/2.0.0`, with competition profiles (MLS, UCL league phase, knockout, domestic).
- Published: **MLS 19, Premier League 5, Bundesliga 9, UCL 0** (no eligible UCL matchday in the window yet; the pipeline is proven by an end-to-end test).
- Held 1 (MLS, numeric grounding). Withdrawn 3 (MLS own-goal attribution error, 2026-09-28), all re-issued as corrections.

## DNA and research

- Player DNA / Team DNA: descriptive, time-safe profiles with percentiles within the competition-season (`workers/soccer-api/src/dna.js`).
- Prediction research (docs/RESEARCH.md): candidate `soccer-research-bundesliga-v1.2-dc` (Dixon-Coles, rho -0.1099, no calibration; holdout log loss 0.9952 vs baseline 1.0740).
- **Private shadow (docs/SHADOW.md), LIVE 2026-09-28:** soccer-ingest lane `model_shadow_bundesliga_dc` (hourly) issues one frozen pre-kick prediction per Bundesliga league fixture within 7 days into `soccer_model_shadow_predictions` (RLS, no policies, anon revoked, never read by soccer-api). Not a product: no public surface, no promotion gate. First issue expected 2026-10-02 18:30 UTC for the 2026-10-09 fixture.

## Web V3 (2026-09-28, main 289bc8f..6a5459b, git-connected Vercel)

- One identity-image component (`src/components/media.js`): approved crest or initials mark, approved portrait or the raster silhouette (`public/brand/player-silhouette-*.webp`), used on match, team, player, news, directory, PBEcast and drawer.
- Player DNA V2 (season switcher, signature, grouped percentiles, splits); `/players` directory (per-90 leaders only inside one competition); `/pbecast` hub + `/pbecast/:id` (live / replay / pregame; cast pages canonicalise to `/matches/:id`); Player DNA drawer on player chips and directory cards; homepage PBEcast live rail.
- Fixed: `/site.webmanifest` had answered 404 HTML since Stage A (middleware file guard capped extensions at 5 chars).
- **Frontend V3 product pass (2026-09-28, main f38c7e6, bundle index-CIqPeJbJ.js)**: house score ticker in the shell (no native scrollbar; marquee on wide hover screens, swipe on touch); homepage hierarchy (PBECAST primary, featured intelligence, news desk with deterministic `selectHomepageLead`, leagues, per-competition Player DNA leaders); player hero with large portrait + percentile radar; team pages with squad portrait cards; key players on match / PBEcast / home; drawer with this match's sourced line + recent matches; `/players` team filter. soccer-api `e8303d82` (rb `a12b822d`): news card image prefers the headline's subject. Production QA 224/224 (28 routes x 8 widths incl. clipped-content + ticker checks). Portraits: 597 of 2,157 directory players (27.7%). Crest audit (docs/evidence/media/crest-audit-2026-09-28.md): 95 teams, 3 approved, 4 held by owner decision, 15 no free logo, 73 identity not proven.

## Newsroom (2026-09-28, house standard)

- soccer-news 1.1.0: detection -> frozen packet -> deterministic draft (evidence only) -> desk (`workers/soccer-news/src/desk.js`, OpenAI Responses API, model `gpt-5.6-sol`, override `NEWS_DESK_MODEL`; strict JSON schema, `store:false`, no tools/retrieval) -> grounded validation + quality gates -> publish, else HOLD. `NEWS_DESK=off` restores the legacy template path (not used).
- 2026-09-28: editorial provider switched from Anthropic to OpenAI (desk 1.1.0). The Anthropic key failed with a workspace-scope 400, so it is no longer used by the desk. BLOCKER: the Worker needs an `OPENAI_API_KEY` secret (owner action: `cd workers/soccer-news && npx wrangler secret put OPENAI_API_KEY`). Until then every new story holds with `editorial_desk_unavailable`, and the 34 earlier template articles stay published as they were.
- 2026-09-28 OpenAI live canary (dark version c115211e, temporary fixed-fixture route never in git, evidence docs/evidence/news/openai-canary-bayern-2026-09-28.json): transport PASS (gpt-5.6-sol, 2 attempts, ~51 s); Bayern rewrite HELD on `unsupported_odds` = the word "spread" ("spread across 4 scorers"), a false positive; 17/18 fact gates, 14/14 quality gates, attribution PASS. Clean candidate 4126864b uploaded dark, NOT deployed; production still 4fc1486d. Gate fix approved and shipped (main c2e4b38).
- 2026-09-28 canary r2 (dark 4348d9e0, evidence ...-r2.json): transport PASS; HOLD on `new_player_or_team` ["Against"] (sentence-opening preposition before a team name, validator false positive) and `thin_output` 448/450 (a real quality hold). Clean candidate c19584bd (main c2e4b38) uploaded dark, NOT deployed; production still 4fc1486d.
- NEWS DEPTH V2 LIVE 2026-09-28 (soccer-news 387d0d5e, rb 4fc1486d): packet soccer-packet/3.0.0 (depth soccer-depth/1.0.0: phases, goal sequence, player lines, shot profile, table move, 5 prior results, cards, subs), desk soccer-desk/2.0.0, gates soccer-quality/2.0.0. Bayern canary PASS (docs/evidence/news/depth-v2-bayern-canary-r3.json); QA 8/9 PASS, RSL correctly held. Legacy backlog (34 published templates + 2 held) NOT re-edited yet: waiting for owner inspection of the Bayern rewrite; 16 recaps rebuild as-of-safe (path A), 20 others use their original packet (path B). Re-edit needs POST /v1/admin/reedit (NEWS_ADMIN_TOKEN, owner).
- After the key: `POST /v1/admin/reedit?scope=template&limit=40` (admin token; add `dry=1` first) rewrites the earlier template stories from their frozen packets; `scope=held_desk` retries held ones. Canary: the Bayern 7-0 Union Berlin story.
- Article page V3 (network pattern) is live for every story; SOURCE & METHOD is collapsed.

## QA (latest, docs/evidence/qa)

- Browser QA (2026-09-28, production, after V3): 196/196 checks at 320/360/390/430/768/1024/1440 incl. /players, /pbecast, a PBEcast replay, replay-seek and drawer interactions; exposure + proxy checks pass.
- SEO first-response QA: 0 failures.
- axe-core: 0 violations on 10 pages × 2 widths.
- Performance (slow-4G, 4× CPU, cold cache): JS about 25 KB, CSS about 11 KB, first HTML about 2 KB compressed; LCP 1.3–2.7 s; CLS 0–0.041 on every audited page (fonts `display=optional`, main reserves the viewport). DNA season profiles cached in KV (cold Wyscout season 16 s once, then about 1 s) and warmed by a soccer-api cron (`20 */6 * * *`).

## Known gaps

- Crest coverage is limited by licensing, not identity.
- Player photos exist for about 20% of observed players: Wikidata coverage of ESPN ids is the ceiling.
- MLS West table withholds itself whenever a just-finished match is in ESPN's standings before our lane details it (minutes to about 2 h).
- Only the Bundesliga has long history; other competitions have one ESPN season.
- No injury, transfer or quote sources (by design).

## Newsroom + PBEcast release (2026-09-29, main 78c5cf7..fb9a2b7)

- **PBEcast phantom circles fixed.** Every pitch mark carried a hidden `circle.pulse`; the page loading-dot rule
  (`.pulse` + `@keyframes pulse`, opacity .25 / scale .7) animated it, so each located shot showed a pale halo
  displaced toward the SVG origin. Marks are now shot / goal / own goal with a source location only (`pitchKind`,
  `pitchItems` in src/lib/cast.js), one per source event, solid miss markers, goal rings, and only the current
  replay event highlighted (`cpulse`, once). Production QA: docs/evidence/qa/news-pbecast-2026-09-29.json (50/50 at
  360/390/768/1024/1440); replay contract 163/163 (Dallas 1-0 LAFC).
- **News imagery:** one subject rule (workers/shared/news-subject.js) for cards and heroes, never another player's
  face. 37/37 existing stories carry the primary-subject marker (scripts/news/backfill-subjects.mjs). Olise 7-0
  Union Berlin: subject Michael Olise (hat_trick), his own portrait on card and hero.
- **Newsroom:** registry-driven enablement (`news` in data/registry/competitions.json), match previews, matchday
  briefs, verified group watch, readiness-based recaps, and the `/v1/data-health` newsroom block. Diagnosis plus the
  competition / FIFA coverage matrix: docs/evidence/news/newsroom-baseline-2026-09-29.md.
- The hand-deployed soccer-news `abc1fe23` (an uncommitted TEMP backfill route authenticated by a header value in
  source) was replaced by the committed build; its source is kept in `git stash`. Legacy re-edits remain available
  through the authenticated `POST /v1/admin/reedit` (and scripts/news/reedit-backlog.mjs) ONLY. 16 legacy template
  stories are still not re-edited.
- **OpenAI cost controls (2026-09-29, main ce399b0):** the temporary `*/10` backlog-migration cron and src/migration.js
  are REMOVED (migration:control never existed; only one dry story ran). The only schedule is `7,37 * * * *`; the
  scheduled handler ignores any other cron. Automatic desk = ONE paid attempt (`NEWS_DESK_ATTEMPTS`, default 1, no
  retry on provider error); the two-attempt repair only via `POST /v1/admin/reedit?repair=1`. `max_output_tokens` 6000
  (was 18000). Every call is logged to KV `openai:v1:calls:<UTC day>` (src/openai-cost.js); cost today =
  `GET /v1/admin/openai-cost` (NEWS_ADMIN_TOKEN). Breaker `SOCCER_OPENAI_DAILY_MAX_USD` (default $5): past it the desk
  holds (`editorial_daily_budget_reached`) without calling the model.
- **Article data visuals (main 7d48824, soccer-visuals/1.0.0):** every article carries code-built visual specs frozen
  in `body.visuals` (match flow, goal timeline, shot profile, static shot map with stated coverage, player focus,
  table move / group position, form; scoring run; run results; standings; verified group tables; preview matchup
  dashboard, form, players in form; matchday fixtures board). The desk may only choose `emphasis` ids (live dry
  re-edit 2026-09-29: `["matchup","recent_form"]`). Backfill applied to all 41 published + held articles, 0 rejected
  (docs/evidence/news/visual-backfill-2026-09-29.json). Production QA 60/60 at 360-1440 (docs/evidence/qa/news-pbecast-2026-09-29.json).

## Newsroom V4 Stage 3 — AI router (ACCEPTED 2026-09-29)

- soccer-news `fc7b1337` (main 6fec521, soccer-news/1.5.0, soccer-ai-router/1.0.0); rollback `1f75b0a8` (`cd workers/soccer-news && npx wrangler versions deploy 1f75b0a8-188e-4a41-879d-1de2aba53f9f@100% --yes`). Cron `7,37 * * * *` unchanged.
- Lanes: DETERMINISTIC / VOLUME (defined, unused) / STANDARD_EDITORIAL `gpt-5.6-sol` / FLAGSHIP_EDITORIAL `gpt-6-astra` OFF (`SOCCER_AI_FLAGSHIP_ENABLED` unset, class list empty; candidate classes rich_match_report, continental_or_international). Paid triggers: new_story, admin re-edit, canary (repair = explicit attempt 2 only). Revision, backfill/scope sweeps, correction, dry_run: DETERMINISTIC. Automatic attempts: 1. Kill switch `SOCCER_AI=off`.
- Audit prerequisites fixed: (A) desk.js inline comment swallowed article_id/news_event_id — fixed, proven by the live canary row; (B) dry=1 = zero model transport + zero writes (trigger dry_run -> DETERMINISTIC); (C) withdrawn stories are terminal (automatic `:correction` re-key deleted); (D) breaker fails CLOSED: no readable ledger and no KV -> hold `editorial_budget_state_unavailable`; an explicit 0 ceiling blocks; re-checked before attempt 2.
- Production acceptance canary 2026-09-29 22:02Z: `POST /v1/admin/reedit?slug=austin-fc-san-diego-fc-2026-09-27-ac300b&canary=1` (forced dry). 1 call, STANDARD_EDITORIAL / gpt-5.6-sol / premium, trigger canary; frozen packet (path A_asof_safe_rebuild); real gates HELD the draft (new_number_not_in_packet, unsupported_comeback) -> nothing published; article row md5 a6ab0c1b… identical before/after; articles/evidence/events counts unchanged; ledger +1 row with every V4 field (response resp_0806da24…, 7,281 in / 0 cached / 1,773 out / 647 reasoning, 29.7 s, nominal_standard_cost 0.026831 — a nominal standard-rate estimate only, not evidence of actual billing).

## PBEcast live match feed V4 + FIFA World Cup tile (2026-10-02, main ee59351, Vercel dpl_9qnLLdhwiZ7Sq3PxbYMbMV2Ew9Zz, rollback dpl_Ahikig9GbC2tw7qukTenHteT1CY4)

- **Frontend only.** No Worker, migration or cadence change: the cast API already carried every field used
  (`sequence` outcome / body_part / provider_xg / assist / penalty / x,y / running score; `shot_timeline` situation).
- `src/lib/castfeed.js` (pure, tests/web/pbecast-feed.test.js): `describe()` headline + sourced facts, `shotGeometry()`
  distance / in-box (PBE derived from the source location, labelled), `xgOf()` (provider label kept: ESPN xG),
  `withShotDetail()` (joins shot_timeline situation ONLY when minute/side/player align item by item), `scoreSwing()`,
  `callLine()` (one deterministic sentence; no quotes, intent, injury or reason), `matchPulse()` (last-10-min and
  cumulative counts from the events at the cursor; xG total only when every shot of that side has provider xG),
  `liveCursor()` (provider clock; `tl.total` is the nominal 90' and must not be the live cursor).
- UI: Current Moment panel, Match Pulse, feed filters (All / Shots / Goals / Cards / Subs) + order, Prev / Next steps,
  live tap-to-focus (feed row or pitch mark), older located shots fade while one is in focus, one-shot pulse on a new
  latest event, score flash on a new goal. Second yellow is never claimed: a red card shows "Booked earlier at N'" only
  when the ledger holds that player's earlier yellow. Woodwork is not in ESPN's play map (only Wyscout `post`).
- Field coverage measured 2026-10-02 on real casts: coordinates on every ESPN shot; body part on most; goal assists
  linked; ESPN xG present on MLS, absent on UEFA Nations League. OpenLigaDB (goals-only) matches get no shot pulse.
- **FIFA World Cup tile root cause:** `accent: 'fifa'` had no `--a-fifa` / `.a-fifa`, so `--accent` was unresolved and
  the tile's gradient was invalid (white text on the light canvas). Added the FIFA theme, a `:root --accent` default
  plus a solid dark tile fallback for any unknown accent, and fixed `.cmono.lg` (the legend `.lg` dot rule made the mono
  display:block). tests/web/accents.test.js enumerates every enabled competition. Hub `/competitions/fifa-world-cup`:
  104 = 72 group + 16 + 8 + 4 + 2 + 1 + 1 knockout, 12/12 group tables verified, completed; no approved FIFA logo, so
  the owned `FIFA` mono.
- Production QA (docs/evidence/qa/pbecast-v4-fifa-2026-10-02.json): 92/92 at 390/768/1024/1440 (home tiles, FIFA hub,
  Seattle 2-1 Kansas City with ESPN xG, Denmark 2-4 Portugal, live France v Italy); replay contract 163/163.
- Observed, not fixed: soccer-api `/v1/matches/:id/cast` returned HTTP 500 on 2 of ~12 browser loads of a LIVE match
  during QA (0 of 20 direct retries); needs a `wrangler tail` during the next live window.

## 2026-10-02 — owner-approved next phase A–D (main 2963061..87c34f8)

- **A. ESPN parser espn-core/1.1.0 (isolated):** soccer-ingest `fdee715b` (rb `34ec7657` = commit 49faecc, live before
  but missing from this ledger). Functional diff vs live = parser + admin route only (video/art/registry desk unused by
  ingest). A 0-1-scale match gets no canonical location (`espn_unit_unverified`, source values kept).
- **B. Coordinate repair APPLIED:** 271 matches (MLS 2026-02-21..05-25: 218; Nations League 2024/25: 53), 54,342 event
  rows = dry run; canonical x/y cleared, relabelled, source untouched; 0 rows left with a canonical point. Rollback
  snapshot `docs/evidence/storage/espn-unit-coords-rollback-2026-10-02.json.gz` (written before the first PATCH).
  Production QA (`docs/evidence/qa/espn-unit-coords-repair-2026-10-02.json`): before 23/23, 30/30, 22/22 shots within 3 m
  of a corner flag; after 0 located, "nothing is plotted". No coordinate calibration attempted.
- **C. Season publication gate:** migration `20261002001400` APPLIED (rollback-only proof: fingerprint 48f5c2d2
  unchanged, checks-1400, zero residue). 29/29 existing seasons published; new seasons default held. Views
  `soccer_public_seasons` / `soccer_public_matches` (security_invoker; no anon/authenticated). soccer-api `583ffeb6`
  then `60f66ae8` (rb `583ffeb6`, then `88d28fc1`) reads only the views (every competition, season, match, team history,
  table, sitemap, data-health and coverage path); located-event counts use verified coordinate systems only. This release
  also shipped the previously undeployed soccer-api video/keyless changes from main (22 public routes smoke-tested 200).
  Newsroom reads switch to the views at the next soccer-news deploy (held, owner gate); its detection already ignores
  history (latest season + 4-day window, tests/history-newsroom.test.js).
- **D. Algo V2 → soccer-algo-v2.1.0:** same research, model hash `4c40fa9c`, coefficients and policy; input membership
  frozen to 362 canonical match ids (sha256 `2dc6c0b5…`, frozen_at 2026-10-02T21:51:00Z) + matches after frozen_at
  (`workers/soccer-ingest/src/algo-v2-dataset.json`). Spec `53e6b8d7…`. V2 has never run in production (ALGO_V2 off;
  0 events/forecasts/picks). Parity + backfill-immunity regression in tests/algo-v2.test.js.
- **E (started):** soccer-ingest `0b1682de` (held seasons + V2.1) then `22c8c961` (rb `0b1682de`): PASS A lanes
  `espn_<comp>@<year>:results`, repeated-pairing status rule, `scripts/history/accept-season.mjs`, queue
  `scripts/history/queue.json`.
- Known gap: Nations League 2024/25 (published) has 134 past matches with status unknown (an earlier history run never
  detailed them); acceptance fails it on that check. V2.1 would hold on them if switched on.

## Article market — writer freeze + forced preview (2026-10-04) — REMOVED FROM MAIN in 10fd267 (RC2 reconcile); recoverable from tag soccer-news-rc1; never deployed

- `workers/soccer-news/src/market-freeze.js` (soccer-article-market-freeze/1): each newsroom run (never dry) reads
  propsports-markets `/v1/article-market/soccer/:match?published_at=<original>` through the new `MARKETS` Service
  Binding for published articles first published at/after 2026-10-04T14:31:40Z with a SportsEvent link (30-day lookback,
  25 reads/run). Only `freeze = EMBED_THIS_PACKET` + `packet_state FINAL` + same event + a re-verified sha256 is stored:
  one append-only `soccer_article_evidence` row (packet_version soccer-article-market-freeze/1, keyed by the article's
  news_event_id; wrapper {article_id, slug, canonical_event_id, published_at, market_packet_sha256, packet}). No
  migration. Article rows are never touched. Not yet: the page rendering from the stored copy.
- `POST /v1/run?preview_match=<match uuid>` (NEWS_ADMIN_TOKEN): builds ONLY that fixture's preview up to 7 days out
  (same materiality bar, packet, gates, ONE paid desk attempt, same story key so the natural 24 h preview is a
  duplicate). `&dry=1` = zero model calls, zero writes. Does not overwrite `news:last_run`.
- Deploy is gated with the rest of the undeployed newsroom on main (live soccer-news fc7b1337 = 6fec521).

## soccer-news RC2.1 (LIVE 2026-10-04 20:28Z) and the competition-runner program

- `c0ec2b50` = main `2e24eb9` (ledger `9a501ec`), rollback `fc7b1337`. UCL gate = fail-closed canary (no qualifying
  material -> no story, no write, no model call), accepted by the owner. Packet V4 / market freeze / desk 2.2-2.3
  are NOT in production and not on main.
- Runner program (docs/COMPETITION_DESKS.md): ONE Worker, ONE codebase, one logically independent runner per
  competition. Phase 1 = `runCompetition(store, slug, ctx)` + orchestrator, behaviour-identical (parity:
  tests/news-runner-parity.test.js). Phase 1: CODE COMPLETE (8292d10), PRODUCTION LIVE `2eaf6b80` 2026-10-05 11:27Z
  (rollback `c0ec2b50`), OBSERVATION PENDING. Pre-release dark `b9831fdb` and post-release production dry runs were
  byte-identical to live `c0ec2b50`'s dry run (14 candidates, 0 new, all duplicates). Enabled newsroom competitions stay exactly MLS, Premier League, Bundesliga,
  Champions League, Nations League; the nine product lanes and FIFA stay OFF.
- 2026-10-05 phase 2 LIVE `179e4499` (main ab54f62), rollback `2eaf6b80`. Phase 2 acceptance canaries (deliberate,
  operator-driven by the owner's session, plain wrangler, not from the release script, source not on main):
  `48d45671` (13:33Z) = temporary `* * * * *` cron for the phase 2 acceptance; `a19b22fb` (13:41Z) = temporary one-shot
  phase 2 acceptance route with the normal `7,37` cron restored; then the audited `179e4499` was redeployed 13:44Z /
  13:46Z. The 13:37Z cron tick (while `48d45671` was live) left no `news:last_tick`.
- 2026-10-05 phase 3 initial release `3151b3e6` (main 641b279, ledger 6db85dc), rollback `179e4499`. REGRESSION found in
  review (no paid call happened: only duplicates): it dispatched the five runners CONCURRENTLY, so the read-before-call
  OpenAI ceiling (openai-cost.js overCeiling) and the read-modify-write KV call log could race across competitions.
  Patched in isolation 1.1.0 (soccer-news/1.6.0): real ticks dispatch sequentially in registry order with a cooperative
  per-runner time budget; parallel only for dry canaries. Proof: gate 611/611; frozen
  production replay isolated == RC2.1; dark `906b1c18` real-loopback dry run byte-identical to live in-process; injected
  dry fault in UCL (dark + production `/v1/run?isolated=1&dry=1&fault=uefa-champions-league`): UCL failed alone, the
  other four identical; runner unreachable over HTTP (404); first scheduled tick 14:37:50Z: ran, 5 runners ran,
  state_writes ok 5, every competition `dispatch: isolated`, newsroom fingerprints unchanged (75/75/81).
  NOT proven: separate CPU / subrequest budgets per runner invocation (not documented, not measured).
- 2026-10-05 phase 4 LIVE `25bb40ac` (main 4f62bf8 = rebased onto the privacy-consent main f246153, ledger 762d61a),
  rollback `03666f90`. First real scheduled tick 20:07:38Z: plan mode `activity`; Nations League `live` -> DUE
  (every_tick:live), dispatched alone (sequential, 0 failed, 13 candidates / 0 new / 13 duplicates); Bundesliga, PL,
  UCL, MLS `quiet` -> skipped (`not_due:quiet`, next 01:37:38Z), represented in news:last_run with
  `scheduled.ran: false` + `carried_from` 19:37:38Z; their KV states keep the real last run 19:37:38Z; state_writes
  ok 1 / failed 0 (only the runner that ran); /health 200 `publishing`, all five ok, none failing; newsroom tables
  unchanged across the tick (79 articles 47/29/3, 79 events, 85 evidence; fingerprints identical to 19:49Z);
  11 OFF competitions unchanged. Fail-open (schedule read failure -> run all) and pending-work-forces-next-tick are
  proven by tests (tests/news-schedule.test.js, mutation-checked), not observable on a healthy tick.

