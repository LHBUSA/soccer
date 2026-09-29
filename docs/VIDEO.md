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

## Discovery: SUSPENDED (2026-09-29)

YouTube's robots.txt disallows `/youtubei/` and `/feeds/videos.xml`, and its Terms of Service forbid automated
access except public search engines following robots.txt or with written permission (evidence:
`docs/evidence/source-audit/2026-09-29/youtube_rss__*.json`, registry key `youtube_rss`). The public-page discovery
below used `/youtubei/v1/browse` and automated watch-page reads, so `scripts/videos/ingest.mjs` now refuses to run
anything except `--link-only` (our database only, no YouTube request). The compliant replacement is the
**YouTube Data API v3** (YouTube API Services Terms; owner-created API key). Embedding through the official
player is unaffected.

### Former public-page discovery (not run)

Each channel's public uploads listing (newest first). A candidate is a title naming one of our clubs (league
channels) or two clubs / a highlights title (club channels). Its public watch page gives the exact publish
time, uploading channel (must equal the listing channel), duration, `playableInEmbed` and US availability;
oEmbed confirms the embed page exists. oEmbed 200 is not region playability: the page's player falls back at
runtime (below).

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
    node scripts/videos/ingest.mjs --link-only   # re-score stored videos against articles (DB only); discovery is suspended
    node scripts/qa/video.mjs --site <url> --article /news/<desk>/<slug> --none /news/<desk>/<slug>
