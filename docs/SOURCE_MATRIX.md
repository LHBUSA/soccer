# Source matrix — Phase 0 red team (2026-09-27)

Operational contract. A source is only as good as its evidence file. Verdicts:
`PASS` · `PARTIAL` · `BLOCKED_BY_ACCESS_CONTROL` · `RESTRICTS_AUTOMATED_ACCESS` ·
`RESTRICTS_COMMERCIAL_USE` · `UNVERIFIED`. No source is production-ready until a
deployed canary passes (`production_ready` is false for every source today).

Method: `scripts/evidence/source-audit.mjs` made 57 polite, sequential,
cookieless requests with an honest user agent (robots, terms, one data endpoint
per source) and wrote one evidence file per probe to
`docs/evidence/source-audit/2026-09-27/`. Licence files were captured by
`scripts/evidence/licenses.py`. No authentication, CAPTCHA, Cloudflare or Akamai
control was bypassed; every block is recorded as a block. This is an engineering
rights triage, not legal advice.

## Update — ESPN Core as a secondary source (owner decision 2026-09-27)

The owner approved ESPN as a **secondary ingestion source**. The terms verdict stays `RESTRICTS_COMMERCIAL_USE`, now with `use_status = OWNER_APPROVED_SECONDARY`.

- **Access:** Core API only. site.api is Akamai-blocked and is never touched.
- **Evidence:**
  - discovery: `docs/evidence/espn-soccer-discovery-latest.json`, 308 requests, all 200;
  - coordinates: `docs/evidence/espn-soccer-coordinates.json`;
  - rehearsals: `docs/evidence/espn/`;
  - live canary: `docs/evidence/espn-canary-latest.json`, passing.

ESPN reverses several of the conclusions below:

| Earlier conclusion | With ESPN Core |
|---|---|
| No Champions League / Europa League source | uefa.champions (775) and uefa.europa (776): fixtures, results, lineups, formations, team stats and plays with coordinates. Rehearsed on the Champions League: 144 fixtures, 18 finished matches detailed. |
| No MLS source | usa.1 (770): 511 regular-season events and 32 teams; canary passes. Not yet rehearsed through the lane. |
| Premier League current data weak | eng.1 (700), rehearsed: 380 fixtures and 20 teams founded; 50 finished matches with lineups, formations, team stats and 71,092 play events. |
| No current-season event coordinates anywhere | **Core plays carry fieldPositionX/Y for current matches**, verified 0–100, team-relative, attacking x=100, y=0 on the attacking right. The 2012 and 2017 seasons also have X/Y in the EPL and Bundesliga. |

**What ESPN does not provide:**
- Pass completion: there is no success flag, so outcome stays null.
- Standings: the current table has empty records. We compute tables ourselves.
- Coaches: stale or missing refs.
- Continuous tracking: none.

Its own xG is stored only as a labelled provider fact.

## Headline (Phase 0 audit, before the ESPN decision)

1. **Only two sources give us legitimately reusable soccer data at scale, and both are proven end-to-end:**
   - **Wyscout public dataset (CC BY 4.0)** — full event data with coordinates for 2017/18 in the five big leagues, plus World Cup 2018 and Euro 2016. It's frozen history.
   - **OpenLigaDB (ODbL)** — live, stable-id Bundesliga fixtures, results and goal scorers, with results back to 2004/05.
2. **Every official league and federation site restricts us.** That covers the Premier League, UEFA, LaLiga, DFL, MLS and FIFA. The restriction is on commercial use, database building, automated access, or all three. UEFA and FIFA APIs answer without auth, but their terms still forbid what we would do with them.
3. **The popular analytics aggregators are closed.** FBref, SofaScore and WhoScored block us at the network edge. Understat's robots.txt disallows everything, and FotMob's terms forbid automated access. ESPN falls under the Disney terms already flagged network-wide.
4. **StatsBomb Open Data is the richest open event set, but it is a research licence.** It includes 360 freeze frames, and clause 7 bars exploiting the data without written consent. Use it for internal methodology research only, unless the owner gets consent.
5. **No legitimate source was found for:**
   - Champions League or Europa League events, lineups or stats
   - MLS
   - live event data with coordinates for any current season
   - continuous player tracking. This remains a separate data class; the SkillCorner MIT sample is research reference only.

