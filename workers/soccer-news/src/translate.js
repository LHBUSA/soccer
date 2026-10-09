// NEWSROOM TRANSLATION DESK (soccer-translate/1). Owner approval 2026-10-09 "OWNER APPROVAL — SPANISH SOCCER NEWSROOM";
// Issue #15 stage 1. A published English article is translated into a SEPARATE, VERSIONED record
// (public.soccer_article_translations) bound to the English source revision and its frozen evidence packet:
//
//   English segments (workers/shared/article-i18n.js) -> translator (OpenAI, the existing newsroom transport + ledger)
//   -> deterministic gates (coverage, numbers, names, dates, quotes, brands/links, added claims, leftover English,
//      length) -> INDEPENDENT verifier (a second, separate model call that sees only the English and the translation and
//      lists every factual / meaning difference) -> PUBLISH only when everything passes, else HOLD with the reasons.
//
// The English article is never written. Lifecycle (every tick, model-free): a translation whose English source was
// revised is SUPERSEDED, one whose English article was withdrawn is WITHDRAWN, one whose English row was touched without
// a text change is REVALIDATED (same revision hash). The reader API (soccer-api) additionally serves a translation only
// while its revision hash still equals the live English article's, so a stale translation is never shown.
//
// Spend: every call is a row in soccer_news_openai_usage (task translation | translation_check, locale) and counts
// against the newsroom's $5/day emergency ceiling; translation has its OWN per-locale daily allowance on top
// (SOCCER_TRANSLATE_<LOCALE>_DAILY_MAX_USD; es default $1, every other locale $0 until separately approved). The
// allowance is checked BEFORE each call with a conservative estimate, and fails closed when the ledger is unreadable.
import { storeFromEnv } from '../../shared/postgrest.js';
import { ARTICLE_LOCALES, articleSegments, sourceRevision, exonym, NATION_EXONYMS } from '../../shared/article-i18n.js';
import { overCeiling, spentUsd, dailyMaxUsd, spentToday, readCallLog, LEDGER_TABLE, WORKER_VERSION } from './openai-cost.js';
import { aiConfig, ROUTER_VERSION, nominalStandardCost } from './ai-router.js';
import { DESK_API, sanitizeDeskError } from './desk.js';

// 1.1.0 (pilot tick 1, 2026-10-09): number words translated (never left in English), ordinals localized, national-team
// exonyms (house list); the checker is told the naming policy so canonical club/player names are not 'untranslated'.
// 1.1.1 (pilot tick 2): 'canonical' is a house term (PropBetEdge's verified record), never 'official'.
export const TRANSLATE_VERSION = 'soccer-translate/1.1.1';
export const CHECK_VERSION = 'soccer-translation-check/1.1.0';
export const TRANSLATION_GATES_VERSION = 'soccer-translation-gates/1.1.0';
export const TRANSLATE_MODEL = 'gpt-5.6-sol';
// Conservative per-call estimates used only to refuse a call that could cross an allowance (actual cost is recorded).
export const EST_TRANSLATE_USD = 0.09;
export const EST_CHECK_USD = 0.05;

// ------------------------------------------------------------------------------------------------ prompts (per locale)
const COMMON_RULES = (lang) => `You translate one published PropBetEdge Soccer article from English into ${lang}.
The English text has already passed fact-checking against a frozen evidence record. Your translation must say EXACTLY
the same things: no added facts, no omitted facts, no new adjectives that judge players or teams, no opinions.

Hard rules (an automatic checker rejects any violation):
- Player, club and competition names stay EXACTLY as written in English (same spelling, accents, capitalisation), e.g.
  "Bayern Munich", "Harry Kane", "Premier League", "UEFA Nations League". Do not translate or abbreviate them.
  Possessives become prepositions ("Kane's goals" -> natural ${lang} with "Kane" unchanged).
- NATIONAL TEAMS are written with the exact ${lang} names given in the NATIONAL TEAMS list of the request, and only those.
- Every number written in digits stays in digits with the same value: scores ("2-1"), goals, minutes, points,
  positions, dates, kick-off times ("15:30 UTC"), percentages, decimals (keep the decimal point, e.g. 1.8).
- A number written as an English WORD ("four", "two", "twice", "third") is translated as the equivalent ${lang} word,
  never left in English and never turned into digits.
- Ordinals written with digits ("16th", "1st") use the ${lang} ordinal form with the same digits (${ORDINAL_HINT[lang] || ''}).
- Month and weekday names are translated; their day and year digits stay.
- Keep "PropBetEdge", "PropSports" and "DATA · PropSports" verbatim. Keep every URL verbatim.
- Quotations: keep the same number of quoted passages, translate their meaning faithfully, use the language's quotation marks.
- Never introduce betting, odds, favourites, predictions, probabilities, injuries, transfers, records, history claims,
  tactics or mentality language that the English does not contain.
- Write professional, natural sports journalism for native readers (not word-for-word): idiomatic headlines, fluent
  sentences, the football vocabulary below. Headlines use sentence case as is normal in ${lang}.
- Translate every segment. Return the same ids, one translation each, nothing else.`;

