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

The evidence (property, id, QID, player counts) is stored on every row in `match_evidence`.

## Rights: may we publish this file?

From the file's own Commons metadata (`extmetadata`):

| Verdict | When |
|---|---|
| `approved` | CC0 / public domain / CC BY / CC BY-SA (any version), with author and licence URL stated |
| `restricted` | NC or ND licences |
| `rejected` | non-free / fair use |
| `review_required` | everything else (GFDL-only, unknown licence, missing author, a failed cache) |

Commons restrictions (personality rights, trademarks) are recorded in `rights_notes`, and **trademark status is stored separately from copyright** (`trademark_status`: none | trademark_notice | unknown). Owner policy (2026-09-28): a trademark notice does not by itself reject an otherwise properly licensed identification image; the crest is used only to identify the club, never to imply endorsement, sponsorship or affiliation, and is never modified in a misleading way. This is not a claim of trademark ownership.
Free-licensed crests carrying a trademark notice are approved for **identification of the club
only** (`crest_trademark: "approve_nominative"`); set it to `"review"` to hold every one for owner review.

The database enforces it: an `approved` row must have licence, licence URL, attribution, a
verified content hash, the cached object and a verification time; only approved rows can be primary;
at most one primary per entity and media type.

## Discovery ledger

`soccer_media_discovery` records one outcome per entity and media type, with method, external id, source page, reason and evidence:
`approved` | `held_review` | `rejected` | `not_found`. Held by owner decision (2026-09-28): Barcelona (a third-party CC0 claim is not evidence the uploader could relicense the club crest), Inter Miami, AS Roma and Liverpool (text-only marks, not crests).

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
A broken approved image is swapped for the initials mark in the browser. No generated player art,
no SVG club logos.

## Run

```
node scripts/media/wikimedia-backfill.mjs [--dry] [--limit N] [--skip-teams]
```
Idempotent: re-runs reuse verified cached copies. Evidence: `docs/evidence/media/wikimedia-<date>.json`.
