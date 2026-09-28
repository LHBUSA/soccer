# Media identity (portraits and crests)

Governed by `soccer_entity_media` (migration `20260927000500`), `data/media/policy.json`,
`workers/shared/media-rights.js` and `workers/soccer-ingest/src/media-wikimedia.js`.

**A URL existing is not permission.** Every file is attached by *identity evidence* and
published by *per-file rights*. Nothing else is ever shown.

## Identity: which file belongs to which entity

| Entity | Rule | Never |
|---|---|---|
| Player portrait | Wikidata item found by the **exact ESPN FC player id** (P3681), which is the same id space as our ESPN athlete crosswalk. Exactly one item may carry the id, and a stated birth date must equal ours. The item's image (P18) is the file. | name search, fuzzy match, ESPN headshot URL guessing |
| Player portrait, tier 2 | Only inside a club already proven by roster proof: the club's Wikidata members (P54 with start/end dates) are matched on **exact normalized name (label or alias) + exact birth date + a club spell overlapping the dates we observed the player at that club + exactly one candidate**. This mirrors the owner-approved attribute_corroborated identity rule. Ambiguity is recorded (held_review), never attached. | name-only or partial names |
| Club crest | **Roster proof**: the current club (P54, no end date) shared by at least 60% (and at least 5) of the team's id-matched players, runner-up at most 30%, the item is a football club, and no two canonical teams claim it. The club's logo (P154) is the file. | name matching, random CDN/logo sites |

**Club identity paths (media-wikimedia 1.1.0, 2026-09-28).** Any of four deterministic paths may prove a
club; paths that yield a club must agree, and a club claimed by two canonical teams is refused:
1. roster proof (current club, thresholds above);
2. dated roster proof: the same thresholds over the P54 spell that overlaps the dates we observed each
   player at this team (recovers clubs that fail on transfers);
3. exact ESPN team id on Wikidata P13590 (exactly one football-club item);
4. exact OpenLigaDB team id -> its current-season `teamIconUrl` -> only when that URL is an exact
   Wikimedia Commons upload -> the item whose logo (P154) is that exact file -> exactly one football club
   whose league (P118) is the Bundesliga or 2. Bundesliga (separates the senior club from reserve,
   women's and season items that reuse the logo). Imgur and club / federation hosts are never trusted.
The crest file is the club's CURRENT logo: deprecated and ended P154 statements are ignored, preferred
rank wins, exactly one is required. The rights verifier runs on every file regardless of the path.
UEFA and ESPN logo URLs are never treated as licensed artwork; ESPN artwork is displayed only under the owner identification policy below, recorded as not free-licensed.

## Owner identification policy (2026-09-28)

The owner of PropBetEdge / PropTechUSA.ai has **approved team crests and player media for entity
identification in the product** (`data/media/policy.json` `owner_identification`, migration
`20260928000800`). There are no internal owner holds. The rule:

**identity proven by an exact id + current crest / photo identified + owner approval = eligible for rendering.**

This is an internal product decision, not a licence. Rows displayed under it have
`rights_status = 'owner_approved_identification'` and keep truthful provenance: `provider`, `source_url`,
`retrieved_at`, the copyright / licence text as known ("Not free-licensed ..."), `trademark_status` and
`owner_policy_version`. They are never labelled free, public domain or licensed; the API exposes
`basis: free_license | owner_approved_identification` on every media object.

Source priority per entity: (1) an already-governed free-licensed Commons file (`approved`) stays primary;
(2) an official club / league asset with deterministic identity; (3) provider artwork tied to an exact
provider id (`scripts/media/provider-media.mjs`, `workers/soccer-ingest/src/media-provider.js`): the ESPN
team's `default` logo from ESPN's league team listing for the exact ESPN team id in
`soccer_team_external_ids`, and the athlete headshot from ESPN's team roster payload for the exact ESPN
athlete id in `soccer_player_external_ids` (a stated birth date must agree); (4) Commons/Wikidata.
URLs are taken from the provider's own payload, never guessed; bytes are cached write-once in R2 and
served same-origin. Identity is not loosened: no name matching, no fuzzy logo attachment.

Text-only wordmarks (Inter Miami, AS Roma, Liverpool on Wikidata P154) are not the current crest, so
they are not used; those clubs get their current crest through path (3).

## Discovery ledger

`soccer_media_discovery` records one outcome per entity and media type, with method, external id, source page, reason and evidence:
`approved` | `owner_approved_identification` | `held_review` | `rejected` | `not_found`. A hold now always names a real blocker: identity unresolved, asset unavailable, source/provenance issue, current crest not found, or a failed cache.

## Storage and serving

Approved files are downloaded once (Commons thumbnail, 480 px), hashed, and written
**write-once, content-addressed** to R2 at `soccer-source/media/sha256/<xx>/<sha256>`.
The API serves bytes at `/v1/media/<sha256>` **only while an approved row carries that hash**:
a rejected or unreviewed file cannot be fetched even by guessing its hash. The browser reaches it
same-origin through `/api/soccer/media/<sha256>`.

The API exposes approved media only (`players/:slug.media`, `teams/:slug.media` and `crest`,
and `crest` on every team object in matches and tables), with licence, author, attribution and
the source page. Pages credit the author and licence; a crest shows its attribution on hover and
on the team page.

## Fallbacks

No approved media means a typographic initials mark for teams and a neutral silhouette for players.
A broken approved image is swapped for the same fallback in the browser. No generated player art,
no SVG club logos.

Every page draws identity images through ONE component, `src/components/media.js` (`crest`,
`portrait`, `mountMediaFallbacks`; `playerChip` in ui.js = portrait + name). The silhouette is
an original raster (`public/brand/player-silhouette-{128,256}.webp`, rendered by
`scripts/brand/render-silhouette.py`): no face, no likeness, no marks, transparent background.
Unresolved source names ("identity pending") never get a portrait.

## Run

```
node scripts/media/wikimedia-backfill.mjs [--dry] [--limit N] [--skip-teams]
```
Idempotent: re-runs reuse verified cached copies. Evidence: `docs/evidence/media/wikimedia-<date>.json`.