const GLOSSARY = {
  es: `Spanish: neutral international Spanish (readable in Spain and Latin America; avoid regionalisms).
Vocabulary: match report = crónica; preview = previa; matchday = jornada; table/standings = clasificación;
hat-trick = triplete; brace = doblete; clean sheet = portería a cero; own goal = gol en propia puerta; penalty = penalti;
stoppage time = tiempo de añadido; half-time = descanso; second half = segunda parte; header = cabezazo;
assist = asistencia; shots on target = tiros a puerta; corners = saques de esquina; kick-off = inicio / saque inicial;
league phase = fase liga; group = grupo; form = racha / forma; scoring run = racha goleadora; substitute = suplente.
House terms: canonical (results, record, data) = canónico/canónicos - our verified record, NEVER "oficial"; sourced = con fuente;
frozen at publication = congelado en la publicación.`,
  pt: `Brazilian Portuguese (pt-BR) as written by Brazilian football media.
Vocabulary: match report = crônica / relato da partida; preview = prévia; matchday = rodada; table = classificação;
hat-trick = hat-trick; clean sheet = sem sofrer gols; own goal = gol contra; penalty = pênalti; stoppage time = acréscimos;
half-time = intervalo; header = cabeçada; assist = assistência; shots on target = finalizações no alvo; corners = escanteios.
House terms: canonical = canônico (our verified record, NEVER "oficial"); sourced = com fonte.`,
  fr: `French as written by French-language football media.
Vocabulary: match report = compte rendu; preview = avant-match; matchday = journée; table = classement; hat-trick = triplé;
brace = doublé; clean sheet = cage inviolée; own goal = but contre son camp; penalty = penalty / pénalty; stoppage time =
temps additionnel; half-time = mi-temps; header = tête; assist = passe décisive; shots on target = tirs cadrés; corners = corners.
House terms: canonical = canonique (our verified record, NEVER "officiel"); sourced = sourcé.`,
};
const LANG = { es: 'Spanish', pt: 'Brazilian Portuguese (pt-BR)', fr: 'French' };
const ORDINAL_HINT = { Spanish: '16.º, 1.º or "el puesto 16"', 'Brazilian Portuguese (pt-BR)': '16º, 1º', French: '16e, 1er' };
export const translatorInstructions = locale => `${COMMON_RULES(LANG[locale])}\n\n${GLOSSARY[locale]}`;

export const checkerInstructions = locale => `You are an independent bilingual fact-checking editor (English and ${LANG[locale]}).
You did NOT write the translation. You receive pairs of English source segments and their ${LANG[locale]} translation.
House naming policy (do NOT report these): player, club and competition names are intentionally kept exactly as in the
English (e.g. "Bayern Munich", "Premier League"); national teams use the names in the NATIONAL TEAMS list provided;
brands "PropBetEdge", "PropSports", "DATA · PropSports" stay as written.
For EVERY pair decide whether the translation states exactly the same facts and meaning. Report an issue for any:
- fact: a different or missing player, team, score, number, date, minute, competition, position, statistic or attribution;
- meaning: a sentence whose meaning, certainty or attribution changed (including a quotation whose meaning changed);
- omission: English content that is not translated;
- addition: content that is not in the English (new claims, judgements, predictions, odds, betting, injuries, records);
- untranslated: English words left untranslated (names, brands and URLs are expected to stay as written).
Use severity "style" only for purely stylistic remarks that do not change facts or meaning.
verdict is "pass" only when there is no issue other than "style". Be strict: when in doubt, report it.
fluency rates the whole translation for a native ${LANG[locale]} reader.`;

const TRANSLATION_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['segments'],
  properties: { segments: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'text'], properties: { id: { type: 'string' }, text: { type: 'string' } } } } },
};
const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['verdict', 'fluency', 'issues'],
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    fluency: { type: 'string', enum: ['native', 'good', 'acceptable', 'poor'] },
    issues: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'severity', 'detail'], properties: { id: { type: 'string' }, severity: { type: 'string', enum: ['fact', 'meaning', 'omission', 'addition', 'untranslated', 'style'] }, detail: { type: 'string' } } } },
  },
};

// ------------------------------------------------------------------------------------------------ transport
/** One Responses API call with a strict JSON schema; same exits and telemetry shape as the editorial desk. */
export async function callModel(env, { instructions, input, schema, name, model, effort, maxOutputTokens, fetcher = fetch }) {
  const meta = { response_id: null, model, usage: null, status: 'completed', error_code: null };
  const fail = (msg, status, code) => { const e = new Error(sanitizeDeskError(msg, env)); e.meta = { ...meta, status, error_code: code }; return e; };
  let res;
  try {
    res = await fetcher(DESK_API, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model, store: false, reasoning: { effort }, instructions, input, max_output_tokens: maxOutputTokens, text: { format: { type: 'json_schema', name, strict: true, schema } } }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    const timeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    throw fail(`${name} ${timeout ? 'timeout' : 'network error'}: ${e?.message || e}`, timeout ? 'timeout' : 'error', timeout ? 'timeout' : 'network_error');
  }
  if (!res.ok) { let code = `http_${res.status}`; try { const e = await res.json(); if (e?.error?.code) code = `http_${res.status}:${e.error.code}`; } catch { /* no body */ } throw fail(`${name} HTTP ${res.status}`, 'failed', code); }
  let j; try { j = await res.json(); } catch { throw fail(`${name} invalid_response_body`, 'error', 'invalid_response_body'); }
  meta.response_id = j?.id || null; meta.model = j?.model || model;
  meta.usage = { input_tokens: j?.usage?.input_tokens ?? null, cached_input_tokens: j?.usage?.input_tokens_details?.cached_tokens ?? null, output_tokens: j?.usage?.output_tokens ?? null, reasoning_tokens: j?.usage?.output_tokens_details?.reasoning_tokens ?? null };
  if (j?.status === 'incomplete') throw fail(`${name} incomplete: ${j.incomplete_details?.reason || 'unknown'}`, 'incomplete', j.incomplete_details?.reason || 'incomplete');
  if (j?.status && j.status !== 'completed') throw fail(`${name} status ${j.status}`, j.status === 'failed' ? 'failed' : 'error', `status_${j.status}`);
  const parts = []; const refusals = [];
  for (const item of j?.output || []) for (const c of item?.content || []) { if (c?.type === 'refusal') refusals.push(String(c.refusal || '')); if (c?.type === 'output_text' && c.text) parts.push(String(c.text)); }
  if (refusals.length) throw fail(`${name} refusal`, 'refused', 'refusal');
  try { return { meta, out: JSON.parse(parts.join('').trim()) }; } catch { throw fail(`${name} invalid_json`, 'completed', 'invalid_json'); }
}

