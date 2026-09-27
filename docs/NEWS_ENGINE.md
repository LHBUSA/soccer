# News engine

**Data-backed soccer intelligence journalism.** Soccer News is the public
discovery surface for the graph, not a detached blog. Every article leads deeper
into the graph:
- player
- team
- match
- competition
- PBEcast
- DNA

## Pipeline

```
detect (soccer_news_events) -> packet (frozen, hashed) -> compose -> gates -> publish | HOLD
```

1. **Detect.** A materiality-scored event, e.g. a match went final. `event_id` = UUIDv5(`news_event:<class>:<entity ids>:<as_of>`).
2. **Packet** (`workers/soccer-news/src/packet.js`, `soccer-packet/1.0.0`). This is the ONLY input to composition. For a match recap it holds:
   - match, score (final and half-time), winner, margin
   - teams: manager, form before, table position before and after (computed from canonical results)
   - goals, with display minute, scorer, assist where the source tags one, penalty or free kick, body part and distance
   - shots in the match frame, and per-team counts (`pbe-counts/1.0.0`)
   - shares (completed passes, attacking-third events) and shot profile
   - key performers, by a documented ordering rule rather than a rating
   - `unavailable[]`: what we will not say, and why
   - provenance: attributions, every provider's result, capture ids
   The packet is stored once in `soccer_article_evidence`. An append-only trigger blocks update and delete.
3. **Compose** (`compose.js`, `template/soccer-recap@1.0.0`):
   - deterministic templates, and a sentence is omitted when its inputs are missing;
   - sections: Result, How the goals came, Shot profile, Territory and control, Key performers, Table impact and form, Evidence and method;
   - an LLM editorial pass may be added later, but its output must pass the same gates against the same packet.
4. **Gates** (`gates.js`, `soccer-gates/1.0.0`). Every gate must pass:

| Gate | Checks |
|---|---|
| `numeric_grounding` | Every number and number word in the text exists in the packet. Identifier digits (uuids, hashes) never count. |
| `claims_consistency` | Numbers in known sentence forms equal the exact packet field they describe: shots, on target, passes, duels, corners, fouls, table position, points, half-time. |
| `match_not_final`, `score_in_headline`, `wrong_winner`, `entity_headline`, `hat_trick_grounding` | Result integrity. |
| `entity_grounding` | Every linked entity exists in the packet with the same id and name. |
| `unsupported_quote`, `unsupported_medical`, `unsupported_market`, `unsupported_record`, `unsupported_mentality`, `unpublished_metric`, `unsupported_possession`, `cliche` | Banned claims in editorial text. The method section is exempt, because it must name what is unavailable. |
| `too_thin`, `headline_length`, `attribution`, `render_artifact` | Quality and obligations. |

5. **Publish or hold.** Failed gates become `hold_reasons`, and the schema refuses `published` while any remain. Archive matches (older than 30 days) are held as `archive_match_not_current_news`.

## Proof

Bayern München 6-0 Borussia Dortmund, 31 March 2018. Evidence:
- `docs/evidence/proof/packet-bayern-dortmund-2018-03-31.json`
- `article-….json`
- `match-….html`

Results:
- **Headline:** "Bayern München 6-0 Borussia Dortmund: Robert Lewandowski hat-trick". All gates pass.
- **Adversarial check:** the same article with shots +7 is rejected by `claims_consistency`. The inflated number happens to exist elsewhere in the packet, which is exactly why set-membership grounding alone is not enough.
- **Packet immutability:** confirmed.
- **Status:** `held` (archive match).

## Story classes

| Class | Evidence needed before it may run |
|---|---|
| Match recap | Proven: packet, composer, gates. |
| Match preview | Fixture, form and table from the graph. Lineups only when sourced. Injuries only from a legitimate ingested source (none yet), so previews carry no injury claims. |
| Player form | Rolling derived counts across matches, with explicit minimum minutes. |
| Team trend | Rolling team counts. Formation changes only when a source states formations (none today). |
| Competition intelligence | Table, race and form, all computable from canonical results today. |
| Data feature | Soccer DNA and model findings. Blocked until `MODEL_READINESS` gates pass. |

## Desks, SEO, imagery

**Desks:**
- `/news/premier-league`
- `/news/champions-league`
- `/news/mls`
- `/news/la-liga`
- `/news/bundesliga`
- `/news/serie-a`
- `/news/ligue-1`
- `/news/international`

A desk only goes indexable once it has current, legitimately sourced stories. Today that means the Bundesliga only.

**Structured data:**
- one `@graph` with `NewsArticle` + `BreadcrumbList`
- `about` covers packet entities: `SportsEvent` (home/away `SportsTeam`), `SportsTeam`, `Person`
- canonical, OG and X card tags
- a sitemap index split into news-current, articles-by-month, teams, players, matches and competitions
- no invented `lastmod`

This follows the `propbetedge-news-site` entity-graph pattern: one resolver, and links only to resolved canonical ids.

**No indexable thin or sample pages.** The proof match page is `noindex`.

**Imagery:**
- real, licensed photography only: Wikimedia Commons with per-file licence, author and source reviewed;
- the tennis tiering applies: same match, then same event, then venue, then a canonical portrait, otherwise no image and a headline-first card;
- never a generated SVG or AI hero.

**Attribution** on every article that uses the data:
- Wyscout (CC BY 4.0)
- OpenLigaDB (ODbL)
