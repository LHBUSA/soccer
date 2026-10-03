# World Coverage (men + women)

Program started 2026-10-03. Goal: a broad global soccer product without rebuilding working competitions (MLS, Premier
League, Bundesliga, UCL, Nations League, FIFA World Cup stay as they are).

## Rules

- **Source first.** A competition is registered only from discovery evidence (`scripts/evidence/espn-world-discovery.mjs`,
  ESPN Core only, polite, budgeted). ESPN listing a league is not a reason to enable it.
- **Canary before enable.** `node scripts/canary/competition.mjs --slug <slug>` runs the real lane on real data in a
  local PGlite store with production team identities seeded read-only. Gates: lane completes, fixture graph complete,
  every finished match scored + detailed, 0 enrichment gaps, identity (team kind, gender, stable ESPN ids, no duplicate
  vs production, nothing queued, expected team count), table, knockout winners. Evidence: `docs/evidence/world/`.
- **One identity per sporting team.** A club is the same canonical team in every competition (crosswalk by stable ESPN
  team id: the LaLiga canary reused Real Madrid, Barcelona, Atlético, Betis and Villarreal from the Champions League).
- **Women's teams are their own teams.** ESPN names a women's side exactly like the club ("Manchester City" in eng.w.1)
  and gives it a different team id (0 ids shared across genders in discovery). The lane founds it with the
  competition's gender, never matches names across genders, refuses an ESPN id already mapped to the other gender
  (`team_gender_differs_from_competition`), and displays "<name> Women" only when a men's namesake exists (display,
  never identity; evidence on the crosswalk). Parent-club relationships are not modelled yet.
- **Players**: exact provider id + DOB + roster/fixture corroboration; never a name-only merge. Athletes without a DOB
  wait in the identity queue.
- **Models**: data and descriptive DNA yes; PBE predictions NO for any new competition until its own research passes
  its own gates. The Bundesliga / PL / V2 models are never applied to another competition.
- **Markets**: new competitions use the shared sportsbook / Kalshi / model / movement architecture; no verified market
  = omitted.
- **Video**: `soccer-video-match/1.3.0` is gender target-aware (NWSL video valid for NWSL, rejected for MLS).

## Release runbook per competition (after a canary PASS)

1. Registry: `espn.enabled = true` + `enable_note` citing the canary file. Push.
2. Release soccer-ingest: `MSYS_NO_PATHCONV=1 node scripts/release/release-worker.mjs soccer-ingest`.
3. Production fill, ONE competition at a time (shared Supabase ceiling): `node scripts/backfill/espn-fill-prod.mjs espn_<slug_underscored> 60 80`.
4. Verify `/v1/data-health` for the competition (teams, fixtures, 0 gaps); wait ~15 min for edge caches.
5. Frontend: `enabled: true` in `src/lib/competitions.js` (push = Vercel production), production QA.
6. Crests / competition logo: `node scripts/media/provider-media.mjs`, `node scripts/media/competition-logos.mjs`.
7. Newsroom: only after the held soccer-news deploy and a desk canary for the competition.

## Owner decisions (2026-10-03)

- **Policy:** missing spatial data does not block a league; unreliable match identity / status / detail does.
  Acceptance is recorded as two labels (canary gate 1.2.0): `MATCH_DATA_PASS|FAIL` and
  `SPATIAL_DATA_AVAILABLE|UNAVAILABLE|UNVERIFIED`. Never collapse them into one PASS.
- **Rollout order:** men's leagues first, one at a time (LaLiga → Serie A → Ligue 1 → Europa), each proven in
  production before its navigation goes live. Then WSL + UWCL (full PASS), then Liga F + Première Ligue
  (`MATCH_DATA_PASS` + `SPATIAL_DATA_UNAVAILABLE`, approved to launch without pitch maps).
- **No empty shot maps:** `spatial: false` in `src/lib/competitions.js` (Liga F, Première Ligue) makes PBEcast show a
  neutral "shot map not available" note, never an empty pitch, never invented locations. A finished match with zero
  located events gets the same note in any competition.