// ------------------------------------------------------------------------------------------------ deterministic gates
const digitRuns = s => (String(s).match(/\d+/g) || []).sort();
const sameMultiset = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const count = (s, re) => (String(s).match(re) || []).length;
const EN_MONTHS = [/\bjan(uary|\.)?\b/i, /\bfeb(ruary|\.)?\b/i, /\bmar(ch|\.)?\b/i, /\bapr(il|\.)?\b/i, /\bmay\b/i, /\bjune?\b/i, /\bjuly?\b/i, /\baug(ust|\.)?\b/i, /\bsep(t|tember|t\.|\.)?\b/i, /\boct(ober|\.)?\b/i, /\bnov(ember|\.)?\b/i, /\bdec(ember|\.)?\b/i];
const MONTHS = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre|setiembre', 'octubre', 'noviembre', 'diciembre'],
  pt: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  fr: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'],
};
const EN_DAYS = [/\bmonday\b/i, /\btuesday\b/i, /\bwednesday\b/i, /\bthursday\b/i, /\bfriday\b/i, /\bsaturday\b/i, /\bsunday\b/i];
const DAYS = {
  es: ['lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado', 'domingo'],
  pt: ['segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'domingo'],
  fr: ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'],
};
// "May" is also an English modal verb: only a capitalised May next to a digit is the month.
const monthIn = (s, i) => (i === 4 ? /\bMay\b(?=\s*\d)|\d\s+May\b/.test(s) : EN_MONTHS[i].test(s));
// Claims the English never made (desk.js BANNED / gates2 preview bans, in the target language). A category fails only
// when the translation has it and the English segment does not.
const ADDED = {
  odds: [/\b(odds|bet(s|ting)?|wager|bookmaker|sportsbook|favou?rites?|underdogs?)\b/i, { es: /\b(cuotas?|apuestas?|apostar|casas? de apuestas|favorit[oa]s?)\b/i, pt: /\b(odds|apostas?|apostar|casas? de apostas|favorit[oa]s?|zebra)\b/i, fr: /\b(cotes?|paris|parier|bookmakers?|favori(te)?s?|outsiders?)\b/i }],
  prediction: [/\b(predict\w*|probabilit\w*|chances?|likely|will win|expected to)\b/i, { es: /\b(probabilidad\w*|predicci[óo]n\w*|pron[óo]stic\w*|ganar[áa]n?|vencer[áa]n?)\b/i, pt: /\b(probabilidade\w*|previs[ãa]o|palpite\w*|vencer[áa]o?|ganhar[áa]o?)\b/i, fr: /\b(probabilit[ée]s?|pr[ée]diction\w*|pronostic\w*|gagnera(ient|ont)?)\b/i }],
  injury: [/\b(injur\w*|hamstring|knock|ruled out|sidelined|suspen\w*)\b/i, { es: /\b(lesi[óo]n\w*|lesionad\w*|sancionad\w*|suspensi[óo]n|suspendid\w*)\b/i, pt: /\b(les[ãa]o|lesionad\w*|suspens[ãa]o|suspens\w*|desfalque)\b/i, fr: /\b(bless\w*|suspen\w*|forfait)\b/i }],
  transfer: [/\b(transfer|rumou?r\w*|linked with|signing|contract|loan)\b/i, { es: /\b(fichaje\w*|traspaso\w*|rumor\w*|cesi[óo]n|contrato)\b/i, pt: /\b(contrata[çc][ãa]o|transfer[êe]ncia|rumor\w*|empr[ée]stimo|contrato)\b/i, fr: /\b(transfert\w*|rumeur\w*|pr[êe]t|contrat)\b/i }],
  xg: [/\b(xg|expected goals|big chances?|chance quality)\b/i, { es: /\b(xg|goles esperados|ocasiones? claras?)\b/i, pt: /\b(xg|gols esperados|grandes chances)\b/i, fr: /\b(xg|buts attendus|grosses occasions)\b/i }],
  record: [/\b(records?|record-\w+|first time|all-time|historic\w*|history|unprecedented|never before)\b/i, { es: /\b(r[ée]cords?|hist[óo]ric\w*|historia|por primera vez|sin precedentes)\b/i, pt: /\b(recordes?|hist[óo]ric\w*|hist[óo]ria|pela primeira vez|in[ée]dit\w*)\b/i, fr: /\b(records?|histori\w*|premi[èe]re fois|in[ée]dit\w*)\b/i }],
  mentality: [/\b(hungr\w*|desire|mentality|confiden\w*|frustrat\w*|nervous|belief|pressure)\b/i, { es: /\b(mentalidad|hambre|confianza|frustra\w*|nervios\w*|presi[óo]n)\b/i, pt: /\b(mentalidade|fome|confian[çc]a|frustra\w*|nervos\w*|press[ãa]o)\b/i, fr: /\b(mentalit[ée]|faim|confiance|frustr\w*|nerveu\w*|pression)\b/i }],
  tactics: [/\b(formation|press(ing)?|back (three|four|five)|false nine|low block)\b/i, { es: /\b(formaci[óo]n|presi[óo]n alta|defensa de (tres|cuatro|cinco)|falso nueve|bloque bajo)\b/i, pt: /\b(forma[çc][ãa]o|marca[çc][ãa]o alta|linha de (tr[êe]s|quatro|cinco)|falso nove|bloco baixo)\b/i, fr: /\b(syst[èe]me|pressing|d[ée]fense [àa] (trois|quatre|cinq)|faux neuf|bloc bas)\b/i }],
};
const EN_NUMBER_WORDS = /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|twenty|twice|thrice|first|second|third|fourth|fifth)\b/gi;
const EN_ORDINAL = /\b\d+(st|nd|rd|th)\b/i;
const LEFTOVER = /\b(the|and|with|of|was|were|after|their|his|has|have|from|which|while|against|into)\b/gi;
const QUOTED = /[“"«][^”"»]{2,}[”"»]/g;
const URLS = /https?:\/\/\S+/g;
const BRANDS = ['PropBetEdge', 'PropSports', 'DATA · PropSports'];

/** Names the translation must carry verbatim: canonical entities of the story and of its frozen visuals. */
export function protectedNames(a) {
  const names = new Set();
  for (const e of a.entities || []) if (e?.name && ['Person', 'SportsTeam', 'SportsOrganization'].includes(e.type)) names.add(e.name);
  for (const v of a.body?.visuals || []) for (const e of v?.entities || []) if (e?.name) names.add(e.name);
  return [...names].filter(n => n.length >= 3).sort((x, y) => y.length - x.length);
}

/** Deterministic gates over (English segment, translated segment) pairs. Returns { pass, results, reasons }. */
export function translationGates(a, segments, translated, locale) {
  const reasons = []; const results = {};
  const fail = (gate, detail) => { (results[gate] ||= []).push(detail); if (!reasons.includes(`translation_${gate}`)) reasons.push(`translation_${gate}`); };
  const ids = segments.map(s => s.id);
  const got = new Map((translated || []).map(s => [s.id, String(s.text ?? '').trim()]));
  for (const id of ids) if (!got.get(id)) fail('coverage', `missing ${id}`);
  for (const id of got.keys()) if (!ids.includes(id)) fail('coverage', `unknown ${id}`);
  const names = protectedNames(a);
  for (const { id, text: en } of segments) {
    const tr = got.get(id); if (!tr) continue;
    if (!sameMultiset(digitRuns(en), digitRuns(tr))) fail('numbers', `${id}: ${digitRuns(en).join(' ')} != ${digitRuns(tr).join(' ')}`);
    // canonical entities, plus every listed nation the English names (opponents are often not story entities)
    const nations = Object.keys(NATION_EXONYMS[locale] || {}).filter(k => new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(en));
    for (const n of new Set([...names, ...nations])) {
      if (!en.includes(n)) continue;
      const x = exonym(n, locale);
      if (!tr.includes(x || n)) fail('names', `${id}: "${x || n}" expected for "${n}"`);
    }
    EN_MONTHS.forEach((_, i) => { if (monthIn(en, i) && !new RegExp(`\\b(${MONTHS[locale][i]})\\b`, 'i').test(tr)) fail('dates', `${id}: month ${i + 1}`); });
    EN_DAYS.forEach((re, i) => { if (re.test(en) && !new RegExp(`\\b${DAYS[locale][i]}`, 'i').test(tr)) fail('dates', `${id}: weekday ${i + 1}`); });
    if (count(en, QUOTED) !== count(tr, QUOTED)) fail('quotes', `${id}: ${count(en, QUOTED)} quoted passages -> ${count(tr, QUOTED)}`);
    for (const b of BRANDS) if (en.split(b).length !== tr.split(b).length) fail('attribution', `${id}: "${b}" count changed`);
    if ((en.match(URLS) || []).sort().join(' ') !== (tr.match(URLS) || []).sort().join(' ')) fail('attribution', `${id}: links changed`);
    for (const [cat, [enRe, tr2]] of Object.entries(ADDED)) if (tr2[locale].test(tr) && !enRe.test(en)) fail('added_claim', `${id}: ${cat} (${(tr.match(tr2[locale]) || [])[0]})`);
    let bare = tr; for (const n of names) bare = bare.split(n).join(' '); for (const b of BRANDS) bare = bare.split(b).join(' ');
    if (count(bare, LEFTOVER) >= 3) fail('untranslated', `${id}: ${count(bare, LEFTOVER)} English function words`);
    const words = bare.match(EN_NUMBER_WORDS); if (words) fail('untranslated', `${id}: English number words ${[...new Set(words)].join(', ')}`);
    const ord = tr.match(EN_ORDINAL); if (ord) fail('untranslated', `${id}: English ordinal ${ord[0]}`);
    if (en.length >= 40) { const r = tr.length / en.length; if (r < 0.6 || r > 2.0) fail('length', `${id}: length ratio ${r.toFixed(2)}`); }
    if (tr === en && /[a-z]{4,}/i.test(en) && en.length >= 20) fail('untranslated', `${id}: identical to English`);
  }
  const gates = ['coverage', 'numbers', 'names', 'dates', 'quotes', 'attribution', 'added_claim', 'untranslated', 'length'];
  return { pass: reasons.length === 0, reasons, results: Object.fromEntries(gates.map(g => [g, results[g] ? { pass: false, failures: results[g].slice(0, 12) } : { pass: true }])) };
}

/** The independent check's verdict as gate results (issues other than style hold). */
export function checkVerdict(out) {
  const issues = Array.isArray(out?.issues) ? out.issues : [];
  const blocking = issues.filter(i => i.severity !== 'style');
  const pass = out?.verdict === 'pass' && blocking.length === 0 && out?.fluency !== 'poor';
  return { pass, reasons: pass ? [] : ['translation_independent_check'], result: { pass, verdict: out?.verdict || null, fluency: out?.fluency || null, issues: issues.slice(0, 20) } };
}

// ------------------------------------------------------------------------------------------------ budget
export const translationAllowanceUsd = (env, locale) => {
  const v = env?.[`SOCCER_TRANSLATE_${locale.toUpperCase()}_DAILY_MAX_USD`];
  const n = Number(v);
  const dflt = locale === 'es' ? 1 : 0; // new locales spend nothing until separately approved
  return v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(n) || n < 0 ? dflt : Math.min(n, dailyMaxUsd(env));
};
/** Today's translation spend for one locale: the durable ledger, else the KV day log (same records). Neither -> throws. */
export async function translationSpentToday(env, locale, now = Date.now()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const store = (() => { try { return storeFromEnv(env); } catch { return null; } })();
  if (store) {
    try { return spentUsd(await store.select(LEDGER_TABLE, { columns: ['estimated_usd', 'input_tokens', 'output_tokens'], in: { task: ['translation', 'translation_check'] }, eq: { locale }, gte: { occurred_at: `${day}T00:00:00Z` } })); } catch { /* KV fallback */ }
  }
  if (!env?.SOCCER_STATE) throw new Error('translation spend unreadable: no ledger and no KV day log');
  const calls = (await env.SOCCER_STATE.get(`openai:v1:calls:${day}`, 'json')) || [];
  return spentUsd(calls.filter(c => (c.task === 'translation' || c.task === 'translation_check') && c.locale === locale));
}
/** May a call costing up to `est` be made now? Both the per-locale allowance and the global ceiling must hold. */
export async function canSpend(env, locale, est, now = Date.now()) {
  const allowance = translationAllowanceUsd(env, locale);
  if (allowance <= 0) return { ok: false, reason: `translation_budget_not_approved:${locale}` };
  try {
    if (await overCeiling(env, now)) return { ok: false, reason: 'openai_daily_ceiling' };
    const total = await spentToday(env, now);
    if (total + est > dailyMaxUsd(env)) return { ok: false, reason: 'openai_daily_ceiling' };
    const spent = await translationSpentToday(env, locale, now);
    if (spent + est > allowance) return { ok: false, reason: `translation_allowance:${locale}`, spent, allowance };
    return { ok: true, spent, allowance };
  } catch (e) { return { ok: false, reason: 'translation_budget_unreadable', error: String(e?.message || e).slice(0, 120) }; }
}

// ------------------------------------------------------------------------------------------------ one article
// Timestamps compared as instants (PostgREST strings or driver Date objects, any offset notation).
const sameInstant = (x, y) => x != null && y != null && new Date(x).getTime() === new Date(y).getTime();
const ARTICLE_COLUMNS = ['id', 'slug', 'desk', 'story_class', 'status', 'headline', 'dek', 'body', 'entities', 'packet_hash', 'updated_at', 'published_at'];

// The usage record of ONE translation call: the same durable ledger table and the same KV day log the editorial desk
// writes (openai-cost.js recordCall, whose decision path is pinned to production RC2.1 and is not modified), so the
// $5/day breaker (spentToday) counts every translation call. Extra fields: task + locale (migration 20261009001600).
export const TRANSLATION_TRIGGERS = ['cron_translation', 'admin_translation'];
export function translationLedgerRow(env, { started, finished, meta, a, trigger, task, locale, status, error_code, latency }) {
  if (!TRANSLATION_TRIGGERS.includes(trigger)) throw new Error(`unknown translation trigger ${trigger}`);
  if (!['translation', 'translation_check'].includes(task)) throw new Error(`unknown translation task ${task}`);
  const u = meta?.usage || {};
  const known = v => (Number.isFinite(v) ? v : null);
  const model = meta?.model || TRANSLATE_MODEL;
  const usd = Number.isFinite(u.input_tokens) || Number.isFinite(u.output_tokens) ? nominalStandardCost(TRANSLATE_MODEL, u, aiConfig(env)) : null;
  return {
    occurred_at: started, finished_at: finished, article_id: a.id || null, news_event_id: null, slug: a.slug || null, trigger, attempt: 1, model, response_id: meta?.response_id || null,
    input_tokens: known(u.input_tokens), cached_input_tokens: known(u.cached_input_tokens), output_tokens: known(u.output_tokens), reasoning_tokens: known(u.reasoning_tokens),
    estimated_usd: usd, status, error_code: error_code || null, desk_version: task === 'translation' ? TRANSLATE_VERSION : CHECK_VERSION, worker_version: WORKER_VERSION,
    sport: 'soccer', worker: 'soccer-news', story_class: a.story_class || null, routing_lane: 'STANDARD_EDITORIAL', routing_reason: `${task}:${locale}`, pool: 'premium', router_version: ROUTER_VERSION,
    latency_ms: Number.isFinite(latency) ? latency : null, nominal_standard_cost: usd, task, locale,
  };
}
async function record(env, { started, meta, err, a, locale, trigger, task, latency }) {
  const m = err?.meta || meta || {};
  const row = translationLedgerRow(env, { started, finished: new Date().toISOString(), meta: m, a, trigger, task, locale, status: m.status || (err ? 'error' : 'completed'), error_code: m.error_code, latency });
  const store = (() => { try { return storeFromEnv(env); } catch { return null; } })();
  if (store) await store.insert(LEDGER_TABLE, [row]).catch(e => console.error('translation usage ledger insert failed', String(e?.message || e).slice(0, 200)));
  const kv = env?.SOCCER_STATE;
  if (kv) {
    try {
      const key = `openai:v1:calls:${row.occurred_at.slice(0, 10)}`;
      const prior = await readCallLog(kv, row.occurred_at);
      prior.push({ worker: 'soccer-news', sport: 'soccer', id: a.slug || null, ...row, at: row.occurred_at, error: row.error_code, requested_model: TRANSLATE_MODEL });
      await kv.put(key, JSON.stringify(prior), { expirationTtl: 400 * 86400 });
    } catch (e) { console.error('translation usage KV record failed', String(e?.message || e).slice(0, 160)); }
  }
  return row;
}

/**
 * Translate ONE published English article into `locale`, gate it, check it independently, and write a new version
 * (published or held). `dry` = segments + revision only (no model call, no write). Returns a report.
 */
export async function translateArticle(env, store, a, locale, { trigger = 'admin_translation', dry = false, fetcher = fetch, now = Date.now() } = {}) {
  if (!ARTICLE_LOCALES[locale]) throw new Error(`unknown locale ${locale}`);
  if (a.status !== 'published') return { slug: a.slug, locale, outcome: 'skipped', reason: 'english_not_published' };
  const segments = articleSegments(a);
  const revision = sourceRevision(a);
  if (dry) return { slug: a.slug, locale, outcome: 'dry', revision, segments: segments.length, words: segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0) };
  const cfg = aiConfig(env);
  if (!cfg.enabled) return { slug: a.slug, locale, outcome: 'skipped', reason: 'soccer_ai_off' };
  if (!env.OPENAI_API_KEY) return { slug: a.slug, locale, outcome: 'skipped', reason: 'openai_key_missing' };
  const model = env.SOCCER_TRANSLATE_MODEL || TRANSLATE_MODEL;
  const budget = await canSpend(env, locale, EST_TRANSLATE_USD + EST_CHECK_USD, now);
  if (!budget.ok) return { slug: a.slug, locale, outcome: 'skipped', reason: budget.reason };

  // 1. translator
  const nations = protectedNames(a).filter(n => exonym(n, locale)).map(n => `${n} = ${exonym(n, locale)}`);
  const input = `${nations.length ? `NATIONAL TEAMS (write exactly these ${LANG[locale]} names): ${nations.join('; ')}\n\n` : ''}Translate these segments of one article. Segment ids: h = headline, d = dek (standfirst), sN.h = section heading, sN.pM = paragraph, v.*.title/subtitle/source = data-visual captions, m.* = method notes.\n${JSON.stringify({ segments: segments.map(s => ({ id: s.id, text: s.text })) })}`;
  const maxOut = Math.max(2000, Math.min(16000, Math.round(segments.reduce((n, s) => n + s.text.length, 0) / 2.2) + 2500));
  let translated; let t0 = Date.now(); const started = new Date().toISOString();
  try {
    const r = await callModel(env, { instructions: translatorInstructions(locale), input, schema: TRANSLATION_SCHEMA, name: 'soccer_article_translation', model, effort: env.SOCCER_TRANSLATE_EFFORT || 'low', maxOutputTokens: maxOut, fetcher });
    await record(env, { started, meta: r.meta, a, locale, trigger, task: 'translation', latency: Date.now() - t0 });
    translated = r.out.segments;
  } catch (e) {
    await record(env, { started, err: e, a, locale, trigger, task: 'translation', latency: Date.now() - t0 });
    return { slug: a.slug, locale, outcome: 'error', reason: String(e.message).slice(0, 200) };
  }
  // 2. deterministic gates
  const gates = translationGates(a, segments, translated, locale);
  // 3. independent check (only for a translation that passed the deterministic gates: a failed one holds anyway)
  let check = { pass: false, reasons: ['translation_independent_check_not_run'], result: { pass: false, skipped: 'deterministic gates failed' } };
  if (gates.pass) {
    const b2 = await canSpend(env, locale, EST_CHECK_USD, Date.now());
    if (!b2.ok) check = { pass: false, reasons: ['translation_independent_check_not_run'], result: { pass: false, skipped: b2.reason } };
    else {
      const map = new Map(translated.map(s => [s.id, s.text]));
      const pairs = segments.map(s => ({ id: s.id, en: s.text, [locale]: map.get(s.id) }));
      const nationList = protectedNames(a).filter(n => exonym(n, locale)).map(n => `${n} = ${exonym(n, locale)}`);
      t0 = Date.now(); const started2 = new Date().toISOString();
      try {
        const r = await callModel(env, { instructions: checkerInstructions(locale), input: `${nationList.length ? `NATIONAL TEAMS: ${nationList.join('; ')}\n` : ''}${JSON.stringify({ pairs })}`, schema: CHECK_SCHEMA, name: 'soccer_translation_check', model, effort: env.SOCCER_TRANSLATE_CHECK_EFFORT || 'low', maxOutputTokens: 4000, fetcher });
        await record(env, { started: started2, meta: r.meta, a, locale, trigger, task: 'translation_check', latency: Date.now() - t0 });
        check = checkVerdict(r.out);
      } catch (e) {
        await record(env, { started: started2, err: e, a, locale, trigger, task: 'translation_check', latency: Date.now() - t0 });
        check = { pass: false, reasons: ['translation_independent_check_failed_to_run'], result: { pass: false, error: String(e.message).slice(0, 160) } };
      }
    }
  }
  // 4. write the version (the English row is never written)
  const map = new Map((translated || []).map(s => [s.id, String(s.text ?? '').trim()]));
  const seg = Object.fromEntries(segments.map(s => [s.id, map.get(s.id) || '']));
  const reasons = [...gates.reasons, ...check.reasons];
  const publish = reasons.length === 0;
  // The English may have changed while the model ran: never publish against a revision that is no longer live.
  const [live] = await store.select('soccer_articles', { columns: ARTICLE_COLUMNS, eq: { id: a.id }, limit: 1 });
  if (!live || live.status !== 'published') return { slug: a.slug, locale, outcome: 'skipped', reason: 'english_withdrawn_during_translation' };
  if (sourceRevision(live) !== revision || live.packet_hash !== a.packet_hash) return { slug: a.slug, locale, outcome: 'skipped', reason: 'english_revised_during_translation' };
  const prior = await store.select('soccer_article_translations', { columns: ['id', 'version', 'status'], eq: { article_id: a.id, locale }, order: 'version.desc', limit: 50 });
  const version = (prior[0]?.version || 0) + 1;
  const row = {
    article_id: a.id, locale, version, source_revision: revision, source_updated_at: live.updated_at, packet_hash: a.packet_hash,
    segments: seg, headline: seg.h || '(none)', dek: seg.d || null, translator: `${TRANSLATE_VERSION} ${model}`, verifier: `${CHECK_VERSION} ${model}`,
    gate_version: TRANSLATION_GATES_VERSION, gate_results: { ...gates.results, independent_check: check.result, source_revision: revision, segments: segments.length },
    status: publish ? 'published' : 'held', hold_reasons: publish ? [] : reasons, published_at: publish ? new Date().toISOString() : null,
  };
  if (publish) {
    const live2 = prior.filter(p => p.status === 'published');
    for (const p of live2) await store.update('soccer_article_translations', { status: 'superseded', retired_at: new Date().toISOString(), status_reason: `replaced by v${version}` }, { eq: { id: p.id } });
  }
  await store.insert('soccer_article_translations', [row]);
  return { slug: a.slug, desk: a.desk, locale, outcome: publish ? 'published' : 'held', version, hold_reasons: row.hold_reasons, gates: row.gate_results };
}

