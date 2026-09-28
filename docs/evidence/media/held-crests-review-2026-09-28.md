# Held crests review (2026-09-28)

Read-only review of the four club crests HELD by owner decision on 2026-09-28 (`docs/MEDIA.md`, "Discovery ledger"). Nothing was written to the database, R2, approvals or code. Source of the held rows: `docs/evidence/media/crest-audit-2026-09-28.md` (rows 4-7, `held_review` / `held_by_owner_decision`, all from the Wikidata P154 of the club item).

Method: Wikimedia Commons API only (`action=query&prop=imageinfo|categories|templates` with `extmetadata`, plus `prop=revisions` for the file-page wikitext), with an honest User-Agent. Images were checked from Commons thumbnails (320 px) so the description below is what the file actually shows. Alternatives come from the club's Commons logo category and a Commons file search.

Notes that apply to all four:

- **PD-textlogo** is a Commons claim that the image falls below the **US** threshold of originality. It says nothing about the source country: the UK (Liverpool) has historically had a low originality threshold, and Italy (Roma) and Spain (Barcelona) protect graphic works under their own standards. The Commons template itself warns that the file "may still be subject to other restrictions".
- **Trademark**: all three PD-textlogo files carry `{{Trademarked}}` (Liverpool also `{{Trademark}}`). Copyright status does not change the trademark. Use on a betting/prop site is nominative identification of the club, never endorsement, and the owner should treat it as such.
- **CC0 by a non-rights-holder** is not a licence. A user who redraws or copies a club crest and marks it "own work, CC0" cannot waive rights they do not hold.

## FC Barcelona

| Field | Value |
|---|---|
| Team | FC Barcelona (`barcelona`, `db302030-0990-55c4-81ee-140bf1222310`, UCL; Wikidata Q7156) |
| Candidate asset | `File:Football Club Barcelona Color Update.png` |
| File page | https://commons.wikimedia.org/wiki/File:Football_Club_Barcelona_Color_Update.png |
| Original | https://upload.wikimedia.org/wikipedia/commons/3/33/Football_Club_Barcelona_Color_Update.png (1976x2000 PNG) |
| Uploaded | 2026-08-15 by User:HAMDANI 72 |
| Source (as stated) | `{{own}}` ("Own work"); author "HAMDANI 72" |
| Licence | `{{self\|cc-zero}}`: "CC0" / "Creative Commons Zero, Public Domain Dedication", http://creativecommons.org/publicdomain/zero/1.0/deed.en |
| Copyright status | extmetadata `Copyrighted: True`; copyright claimed by the uploader, who dedicates it to the public domain. No PD-textlogo or threshold-of-originality claim. No `permission` field, no VRT/OTRS ticket, no statement from the club. |
| Trademark notice | None (no `{{Trademarked}}` template) |
| Crest or wordmark | **The actual current club crest.** The image is a faithful reproduction of the FCB escut: St George's cross and senyera in the upper field, "FCB" band, blaugrana stripes with a ball in the lower field, gold outline. Category: `FC Barcelona logos` (plus `CC-Zero`, `Self-published work`). |

**Recommendation: REJECT.** This is the club's copyrighted, detailed emblem (far above any threshold of originality), and the only licence on it is a CC0 dedication by an anonymous uploader who calls it "own work". A copy of FC Barcelona's crest is not the uploader's own work, and they cannot relicense it. The page has no club permission, no VRT ticket and no source, and it was uploaded only six weeks ago, so it is also exposed to deletion as a copyright violation. The rights basis is wrong, not merely unproven, so this should move from held to rejected rather than stay pending.

**Alternatives on Commons (reported only, none approved):**

- `File:Imatge escut i lema del FCB.jpg` (528x528, CC0 by User:Marti.bdb, "own work"): a yellow shield in the FCB crest shape with the motto "MÉS QUE UN CLUB" on blue/red. It is not the crest, and it has the same non-rights-holder CC0 problem. Not suitable.
- `File:Fc barca.png` (528x528, CC BY-SA 4.0 "own work" by Majd34): the same third-party-relicence problem. Not suitable.
- `File:FC Barcelona original crest (1899–1910).png` (981x1191, PD-old-70, unknown author 1899): probably genuinely public domain, but it is the historical city-arms crest and would misrepresent the club today. Not suitable as the current crest.
- No free file of the current crest exists on Commons (category scan plus search). Realistic outcome: Barcelona stays crest-less (monogram/initials fallback).

## Inter Miami CF

