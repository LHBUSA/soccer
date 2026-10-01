# News engine

**Data-backed soccer journalism.** News is the discovery surface for the graph: every
story links into its teams, players, match and competition, and every figure traces to a
frozen evidence packet.

Runtime: Cloudflare Worker `soccer-news` (`workers/soccer-news`), cron `7,37 * * * *` (competitions from the registry `news` block), gated
by the `NEWS_ENABLED` var. GitHub Actions are not a runtime. The Worker never calls a provider:
it reads only the canonical graph.

```
detect -> packet (frozen, hashed, append-only) -> compose (template) -> [optional LLM edit] -> gates -> publish | hold
```

## Competition profiles (`profiles.js`)

Materiality and language are competition-specific. A table angle needs a verified league
table, and some words are false for some formats.

| Profile | Competitions | Table angles | Forbidden language |
|---|---|---|---|
| `domestic_european_league` | Premier League, Bundesliga | leader change, title-race swing, top four in/out, bottom three in/out, upset (>= 8 places), winning run, unbeaten run ended | none beyond the global list |
| `mls` | MLS | overall-standings leader change (MLS tiebreak: points, wins, GD, GF), upset (>= 12 places), runs | relegation / drop zone / bottom three; European places / top four; Eastern/Western Conference claims (conferences not stored); playoff-spot claims |
| `ucl_league_phase` | Champions League before 1 Feb 2027 | **none**: 36-team league phase (1-8 round of 16, 9-24 play-off, 25-36 out), but no verified league-phase table is stored | top four; table / standings / top of the table; qualification / round of 16 / eliminated |
| `knockout` | Champions League from 1 Feb 2027 | none | aggregate / through to / eliminated / knocked out (aggregates not stored) |

Match-level angles in every profile: comeback from a half-time deficit (needs a stored half-time
score), a resolved player scoring 2+ (3 = 1.2), 6+ goals, a 4+ goal margin. Materiality >= 1.0 publishes.

**Still-true rule.** A table angle is reported only if the latest table agrees: a team that went
top at 15:30 and was overtaken at 17:30 is not "top".

## Story classes (`engine.js`)

| Class | Trigger (latest match within the window, default 4 days) | Key (dedupe) |
|---|---|---|
| `match_recap` | a finished match with materiality >= 1.0 | `match_recap:<match>` |
| `team_trend` | league run: 4+ wins, 7+ unbeaten (not all wins), 4+ defeats, 7+ winless (not all defeats) | `team_trend:<team>:<kind>:<length>:<last match>` |
| `player_form` | scored in 3+ consecutive appearances (sourced lineups: started or came on) | `player_form:<player>:<length>:<last match>` |
| `competition_intelligence` (table race) | once per ISO week with 6+ league results and no league match within 12 h | `table_race:<competition>:<week>` |
| `competition_intelligence` (group watch, `previews.js`) | profiles without a single table (Nations League groups, UCL league phase): once per ISO week after 6+ results and no match within 12 h; ONLY groups whose ESPN standings verify against canonical results | `group_watch:<competition>:<week>` |
| `match_preview` (fixture, `previews.js`) | a scheduled fixture kicking off in 1-24 h with materiality >= 1.0: top-of-table meeting (top 4; MLS top 6), bottom meeting, leader in action, verified group top-two meeting / group leader, winning (3+) / unbeaten (6+) / losing (3+) run, a player on a 3+ scoring run. Max 3 per competition per run | `match_preview:<match>` |
| `match_preview` (matchday brief) | a UTC day with 3+ fixtures in the next 1-24 h, 2+ of them with table or verified group context | `matchday:<competition>:<date>` |

Previews state only facts known before kick-off (kick-off, venue, table / verified group position, last five
results, sourced scoring runs, earlier meetings this season). The `preview_prediction` and `preview_team_news`
gates (fact gates and desk validation) hold any forecast, favourite, probability, odds, team news or lineup claim.
Data features stay off (model gates not passed); no injury source exists.

