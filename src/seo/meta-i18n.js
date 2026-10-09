// Localized SEO for the first HTML response (middleware.js). meta.js builds the English metadata for the
// unprefixed path; this module turns it into the metadata for `locale` and adds hreflang alternates.
//   - Every page that has a translated interface gets reciprocal alternates (en, es, x-default) in BOTH languages.
//   - Article pages: only a VERIFIED newsroom translation (soccer-article-i18n; the API sets `translation`) is
//     self-canonical with reciprocal alternates among the languages the story truly exists in (`translations`). An
//     article shown in English keeps the English canonical, and claims alternates only for real translations.
//   - Names, scores and numbers are never translated; only the words around them.
import { LOCALES, alternateLinks, localizePath } from '../i18n/locales.js';
import { translateText } from '../i18n/translate.js';
import { SITE } from './meta.js';

const clip = (s, n = 165) => (s.length <= n ? s : `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…`);
const dayEs = iso => (iso ? new Date(iso).toLocaleDateString('es-ES', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : null);
const FORM = { W: 'G', D: 'E', L: 'P' };
const ROLE_ES = { goalkeeper: 'portero', defender: 'defensa', midfielder: 'centrocampista', forward: 'delantero' };
// Pages without a translated equivalent (no alternates, English canonical kept). Articles are decided per story below.
const NO_ALTERNATES = new Set(['article', 'notfound']);
const articleLangs = results => {
  const a = results?.[0]?.data;
  if (!a || results[0].notFound) return null;
  return { shown: a.translation ? a.locale : 'en', codes: ['en', ...Object.keys(a.translations || {}).filter(l => LOCALES[l]?.ready && l !== 'en')] };
};
// NewsArticle JSON-LD of a translated story: its own URL and language, linked to the English work (and vice versa).
function articleJsonld(jsonld, art, path) {
  return (jsonld || []).map(j => {
    if (j['@type'] !== 'NewsArticle') return j;
    const own = `${SITE}${localizePath(path, art.shown)}`;
    const en = `${SITE}${localizePath(path, 'en')}`;
    const others = art.codes.filter(c => c !== art.shown);
    return { ...j, url: own, mainEntityOfPage: { '@type': 'WebPage', '@id': own }, inLanguage: LOCALES[art.shown].hreflang,
      ...(art.shown !== 'en' ? { translationOfWork: { '@id': en } } : others.length ? { workTranslation: others.map(c => ({ '@id': `${SITE}${localizePath(path, c)}` })) } : {}) };
  });
}

function descriptionEs(page, results, meta) {
  const d = results?.[0]?.data;
  if (page === 'match' || page === 'pbecast') {
    const m = d; if (!m) return null;
    const home = m.home?.name; const away = m.away?.name;
    const sc = m.score && m.score.home !== null && m.score.home !== undefined ? `${m.score.home}–${m.score.away}` : null;
    const shots = (m.shots || []).length;
    const intel = [shots ? `mapa de eventos (${shots} ${shots === 1 ? 'tiro' : 'tiros'})` : null,
      m.stats?.basis === 'source' ? 'estadísticas de la fuente' : m.stats?.basis === 'derived' ? 'conteos derivados PBE' : null,
      m.lineups ? 'alineaciones' : null, (m.timeline || []).length ? 'cronología' : null].filter(Boolean);
    const head = m.status === 'finished' && sc ? `${home} ${sc} ${away}` : `${home} vs ${away}`;
    const status = m.status === 'scheduled' ? ' Programado.' : m.status === 'postponed' ? ' Aplazado.' : m.status === 'finished' && sc ? ' Final.' : '';
    const when = dayEs(m.kickoff_at);
    return `${head}${m.competition ? ` · ${m.competition.name}${m.season ? ` ${m.season}` : ''}` : ''}${when ? ` · ${when}` : ''}.${status}${intel.length ? ` Inteligencia del partido: ${intel.join(', ')}.` : ''}`.replace(/\s+/g, ' ').trim();
  }
  if (page === 'team') {
    const t = d; if (!t) return null;
    const comps = [...new Set([...(t.recent || []), ...(t.upcoming || [])].map(x => x.competition?.name).filter(Boolean))];
    const form = (t.form || []).map(f => FORM[f] || f).join('-');
    return `${t.name}${comps.length ? ` (${comps.join(', ')})` : ''}: resultados recientes${form ? ` (últimos cinco: ${form})` : ''}, próximos partidos e inteligencia de partidos del grafo canónico de fútbol de PropBetEdge.`;
  }
  if (page === 'player') {
    const p = d; if (!p) return null;
    const seasons = (p.seasons || []).map(s => s.season).filter(Boolean);
    const bits = [ROLE_ES[p.role], p.birth_date ? `nacido el ${dayEs(`${String(p.birth_date).slice(0, 10)}T12:00:00Z`)}` : null].filter(Boolean);
    return `${p.name}${bits.length ? ` — ${bits.join(', ')}` : ''}. Inteligencia del jugador del grafo canónico de fútbol de PropBetEdge${seasons.length ? `: estadísticas derivadas de eventos de ${seasons.join(', ')}` : ''}.`;
  }
  if (page === 'competition') {
    const c = d; if (!c) return null;
    const seasons = c.seasons || [];
    const total = seasons.reduce((n, s) => n + (s.matches || 0), 0).toLocaleString('en-US');
    const tbl = results?.[1] && !results[1].notFound ? results[1].data : null;
    const latest = seasons[0]?.label;
    if (tbl?.view === 'groups') {
      const v = tbl.verified_groups || 0;
      return `${c.name}${latest ? ` ${latest}` : ''}: ${v ? `${v} ${v === 1 ? 'tabla de grupo verificada' : 'tablas de grupo verificadas'}, ` : ''}resultados y calendario de ${(c.current?.teams || []).length || 'todas las'} selecciones — ${total} partidos canónicos en el grafo de fútbol de PropBetEdge.`;
    }
    const hasTable = (tbl?.rows || []).length > 0;
    return `${c.name}${latest ? ` ${latest}` : ''}: ${hasTable ? 'tabla, resultados y calendario' : 'resultados y calendario'} — ${seasons.length} ${seasons.length === 1 ? 'temporada almacenada' : 'temporadas almacenadas'}, ${total} partidos canónicos en el grafo de fútbol de PropBetEdge.`;
  }
  return null;
}

function localizeJsonld(jsonld, locale) {
  return (jsonld || []).map(j => {
    if (j['@type'] !== 'BreadcrumbList') return j;
    return { ...j, itemListElement: j.itemListElement.map(it => ({ ...it, name: translateText(it.name, locale), item: it.item?.startsWith(SITE) ? `${SITE}${localizePath(it.item.slice(SITE.length) || '/', locale)}` : it.item })) };
  });
}

/**
 * @param meta     English metadata from meta.js buildMeta(path, page, results)
 * @param locale   page locale
 * @param path     unprefixed pathname
 * @param page     router page name
 * @param results  API envelopes used to build `meta`
 */
export function localizeMeta(meta, { locale, path, page, results = [] }) {
  const L = LOCALES[locale] || LOCALES.en;
  const indexable = meta.status === 200 && !String(meta.robots).startsWith('noindex');
  const art = page === 'article' && indexable ? articleLangs(results) : null;
  const alternates = art ? (art.codes.length > 1 && meta.canonical ? alternateLinks(new URL(meta.canonical).pathname, SITE, art.codes) : [])
    : indexable && !NO_ALTERNATES.has(page) && meta.canonical ? alternateLinks(new URL(meta.canonical).pathname) : [];
  const langs = art ? art.codes : Object.values(LOCALES).filter(l => l.ready).map(l => l.code);
  const base = { ...meta, htmlLang: L.htmlLang, ogLocale: L.og, ogAlternates: alternates.length ? langs.filter(c => c !== (art ? art.shown : locale)).map(c => LOCALES[c].og) : [], alternates,
    ...(art && art.codes.length > 1 ? { jsonld: articleJsonld(meta.jsonld, art, new URL(meta.canonical).pathname) } : {}) };
  if (locale === 'en') return base;
  if (art && art.shown === locale) {
    // A verified translation: the API already returned the story in `locale`; self-canonical, chrome translated.
    const tr = s => (s ? translateText(s, locale) : s);
    return { ...base, title: tr(meta.title), canonical: `${SITE}${localizePath(new URL(meta.canonical).pathname, locale)}`, imageAlt: meta.imageAlt, jsonld: localizeJsonld(base.jsonld, locale), path };
  }
  const tr = s => (s ? translateText(s, locale) : s);
  const description = descriptionEs(page, results, meta) || tr(meta.description);
  // Self-canonical in the reader's language, except where no translated equivalent exists (articles).
  const canonical = meta.canonical && !NO_ALTERNATES.has(page) ? `${SITE}${localizePath(new URL(meta.canonical).pathname, locale)}` : meta.canonical;
  const ssr = meta.ssr ? { h1: page === 'article' ? meta.ssr.h1 : tr(meta.ssr.h1), p: page === 'article' ? meta.ssr.p : (descriptionEs(page, results, meta) || tr(meta.ssr.p)), links: (meta.ssr.links || []).map(([h, l]) => [localizePath(h, locale), tr(l)]) } : meta.ssr;
  return { ...base, title: tr(meta.title), description: clip(description), canonical, imageAlt: tr(meta.imageAlt), jsonld: localizeJsonld(meta.jsonld, locale), ssr, path };
}
