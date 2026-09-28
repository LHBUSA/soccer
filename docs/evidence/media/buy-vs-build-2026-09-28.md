# Crests + headshots: buy vs build (2026-09-28)

Research only. Nothing signed up for, trialled, bought or requested. All claims come from the provider's own public pages, cited inline. Where a page blocked automated fetches (HTTP 403) the wording comes from the search engine's index of that page, and the note says so. None of this is legal advice. Club crests are registered trademarks and usually also copyrighted artwork, so any crest decision needs owner or counsel sign-off.

Scope: about 95 active clubs (MLS 30, PL 20, BL 18, UCL 36; see `crest-audit-2026-09-28.md`) and about 2,000 active players. The site's canonical ids are ESPN (plus OpenLigaDB for BL).

## Key distinction

Most data APIs **give you an image URL and say in writing that they do not license the image**. That is not a licence. Only photo agencies (Getty, IMAGO, Shutterstock, AP/Reuters/Imagn) and resellers of their feeds (Sportradar Images) actually license photographs. **No provider found here claims any right to sublicense club crests as trademarks.** Even Sportradar's AP logo collection says nothing public about trademark rights.

## Summary table

| Provider | Comps (MLS / EPL / BL / UCL) | Logos | Headshots | Commercial display rights | Cost | Effort |
|---|---|---|---|---|---|---|
| **Sportradar Images API** | All four (league keys `mls`, `epl`, `bundesliga`, `uefa-champions-league`) | Yes, AP team logos for all four | MLS: Imagn + Getty (standard + premium, media-day). UCL: Getty media-day (standard + premium). EPL/BL: Reuters action-shot-cropped only (standard) | **Licensed photos, for "media use only"**. The API is **"prohibited for betting clients"**. Getty images carry the Getty License Agreement notice. Nothing public on trademark rights for logos | Quote only | Medium: Sportradar ids, so an ESPN->Sportradar crosswalk is needed. About 3-5 dev-days plus a sales/legal cycle |
| **Getty Images (direct / API)** | Yes. Official photography partner of MLS (2025). Broad EPL/BL/UCL editorial coverage | No logo product (photos only) | Yes, editorial (media-day portraits and action). Search per image, no id manifest | **Licensed**, but editorial content is "generally intended for editorial use, not commercial use". The free Embed may not be used for any commercial purpose | Quote only (agreement required for API) | High: no ids; per-player search, curation and licensing for about 2,000 players |
| **IMAGO** | EPL, BL, UCL (strong Europe). MLS not listed | No | Editorial photos. No headshot/portrait product advertised | **Licensed, editorial by default**. "commercial use requires an additional request" | €999 starter = 100+ editorial licences (promo). Otherwise quote | High: per-image, no ids |
| **Shutterstock Editorial** | Editorial sports incl. football (page 403) | No | Editorial photos, per image | **Licensed, "Editorial use only"** | About $199/image editorial (per index); API plans via sales | High: per-image, no ids |
| **Stats Perform / Opta** | All four (data) | Not publicly documented as a product | Not publicly documented. Opta Graphics lets *customers upload their own* headshots/crests | Not documented publicly | Quote only | Unknown |
| **Genius Sports** | Official PL/EFL betting data (FDC) | No public image product | No public image product | n/a (data/betting partner) | Quote only | n/a |
| **Sportmonks** | Yes (2,300+ leagues; Starter picks 5) | Yes (`image_path` URLs) | Yes (URLs) | **URL only. No licence**: "All logos and profile photos are copyrighted by their legal owner… arrange proof of intellectual property yourself" | €29 / €99 / €249 per month; Enterprise quote | Low: own ids; name/team matching or via TheSportsDB crosswalk |
| **API-Football (api-sports.io)** | Yes | Yes (media.api-sports.io) | Yes (player `photo` URLs) | **URL only. No licence**: logos/images "provided solely for identification… API-Sports does not own any of these visual assets"; use "may require additional authorization or licensing from the respective rights holders" | Pro $19 / Ultra $29 / Mega $39 per month (per third-party index; own pages 403) | Low: own ids. TheSportsDB exposes `idAPIfootball` |
| **football-data.org** | All four (EPL/BL free tier; UCL/MLS paid tiers per coverage page) | Crest URLs | No player photos found | **URL only. No licence**: "All graphics, including team logos and profile photos, are copyrighted by their legal owner. You'll have to obtain consent…" | €0-€199 per month | Low for crests |
| **TheSportsDB** | All four | Yes (badges/logos, mostly fan-uploaded) | Thumbs/cutouts (fan-uploaded) | **No licence for third-party marks/photos**: "This does not grant permission to use a third-party trademark." Own artwork CC; DMCA takedowns within 24h | $0 / $9 / $20 per month | Very low. Exposes `idESPN`, `idAPIfootball`, `idTransferMkt`, `idWikidata`. **Useful as an id crosswalk even if the images are not used** |
| **Leagues (PL / MLS / DFL / UEFA)** | Own comp | Own marks only; clubs own their crests | Not offered to third-party sites | **Permission required**. PL: "cannot be used without the express permission"; clubs "should be contacted directly". MLS: no licence without "express written permission". DFL: no licence granted. UEFA: news-media editorial use of UEFA marks allowed under guidelines, with no commercial/promotional use | Not published | Per-club/per-league outreach (about 95 clubs + 4 leagues) |