## Priority competitions

| Competition | Best legitimate path found | Event coordinates | Current season | Verdict |
|---|---|---|---|---|
| **Bundesliga** | Wyscout 2017/18 (CC BY) + OpenLigaDB (ODbL) fixtures/results 2004/05–2026/27, goal detail from 2009/10 | 2017/18 only | Yes: OpenLigaDB, stable ids | **PASS, selected** |
| Premier League | Wyscout 2017/18; openfootball CC0 fixtures/results 2010/11–2026/27 (names only) | 2017/18 only | Partial: openfootball, no ids | PARTIAL |
| LaLiga | Wyscout 2017/18; openfootball CC0 | 2017/18 only | Partial: openfootball | PARTIAL |
| Serie A | Wyscout 2017/18; openfootball CC0 | 2017/18 only | Partial: openfootball | PARTIAL |
| Ligue 1 | Wyscout 2017/18; openfootball CC0 | 2017/18 only | Partial: openfootball | PARTIAL |
| FIFA World Cup | Wyscout 2018 (CC BY); openfootball worldcup.json incl. 2026 (CC0); StatsBomb 2018/2022 research-only | 2018 only | n/a (2026 finished) | PARTIAL |
| UEFA Euro | Wyscout 2016 (CC BY); openfootball euro | 2016 only | n/a | PARTIAL |
| Champions League | openfootball champions-league repo (results; last push 2026-07-02) | none | Unverified | PARTIAL (results only) |
| Europa League | none verified | none | none | UNVERIFIED |
| MLS | none (MLS terms restrict; no open structured source found) | none | none | RESTRICTS_AUTOMATED_ACCESS |

Secondary competitions (Championship, Liga MX, Eredivisie, Primeira Liga, NWSL,
Libertadores) were not probed in this pass. openfootball covers the Championship,
Eredivisie and Primeira (fixtures/results, CC0) — to be audited with the same method.

## Why the Bundesliga, not the Premier League

The choice is based on data, not brand:

- **The Bundesliga has an identity bridge from history to today.** OpenLigaDB team ids are stable across seasons. On the 2017/18 overlap they were proven against the Wyscout-founded canonical teams by the fixture graph, with no names used. That proof carried 15 of the 18 teams of 2026/27 into the live season automatically.
- **The Premier League has no equivalent.** Its only open current-season path, openfootball, has no ids at all.
- **Two independent sources agree on the Bundesliga.** OpenLigaDB matches Wyscout on 306/306 final scores and 304/306 half-time scores. The two half-time mismatches are genuine source contradictions and are kept side by side.
- **OpenLigaDB goal scorers map to canonical players through event alignment.** 285 scorer ids crosswalk with zero conflicts, 13 are queued, and the queue includes 10 genuine conflicts.

## Historical depth (measured)

- **Wyscout:** 2017/18 only, 1,941 matches across 7 competitions. Bundesliga 2017/18 has 306 matches and 519,407 events.
- **OpenLigaDB Bundesliga** (`docs/evidence/coverage/openligadb-bl1.json`):
  - Final results for every season 2004/05–2025/26, 306 finished matches each. 2008/09 lists 308.
  - Goal detail from 2009/10. It is exact (goal rows equal the scores) in 2011, 2012, 2017, 2018, 2021 and 2024. The other seasons are off by 1–11 goals.
  - Phantom "0-0" goal rows (2–11 per season) are detected and never written.
  - No goal detail before 2009/10.

## Event coordinates

- **Available legitimately:** Wyscout 2017/18 only (0–100 team-relative, mapped to 105×68). Shot end locations in that dataset are placeholders, so no canonical end point is derived for shots.
- **Before ESPN, no current-season source provided event coordinates.** ESPN Core plays now do, as a secondary, rights-flagged source (`espn_pct_v1`). They are stored alongside, never replacing, the Wyscout ledger.

