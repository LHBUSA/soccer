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

## State

See the generated matrix below; production steps not yet run are listed in its blocker column.

<!-- matrix -->
Generated 2026-10-03T14:19:55.639Z by scripts/evidence/world-matrix.mjs from docs/evidence/world/*.json.

| phase | competition | gender | region | provider | season | teams | matches | results | standings | lineups | stats | plays | coordinates | live | pbecast | players | dna | news | source_status | launch_status | blocker |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| live | MLS | men | USA | espn usa.1 | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | UEFA Nations League | men | international | espn uefa.nations | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | UEFA Champions League | men | international | espn uefa.champions | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | UEFA European Championship | men | international | wyscout 102, espn uefa.euro | — | — | — | — | — | — | — | — | — | — | — | — | — | off | registered, not certified | registered, lane disabled | No canonical competition row in production; ESPN lane disabled. No current tournament (next EURO 2028). |
| live | FIFA World Cup | men | international | wyscout 28, espn fifa.world | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | off | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | Premier League | men | ENG | wyscout 364, espn eng.1 | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| live | Bundesliga | men | DEU | wyscout 426, openligadb bl1, espn ger.1 | — | — | — | — | — | — | — | — | — | per-minute lane (ESPN-owned matches) | — | — | — | enabled | certified before this sprint (docs/PRODUCTION_STATE.md) | lane live in production | — |
| A | Spanish LALIGA | men | ESP | espn esp.1 (740) | 2026-27 Spanish LALIGA | 20 | 380 | 69 | verified/computed | 69 | 69 | 69 | 93772 | — | replay payload proven | 544 | descriptive (inputs present) | off | source_present | enabled on main; soccer-ingest release pending | soccer-ingest release (owner permission) + production fill + frontend enable |
| A | Italian Serie A | men | ITA | espn ita.1 (730) | 2026-27 Italian Serie A | 20 | 380 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| A | French Ligue 1 | men | FRA | espn fra.1 (710) | 2026-27 French Ligue 1 | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| A | UEFA Europa League | men | international | espn uefa.europa (776) | 2026-27 UEFA Europa League | 36 | 144 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| B | NWSL | women | USA | espn usa.nwsl (8301) | 2026 NWSL | 16 | 240 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| B | English Women's Super League | women | ENG | espn eng.w.1 (8097) | 2026-27 English Women's Super League | 14 | 182 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| B | UEFA Women's Champions League | women | international | espn uefa.wchampions (19483) | 2026-27 UEFA Women's Champions League | 18 | 54 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| B | Spanish Liga F | women | ESP | espn esp.w.1 (20956) | 2026-27 Spanish Liga F | 16 | 240 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| B | frauen-bundesliga | women | DEU | espn ger.w.1: absent | — | — | — | — | — | — | — | — | — | — | — | — | — | off | league_unavailable | not registered | no ESPN Core source |
| B | French Première Ligue | women | FRA | espn fra.w.1 (20955) | 2026-27 French Première Ligue | 12 | 132 | — | — | — | — | — | — | — | — | — | — | off | source_present | registered, lane disabled | canary not run |
| B | serie-a-women | women | ITA | espn ita.w.1: absent | — | — | — | — | — | — | — | — | — | — | — | — | — | off | league_unavailable | not registered | no ESPN Core source |
| B | FIFA Women's World Cup | women | international | espn fifa.wwc (795) | 2023 FIFA Women's World Cup | 32 | 64 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | English League Championship | men | ENG | espn eng.2 (3914) | 2026-27 English League Championship | 24 | 552 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Mexican Liga BBVA MX | men | MEX | espn mex.1 (760) | 2026-27 Liga BBVA MX | 18 | 153 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Dutch Eredivisie | men | NLD | espn ned.1 (725) | 2026-27 Dutch Eredivisie | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Portuguese Primeira Liga | men | PRT | espn por.1 (715) | 2026-27 Portuguese Primeira Liga | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | CONMEBOL Libertadores | men | international | espn conmebol.libertadores (783) | 2026 CONMEBOL Libertadores | 46 | 155 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Scottish Premiership | men | SCO | espn sco.1 (735) | 2026-27 Scottish Premiership | 12 | 198 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Belgian Pro League | men | BEL | espn bel.1 (3901) | 2026-27 Belgian Pro League | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Argentine Liga Profesional de Fútbol | men | ARG | espn arg.1 (745) | 2026 Argentine Liga Profesional de Fútbol | 30 | 495 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Brazilian Serie A | men | BRA | espn bra.1 (630) | 2026 Futebol Brasileiro | 20 | 383 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Saudi Pro League | men | SAU | espn ksa.1 (21231) | 2026-27 Saudi Pro League | 18 | 306 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| C | Japanese J.League | men | JPN | espn jpn.1 (750) | 2026 Japanese J1 League | 20 | 580 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | English FA Cup | men | ENG | espn eng.fa (3918) | 2025-26 English FA Cup | 124 | 123 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | English Carabao Cup | men | ENG | espn eng.league_cup (3920) | 2026-27 English Carabao Cup | 92 | 84 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | Spanish Copa del Rey | men | ESP | espn esp.copa_del_rey (3951) | 2026-27 Spanish Copa del Rey | 20 | 20 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | Coppa Italia | men | ITA | espn ita.coppa_italia (3956) | 2026-27 Coppa Italia | 46 | 45 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | German Cup | men | DEU | espn ger.dfb_pokal (3954) | 2026-27 German Cup | 64 | 48 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | Coupe de France | men | FRA | espn fra.coupe_de_france (3952) | 2025-26 Coupe de France | 64 | 63 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | UEFA Conference League | men | international | espn uefa.europa.conf (20296) | 2026-27 UEFA Conference League | 36 | 108 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | Leagues Cup | men | international | espn concacaf.leagues.cup (19425) | 2026 Leagues Cup | 36 | 62 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| D | U.S. Open Cup | men | USA | espn usa.open (5337) | 2026 U.S. Open Cup | 80 | 79 | — | — | — | — | — | — | — | — | — | — | off | source_present | not registered | not yet registered (phase order) |
| B | frauen-bundesliga | women | DEU | openligadb ffb1 (league 5972, community-maintained) | — | — | — | — | — | — | — | — | — | — | — | — | — | — | source_alternative | not registered | Not on ESPN Core (ger.w.1 absent). OpenLigaDB 2026: 14 teams, 182 fixtures, 35 finished; one fixture with a 1970 placeholder kickoff; 69/123 goals with a named scorer. Results/goals tier only; needs an OpenLigaDB women lane + data-quality gate. |
| B | serie-a-women | women | ITA | — | — | — | — | — | — | — | — | — | — | — | — | — | — | — | no_source | not registered | Not on ESPN Core (ita.w.1 absent) nor OpenLigaDB. No legitimate structured public source found yet. |