- **NWSL: HOLD.** Second canary after the men's rollout with a larger budget; diagnose the 145 `unknown` statuses and
  3 detail gaps; decide separately whether ESPN's 0-1 coordinate format can be normalised with proven semantics. May
  later launch without maps, only after match data passes.
- **Not added:** Frauen-Bundesliga (OpenLigaDB quality decision pending); Serie A Women (no source).
- **Newsroom** stays OFF for new competitions until the held soccer-news deploy is approved. **Video worker** not
  redeployed (freeze).
- **soccer-ingest release (DONE 2026-10-03):** the shared Kalshi client was verified stable (last canonical commit
  8b73545, no uncommitted edits in any worktree), vendored once (59084d6, SHA-256 pin moved to 8b73545, parity test
  green, nothing weakened), then soccer-ingest 366d9b89 released (rollback d4b335bf). LaLiga, Serie A, Ligue 1 and
  Europa were each filled, accepted in production and exposed in navigation one at a time.

- **Women's rollout (DONE 2026-10-03):** WSL -> UWCL -> Liga F -> Premiere Ligue, one at a time (soccer-ingest
  3c87ad74 -> 88ddb1ad -> 09704687 -> 6dfa5321), each filled, accepted in production and exposed in the WOMEN menu.
  Women's teams that play in several competitions are one canonical team (Chelsea / Arsenal / Man City Women in WSL +
  UWCL; Real Madrid / Barcelona Women in Liga F + UWCL; OL Lyonnes / PSG / Paris FC Women in Premiere Ligue + UWCL);
  every men's namesake is a distinct team with no shared ESPN id; 0 production matches join a team of the other gender.
  Liga F + Premiere Ligue: SPATIAL_DATA_UNAVAILABLE proven (0 located events), match page + PBEcast show the neutral
  note, never a pitch.
- **Release discipline:** push only via `node scripts/release/push-main.mjs` (fail-closed gate; tests/push-main.test.js
  proves a deliberately failing test blocks the push). Every push in the women's rollout went through it.

## State

See the generated matrix below; production steps not yet run are listed in its blocker column.

<!-- matrix -->
Generated 2026-10-03T20:08:17.579Z by scripts/evidence/world-matrix.mjs.

### Production rollout (from production evidence only)

Worker enabled = the deployed soccer-ingest (docs/deployments.jsonl) has the lane enabled.