## Owner decisions this matrix raises

1. **StatsBomb:** request written consent from StatsBomb (Hudl) for commercial use of the open data, or keep it research-only.
2. **Football-Data.co.uk:** ask for written permission. It holds results, basic stats and closing odds since the 1990s, which is valuable for market intelligence, but no licence is stated.
3. **ODbL obligations:** accept them for OpenLigaDB, meaning attribution, plus share-alike on any publicly used derivative database of its data.
4. **Current-season event data:** no legitimate free source exists. Options:
   - keep the event layer historical
   - license a feed. This conflicts with the $0 rule and needs owner approval.
   - ask a federation or league for a data partnership.
5. **ESPN:** RESOLVED 2026-09-27. The owner approved it as a secondary source; see the update at the top.
6. **Identity method for exact name + DOB matches:** 79 ESPN athletes match an existing canonical player on normalized full name and birth date, mostly Wyscout 2017/18 players still active. Name + DOB is not an allowed merge method today, so they are queued. The options:
   - review them individually (method `reviewed`);
   - approve a new crosswalk method, e.g. `attribute_corroborated`: DOB + name + membership of the same canonical club. That needs a new migration.

<!-- generated:start -->
_Generated from `data/source-registry/sources.json` (registry 2026-09-27.2) by `npm run matrix`. Do not edit by hand._

### Verdicts

| Source | Tier | Licence | Verdict | Prod-ready | Evidence |
|---|---|---|---|---|---|
| Wyscout public soccer-logs dataset (Pappalardo et al., Scientific Data 2019) (`wyscout_figshare`) | open_data | CC BY 4.0 (declared per file on figshare) | **PASS** | no | 3 file(s) |
| OpenLigaDB (community German football database) (`openligadb`) | community | ODbL (stated on openligadb.de) | **PASS** | no | 4 file(s) |
| openfootball football.json / worldcup.json (`openfootball`) | community | CC0-1.0 | **PARTIAL** | no | 4 file(s) |
| Wikidata (SPARQL + entity API) (`wikidata`) | open_data | CC0 (structured data) | **PASS** | no | 2 file(s) |
| Wikimedia Commons (editorial photography) (`wikimedia_commons`) | open_data | Per file (CC0 / PD / CC BY / CC BY-SA) | **PASS** | no | 1 file(s) |
| StatsBomb Open Data (`statsbomb_open`) | open_data | StatsBomb Public Data User Agreement (last updated 8 September 2023) | **RESTRICTS_COMMERCIAL_USE** | no | 2 file(s) |
| SkillCorner open broadcast-tracking sample (`skillcorner_open`) | open_data | MIT | **PARTIAL** | no | 1 file(s) |
| Metrica Sports sample tracking data (`metrica_sample`) | open_data | none stated | **UNVERIFIED** | no | 1 file(s) |
| Football-Data.co.uk historical CSVs (`football_data_co_uk`) | aggregator | none stated | **UNVERIFIED** | no | 4 file(s) |
| football-data.org API v4 (`football_data_org`) | commercial_api | API terms (token required) | **BLOCKED_BY_ACCESS_CONTROL** | no | 1 file(s) |
| TheSportsDB (`thesportsdb`) | commercial_api | TheSportsDB terms | **RESTRICTS_COMMERCIAL_USE** | no | 2 file(s) |
| FBref (Sports Reference; Opta-derived) (`fbref`) | aggregator | Sports Reference terms | **BLOCKED_BY_ACCESS_CONTROL** | no | 3 file(s) |
| Understat (`understat`) | aggregator | none stated | **RESTRICTS_AUTOMATED_ACCESS** | no | 1 file(s) |
| SofaScore (`sofascore`) | aggregator | proprietary | **BLOCKED_BY_ACCESS_CONTROL** | no | 2 file(s) |
| FotMob (`fotmob`) | aggregator | proprietary | **RESTRICTS_AUTOMATED_ACCESS** | no | 2 file(s) |
| WhoScored (Opta) (`whoscored`) | aggregator | proprietary | **BLOCKED_BY_ACCESS_CONTROL** | no | 2 file(s) |
| Transfermarkt (`transfermarkt`) | aggregator | proprietary | **UNVERIFIED** | no | 1 file(s) |
| ESPN Core API (sports.core.api.espn.com) — soccer (`espn_soccer`) | aggregator | Disney Terms of Use | **RESTRICTS_COMMERCIAL_USE** | no | 4 file(s) |
| Premier League (premierleague.com / Pulselive API) (`premier_league`) | official | proprietary | **RESTRICTS_COMMERCIAL_USE** | no | 3 file(s) |
| UEFA (uefa.com / match.uefa.com API) (`uefa`) | official | proprietary | **RESTRICTS_AUTOMATED_ACCESS** | no | 3 file(s) |
| LALIGA (laliga.com) (`laliga`) | official | proprietary | **RESTRICTS_COMMERCIAL_USE** | no | 2 file(s) |
| Bundesliga / DFL (bundesliga.com) (`bundesliga_dfl`) | official | proprietary | **RESTRICTS_AUTOMATED_ACCESS** | no | 2 file(s) |
| Lega Serie A (legaseriea.it) (`serie_a`) | official | proprietary | **UNVERIFIED** | no | 1 file(s) |
| Ligue 1 (ligue1.com) (`ligue_1`) | official | proprietary | **UNVERIFIED** | no | 1 file(s) |
| Major League Soccer (mlssoccer.com / stats API) (`mls`) | official | proprietary | **RESTRICTS_AUTOMATED_ACCESS** | no | 2 file(s) |
| FIFA (fifa.com / api.fifa.com) (`fifa`) | official | proprietary | **RESTRICTS_COMMERCIAL_USE** | no | 2 file(s) |