**Enablement (one source of truth).** `data/registry/competitions.json` `news`: `enabled`, the `stories` a
competition supports, and for a disabled competition its exact `blocker`. `NEWS_COMPETITIONS` is derived from it;
it is not coupled to a provider lane flag.

**Recap readiness (`recapReadiness`).** A finished match becomes a candidate as soon as its enrichment ledger
is final (every component complete / not applicable), with no blind delay. While a component is still retrying
(within 6 h of kick-off) the match waits (`awaiting_enrichment`): a story's event id is written once, so a recap
built before its goal sequence arrived would hold for good. Without a ledger (OpenLigaDB-only) the old rule
applies: kick-off 2 h ago.

**Primary subject (`workers/shared/news-subject.js`).** The composer marks one entity as the story's subject from
the packet's material event (hat-trick scorer > new leader > two-goal scorer > winner; the player of a form
story; the team of a trend; the table leader; for previews the in-form player, the leader or the home side).
soccer-api's news cards and article hero resolve the subject through the same `selectSubject()` (marker, else
the person the headline names by full name or unambiguous surname, else the headline team) and show only
that subject's approved photo, else its own team's crest, else the competition graphic: never another
player's face. Backfill: `node scripts/news/backfill-subjects.mjs [--apply]`.

**Data visuals (`visuals.js`, `soccer-visuals/1.0.0`).** Every article carries code-built visual specs in
`body.visuals[]` = `{ id, type, title, subtitle, data, units, entities, source, observed_at, provenance, values_hash }`,
built from the article's frozen packet (recaps also freeze the match's canonical located shot events: same event
family and match frame as PBEcast), validated against the packet (goal sequence, phases, team stats, player lines,
verified group rows, shot coverage label "N of M recorded shots have location data"), and frozen at publication.
Types: recap `match_flow` (1H v 2H), `goal_timeline` (stoppage, penalties, own goals), `shot_profile`, `shot_map`
(>= 6 located shots), `player_focus` (hat-trick / brace scorer: sourced line + his located shots), `table_move` or
`group_position`, `form_strip`; player form `scoring_run`; team trend `run_results` + `team_standing`; table race
`standings`; group watch `group_table` per verified group; preview `matchup` (descriptive only) + `form_strip` +
`players_in_form`; matchday `fixtures_board` + `standings`. The desk sees only the menu (id, type, title) and may
return `emphasis` (ids, most important first); it never supplies a value. A visual that fails validation is dropped
(`visuals_rejected`), never repaired. soccer-api serves a stored visual only while its values still hash to
`values_hash` (else `visuals_withheld`). Renderer: `src/components/visuals.js` (static HTML/SVG; no animation).
Backfill (fills only articles without visuals): `node scripts/news/backfill-visuals.mjs [--apply]`.

**Health.** `GET /v1/data-health` -> `newsroom`: cron freshness and the last tick's outcome (ran / disabled /
failed), NEWS_ENABLED, desk availability, publications in 24 / 72 h, and per competition the last run's
candidates, duplicates, new, published, held, detection diagnostics, newest story and age, hold reasons and
fixtures in the next 24 h.

## Packet (`soccer-packet/2.0.0`)

The ONLY composer input. Recap packets hold the score, half-time (when stored), goals
(one event family per match, own goals credited to the benefiting side), source or derived team
statistics labelled by basis, located-shot counts and mean distance, table before/after and form
(table profiles only), the angles with resolved names, `unavailable[]` (quotes, injuries, odds, xG)
and attributions. Stored once in `soccer_article_evidence`; a trigger blocks update and delete.
`event_id = uuidv5("news_event:" + key)`, so a story is written once.

## Compose and the optional LLM pass

`compose2.js` (`template/soccer-news@2.0.0`): deterministic templates; a sentence is omitted when
an input is missing. Wording follows the profile (MLS says "overall MLS standings").

`editorial.js` is **off** unless `NEWS_LLM=on` and `ANTHROPIC_API_KEY` are set. The model sees only
the frozen packet and the draft, must keep the section structure and the method section, and its
output runs through the **same gates** against the **same packet**. If it fails, the template
article is published and the rejection is recorded on the article.

