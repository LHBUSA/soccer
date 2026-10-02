# Newsroom V3 — media, packet depth and art (status 2026-10-02)

## Current experience (audited)

- Card image resolver (`src/components/newscard.js`): approved portrait → approved crest → competition graphic.
- Article hero (`src/pages/article.js` `heroMedia`): approved portrait or crest placed over the owned stadium art; the
  IN THIS STORY entity chips render ABOVE the hero. 36 of the last 40 stories carry a crest, 4 a portrait.
- Finland v Albania preview (production, desk 2.1.1): 235 words, three sections, all table/fixture recitation; its packet
  carried group position, last results, runs and this-season meetings only.

## Media decision

Owner direction (2026-10-02): a **PBE-owned editorial art engine** first; licensed photography stays a separate, rights-gated
track. Generated or rendered art is `media_kind = 'pbe_editorial_art'`, never a photo, and never a likeness, crest, logo,
kit or copied photograph.

- Engine: `workers/shared/art/engine.js` (`pbe-art-soccer/0.1.0`), pure deterministic SVG; 3 directions (poster, pitch,
  broadcast) × 4 formats (1600×900, 1200×630, 1080², 1080×1920); templates: preview, report, team trend, player form,
  table. Contact sheet: `node scripts/art/contact-sheet.mjs --out <dir>` (5 production stories, 60 assets; manifest in
  `docs/evidence/art/`). Not wired into production.
- Next: owner picks a direction → art spec frozen with the article packet (`packet_hash`), rendered once, content-hashed,
  stored in R2 (spec, engine version, packet hash, asset hash, generated_at) → hero/OG/social from the same spec; failure
  falls back to today's owned graphic and never blocks publication. Fonts must be embedded for server-side rasterisation.
- Rights notes: renderer output built by code from our own design + factual data is our work; any later generative layer
  (atmosphere only) has weaker copyright protection for the raw output (US Copyright Office guidance) and must never
  produce identifiable people or marks.

## Licensed photography (research only — nothing purchased, contacted or signed)

Decisive constraint: **betting-adjacent use.** Getty's EULA excludes "gambling/betting/gaming uses" unless the invoice
authorises it; Premier League (DataCo) images carry "No use in betting, games"; Stats Perform's Getty resale terms list
EPL, F1 and US leagues as betting-excluded and require no odds/betting call-to-action on the page. Any licence needs the
betting position **in writing** first.

| Provider | Fit | Notes |
|---|---|---|
| Getty Images (API) | Best coverage: exclusive MLS partner, official UEFA agency, FIFA / U.S. Soccer partner; REST v3 search by event id/date | Self-serve editorial from $167/mo for 10 downloads; API via account manager; §3.7 betting clause; OG/social scope unconfirmed |
| IMAGO | Soccer specialist: PL, Bundesliga, LaLiga, Serie A, UCL, national teams, live World Cup 2026 feed; CMS push API | Starter 100+ licences €999; betting and OG terms unpublished |
| Reuters Connect (incl. Imagn) | US sports strength; Imagn now sold only via Reuters | Points or unlimited plans; terms unpublished (official docs unreachable to research) |
| AP Media API | Clean search/feed API | Only terms found (resale) cap storage at 30 days and ban photo-only displays |
| Getty Embed | Not suitable | iframe only, no OG, ads in viewer, revocable |

Questions for sales are in the research notes (betting clause wording in the invoice; which competitions are excluded;
OG/social rights; retention after term; self-hosting/CDN).

## Proposed `soccer_story_media` (not a migration yet)

`id, media_kind ('licensed_photo' | 'pbe_editorial_art'), provider, provider_asset_id, source_url, story_id, match_id,
subject_entity_ids[], home_team_id, away_team_id, competition_id, captured_at, published_at, caption, photographer,
credit, usage_terms, rights_status, rights_basis, allows_web_editorial, allows_social_og, allows_archive,
betting_page_allowed, expires_at, original_width, original_height, sha256, r2_path, retrieved_at, match_evidence jsonb,
freshness ('current_match' | 'recent' | 'portrait'), art_spec_hash, engine_version, packet_hash` — with media revisions
append-only (a better photo after publication is a new revision row; prose stays frozen).

Resolver hierarchy (cards and heroes): exact-match licensed photo (teams + event/date window + competition evidence stored)
→ same event/tournament + exact subject → recent exact-subject editorial photo (captioned with its own date/event) →
PBE editorial art → approved portrait → approved crest → competition graphic. Adjacent cards never repeat a lead asset
unless unavoidable. OG uses a licensed image only when `allows_social_og`; else PBE art.

## Packet V4 (previews) — committed, not deployed

`workers/soccer-news/src/preview-depth.js`: campaign record, last five within 400 days (with competitions), scoring by
half / 15-minute period (reconciled matches only), source shots, located-shot profile (PBE derived), scorers,
contributors, formations + XI continuity, cards, home/away, rest days, H2H "in the PropBetEdge record since <year>",
previous meeting, next fixtures, group consequences provable on points, and ranked angles. Finland v Albania packet:
`docs/evidence/news/packet-v4-preview-depth-finland-albania-2026-10-02.json`. Desk brief: primary angle first, facts not
tactics, 500–850 words only when evidence is rich.

## Not done yet (owed)

- Desk canary on the five stories (paid OpenAI calls through the authenticated admin re-edit path) and the blind editorial
  review; soccer-news deploy after it.
- Article hero/IN-THIS-STORY reorder, PLAYER IN FORM module, new story types, media revision trail, story-media migration.
- Art direction choice by the owner; R2 storage + server rasterisation for OG.