| competition | gender | worker_enabled | backfill_complete | fixtures | table_verified | finished_detail | spatial | identity_dedupe | gender_integrity | api_canary | browser_390 | browser_768 | browser_1440 | navigation |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| la-liga | men | yes | PASS | 380/380 PASS | PASS (overall, 20) | 69 PASS (0 gaps) | AVAILABLE PASS | PASS (20 teams, 7 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| liga-f | women | yes | PASS | 240/240 PASS | PASS (overall, 16) | 44 PASS (0 gaps) | UNAVAILABLE PASS | PASS (16 teams, 2 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| ligue-1 | men | yes | PASS | 306/306 PASS | PASS (overall, 18) | 45 PASS (0 gaps) | AVAILABLE PASS | PASS (18 teams, 6 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| premiere-ligue | women | yes | PASS | 132/132 PASS | PASS (overall, 12) | 22 PASS (0 gaps) | UNAVAILABLE PASS | PASS (12 teams, 3 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| serie-a | men | yes | PASS | 380/380 PASS | PASS (overall, 20) | 50 PASS (0 gaps) | AVAILABLE PASS | PASS (20 teams, 6 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| uefa-europa-league | men | yes | PASS | 144/144 PASS | PASS (league-phase, 36) | 18 PASS (0 gaps) | AVAILABLE PASS | PASS (36 teams, 12 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| uefa-womens-champions-league | women | yes | PASS | 54/54 PASS | PASS (league-phase, 18) | 18 PASS (0 gaps) | AVAILABLE PASS | PASS (18 teams, 3 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |
| womens-super-league | women | yes | PASS | 182/182 PASS | PASS (overall, 14) | 29 PASS (0 gaps) | AVAILABLE PASS | PASS (14 teams, 3 shared) | PASS | PASS | PASS | PASS | PASS | LIVE |

### All discovered competitions (canary + discovery evidence)

| phase | competition | gender | region | provider | season | teams | matches | results | standings | lineups | stats | plays | coordinates | live | pbecast | players | dna | news | match_data | spatial | source_status | launch_status | blocker |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| live | MLS | men | USA | espn usa.1 | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | — | — | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | UEFA Nations League | men | international | espn uefa.nations | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | — | — | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | UEFA Champions League | men | international | espn uefa.champions | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | — | — | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | UEFA European Championship | men | international | wyscout 102, espn uefa.euro | — | — | — | — | — | — | — | — | — | — | — | — | — | off | — | — | registered, not certified | registered, lane disabled | No canonical competition row in production; ESPN lane disabled. No current tournament (next EURO 2028). |
| live | FIFA World Cup | men | international | wyscout 28, espn fifa.world | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | off | — | — | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | Premier League | men | ENG | wyscout 364, espn eng.1 | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | — | — | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | Bundesliga | men | DEU | wyscout 426, openligadb bl1, espn ger.1 | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | — | — | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| A | Spanish LALIGA | men | ESP | espn esp.1 (740) | 2026-27 Spanish LALIGA | 20 | 380 | 69 | verified/computed | 69 | 69 | 69 | 93772 | per-minute lane | replay payload proven | 544 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | lane live in production | — |
| A | Italian Serie A | men | ITA | espn ita.1 (730) | 2026-27 Italian Serie A | 20 | 380 | 50 | verified/computed | 50 | 50 | 50 | 67835 | per-minute lane | replay payload proven | 582 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | lane live in production | — |
| A | French Ligue 1 | men | FRA | espn fra.1 (710) | 2026-27 French Ligue 1 | 18 | 306 | 45 | verified/computed | 45 | 45 | 45 | 63170 | per-minute lane | replay payload proven | 446 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | lane live in production | — |
| A | UEFA Europa League | men | international | espn uefa.europa (776) | 2026-27 UEFA Europa League | 36 | 144 | 18 | verified/computed | 18 | 18 | 18 | 24771 | per-minute lane | replay payload proven | 781 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | lane live in production | — |
| B | NWSL | women | USA | espn usa.nwsl (8301) | 2026 NWSL | 16 | 240 | 210 | verified/computed | 210 | 210 | 210 | 143570 | — | replay payload proven | 433 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | canary PASS (not enabled) | enable + release + production fill |
| B | English Women's Super League | women | ENG | espn eng.w.1 (8097) | 2026-27 English Women's Super League | 14 | 182 | 29 | verified/computed | 29 | 29 | 29 | 40295 | per-minute lane | replay payload proven | 308 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | lane live in production | — |
| B | UEFA Women's Champions League | women | international | espn uefa.wchampions (19483) | 2026-27 UEFA Women's Champions League | 18 | 54 | 18 | verified/computed | 18 | 18 | 18 | 24760 | per-minute lane | replay payload proven | 403 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_AVAILABLE | source_present | lane live in production | — |
| B | Spanish Liga F | women | ESP | espn esp.w.1 (20956) | 2026-27 Spanish Liga F | 16 | 240 | 43 | verified/computed | 43 | 43 | 43 | 0 | per-minute lane | replay payload proven | 357 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_UNAVAILABLE | source_present | lane live in production | — |
| B | frauen-bundesliga | women | DEU | espn ger.w.1: absent | — | — | — | — | — | — | — | — | — | — | — | — | — | off | — | — | league_unavailable | not registered | no ESPN Core source |
| B | French Première Ligue | women | FRA | espn fra.w.1 (20955) | 2026-27 French Première Ligue | 12 | 132 | 18 | verified/computed | 18 | 18 | 18 | 0 | per-minute lane | replay payload proven | 222 | descriptive (inputs present) | off | MATCH_DATA_PASS | SPATIAL_DATA_UNAVAILABLE | source_present | lane live in production | — |
| B | serie-a-women | women | ITA | espn ita.w.1: absent | — | — | — | — | — | — | — | — | — | — | — | — | — | off | — | — | league_unavailable | not registered | no ESPN Core source |
| B | FIFA Women's World Cup | women | international | espn fifa.wwc (795) | 2023 FIFA Women's World Cup | 32 | 64 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | English League Championship | men | ENG | espn eng.2 (3914) | 2026-27 English League Championship | 24 | 552 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Mexican Liga BBVA MX | men | MEX | espn mex.1 (760) | 2026-27 Liga BBVA MX | 18 | 153 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Dutch Eredivisie | men | NLD | espn ned.1 (725) | 2026-27 Dutch Eredivisie | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Portuguese Primeira Liga | men | PRT | espn por.1 (715) | 2026-27 Portuguese Primeira Liga | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | CONMEBOL Libertadores | men | international | espn conmebol.libertadores (783) | 2026 CONMEBOL Libertadores | 46 | 155 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Scottish Premiership | men | SCO | espn sco.1 (735) | 2026-27 Scottish Premiership | 12 | 198 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Belgian Pro League | men | BEL | espn bel.1 (3901) | 2026-27 Belgian Pro League | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Argentine Liga Profesional de Fútbol | men | ARG | espn arg.1 (745) | 2026 Argentine Liga Profesional de Fútbol | 30 | 495 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Brazilian Serie A | men | BRA | espn bra.1 (630) | 2026 Futebol Brasileiro | 20 | 383 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Saudi Pro League | men | SAU | espn ksa.1 (21231) | 2026-27 Saudi Pro League | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| C | Japanese J.League | men | JPN | espn jpn.1 (750) | 2026 Japanese J1 League | 20 | 580 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | English FA Cup | men | ENG | espn eng.fa (3918) | 2025-26 English FA Cup | 124 | 123 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | English Carabao Cup | men | ENG | espn eng.league_cup (3920) | 2026-27 English Carabao Cup | 92 | 84 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | Spanish Copa del Rey | men | ESP | espn esp.copa_del_rey (3951) | 2026-27 Spanish Copa del Rey | 20 | 20 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | Coppa Italia | men | ITA | espn ita.coppa_italia (3956) | 2026-27 Coppa Italia | 46 | 45 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | German Cup | men | DEU | espn ger.dfb_pokal (3954) | 2026-27 German Cup | 64 | 48 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | Coupe de France | men | FRA | espn fra.coupe_de_france (3952) | 2025-26 Coupe de France | 64 | 63 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | UEFA Conference League | men | international | espn uefa.europa.conf (20296) | 2026-27 UEFA Conference League | 36 | 108 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | Leagues Cup | men | international | espn concacaf.leagues.cup (19425) | 2026 Leagues Cup | 36 | 62 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| D | U.S. Open Cup | men | USA | espn usa.open (5337) | 2026 U.S. Open Cup | 80 | 79 | — | — | — | — | — | — | — | — | — | — | off | — | — | source_present | not registered | not yet registered (phase order) |
| B | frauen-bundesliga | women | DEU | openligadb ffb1 (league 5972, community-maintained) | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | source_alternative | not registered | Not on ESPN Core (ger.w.1 absent). OpenLigaDB 2026: 14 teams, 182 fixtures, 35 finished; one fixture with a 1970 placeholder kickoff; 69/123 goals with a named scorer. Results/goals tier only; needs an OpenLigaDB women lane + data-quality gate. |
| B | serie-a-women | women | ITA | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | no_source | not registered | Not on ESPN Core (ita.w.1 absent) nor OpenLigaDB. No legitimate structured public source found yet. |