// ------------------------------------------------------------------------------------------------ lifecycle + automation
/**
 * Model-free lifecycle for one locale: retire translations whose English source was withdrawn or revised; revalidate
 * those whose English row moved without a text change. Returns counts.
 */
export async function sweepTranslations(env, store, locale) {
  const live = await store.select('soccer_article_translations', { columns: ['id', 'article_id', 'source_revision', 'source_updated_at', 'packet_hash'], eq: { locale, status: 'published' }, order: 'id.asc' });
  const out = { checked: live.length, withdrawn: 0, superseded: 0, revalidated: 0 };
  if (!live.length) return out;
  const arts = new Map();
  for (let i = 0; i < live.length; i += 100) for (const r of await store.select('soccer_articles', { columns: ['id', 'status', 'packet_hash', 'updated_at'], in: { id: live.slice(i, i + 100).map(t => t.article_id) } })) arts.set(r.id, r);
  const at = new Date().toISOString();
  for (const t of live) {
    const a = arts.get(t.article_id);
    if (!a || a.status !== 'published') { await store.update('soccer_article_translations', { status: 'withdrawn', retired_at: at, status_reason: 'english_withdrawn' }, { eq: { id: t.id } }); out.withdrawn += 1; continue; }
    if (a.packet_hash !== t.packet_hash) { await store.update('soccer_article_translations', { status: 'superseded', retired_at: at, status_reason: 'english_evidence_changed' }, { eq: { id: t.id } }); out.superseded += 1; continue; }
    if (sameInstant(a.updated_at, t.source_updated_at)) continue;
    const [full] = await store.select('soccer_articles', { columns: ARTICLE_COLUMNS, eq: { id: a.id }, limit: 1 });
    if (sourceRevision(full) !== t.source_revision) { await store.update('soccer_article_translations', { status: 'superseded', retired_at: at, status_reason: 'english_revised' }, { eq: { id: t.id } }); out.superseded += 1; }
    else { await store.update('soccer_article_translations', { source_updated_at: full.updated_at, revalidated_at: at }, { eq: { id: t.id } }); out.revalidated += 1; }
  }
  return out;
}