### Capabilities (sources with structured data)

Y provided · P partial · N not provided · ? not verified

| Capability | `wyscout_figshare` | `openligadb` | `openfootball` | `wikidata` | `wikimedia_commons` | `statsbomb_open` | `skillcorner_open` | `football_data_co_uk` | `espn_soccer` |
|---|---|---|---|---|---|---|---|---|---|
| schedule (sched) | Y | Y | Y | N | N | Y | N | Y | Y |
| results (res) | Y | Y | Y | N | N | Y | P | Y | Y |
| competition_structure (struct) | P | P | P | P | N | Y | N | N | P |
| teams (teams) | Y | Y | P | P | N | Y | P | P | Y |
| player_identity (p-id) | Y | P | N | Y | N | Y | P | N | Y |
| rosters (roster) | P | N | N | N | N | P | P | N | Y |
| managers (mgr) | Y | N | N | P | N | Y | N | N | P |
| venues (venue) | P | P | P | P | N | Y | N | N | Y |
| starting_xi (XI) | Y | N | ? | N | N | Y | P | N | Y |
| bench (bench) | Y | N | ? | N | N | Y | N | N | Y |
| formation (form) | N | N | N | N | N | Y | N | N | Y |
| substitutions (subs) | Y | N | ? | N | N | Y | N | N | Y |
| goals (goals) | Y | Y | P | N | N | Y | N | P | Y |
| cards (cards) | Y | N | N | N | N | Y | N | P | Y |
| fouls (fouls) | Y | N | N | N | N | Y | N | P | Y |
| shots (shots) | Y | N | N | N | N | Y | N | P | Y |
| passes (pass) | Y | N | N | N | N | Y | N | N | P |
| carries (carry) | N | N | N | N | N | Y | N | N | N |
| duels (duel) | Y | N | N | N | N | Y | N | N | Y |
| tackles (tackl) | P | N | N | N | N | Y | N | N | Y |
| interceptions (int) | P | N | N | N | N | Y | N | N | Y |
| recoveries (recov) | N | N | N | N | N | Y | N | N | ? |
| corners (crnr) | Y | N | N | N | N | Y | N | P | Y |
| free_kicks (FK) | Y | N | N | N | N | Y | N | N | P |
| goalkeeper_actions (GK) | P | N | N | N | N | Y | N | N | Y |
| event_coordinates (xy) | Y | N | N | N | N | Y | N | N | Y |
| event_sequence (seq) | Y | N | N | N | N | Y | N | N | Y |
| live (live) | N | ? | N | N | N | N | N | N | ? |
| historical_depth (hist) | P | Y | Y | Y | N | P | N | Y | Y |
| stable_ids (ids) | Y | P | N | Y | Y | Y | P | N | Y |

