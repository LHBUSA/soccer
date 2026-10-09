// Pure string translation from a gettext-style catalog: the msgid is the English UI string exactly as rendered.
// Contract (owner brief 2026-10-09):
//   - only WHOLE strings in the catalog are translated; anything unknown is returned unchanged, so team names,
//     player names, competition names, scores, odds, probabilities and every number pass through untouched;
//   - patterns capture numbers/names verbatim and only move the words around them;
//   - leading/trailing whitespace is preserved (text nodes in templates carry spacing).
import es from './catalog/es.js';

export const CATALOGS = { es };

const cache = new Map();
function compiled(locale) {
  if (cache.has(locale)) return cache.get(locale);
  const c = CATALOGS[locale];
  if (!c) { cache.set(locale, null); return null; }
  const exact = new Map(Object.entries(c.exact || {}));
  // Case-insensitive fallback for strings the UI upper-cases in markup ("MATCHES") while the catalog holds the
  // phrase once: the translation is upper-cased to match.
  const upper = new Map();
  for (const [k, v] of exact) if (k !== k.toUpperCase()) upper.set(k.toUpperCase(), v.toUpperCase());
  const patterns = c.patterns || [];
  // Patterns that spell out a " · " themselves run before the segment pass; the rest after it, so a generic
  // "(.+) suffix" pattern can never swallow a whole "a · b · c" label.
  const dotted = patterns.filter(([re]) => re.source.includes('·'));
  const out = { exact, upper, patterns, dotted, plain: patterns.filter(p => !dotted.includes(p)), html: new Map(Object.entries(c.html || {})) };
  cache.set(locale, out);
  return out;
}

/** Translates one UI string. Returns the input unchanged when the locale is English or the string is unknown. */
export function translateText(input, locale) {
  if (!input || locale === 'en') return input;
  const c = compiled(locale);
  if (!c) return input;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(input);
  const core = m[2];
  if (!core || !/[A-Za-z]/.test(core)) return input;
  const hit = c.exact.get(core) ?? c.upper.get(core);
  if (hit !== undefined) return m[1] + hit + m[3];
  const tr = s => translateText(s, locale);
  const run = list => { for (const [re, to] of list) { const p = re.exec(core); if (p) return to(...p.slice(1), tr); } return null; };
  const dotted = core.includes('·');
  if (dotted) {
    const hit2 = run(c.dotted);
    if (hit2 !== null) return m[1] + hit2 + m[3];
    // " · "-joined labels ("1 goal · 3 shots · 90 min", "· kickoff …"): translate segment by segment. Unknown
    // segments (names, numbers, dates) stay as they are.
    const parts = core.split(/(\s*·\s*)/);
    const out = parts.map((x, i) => (i % 2 ? x : tr(x))).join('');
    if (out !== core) return m[1] + out + m[3];
  }
  const hit3 = run(dotted ? c.plain : c.patterns);
  return hit3 === null ? input : m[1] + hit3 + m[3];
}

/** Whole-element markup translation for headings whose word order differs ("Official <span>Picks</span>"). */
export function translateHtml(html, locale) {
  if (locale === 'en') return null;
  return compiled(locale)?.html.get(html.trim()) ?? null;
}

/** True when the catalog knows the string (used by the coverage report). */
export function knows(input, locale) {
  return translateText(input, locale) !== input;
}
