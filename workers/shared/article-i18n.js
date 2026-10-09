// ARTICLE TRANSLATION CONTRACT (soccer-article-i18n/1). One module shared by the translator (soccer-news) and the reader API
// (soccer-api), so both agree byte-for-byte on WHAT is translated and WHICH English revision a translation belongs to.
//
//   segments   the reader-visible English text of one published article, as ordered { id, text } pairs: headline, dek,
//              every story section heading + paragraph, each data visual's title / subtitle / source line, and the
//              customer method notes. Nothing else: numbers inside charts, names, links, media and evidence stay the
//              English record's own data, untouched.
//   revision   sha256 of the segments: the English SOURCE REVISION. Any edit to reader-visible English text changes it,
//              so a translation of an older revision is stale and is never served (soccer-api) and is retired (soccer-news).
//   apply      the English article with a verified translation's segments laid over it, for the reader API.
import { sha256Hex } from './ids.js';

export const ARTICLE_I18N_VERSION = 'soccer-article-i18n/1.0.0';

// Locales the newsroom can translate into. `enabled` is the PUBLIC switch: a disabled locale is never served, never
// listed in a sitemap and never claimed in hreflang, whatever rows exist (pt/fr stay off until their release gates pass).
export const ARTICLE_LOCALES = Object.freeze({
  es: { tag: 'es', name: 'Spanish', enabled: true },
  pt: { tag: 'pt-BR', name: 'Brazilian Portuguese', enabled: false },
  fr: { tag: 'fr', name: 'French', enabled: false },
});
export const servedLocale = l => !!ARTICLE_LOCALES[l]?.enabled;

// NATIONAL-TEAM EXONYMS (house style for translated prose). Clubs, players and competitions keep their canonical names
// in every language; national teams are written as native readers know them (England -> Inglaterra). Fixed list, never
// model-invented; the translation gates require exactly these forms. Entity links follow via `story_name`.
export const NATION_EXONYMS = Object.freeze({
  es: Object.freeze({
    Albania: 'Albania', Andorra: 'Andorra', Armenia: 'Armenia', Austria: 'Austria', Azerbaijan: 'Azerbaiyán', Belarus: 'Bielorrusia',
    Belgium: 'Bélgica', 'Bosnia and Herzegovina': 'Bosnia y Herzegovina', 'Bosnia-Herzegovina': 'Bosnia y Herzegovina', Bulgaria: 'Bulgaria',
    Croatia: 'Croacia', Cyprus: 'Chipre', Czechia: 'Chequia', 'Czech Republic': 'República Checa', Denmark: 'Dinamarca', England: 'Inglaterra',
    Estonia: 'Estonia', 'Faroe Islands': 'Islas Feroe', Finland: 'Finlandia', France: 'Francia', Georgia: 'Georgia', Germany: 'Alemania',
    Gibraltar: 'Gibraltar', Greece: 'Grecia', Hungary: 'Hungría', Iceland: 'Islandia', Israel: 'Israel', Italy: 'Italia', Kazakhstan: 'Kazajistán',
    Kosovo: 'Kosovo', Latvia: 'Letonia', Liechtenstein: 'Liechtenstein', Lithuania: 'Lituania', Luxembourg: 'Luxemburgo', Malta: 'Malta',
    Moldova: 'Moldavia', Montenegro: 'Montenegro', Netherlands: 'Países Bajos', 'North Macedonia': 'Macedonia del Norte', 'Northern Ireland': 'Irlanda del Norte',
    Norway: 'Noruega', Poland: 'Polonia', Portugal: 'Portugal', 'Republic of Ireland': 'República de Irlanda', Ireland: 'Irlanda', Romania: 'Rumanía',
    Russia: 'Rusia', 'San Marino': 'San Marino', Scotland: 'Escocia', Serbia: 'Serbia', Slovakia: 'Eslovaquia', Slovenia: 'Eslovenia', Spain: 'España',
    Sweden: 'Suecia', Switzerland: 'Suiza', Turkey: 'Turquía', 'Türkiye': 'Turquía', Ukraine: 'Ucrania', Wales: 'Gales',
    Argentina: 'Argentina', Brazil: 'Brasil', Uruguay: 'Uruguay', Colombia: 'Colombia', Chile: 'Chile', Peru: 'Perú', Ecuador: 'Ecuador', Paraguay: 'Paraguay',
    Bolivia: 'Bolivia', Venezuela: 'Venezuela', Mexico: 'México', 'United States': 'Estados Unidos', USA: 'Estados Unidos', Canada: 'Canadá',
    'Costa Rica': 'Costa Rica', Panama: 'Panamá', Honduras: 'Honduras', Jamaica: 'Jamaica', Morocco: 'Marruecos', Senegal: 'Senegal', Nigeria: 'Nigeria',
    Egypt: 'Egipto', Japan: 'Japón', 'South Korea': 'Corea del Sur', 'Korea Republic': 'Corea del Sur', Australia: 'Australia', 'Saudi Arabia': 'Arabia Saudí', Iran: 'Irán', Qatar: 'Catar',
  }),
});
export const exonym = (name, locale) => NATION_EXONYMS[locale]?.[name] ?? null;