## Gates (`gates2.js`, `soccer-gates/2.0.0`)

| Gate | Checks |
|---|---|
| `numeric_grounding` | Every number and number word is in the packet. ISO dates ground only their day and year (a stray "9" cannot hide in "2026-09-20"); identifiers, hashes and version strings never ground anything. |
| `entity_grounding` | Every linked entity exists in the packet with the same id and name. |
| `claims_consistency` | Known sentence forms equal the exact packet field: table position/points/played, shots/on target, half-time, run length, goals for/against, scoring run, leader gap; hat-trick needs a three-goal scorer; comeback needs a half-time deficit; "top of the" needs a leader change. |
| global bans | quotes, injuries/suspensions, transfers/rumours, odds/betting, records/"historic", mental-state claims, unpublished metrics (xG etc.), possession, cliches (method section exempt) |
| profile bans | as in the table above |
| `match_final`, `score_in_headline`, `wrong_winner` | result integrity |
| `too_thin` (>= 3 sections), `headline_length`, `attribution`, `render_artifact`, `method_section` | quality and obligations |

Failed gates become `hold_reasons`; the schema refuses `published` while any remain.

## Desks, pages, SEO

Desk routes now cover `/news/mls`, `/news/premier-league`, `/news/la-liga`, `/news/serie-a`, `/news/ligue-1`, `/news/champions-league`, `/news/europa-league`, `/news/bundesliga`, `/news/international` and `/news/fifa`. A desk may exist while its competition remains disabled in the registry; empty desks are `noindex` and publish nothing until canonical ingest + newsroom enablement pass. Articles live at
`/news/:desk/:slug` (a slug under the wrong desk is a 404). `/news` and each desk are `noindex` until
they hold published stories, then `index`. Articles carry `NewsArticle` JSON-LD (headline, dates,
publisher, section, `about` teams) and a breadcrumb. `sitemap-news.xml` lists published articles and
only the desks that have them. The home page shows a news rail when stories exist.

No generated story visuals and no AI imagery: an article's hero media stays null unless approved,
licensed media with provenance exists (docs/MEDIA.md).

## V4 — UFC-quality article surface, global desk contract

Soccer now uses the same product principles as the UFC newsroom while keeping soccer's canonical match
graph as the source of truth:

- **frozen evidence packet first** — the model never owns a score, player line, table row or chart value
- **OpenAI Soccer Desk** — new stories pass through the guarded editorial desk; an unavailable model holds
  a required desk story rather than inventing a replacement
- **deterministic content modules** — article hero, entity chips, Match Intelligence, PBEcast, Player DNA,
  frozen data visuals, related coverage, official video and Source & Method are attached only when evidence exists
- **internal graph links** — players, clubs, matches and competitions link to their canonical Soccer pages
- **official video is a separate authoritative layer** — the video autopilot owns discovery + matching;
  the article renderer consumes validated links and never asks the writer to invent a URL
- **SEO is server-first** — NewsArticle, breadcrumbs, entity references, canonical metadata and VideoObject
  (validated video only)
- **all major desk routes + FIFA are represented** — route coverage is not permission to publish. Registry
  `news.enabled` remains the single publish switch.

Current publish-enabled competitions remain the ones whose canonical lanes and newsroom contracts are
certified: MLS, Premier League, Bundesliga, Champions League and Nations League. FIFA World Cup has a
certified ESPN canonical lane but its 2026 tournament is historical; automatic news remains disabled until
a deliberate historical/current-tournament policy is approved. LaLiga, Serie A, Ligue 1 and Europa League
remain visible in the newsroom architecture but cannot publish until their ingest canaries and identity
certification pass. This prevents an attractive empty route from becoming a fabricated content feed.

## History

v1 (`packet.js` / `compose.js` / `gates.js`) proved the approach on the Wyscout 2017/18 ledger
(Bayern München 6-0 Borussia Dortmund, held as an archive match). Its gates remain in the test suite.
