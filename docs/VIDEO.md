# Official video (soccer)

YouTube videos from **verified, allowlisted official publishers only**, linked to stories by an
explainable matcher, rendered poster-first through the privacy-enhanced player. Modelled on the UFC
video layer (LHBUSA/UFC `scripts/videos/`, `web/components/OfficialVideo.tsx`, `docs/videos.md`) and the
propbetedge-news-site playback tests. Nothing is downloaded or rehosted; the footage stays on YouTube.

## Tables (migration `20260929000900_soccer_official_video.sql`)

| table | holds |
|---|---|
| `soccer_video_channels` | the allowlist: exact channel id, name, handle, publisher type (competition / governing_body / club / publisher), competition or team, `verified`, `enabled` (enabled requires verified), `verification` evidence |
| `soccer_videos` | normalized metadata: provider video id, channel, title, description, published_at, duration, YouTube thumbnail URL, watch URL, `embeddable`, `region_restriction`, `video_type` (highlights, match_recap, goals, interview, press_conference, preview, analysis, other) |
| `soccer_video_links` | graph edges: video -> article (+ match, team ids, player ids, competition), score, reasons, `linked` or `rejected`, matcher version |

## Allowlist (`scripts/videos/channels.mjs`, `data/video/channels.json`)

A channel is verified + enabled only when, live on every run: (1) Wikidata's **P2397 (YouTube channel ID)**
on the competition / governing body / club item equals the channel id exactly, and (2) the channel page at
`/channel/<id>` is canonical for that id. Club items come only from clubs whose Wikidata identity the media
pipeline already proved. Never a handle guess or a name search. Fan channels, compilations and re-uploads are
never added; broadcaster channels need explicit owner approval (none enabled).

## Discovery: scheduled Data API autopilot

The old keyless public-page discovery remains **suspended**. YouTube's robots.txt disallows
`/youtubei/` and `/feeds/videos.xml`, and the source audit records the automated-access restriction
(`docs/evidence/source-audit/2026-09-29/youtube_rss__*.json`, registry key `youtube_rss`).
`scripts/videos/ingest.mjs` therefore still refuses every provider request and supports only
`--link-only` against rows we already own.

Production-ready replacement: `workers/soccer-video-autopilot`.

- cron: `13,43 * * * *`
- discovery: **YouTube Data API v3 only**
- inventory: enabled + verified rows from `soccer_video_channels`
- requests: each channel's uploads playlist via `playlistItems.list`, then `videos.list` in batches
- stores: title, description, publish time, duration, thumbnail, embeddability, privacy/live state and
  region restrictions; no video bytes are downloaded or rehosted
- linking: the existing `soccer-video-match` resolver is rerun against published article packets after
  discovery, so a new official highlight can attach to an article without rewriting the article
- fail closed: without `YOUTUBE_API_KEY`, discovery does not fall back to scraping; the worker may only
  rebuild article links from already stored rows
- health: `GET /health` states whether the key is configured and records the last scheduled run in
  `SOCCER_STATE`

The YouTube API key is a platform credential, not a paid sports-data feed. Embedding remains through the
official privacy-enhanced player and does not require the Data API key.

FIFA is now an explicit governing-body candidate in `scripts/videos/channels.mjs`. Its exact YouTube
channel id is still resolved from Wikidata P2397 and re-proved against the canonical channel page before
the database row can be enabled. UEFA remains multi-competition scoped; its videos receive competition
credit only when the title identifies the correct competition.

### Retired public-page implementation

The older implementation used public uploads pages, `/youtubei/v1/browse`, watch-page reads and oEmbed.
It is retained only as historical code and must not be scheduled. oEmbed may confirm that an embed page
exists, but does not establish country playability.

## Matching (`workers/shared/video-match.js`, `soccer-video-match/1.2.0`)

1.2.0 (2026-09-29):
- **Player form:** besides the player named in the title, official highlights / goals of the exact match of the
  story's latest appearance attach when the canonical appearance records that the player scored in it (reason
  recorded). Not named and did not score = no video.
- **Match preview:** timing inverts (+20 within the 7 days before kickoff, -30 after kickoff) and only preview /
  press conference / interview / analysis videos attach; highlights never attach to a preview.
- **Live shows** ("Matchday Live", streams, watch-alongs) are never highlights or previews; `video_type` is
  re-derived from the title at link time.
- Table / competition stories still take no video (no single match fits a league-wide story).

| points | rule |
|---|---|
| +40 | both teams of the story's match named in the title |
| +25 | the story's player named in full (player form) |
| +20 | competition channel of that competition, or club channel of a team in the match |
| +20 | published between kickoff and 72 h after it |
| +15 | final score in the title |
| +10 | highlights / match recap / goals video |
| -50 | another club named (conflicting opponent) -> rejected |
| -40 | another competition named (cup, Europe, friendly, women, youth...) -> rejected |
| -30 | published before kickoff or more than 7 days after |

**Threshold 75**, and any conflict / wrong-competition penalty rejects outright. A single-team title can
reach at most 65; a match video needs both teams plus competition or date context (>= 80). Story context comes
from the frozen packet: recap -> its match; player form -> the latest appearance's match + the player; team
trend -> the run's latest match; table stories take no match video. No confident video = no module.

## API (soccer-api)

- `GET /v1/news/:slug` -> `media.videos`: linked videos only (enabled channel, never known-unembeddable),
  each with `validated: true`, the link score and reasons.
- `GET /v1/videos?desk=&limit=` -> the newsroom WATCH module: recent official highlights (verified channels,
  embeddable, not US-blocked, no Shorts), story-linked first, at most two per channel.
Every video object carries `embed_url` (youtube-nocookie), `url` (watch page) and the attribution
"Official video · embedded from YouTube · not hosted by PropBetEdge".

## Playback (`src/components/video.js`)

Poster first (YouTube's thumbnail), explicit 1280x720 / CSS 16:9 box, no iframe and no player request until
the reader clicks. Then an in-place `https://www.youtube-nocookie.com/embed/<id>?enablejsapi=1&origin=<page
origin>` iframe (referrer policy strict-origin-when-cross-origin, allowfullscreen). The IFrame API handshake
listens for player errors: **100 / 101 / 150** return the card to its poster with "Not available for embedded
playback in your region." and **Watch on YouTube ↗**. A known US block or unembeddable video renders that
fallback from the start. CSP: `img-src https://i.ytimg.com`, `frame-src https://www.youtube-nocookie.com`.

## SEO

`VideoObject` JSON-LD (name, description, thumbnailUrl, uploadDate, contentUrl = watch URL, embedUrl =
nocookie URL, publisher = channel) only for a matcher-validated video linked to the article.

## Run

    node scripts/videos/channels.mjs          # re-prove the allowlist
    node scripts/videos/ingest.mjs --link-only   # DB-only repair / relink
    cd workers/soccer-video-autopilot && npx wrangler deploy --dry-run
    node scripts/qa/video.mjs --site <url> --article /news/<desk>/<slug> --none /news/<desk>/<slug>