### Terms and access, verbatim

**Wyscout public soccer-logs dataset (Pappalardo et al., Scientific Data 2019)** — PASS. Access: figshare API + ndownloader, no auth, md5 published per file. Robots: n/a (figshare API).

> License: CC BY 4.0 (figshare article metadata for every file in collection 4415000)

Frozen historical dataset: proven end-to-end (docs/evidence/proof/bundesliga-2017-18.json). No live component, so no runtime canary applies; production readiness = migration applied + backfill run against the sports project. Obligations: Attribute: Pappalardo et al. (2019), Wyscout public dataset, CC BY 4.0.

Evidence: `docs/evidence/source-audit/2026-09-27/wyscout_figshare__collection.json`, `docs/evidence/captures/wyscout_figshare.json`, `docs/evidence/proof/bundesliga-2017-18.json`

**OpenLigaDB (community German football database)** — PASS. Access: Public JSON API, no auth. Robots: api.openligadb.de/robots.txt and www.openligadb.de/robots.txt -> 404 (none).

> Die über diese API bereitgestellten Daten stehen unter der Open Database License (ODbL).

Proven locally (fixture-graph identity, 306/306 score agreement vs Wyscout 2017/18, current season 2026/27 ingested). Needs the soccer-ingest Worker deployed with a cron + canary before it is production-ready. Obligations: Attribute OpenLigaDB (ODbL) on surfaces using it; A publicly used derivative database of OpenLigaDB data must be offered under ODbL (share-alike); keep OpenLigaDB-derived rows identifiable by provider.

Evidence: `docs/evidence/source-audit/2026-09-27/openligadb__home.json`, `docs/evidence/source-audit/2026-09-27/openligadb__bl1_2025.json`, `docs/evidence/coverage/openligadb-bl1.json`, `docs/evidence/proof/bundesliga-2017-18.json`

**openfootball football.json / worldcup.json** — PARTIAL. Access: raw.githubusercontent.com, no auth. Robots: n/a (GitHub raw).

> CC0 1.0 Universal ... for any purpose whatsoever, including without limitation commercial, advertising or promotional purposes

Fixtures/results with team NAMES only (no ids) for EPL, Bundesliga, LaLiga, Serie A, Ligue 1, Eredivisie, Primeira 2026/27. Team identity would need fixture-graph proof per season. The '-full' files carry lineups/goals of unknown upstream provenance (possible scrape of a restricted source): not ingested until provenance is established.

Evidence: `docs/evidence/source-audit/2026-09-27/openfootball__license.json`, `docs/evidence/source-audit/2026-09-27/openfootball__epl_2025_26.json`, `docs/evidence/source-audit/2026-09-27/openfootball__worldcup_2026.json`, `docs/evidence/source-audit/2026-09-27/licenses.json`

**Wikidata (SPARQL + entity API)** — PASS. Access: Public SPARQL endpoint, UA policy applies. Robots: n/a (API).

> Wikidata requires a CC0 license, which is equivalent to public domain

Identity crosswalk layer only (QIDs, DOB, cross-provider ids such as Transfermarkt P2446, FBref P5750, UEFA P2276, MLS P2398, Kicker P8912). No Wyscout or OpenLigaDB id property exists, so joins go through name+DOB rules, never name alone.

Evidence: `docs/evidence/source-audit/2026-09-27/wikidata__sparql_epl_clubs.json`, `docs/evidence/source-audit/2026-09-27/wikidata__licensing.json`

