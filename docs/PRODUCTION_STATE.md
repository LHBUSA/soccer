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
| soccer-api | `2fd0e5e9` (2026-09-29, main 21376b2: one news-subject rule for cards + article hero; `/v1/data-health` newsroom block) | `2f8a5b0d` |
| soccer-ingest | unchanged by the 2026-09-29 newsroom / PBEcast release (see docs/deployments.jsonl) | — |
| soccer-news | `8e03520d` (1.4.0, main fb9a2b7: previews, matchday briefs, group watch, readiness-based recaps, registry enablement, news:last_tick) | `204dd215` (then `abc1fe23`, the hand-deployed backfill build) |

Rollback: `cd workers/<worker> && npx wrangler versions deploy <rollback>@100% --yes`. Web rollback: Vercel instant rollback to the previous production deployment.

## Migrations (all applied, each after a rollback-only proof with an unchanged catalog fingerprint)

`0100` core graph · `0200` events · `0300` newsroom (append-only evidence) · `0400` attribute_corroborated player crosswalk · `0500` governed media registry · `0600` enrichment ledger + season groups/standings + media discovery/trademark status · `0700` private model shadow (predictions frozen by trigger, append-only events/metrics). · `0800` owner-approved identification media (APPLIED 2026-09-28, sha256 12f2ec07…; rollback docs/evidence/storage/rollback-0800-2026-09-28.sql).

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
  through the authenticated `POST /v1/admin/reedit` and the KV-controlled `*/10` migration cron (a no-op while
  `migration:control` is unset). 16 legacy template stories are still not re-edited.
