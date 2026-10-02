/**
 * src/seo/image-metadata.js
 *
 * ONE image-rights contract for every schema.org ImageObject PropBetEdge emits.
 * The same file (same contract, same rules) ships in each PropBetEdge site repo;
 * docs/IMAGE_METADATA_CONTRACT.md is the canonical copy of the rules.
 *
 * An image is described by a normalized record:
 *   { url, contentUrl, width, height, caption, creditText, creator_name,
 *     creator_type, copyrightNotice, license, acquireLicensePage, source_url,
 *     source_type }
 * and imageObject() is the only thing that turns that record into JSON-LD.
 *
 * Rights fields (creator, copyrightNotice, creditText, license,
 * acquireLicensePage) are filled ONLY from what is actually known about the
 * pixels:
 *   owned            PropBetEdge-made art (logos, brand cards, generated cards
 *                    with no third-party pixels) → creator PropBetEdge,
 *                    "© <year> PropBetEdge".
 *   cc_licensed      Creative Commons / Commons photo with a recorded author →
 *                    that author, "<author> / <license>", license + source page.
 *   owned_composite  PropBetEdge card that embeds other images. Rights are
 *                    emitted only when EVERY embedded part is owned or
 *                    cc_licensed; the notice then credits each photo. If any
 *                    part is third-party with unknown rights, the card is held.
 *   third_party      Press photo, provider headshot, league/team mark, ... →
 *                    only the creator / notice / credit the source itself
 *                    published. Never "© PropBetEdge", never a guessed
 *                    "© <host>" because of the URL the file came from.
 * A held image still gets url/contentUrl/width/height/caption — just no
 * invented rights claim.
 */

export const PBE_ORG_NAME = 'PropBetEdge';
/** Year the PropBetEdge brand art (logos, static share cards) was created. */
export const PBE_BRAND_YEAR = 2026;

export const SOURCE_TYPES = Object.freeze({
  OWNED: 'owned',
  CC_LICENSED: 'cc_licensed',
  OWNED_COMPOSITE: 'owned_composite',
  THIRD_PARTY: 'third_party',
});

const text = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : null);

function yearOf(value) {
  if (!value) return null;
  const y = Number(String(value).slice(0, 4));
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : null;
}

function base({ url, contentUrl, width, height, caption, source_url }) {
  const u = text(url);
  return {
    url: u,
    contentUrl: text(contentUrl) || u,
    width: num(width),
    height: num(height),
    caption: text(caption) || null,
    creditText: null,
    creator_name: null,
    creator_type: null,
    copyrightNotice: null,
    license: null,
    acquireLicensePage: null,
    source_url: text(source_url) || null,
    source_type: null,
  };
}

/** PropBetEdge-made art. `year` = when it was made (content date for generated cards). */
export function ownedImage({ year, ...rest } = {}) {
  const y = yearOf(year) || PBE_BRAND_YEAR;
  return {
    ...base(rest),
    creator_name: PBE_ORG_NAME,
    creator_type: 'Organization',
    copyrightNotice: `© ${y} ${PBE_ORG_NAME}`,
    creditText: PBE_ORG_NAME,
    source_type: SOURCE_TYPES.OWNED,
  };
}

/**
 * Words that mark an attribution name as an organization (agency, club, outlet,
 * government body). Anything else is treated as the person Commons names.
 */
const ORG_WORDS = /\b(sports?|central|media|news|press|photo(?:graphy|s)?|images?|agency|studios?|inc|llc|ltd|corp(?:oration)?|company|co\.|club|team|league|association|federation|university|college|school|department|ministry|government|office|service|army|navy|air force|marines?|guard|police|official|foundation|institute|society|network|tv|radio|magazine|times|post|herald|journal|gazette|daily|weekly|records|commons|wikimedia|archives?|library|museum|fc|cf|sc|ac|athletics?|basketball|football|soccer|hockey|baseball|tennis|golf|racing|motorsports?|f1|nba|wnba|nfl|nhl|mlb|ufc|pga|atp|wta|fifa|uefa|ioc|olympic|government of|state of|city of|county|embassy|consulate|kremlin|white house|presidencia|casa rosada)\b/i;

export function creatorTypeFor(name, declared) {
  if (declared === 'Person' || declared === 'Organization') return declared;
  // Flickr imports read "<name> from <place>": the part before "from" is the photographer.
  const who = text(name).split(/\s+from\s+/i)[0];
  return ORG_WORDS.test(who) ? 'Organization' : 'Person';
}