// Customer disclosure (mirrors src/pages/article.js storyParts/sourceMethod): a collection-lane credit renders as
// DATA · PropSports; source-credit lines stay verbatim (brand / licence credits); the evidence-packet paragraph is not
// shown except its "Not reported: ..." clause.
const SOURCE_LINE = /^(Fixtures|Structured|Event data|Results|DATA · PropSports)/;
export function customerDisclosure(body = {}) {
  const legacyMethod = (body.sections || []).find(s => s.key === 'method');
  return [...new Set((body.disclosure || legacyMethod?.paragraphs || []).map(p => (/^Structured facts: ESPN/.test(p) ? 'DATA · PropSports.' : String(p).replace(/\bESPN(?:'s)?\b(?: \(secondary(?: source)?\))?/g, 'PropSports'))))];
}
export function methodNotes(body = {}) {
  const disclosure = customerDisclosure(body);
  const sources = disclosure.filter(p => SOURCE_LINE.test(p));
  const notes = disclosure.filter(p => !sources.includes(p) && !/evidence packet|hash/i.test(p));
  const uncovered = (disclosure.join(' ').match(/Not reported: ([^.]+)\./) || [])[1] || null;
  return { sources, notes, uncovered };
}

const storySections = body => (body?.sections || []).filter(s => s.key !== 'method');
const clean = t => String(t ?? '').trim();

/** The reader-visible English text of one article, in reading order. Empty strings are left out. */
export function articleSegments(a) {
  const out = [];
  const add = (id, text) => { const t = clean(text); if (t) out.push({ id, text: t }); };
  add('h', a.headline);
  add('d', a.dek);
  storySections(a.body).forEach((s, i) => { add(`s${i}.h`, s.heading); (s.paragraphs || []).forEach((p, j) => add(`s${i}.p${j}`, p)); });
  for (const v of a.body?.visuals || []) { if (!v?.id) continue; add(`v.${v.id}.title`, v.title); add(`v.${v.id}.subtitle`, v.subtitle); add(`v.${v.id}.source`, v.source); }
  const m = methodNotes(a.body);
  m.notes.forEach((n, k) => add(`m.note${k}`, n));
  add('m.uncovered', m.uncovered);
  return out;
}

/** sha256 over the ordered segments: the English source revision a translation is bound to. */
export function sourceRevision(a) {
  return sha256Hex(JSON.stringify(articleSegments(a).map(s => [s.id, s.text])));
}

/**
 * The English article with a translation laid over it (reader API). Everything that is not a segment (ids, slugs,
 * entities, numbers in visuals, media, evidence) is the English record's own data. Returns null when the translation
 * does not cover exactly the current English segments (never a partly translated page).
 */
export function applyTranslation(a, segments, locale) {
  const src = articleSegments(a);
  if (!segments || src.some(s => typeof segments[s.id] !== 'string' || !segments[s.id].trim()) || Object.keys(segments).length !== src.length) return null;
  const T = id => segments[id];
  const sections = storySections(a.body).map((s, i) => ({ ...s, heading: s.heading ? T(`s${i}.h`) : s.heading, paragraphs: (s.paragraphs || []).map((p, j) => (clean(p) ? T(`s${i}.p${j}`) : p)) }));
  const method = (a.body?.sections || []).filter(s => s.key === 'method'); // English, kept only for the source-credit lines
  const visuals = (a.body?.visuals || []).map(v => (v?.id ? { ...v, ...(clean(v.title) ? { title: T(`v.${v.id}.title`) } : {}), ...(clean(v.subtitle) ? { subtitle: T(`v.${v.id}.subtitle`) } : {}), ...(clean(v.source) ? { source: T(`v.${v.id}.source`) } : {}) } : v));
  const m = methodNotes(a.body);
  const named = e => (e?.name && exonym(e.name, locale) && exonym(e.name, locale) !== e.name ? { ...e, story_name: exonym(e.name, locale) } : e);
  return {
    ...a,
    entities: (a.entities || []).map(named),
    headline: T('h'), dek: clean(a.dek) ? T('d') : a.dek,
    body: { ...a.body, sections: [...sections, ...method], visuals, method_i18n: { notes: m.notes.map((_, k) => T(`m.note${k}`)), uncovered: m.uncovered ? T('m.uncovered') : null } },
    locale,
  };
}