**Wikimedia Commons (editorial photography)** — PASS. Access: MediaWiki API. Robots: n/a (API).

> per-file licence metadata (extmetadata)

Media only. Every file needs a reviewed licence + author + source before use; never a generic stock or generated hero. Obligations: Per-file attribution as the licence requires.

Evidence: `docs/evidence/source-audit/2026-09-27/wikimedia_commons__api.json`

**StatsBomb Open Data** — RESTRICTS_COMMERCIAL_USE. Access: GitHub raw, no auth. Robots: n/a (GitHub raw).

> The User shall, except as expressly permitted herein, shall not modify, translate, transfer, distribute, license, sell or otherwise exploit for any purposes whatsoever any data ... without the express prior written consent of StatsBomb

Richest open event data (360 freeze frames; World Cups 2018/2022, Euros 2020/2024, Bundesliga/Premier League/Serie A/Ligue 1 2015/16, Messi-era LaLiga, MLS, women's). Agreement frames it as a research tool and bars distributing/exploiting the data without written consent. Use only for internal methodology research unless the owner obtains written consent from StatsBomb (Hudl). Obligations: Credit StatsBomb logo on any published analysis (clause 1.4).

Evidence: `docs/evidence/source-audit/2026-09-27/statsbomb_open__competitions.json`, `docs/evidence/source-audit/2026-09-27/licenses.json`

**SkillCorner open broadcast-tracking sample** — PARTIAL. Access: GitHub. Robots: n/a.

> MIT (GitHub licence API)

A handful of matches of broadcast tracking. Research reference for a FUTURE tracking data class only; never presented as our own tracking. Obligations: MIT notice.

Evidence: `docs/evidence/source-audit/2026-09-27/licenses.json`

**Metrica Sports sample tracking data** — UNVERIFIED. Access: GitHub. Robots: n/a.

> GitHub licence API: no licence

No licence file: all rights reserved by default. Not used.

Evidence: `docs/evidence/source-audit/2026-09-27/licenses.json`

**Football-Data.co.uk historical CSVs** — UNVERIFIED. Access: Plain HTTP CSV, no auth. Robots: User-agent: * Disallow: (allow) — but explicitly disallows GPTBot, ClaudeBot, Anthropic-AI, CCBot and other AI crawlers.

> No licence or reuse terms found on the disclaimer page; notes.txt lists upstream sources for results, stats and odds.

Results + basic match stats (shots, shots on target, corners, fouls, cards) + bookmaker odds incl. closing lines for 20+ leagues since the 1990s. Valuable for future market intelligence, but no licence is stated and the site credits upstream sources (BBC, ESPN, Flashscore, Betbrain, Oddsportal). Needs written permission before any ingestion.

Evidence: `docs/evidence/source-audit/2026-09-27/football_data_co_uk__robots.json`, `docs/evidence/source-audit/2026-09-27/football_data_co_uk__notes.json`, `docs/evidence/source-audit/2026-09-27/football_data_co_uk__disclaimer.json`, `docs/evidence/source-audit/2026-09-27/football_data_co_uk__epl_2025_26_csv.json`

**football-data.org API v4** — BLOCKED_BY_ACCESS_CONTROL. Access: X-Auth-Token required. Robots: n/a.

> Not reviewed: token-gated

403 without an API token. No token requested (would be a new third-party account/API dependency; owner decision).

Evidence: `docs/evidence/source-audit/2026-09-27/football_data_org__matches_no_token.json`

**TheSportsDB** — RESTRICTS_COMMERCIAL_USE. Access: Shared free key '3'. Robots: n/a.

> Free API Usage You may use our API to lookup data and artwork for your development ... Paid API Usage You may use our API to develop apps and services as long as you stay within the rate limit

Free key is for development; production apps/services require a paid subscription ($0 rule: not pursued).

Evidence: `docs/evidence/source-audit/2026-09-27/thesportsdb__terms.json`, `docs/evidence/source-audit/2026-09-27/thesportsdb__epl_next.json`

**FBref (Sports Reference; Opta-derived)** — BLOCKED_BY_ACCESS_CONTROL. Access: Cloudflare challenge on every request. Robots: 403 Cloudflare challenge (robots.txt itself blocked).

> you should not create websites or tools based on data you scrape from Sports Reference or any of our sites

robots.txt and pages return a Cloudflare challenge (403). Terms also forbid building a competing data store and sites built on scraped data.

Evidence: `docs/evidence/source-audit/2026-09-27/fbref__robots.json`, `docs/evidence/source-audit/2026-09-27/fbref__epl_page.json`, `docs/evidence/source-audit/2026-09-27/fbref__data_use.json`

**Understat** — RESTRICTS_AUTOMATED_ACCESS. Access: Open HTML. Robots: User-agent: * / Disallow: /.

> robots.txt: Disallow: /

robots.txt disallows all crawling.

Evidence: `docs/evidence/source-audit/2026-09-27/understat__robots.json`

**SofaScore** — BLOCKED_BY_ACCESS_CONTROL. Access: 403. Robots: 403.

> Not reachable

403 on robots.txt and API.

Evidence: `docs/evidence/source-audit/2026-09-27/sofascore__robots.json`, `docs/evidence/source-audit/2026-09-27/sofascore__api_events.json`

**FotMob** — RESTRICTS_AUTOMATED_ACCESS. Access: Public site; API path probed returned 404. Robots: Long disallow list (see evidence).

> The use of automatic services (robots, crawler, indexing etc.) as well as other methods for systematic or regular use is not permitted.

Site footer forbids automated access.

Evidence: `docs/evidence/source-audit/2026-09-27/fotmob__terms.json`, `docs/evidence/source-audit/2026-09-27/fotmob__robots.json`

**WhoScored (Opta)** — BLOCKED_BY_ACCESS_CONTROL. Access: 403 + CAPTCHA. Robots: Partial disallow (/Accounts/, /Predictions/, /Users/).

> Not reachable

Homepage returns 403 with CAPTCHA markup.

Evidence: `docs/evidence/source-audit/2026-09-27/whoscored__home.json`, `docs/evidence/source-audit/2026-09-27/whoscored__robots.json`

**Transfermarkt** — UNVERIFIED. Access: Open HTML. Robots: User-agent: * Allow: / (wget disallowed).

> Not reviewed

robots allows generic crawlers; terms not reviewed. Only its ids are relevant, and those are available via Wikidata P2446.

Evidence: `docs/evidence/source-audit/2026-09-27/transfermarkt__robots.json`

**ESPN Core API (sports.core.api.espn.com) — soccer** — RESTRICTS_COMMERCIAL_USE. Access: site.api: Akamai 403; core API: open. Robots: n/a (API).

> use the Disney Products for any commercial or business-related use (prohibited); compiling ... any collection of data, data set or database (prohibited)

Core API: 308/308 discovery requests 200 (docs/evidence/espn-soccer-discovery-latest.json). site.api scoreboard 403 (Akamai) — never touched. Coordinates verified: 0-100 team-relative, attacking x=100, y=0 attacking right (docs/evidence/espn-soccer-coordinates.json). Precedence: official/open proven sources > ESPN; ESPN attaches ids, records its own result observation, founds only where no other source exists.

Evidence: `docs/evidence/source-audit/2026-09-27/espn_soccer__scoreboard.json`, `docs/evidence/source-audit/2026-09-27/espn_soccer__core_events.json`, `docs/evidence/espn-soccer-discovery-latest.json`, `docs/evidence/espn-soccer-coordinates.json`

**Premier League (premierleague.com / Pulselive API)** — RESTRICTS_COMMERCIAL_USE. Access: Pulselive API: ECONNRESET. Robots: Allows paths; blocks query-parameter variants.

> The Website and App must not be used in any other way, including for commercial purposes, and you may not otherwise reproduce, re-utilise or redistribute it (including, by way of example, creating a database ...

Terms forbid commercial use and creating a database from site material. Pulselive API connection reset from this workstation.

Evidence: `docs/evidence/source-audit/2026-09-27/premier_league__terms.json`, `docs/evidence/source-audit/2026-09-27/premier_league__robots.json`, `docs/evidence/source-audit/2026-09-27/premier_league__pulselive_comps.json`

**UEFA (uefa.com / match.uefa.com API)** — RESTRICTS_AUTOMATED_ACCESS. Access: Open JSON API. Robots: Allows most paths.

> You are not allowed to systematically collect, compile, or gather the Content in any way ... to create a collection, database, or directory. Additionally, you are prohibited from using automated tools, such as robots, spiders, or scripts, to scrape or collect Content

Match API answers without auth (200), but terms explicitly ban robots/scrapers and building a database, and model training on the content. Champions League / Europa League have NO legitimate event source found.

Evidence: `docs/evidence/source-audit/2026-09-27/uefa__terms.json`, `docs/evidence/source-audit/2026-09-27/uefa__match_api.json`, `docs/evidence/source-audit/2026-09-27/uefa__robots.json`

**LALIGA (laliga.com)** — RESTRICTS_COMMERCIAL_USE. Access: Open HTML. Robots: See evidence.

> The Content that you access through the Website is for your personal, non-commercial use.

Content for personal, non-commercial use; commercial reproduction prohibited.

Evidence: `docs/evidence/source-audit/2026-09-27/laliga__legal.json`, `docs/evidence/source-audit/2026-09-27/laliga__robots.json`

**Bundesliga / DFL (bundesliga.com)** — RESTRICTS_AUTOMATED_ACCESS. Access: Open HTML. Robots: Long list; second fetch reset.

> the Bundesliga expressly reserves the right to reproduce the content ... for the purposes of text and data mining. Any automated programmes, applets, bots or similar technologies may not be used to access, analyse or download the content

Text-and-data-mining rights reserved; bots may not access, analyse or download content.

Evidence: `docs/evidence/source-audit/2026-09-27/bundesliga__terms.json`, `docs/evidence/source-audit/2026-09-27/bundesliga__legal_notices.json`

**Lega Serie A (legaseriea.it)** — UNVERIFIED. Access: Open HTML. Robots: User-agent: * Allow: /.

> Not captured

robots allows; terms not yet captured.

Evidence: `docs/evidence/source-audit/2026-09-27/serie_a__robots.json`

**Ligue 1 (ligue1.com)** — UNVERIFIED. Access: Open HTML. Robots: User-agent: * Allow: /.

> Not captured

robots allows; terms not yet captured.

Evidence: `docs/evidence/source-audit/2026-09-27/ligue_1__robots.json`

**Major League Soccer (mlssoccer.com / stats API)** — RESTRICTS_AUTOMATED_ACCESS. Access: Open HTML. Robots: Allows most paths.

> use any engine, software, tool, agent or other device or mechanism (including, without limitation, browsers, spiders, robots ...) to navigate or search the Services to harvest or otherwise collect information from the Services to be used for any commercial purpose

Terms ban spidering/screen scraping and automated harvesting for commercial purposes. Stats API path probed returned 404. MLS has NO legitimate structured source found.

Evidence: `docs/evidence/source-audit/2026-09-27/mls__terms.json`, `docs/evidence/source-audit/2026-09-27/mls__stats_api.json`

**FIFA (fifa.com / api.fifa.com)** — RESTRICTS_COMMERCIAL_USE. Access: Open JSON API. Robots: Allows.

> FIFA grants You a limited, revocable, non-exclusive licence to access the FIFA Digital Platforms and use the Content strictly for the purpose of using the FIFA Digital Platforms privately for non-commercial purposes

api.fifa.com answers without auth (200), but terms limit content to private non-commercial use and ban robots used to circumvent intended function.

Evidence: `docs/evidence/source-audit/2026-09-27/fifa__terms.json`, `docs/evidence/source-audit/2026-09-27/fifa__api_matches.json`

<!-- generated:end -->