/**
 * A Creative Commons photo with a recorded author. Without an author or a
 * license the photo is not "known" and falls back to a held third-party record.
 */
export function licensedImage({ author, author_type, license, license_url, source_page, ...rest } = {}) {
  const who = text(author);
  const lic = text(license);
  if (!who || !lic) {
    return thirdPartyImage({ ...rest, source_url: source_page || rest.source_url, license: license_url, acquireLicensePage: source_page });
  }
  return {
    ...base({ ...rest, source_url: source_page || rest.source_url }),
    creator_name: who,
    creator_type: creatorTypeFor(who, author_type),
    copyrightNotice: `${who} / ${lic}`,
    creditText: `${who} / ${lic}`,
    license: text(license_url) || null,
    acquireLicensePage: text(source_page) || null,
    source_type: SOURCE_TYPES.CC_LICENSED,
    license_name: lic,
  };
}

/**
 * Pixels PropBetEdge did not make and holds no recorded rights metadata for.
 * Only fields the source itself published are passed through.
 */
export function thirdPartyImage({ creator, creator_type, copyrightNotice, creditText, license, acquireLicensePage, ...rest } = {}) {
  const who = text(creator);
  return {
    ...base(rest),
    creator_name: who || null,
    creator_type: who ? creatorTypeFor(who, creator_type) : null,
    copyrightNotice: text(copyrightNotice) || null,
    creditText: text(creditText) || null,
    license: text(license) || null,
    acquireLicensePage: text(acquireLicensePage) || null,
    source_type: SOURCE_TYPES.THIRD_PARTY,
  };
}

/**
 * A PropBetEdge-rendered card that embeds `parts` (records from the builders
 * above). Rights are asserted only when every part is owned or cc_licensed.
 */
export function compositeImage({ year, parts = [], ...rest } = {}) {
  const list = (parts || []).filter(Boolean);
  const unknown = list.some((p) => p.source_type !== SOURCE_TYPES.OWNED && p.source_type !== SOURCE_TYPES.CC_LICENSED);
  if (unknown) {
    return { ...base(rest), source_type: SOURCE_TYPES.OWNED_COMPOSITE, held: 'embedded image rights unknown' };
  }
  const photos = list.filter((p) => p.source_type === SOURCE_TYPES.CC_LICENSED);
  const owned = ownedImage({ ...rest, year });
  if (!photos.length) return owned;
  const credits = [...new Set(photos.map((p) => p.copyrightNotice))];
  const label = credits.length > 1 ? 'Photos' : 'Photo';
  // ShareAlike photos make the card an adaptation under the same license.
  const sa = [...new Set(photos.filter((p) => /-SA\b/i.test(p.license_name || p.copyrightNotice)).map((p) => p.license).filter(Boolean))];
  const pages = [...new Set(photos.map((p) => p.acquireLicensePage).filter(Boolean))];
  return {
    ...owned,
    copyrightNotice: `${owned.copyrightNotice}. ${label}: ${credits.join('; ')}`,
    creditText: `${PBE_ORG_NAME} · ${label}: ${credits.join('; ')}`,
    license: sa.length === 1 ? sa[0] : null,
    acquireLicensePage: pages.length === 1 ? pages[0] : null,
    source_type: SOURCE_TYPES.OWNED_COMPOSITE,
  };
}

/** Normalized record → schema.org ImageObject. `extra` adds @id etc. */
export function imageObject(meta, extra = {}) {
  if (!meta?.url) return undefined;
  const node = { '@type': 'ImageObject', ...extra, url: meta.url, contentUrl: meta.contentUrl || meta.url };
  if (meta.width) node.width = meta.width;
  if (meta.height) node.height = meta.height;
  if (meta.caption) node.caption = meta.caption;
  if (meta.creator_name) node.creator = { '@type': meta.creator_type || 'Organization', name: meta.creator_name };
  if (meta.copyrightNotice) node.copyrightNotice = meta.copyrightNotice;
  if (meta.creditText) node.creditText = meta.creditText;
  if (meta.license) node.license = meta.license;
  if (meta.acquireLicensePage) node.acquireLicensePage = meta.acquireLicensePage;
  return node;
}