/** Newest published English articles without a current translation (and not already held at this revision). */
// `slugs` + retry=true (admin): translate those even if current; retry=false (pilot list): same one-try-per-revision rule.
export async function translationCandidates(store, locale, { limit = 2, slugs = null, retry = true } = {}) {
  const named = !!slugs?.length && retry;
  const arts = slugs?.length
    ? await store.select('soccer_articles', { columns: ARTICLE_COLUMNS, in: { slug: slugs }, eq: { status: 'published' } })
    : await store.select('soccer_articles', { columns: ['id', 'slug', 'updated_at', 'packet_hash'], eq: { status: 'published' }, order: 'published_at.desc', limit: 60 });
  const rows = arts.length ? await store.select('soccer_article_translations', { columns: ['article_id', 'status', 'source_revision', 'source_updated_at', 'translator'], eq: { locale }, in: { article_id: arts.map(x => x.id) } }) : [];
  const out = [];
  for (const x of arts) {
    if (out.length >= limit) break;
    const mine = rows.filter(r => r.article_id === x.id);
    if (!named && mine.some(r => r.status === 'published' && sameInstant(r.source_updated_at, x.updated_at))) continue;
    const full = x.body ? x : (await store.select('soccer_articles', { columns: ARTICLE_COLUMNS, eq: { id: x.id }, limit: 1 }))[0];
    const rev = sourceRevision(full);
    if (mine.some(r => r.status === 'published' && r.source_revision === rev)) continue;
    // one automatic try per revision AND translator version (an improved translator may retry a held revision once)
    if (!named && mine.some(r => r.status === 'held' && r.source_revision === rev && String(r.translator || '').startsWith(TRANSLATE_VERSION))) continue;
    out.push(full);
  }
  return out;
}