| Field | Value |
|---|---|
| Team | Inter Miami CF (`inter-miami-cf`, `e7ab1df1-d63c-5694-9757-ffa7ce360899`, MLS; Wikidata Q16844931) |
| Candidate asset | `File:Inter Miami CF wordmark-full pink.png` |
| File page | https://commons.wikimedia.org/wiki/File:Inter_Miami_CF_wordmark-full_pink.png |
| Original | https://upload.wikimedia.org/wikipedia/commons/5/5f/Inter_Miami_CF_wordmark-full_pink.png (1000x71 PNG; audit rendition 480x34) |
| Uploaded | 2021-02-12 by User:IagoQnsi |
| Source (as stated) | `[[:File:Inter Miami CF wordmark-full white.png]]` (a recolour of another Commons file); author "Inter Miami CF" |
| Licence | `{{PD-textlogo}}`: "Public domain" (no licence URL; PD is not a licence) |
| Copyright status | PD-textlogo: the uploader says the logo is simple text below the (US) threshold of originality. extmetadata `Copyrighted: False`. The club (Inter Miami CF) is named as author, i.e. the underlying rights holder. |
| Trademark notice | **Yes**: `{{trademarked}}`; category `With trademark`; extmetadata `Restrictions: trademarked` |
| Crest or wordmark | **Text-only wordmark.** The image is the words "INTER MIAMI CF" in pink block capitals on a transparent background, aspect ~14:1. Categories: `Inter Miami CF logos`, `PD textlogo`, `Pink text logos`, `Text logos`. It is not the heron crest. |

**Recommendation: KEEP HELD (do not approve as a crest).** For a plain text mark the PD-textlogo claim is plausible under US law, which is the relevant jurisdiction for a US club, and the trademark template is present. The rights are therefore not the problem. The problem is that this is not a crest: a 14:1 text strip does not fit a square crest slot, and it would render as an unreadable sliver. It could only be used if the owner separately approves wordmarks as a different asset type (audit item 3, "Wordmarks ... as crest candidates"). As a crest it should stay held, or be rejected as `not_a_crest`.

**Alternatives on Commons (reported only, none approved):**

- `File:Inter Miami CF wordmark pink.svg` (512x91 SVG, PD-textlogo + Trademarked, source intermiamicf.com): the same wordmark as a cleaner SVG. Still text-only, so it has the same issue.
- `File:MLS crest logo RGB - Inter Miami CF.svg` (424x448, PD-textlogo + Trademarked): the **MLS league shield** ("MLS", three stars) recoloured pink/black. It is a league mark, not the club's crest, and would misidentify the club. Not suitable.
- The real Inter Miami crest (twin herons, sun, "CF" roundel) is not on Commons as a free file. It appears only in match photos (e.g. `Inter Miami Crest on Lionel Messi ... (cropped).jpg`), which are not crest assets.

## AS Roma

| Field | Value |
|---|---|
| Team | AS Roma (`as-roma`, `45ddf007-64aa-5c34-8057-ad96a2782853`, UCL; Wikidata Q2739) |
| Candidate asset | `File:AS ROMA Text Logo 2020 - 2021 .svg` |
| File page | https://commons.wikimedia.org/wiki/File:AS_ROMA_Text_Logo_2020_-_2021_.svg |
| Original | https://upload.wikimedia.org/wikipedia/commons/b/b9/AS_ROMA_Text_Logo_2020_-_2021_.svg (443x95 SVG; audit rendition 480x103) |
| Uploaded | 2020-09-24 by User:MacMoreno |
| Source (as stated) | Citation of footyheadlines.com, "All-New AS Roma 2020 Branding Revealed" (17 Sep 2020), a fan/news site, not the club; author "Associazione Sportiva Roma S.p.A." |
| Licence | `{{PD-textlogo}}` in the `permission` field: "Public domain" (no licence URL) |
| Copyright status | PD-textlogo (US threshold-of-originality claim); extmetadata `Copyrighted: False`. The rights holder named is AS Roma S.p.A. **Jurisdiction caveat:** this is an Italian club's mark; PD-textlogo is a US-law judgement only. |
| Trademark notice | **Yes**: `{{Trademarked}}`; category `With trademark`; `Restrictions: trademarked` |
| Crest or wordmark | **Text-only wordmark.** The image is "ASROMA" in outlined italic capitals ("AS" in maroon, "ROMA" in yellow-orange), aspect ~4.7:1. Categories: `SVG text logos`, `Red and yellow text logos`, `SVG logos of AS Roma`, `PD textlogo`. It is not the she-wolf (Lupa Capitolina) crest. Stray text "DEDI SETIAWAN" sits at the top of the wikitext (probable vandalism/noise, no licence effect). |

**Recommendation: KEEP HELD (do not approve as a crest).** This is a text-only wordmark, not the crest, and its source is a fan-news article rather than the club. PD-textlogo is plausible in the US, but for an Italian mark it is unverified outside the US. As a crest it fails on type regardless of rights. It could only be used if the owner separately approves wordmarks.

**Alternatives on Commons (reported only, none approved):**

- `File:Logo AS Roma 1960s.svg` (960x923, PD-textlogo + Trademark, "own work" by KoreanDragon/Blackcat): a round maroon disc with an orange ring and "A. S. ROMA" text. It is square-friendly and is a genuine (historical, 1960s) club roundel. It is text/geometric only, so PD-textlogo is credible in the US. However, it is not the current crest, it is a user redraw from a fan-site source, and the same Italy caveat applies. It is the best-shaped option if the owner ever accepts a historical roundel, but it would show a 60-year-old mark as the club's badge. Not recommended without an explicit owner decision.
- `File:AS ROMA 1961.svg`, `File:AS Roma 1930-34.svg`, `File:AS-Roma-Logo-1945.svg`, `File:AS ROMA 1937-38.svg`: all historical redraws tagged PD-textlogo. Several depict the she-wolf, which is not "simple text or geometric shapes", so the PD-textlogo tag on those is doubtful. Not suitable.
- `File:A.S. Roma - 99 Anni (1927—2026).png` (CC0): a photo/graphic of a fan mural, with a CC0 dedication by someone who is not the rights holder. Not suitable.
- The current (2017-) crest is not on Commons as a free file.

