# News engine

**Data-backed soccer journalism.** News is the discovery surface for the graph: every
story links into its teams, players, match and competition, and every figure traces to a
frozen evidence packet.

Runtime: Cloudflare Worker `soccer-news` (`workers/soccer-news`), cron `7,37 * * * *`, gated
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

Previews and data features stay off (no injury source; model gates not passed).

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

Desks: `/news/mls`, `/news/premier-league`, `/news/champions-league`, `/news/bundesliga`; articles at
`/news/:desk/:slug` (a slug under the wrong desk is a 404). `/news` and each desk are `noindex` until
they hold published stories, then `index`. Articles carry `NewsArticle` JSON-LD (headline, dates,
publisher, section, `about` teams) and a breadcrumb. `sitemap-news.xml` lists published articles and
only the desks that have them. The home page shows a news rail when stories exist.

No generated story visuals and no AI imagery: an article's hero media stays null unless approved,
licensed media with provenance exists (docs/MEDIA.md).

## History

v1 (`packet.js` / `compose.js` / `gates.js`) proved the approach on the Wyscout 2017/18 ledger
(Bayern München 6-0 Borussia Dortmund, held as an archive match). Its gates remain in the test suite.