/**
 * The cron step: lifecycle for every locale with rows, then translation by mode (SOCCER_TRANSLATE_<L>):
 *   off (default)  lifecycle only;
 *   pilot          ONLY the published articles named in SOCCER_TRANSLATE_<L>_PILOT (comma-separated slugs), each once
 *                  per English revision - the owner's bounded pilot, auditable in wrangler.toml;
 *   auto           the newest published articles without a current translation.
 * Every mode honours the per-locale allowance, the $5/day ceiling and SOCCER_AI=off; a non-public locale never runs.
 */
export async function translationTick(env, { now = Date.now() } = {}) {
  const store = storeFromEnv(env);
  const report = { at: new Date(now).toISOString(), version: TRANSLATE_VERSION, locales: {} };
  for (const locale of Object.keys(ARTICLE_LOCALES)) {
    const r = report.locales[locale] = { mode: String(env[`SOCCER_TRANSLATE_${locale.toUpperCase()}`] || 'off') };
    try { r.sweep = await sweepTranslations(env, store, locale); } catch (e) { r.sweep_error = String(e?.message || e).slice(0, 160); }
    if (!['auto', 'pilot'].includes(r.mode) || !ARTICLE_LOCALES[locale].enabled) continue;
    const per = Math.max(0, Math.min(5, Number(env.SOCCER_TRANSLATE_PER_TICK) || 2));
    const pilot = r.mode === 'pilot' ? String(env[`SOCCER_TRANSLATE_${locale.toUpperCase()}_PILOT`] || '').split(',').map(x => x.trim()).filter(x => /^[a-z0-9-]+$/.test(x)).slice(0, 25) : null;
    if (pilot && !pilot.length) { r.error = 'pilot mode without a pilot list'; continue; }
    r.results = [];
    try {
      for (const a of await translationCandidates(store, locale, pilot ? { limit: per, slugs: pilot, retry: false } : { limit: per })) {
        const x = await translateArticle(env, store, a, locale, { trigger: 'cron_translation', now });
        r.results.push({ slug: x.slug, outcome: x.outcome, reason: x.reason, hold_reasons: x.hold_reasons, version: x.version });
        if (x.outcome === 'skipped' && /budget|allowance|ceiling/.test(x.reason || '')) break;
      }
    } catch (e) { r.error = String(e?.message || e).slice(0, 160); }
  }
  await env.SOCCER_STATE?.put('translate:last_tick', JSON.stringify(report)).catch(() => {});
  return report;
}