## Liverpool FC

| Field | Value |
|---|---|
| Team | Liverpool (`liverpool`, `338c117f-5477-5701-8ca4-fc1e2a35547c`, PL+UCL; Wikidata Q1130849) |
| Candidate asset | `File:Logo Liverpool FC (2024).png` |
| File page | https://commons.wikimedia.org/wiki/File:Logo_Liverpool_FC_(2024).png |
| Original | https://upload.wikimedia.org/wikipedia/commons/3/30/Logo_Liverpool_FC_%282024%29.png (520x199 PNG; audit rendition 480x184) |
| Uploaded | 2024-11-27 by User:AbchyZa22 |
| Source (as stated) | https://seeklogo.com/vector-logo/547647/liverpool-f-c, a third-party logo aggregator, not the club; author "Liverpool FC" |
| Licence | `{{PD-textlogo}}`: "Public domain" (no licence URL) |
| Copyright status | PD-textlogo (US threshold-of-originality claim); extmetadata `Copyrighted: False`. Named rights holder is Liverpool FC. **Jurisdiction caveat:** UK originality law has historically been stricter than the US (low threshold for typographic/graphic works), so a US PD-textlogo judgement is weaker evidence for an English club's mark. |
| Trademark notice | **Yes**: `{{Trademark}}` (plus `Trademarked`); category `With trademark`; `Restrictions: trademarked` |
| Crest or wordmark | **Text-only monogram.** The image is "L.F.C." in red serif capitals on a transparent background, aspect ~2.6:1. Categories: `Liverpool FC`, `PD textlogo`, `Text logos`. It is not the Liver bird crest. |

**Recommendation: KEEP HELD (do not approve as a crest).** This is a text monogram, not the crest. Its source is a logo-aggregator site rather than the club, and the PD-textlogo claim is US-only for an English club whose home jurisdiction is less permissive. As a crest it fails on type. The "L.F.C." monogram is closer to square than the other wordmarks, but it is still not the club badge, and it could only be used under a separate owner-approved wordmark policy.

**Alternatives on Commons (reported only, none approved):**

- `File:Liverpool Crest.jpg` (1024x683, CC BY 2.0, Flickr user cchana, FlickreviewR-checked): a **photograph** of the Liver bird relief on the (old) Shankly Gates. The CC BY licence covers the photo, not the underlying crest design (UK freedom of panorama may cover a permanently sited public work, but the result is still a photo of a gate, not a crest asset). Not suitable.
- `File:Liverpool FC crest, Main Stand - side view.jpg` (CC BY-SA 4.0): same situation, a photo of the stadium crest. Not suitable.
- No free file of the current Liverpool crest exists on Commons (category `Logos of Liverpool FC` plus search).

## Summary

| Team | Candidate (Commons) | Licence as stated | Rights basis | Trademark tag | What it is | Recommendation | Better Commons alternative |
|---|---|---|---|---|---|---|---|
| FC Barcelona | `Football Club Barcelona Color Update.png` | CC0 1.0 (`{{self\|cc-zero}}`) | "Own work" CC0 by uploader HAMDANI 72 (not the rights holder); no club permission/VRT | No | **Actual current crest** (copy) | **REJECT** | None free. Only the 1899-1910 historical crest (PD-old-70), which is not the current identity |
| Inter Miami CF | `Inter Miami CF wordmark-full pink.png` | Public domain (PD-textlogo) | US threshold-of-originality claim; author Inter Miami CF | Yes | Text wordmark "INTER MIAMI CF" (1000x71) | **KEEP HELD** (not a crest) | None. `MLS crest logo RGB - Inter Miami CF.svg` is the MLS league shield, not the club crest |
| AS Roma | `AS ROMA Text Logo 2020 - 2021 .svg` | Public domain (PD-textlogo) | US ToO claim only (Italian mark); source is a fan-news site | Yes | Text wordmark "ASROMA" (443x95) | **KEEP HELD** (not a crest) | `Logo AS Roma 1960s.svg`: square PD-textlogo historical roundel, not the current crest; owner call only |
| Liverpool | `Logo Liverpool FC (2024).png` | Public domain (PD-textlogo) | US ToO claim only (UK mark, stricter threshold); source seeklogo.com | Yes | Text monogram "L.F.C." (520x199) | **KEEP HELD** (not a crest) | None. Only CC BY photos of the Shankly Gates / Main Stand crest |

Net: no approval is recommended for any of the four. Barcelona should move from held to rejected, because an uploader's CC0 on the club's emblem is the wrong rights basis. The three wordmarks may be legitimately free in the US, but they are not crests. They stay held pending any separate owner decision on a wordmark asset type.