## Per-provider notes

### Sportradar Images API
- The API offers "player headshots, venue images, team and league logos, and in-game action shots". **"Sportradar's Images API is for media use only. Use of this API is prohibited for betting clients."** 302 redirects must be followed. All assets carry Sportradar ids. https://developer.sportradar.com/images-and-editorials/reference/images-overview
- Coverage matrix "Image & Editorial Coverage, Updated: July 2026" (https://api-docs.sportradar.us/image-editorial/Sportradar_Image_Editorial_CoverageV3.pdf):
  - **EPL**: action GETTY, REUTERS; standard headshots REUTERS (action-shot-cropped); premium none; logos AP; venues GETTY; AP editorial.
  - **German Bundesliga**: action GETTY, REUTERS; standard headshots REUTERS (action-shot-cropped); premium none; logos AP.
  - **MLS**: action Imagn; standard headshots Imagn, GETTY; premium Imagn, GETTY; logos AP; AP editorial.
  - **UEFA Champions League**: action GETTY, REUTERS; standard + premium headshots GETTY (media-day); logos AP; AP editorial.
- The change log records Getty media-day headshots for MLS/NWSL and UEFA men's/women's, JPG + transparent PNG in 25+ sizes. It also records **"We have removed NFL Logos from our Images API as of January 2025"**, which shows that logo collections can be withdrawn. https://developer.sportradar.com/images-and-editorials/reference/images-change-log
- Logo endpoints: soccer logo provider is `ap`; leagues include `bundesliga`, `epl`, `mls`, `uefa-champions-league`. https://developer.sportradar.com/images-and-editorials/reference/images-logo-manifest
- Player manifest: providers `ap`, `ap_premium`, `getty`, `getty_premium`, `reuters`, `usat`, `usat_premium`; leagues include `bundesliga`, `epl`, `mls`, `uefa-champions-league`. https://developer.sportradar.com/images-and-editorials/reference/images-player-manifest
- FAQ: sample Getty metadata says "by downloading and or using this Photograph, user is consenting to the terms and conditions of the Getty Images License Agreement". Media support is mediasupport@sportradar.com. https://developer.sportradar.com/images-and-editorials/reference/images-faqs
- **Rights**: these are real licensed photos, but only for "media use". The **betting-client prohibition is the gating question** for a prop/picks site. PropBetEdge is not a sportsbook, but Sportradar decides who counts as a "betting client". Get the answer in writing before any build. There is no public statement on trademark rights in the AP logos.
- **Pricing**: not public (developer portal / marketplace; quote only).
- **ID mapping**: Sportradar ids (`sr:player:*`, `sr:competitor:*`). Map ESPN->Sportradar by name + team + DOB/jersey from the manifests, optionally seeded via the Sportradar Soccer API (separate product). About 3-5 dev-days for crosswalk, ingest to R2 and QA.
- **Headshot quality caveat**: EPL and BL are Reuters *action-shot crops*, not media-day portraits. Coverage depth per squad is not published; measure it in a trial.

### Getty Images
- API access requires an agreement. "Your API credentials are configured to provide access to the content in your licensing or revenue share agreement." Editorial content is "generally intended for editorial use, not commercial use"; creative is "available for commercial use". https://www.gettyimages.com/api
- MLS official photography partner (2025-03-28): "Getty Images will edit, distribute and license MLS-owned imagery for both editorial and commercial uses via gettyimages.com." https://newsroom.gettyimages.com/en/getty-images/getty-images-announced-as-the-official-photography-partner-of-major-league-soccer
- Free Embed is not usable here. Per Getty's embed terms (as summarised in coverage of them), embedded content "may not be used for any commercial purpose" and must stay inside the Embedded Viewer. It cannot be restyled as a headshot, and it adds tracking.
- No logos. No id-keyed headshot manifest publicly. Pricing is quote/agreement only.
- Effort: high if direct (search + license + crop about 2,000 players). Getty headshots are reachable id-mapped **through Sportradar** (MLS, UCL).

### IMAGO
- Covers "Premier League, LaLiga, Serie A, Bundesliga, and Ligue 1, as well as UEFA competitions". "All images on our webshop are available for editorial use by default, commercial use requires an additional request". API delivery is available. Starter: "100+ premium image licenses for €999" (editorial, new customers, limited time). Pricing otherwise "based on usage, territory, duration, and volume". https://connect.imago-images.com/en/licensed-sports-images-for-creators-publishers-and-communities
- No crest product and no headshot manifest. MLS is not listed. Best for Bundesliga-heavy editorial photos, not systematic headshots.

### Shutterstock Editorial
- The pricing page returned 403 to automated fetch. Per the search index: editorial images at $199/image, "Editorial use only". An API exposes `/v2/editorial/images/search` and `/v2/editorial/images/licenses`. https://www.shutterstock.com/pricing/editorial , https://www.shutterstock.com/developers/documentation/licensing-and-downloading
- At that per-image price about 2,000 headshots is roughly $400k. Not practical except via an enterprise deal.

### Stats Perform / Opta
- Pricing: "please contact our expert sales team… for a customised quote"; licensing is "by competition, country, or data level". https://www.statsperform.com/faqs/stats-perform-faqs-pricing-licensing/
- Opta Graphics lets customers upload "player headshots, crests and other template components", so the customer supplies the assets. https://www.statsperform.com/opta-graphics/
- No public headshot or logo licensing product found.

### Genius Sports
- PL/EFL/SPFL "sole official live data distributor to global sportsbooks" (Football DataCo) through 2028-29. https://www.geniussports.com/newsroom/genius-sports-and-football-dataco-extend-exclusive-official-data-partnership-through-2029/
- No public image/logo licensing product. Not an image source.

### Sportmonks
- Plans: Starter €29 (5 leagues), Growth €99 (30), Pro €249 (120), Enterprise custom. No image add-on is listed. https://www.sportmonks.com/football-api/plans-pricing/
- "All logos and profile photos are copyrighted by their legal owner. To display these types of content in your app or website, you have to arrange proof of intellectual property yourself." https://www.sportmonks.com/terms-of-service/ , https://www.sportmonks.com/faq/
- **URL only, no licence.** Own ids.

### API-Football / API-Sports
- The terms and docs pages return 403 to automated fetch (bot protection, not bypassed). Per the search index of https://api-sports.io/terms and https://www.api-football.com/terms: logos, images and trademarks are "provided solely for identification and descriptive purposes… API-Sports does not own any of these visual assets, and no intellectual property rights are claimed over them". Use "may require additional authorization or licensing from the respective rights holders". Users are "fully responsible".
- Pricing per third-party index (not verified on own page): Pro $19, Ultra $29, Mega $39 per month.
- **URL only, no licence.** Own ids. TheSportsDB records `idAPIfootball`.

### football-data.org
- "All graphics, including team logos and profile photos, are copyrighted by their legal owner. You'll have to obtain consent from the respective owners…" Data may not be referenced after cancellation. https://www.football-data.org/about
- Pricing €0-€199 per month. EPL and BL are in the free tier; UCL and MLS are in paid tiers per https://www.football-data.org/coverage (the tier wording on that page is ambiguous; confirm before relying on it). https://www.football-data.org/pricing

### TheSportsDB
- "Most of our artwork is custom and is created by our users." "Any trademarked sports logos must be used 'As is'… This does not grant permission to use a third-party trademark." Paid subscription does not grant rights to third-party artwork. DMCA takedowns within 24h. https://www.thesportsdb.com/docs_terms_of_use.php
- Pricing: $0 / $9 / $20 per month. https://www.thesportsdb.com/docs_pricing
- **ID crosswalk value**: a live free-API lookup (`lookupteam.php?id=133604`, `lookupplayer.php?id=34145937`) returned `idESPN` (Arsenal = 359), `idAPIfootball`, `idTransferMkt` and `idWikidata` on players. That makes it a cheap ESPN<->Wikidata/Transfermarkt/API-Football bridge, and could relieve the `identity_not_proven` bottleneck in the crest audit (73/95). Check its data licence before bulk use.

### Leagues / rights holders
- **Premier League**: "Logos and other trademarks cannot be used without the express permission of the Premier League." "Our clubs retain their own trademarks and they should be contacted directly…". Contact: partnerships@premierleague.com. https://www.premierleague.com/en/about/faq/other . Football DataCo controls PL/EFL still-action image accreditation.
- **MLS**: marks of MLS and "current and former MLS member clubs" are MLS property. Nothing grants "any license or right to use any Trademark… without the express written permission". Embedding of MLS-site content is allowed with conditions. https://www.mlssoccer.com/legal/terms-of-service . Getty licenses MLS-owned imagery (above).
- **DFL/Bundesliga**: trademarks and logos are protected, and "The User is not granted any license". Use beyond German copyright law "requires the prior written consent of the DFL or the respective holder". https://www.dfl.de/en/legal-notices/ , https://www.bundesliga.com/en/bundesliga/info/legal-notices . Brand licensing (merch) goes through IMG: https://imglicensing.com/brands/bundesliga/
- **UEFA**: the Media Guidelines let news media use UEFA Official Marks "for editorial purposes" only. They may not be used for "advertising, marketing or promotional purposes (including… competitions, games, lotteries or other types of contest)". The marks must be kept "clearly separated from advertisements", must not suggest association with other marks/services, and must not be used in meta tags or site design. https://editorial.uefa.com/resources/020a-0f8428bf2255-54a1767838ba-1000/uefa_s_media_guidelines_pdf_file_.pdf . These cover **UEFA's** marks, not club crests. The guidelines are dated (they reference Euro 2016).

## Recommendation

**Can free or governed sources reach 90% crests and 80% active-player headshots? No.**
- **Crests**: the 2026-09-28 audit has 3/95 approved and an evidenced ceiling of 7 free Commons logos among the 23 identifiable clubs. 14 marquee clubs (Arsenal, Chelsea, Man City, Man Utd, Real Madrid…) have **only** non-free enwiki files. Fixing identity (e.g., via the TheSportsDB `idWikidata`/`idESPN` crosswalk) will raise the ceiling somewhat, but most PL/UCL crests are not free on Commons at all. A realistic free ceiling is well under 50%, nowhere near 90%.
- **Headshots**: Commons is at about 28%. Wikimedia portraits of MLS and squad players are sparse, and no governed free source exists for the long tail. 80% is not reachable.
- **Crests are a policy problem, not a vendor problem**: no vendor licenses the trademarks. The only way to get *licensed* crests is permission from each club/league. Otherwise it is an owner/counsel decision to display vendor-supplied (AP via Sportradar) or club-supplied crests as nominative identification. The repo policy already contemplates `crest_trademark=approve_nominative`; the copyright in the artwork is the unsolved part.

**Most practical licensed options:**
1. **Sportradar Images API.** It is the only single feed with id-keyed logos (AP) plus headshots for all four competitions: Getty media-day for UCL and MLS, Imagn for MLS, Reuters crops for EPL/BL. It has a manifest-based pull and one contract. **Blocker**: "prohibited for betting clients". Get a written determination that PropBetEdge (analytics/picks, no wagering) is eligible, and confirm in the contract (a) web display rights for the AP logos and (b) that caching to R2 is allowed. Quote only.
2. **Getty Images direct (agreement + API)** as fallback or complement. It is the rights source behind most of the Sportradar headshots, MLS's official photography partner with commercial rights to MLS-owned imagery, and it covers EPL/BL/UCL. It has no logos and no id manifest, so effort is high. Use it if Sportradar refuses a betting-adjacent client. Confirm that editorial licensing fits a monetised picks site.

Not recommended as the image source: API-Football, Sportmonks, football-data.org and TheSportsDB. They are cheap and easy, but they **hand over URLs while disclaiming the rights**, which puts 100% of the risk on PropBetEdge. TheSportsDB is still worth using as an **id crosswalk** (ESPN <-> Wikidata/Transfermarkt/API-Football). IMAGO and Shutterstock are per-image editorial licences: fine for article art, not practical for 2,000 systematic headshots.

Next owner decisions (nothing actioned):
- Approve a Sportradar sales/legal enquiry on betting-client eligibility.
- Decide the crest policy: licensed per club vs nominative display vs text/monogram fallback.
