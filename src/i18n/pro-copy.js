// PREMIUM (PRO) COPY BY CODE. The soccer-api Pro routes return structured codes (component `key`, `unit`, `group`,
// coverage labels) plus English text assembled from those codes and numbers. This module renders that text in the
// page locale FROM THE CODES AND NUMBERS, never by translating free text:
//   - `en` holds the API's English exactly as soccer-api writes it (workers/soccer-api/src/pro/analyzer.js, fatigue.js);
//   - a translation is used only when the API's English for that code is identical to `en` (or, for templated text,
//     re-creates byte-for-byte from the same fields). If the API wording changes, readers get the API's own English,
//     never a stale translation; tests/web/pro-copy.test.js runs the real analyzer and fails until this file follows.
//   - numbers are passed through exactly as the API returns them.
// Adding a language: add its table to TABLES (same keys). Adding an analyzer component: add its `en` and the
// translations here; the sync test lists anything missing.
import { currentLocale } from './current.js';
import { resolveComp } from '../lib/competitions.js';
import es from './catalog/es-pro.js';

export const TABLES = { es };

// English source of truth (mirrors soccer-api). Keys are the API's own component codes.
export const ANALYZER_EN = {
  components: {
    form5: { label: 'Recent form · last 5', basis: 'Canonical results in the same competition-season league/group stages; 3/1/0 result points.' },
    form10: { label: 'Recent form · last 10', basis: 'Canonical results in the same competition-season league/group stages; 3/1/0 result points.' },
    scoring: { label: 'Recent scoring', basis: 'Last ten stored score pairs in the same competition-season league/group stages.' },
    conceding: { label: 'Recent conceding', basis: 'Last ten stored score pairs in the same competition-season league/group stages.' },
    gd: { label: 'Recent goal differential', basis: 'Last ten stored score pairs in the same competition-season league/group stages.' },
    season_scoring: { label: 'Season scoring', basis: 'Current competition-season league/group-stage results.' },
    season_conceding: { label: 'Season conceding', basis: 'Current competition-season league/group-stage results.' },
    venue: { label: 'Home / away split', basis: 'Home team at home and away team away; same competition-season league/group stages.' },
    shots: { label: 'Shot creation', basis: null },
    suppression: { label: 'Shot suppression', basis: null },
    shot_diff: { label: 'Shot differential', basis: null },
    sot_diff: { label: 'Shots-on-target differential', basis: null },
    rest: { label: 'Days since last match', basis: 'Calendar days at as-of time; all competitions. Rest comparison, not fitness.' },
    load7: { label: 'Recent schedule load', basis: 'Canonical matches played in seven days, all competitions; fewer fixtures = lower schedule load.' },
    xi: { label: 'XI continuity', basis: 'Consecutive sourced starting XIs; fraction retained. Not a selection forecast.' },
  },
  // Shot components: `Paired team/opponent ${metric}; compatible provider and basis: ${sig || 'none'}.`
  shotBasis: /^Paired team\/opponent (shots|shots_on_target); compatible provider and basis: (.+)\.$/,
  omittedReason: 'Missing, incompatible or insufficient paired coverage.',
  normalization: 'clamp((home - away) / scale, -1, 1), inverted for lower-is-better',
  coverageLabels: ['WEAK DATA · RATING WITHHELD', 'RESULTS + COMPATIBLE STATS', 'RESULTS / SCHEDULE ONLY'],
  coverageBasis: 'Coverage of stored observations, never predictive confidence. National-team results never enter club-league comparison samples.',
  historyBasis: 'Match-weighted canonical league/group-stage goals in stored seasons; event/stat metrics are not compared across eras.',
  ratingLabel: 'PBE MATCHUP RATING: descriptive component score. Not a win probability or prediction.',
  formula: 'Results 50%, compatible shot stats 30%, schedule/XI 20%; equal weights within each available group, groups renormalized when absent. Home = round(50 + 50 × weighted edge), away = round(50 - 50 × weighted edge). Scales are display normalizations, not fitted predictive weights. Rating requires at least three result matches per side.',
};
// The public preview omits `key`; its labels are the same closed set, so they identify the code.
export const ANALYZER_KEY_BY_LABEL = Object.fromEntries(Object.entries(ANALYZER_EN.components).map(([k, v]) => [v.label, k]));

// Fatigue / XI load / rotation index components (workers/soccer-api/src/pro/fatigue.js): label + detail templates.
export const INDEX_EN = {
  congestion_14: { label: 'Matches in the last 14 days', detail: [/^(\d+) in 14 days \(5 = maximum load\)$/] },
  short_rest: { label: 'Short-rest turnarounds (< 4 days) in 21 days', detail: [/^(\d+) short turnaround\(s\)$/] },
  rest: { label: 'Rest before the next match (or since the last)', detail: [/^(-?[\d.]+) day\(s\)$/, 'no recent match'] },
  travel_sequence: { label: 'Away share of the last five', detail: ['none'] },
  competition_switching: { label: 'Competition switches in the last five', detail: [/^(\d+) switch\(es\)$/] },
  xi_minutes_share_14: { label: 'Share of available minutes the last XI played (14 days)', detail: [/^(\d+)% of (\d+) team minutes per player$/] },
  international_return: { label: 'Players in the last XI returning from national-team duty', detail: [/^(\d+) player\(s\)$/] },
  schedule: { label: 'Team fatigue index (schedule)', detail: [/^(\d+)\/100$/] },
  concentration: { label: 'Minutes concentrated in the top 11', detail: [/^(\d+)% of minutes$/, 'no sourced lineups'] },
  continuity: { label: 'Starting-XI continuity', detail: [/^(\d+)% of starters kept$/, 'fewer than two sourced XIs'] },
};

const fmt = v => String(v); // numbers exactly as the API serialized them

// Customer source boundary (network standard DATA · PropSports). The API keeps the stat provenance signature
// (`<family>:<basis>`, e.g. the collection lane + 'source') for evidence; displays never print it. Display only:
// the API payload, provenance and calculations are unchanged.
const SIGNATURE = /\b[a-z][a-z0-9_]*:(?:source|derived)\b/g;
const LANE = /\bESPN\b/g;
export const customerCopy = s => typeof s === 'string' ? s.replace(SIGNATURE, 'PropSports').replace(LANE, 'PropSports') : s;
const SHOT_EN = {
  metrics: { shots: 'shots', shots_on_target: 'shots on target' },
  shotBasis: (metric, has) => has ?`Paired team/opponent ${metric} from one compatible stat basis (DATA · PropSports).` : `Paired team/opponent ${metric}; no compatible stat basis.`,
};
const humanSlug = s => String(s || '').split('-').filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(' ');

/** Copy accessor for the page locale. Every method returns the API's English when no verified translation applies. */
export function proCopy(locale = currentLocale()) {
  const T = TABLES[locale] || null;
  const A = T?.analyzer;
  const keyOf = c => c.key || ANALYZER_KEY_BY_LABEL[c.label] || null;
  const same = (api, en) => typeof api === 'string' && api === en;
  const t = {
    locale,
    // ---- analyzer ----
    label(c) { const k = keyOf(c); return A && k && same(c.label, ANALYZER_EN.components[k]?.label) ? A.components[k].label : c.label; },
    basis(c) {
      const k = keyOf(c); const en = ANALYZER_EN.components[k];
      const m = ANALYZER_EN.shotBasis.exec(c.basis || '');
      if (m && en && en.basis === null) { const S = A || SHOT_EN; return S.shotBasis(S.metrics[m[1]], m[2] !== 'none'); }
      if (!A) return customerCopy(c.basis);
      if (en?.basis && same(c.basis, en.basis)) return A.components[k].basis;
      return customerCopy(c.basis);
    },
    unit(u) { return A?.units[u] ?? u; },
    explanation(c) {
      // soccer-api: `Home: ${home} ${unit}; away: ${away} ${unit}. Samples: ${hs} / ${as}. ${basis}`
      if (!c.sample) return customerCopy(c.explanation);
      const head = `Home: ${fmt(c.home)} ${c.unit}; away: ${fmt(c.away)} ${c.unit}. Samples: ${fmt(c.sample.home)} / ${fmt(c.sample.away)}. `;
      if (c.explanation !== head + c.basis) return customerCopy(c.explanation);
      const basis = t.basis(c);
      if (!A) return head + basis; // English: the API sentence with the customer basis
      if (basis === customerCopy(c.basis)) return customerCopy(c.explanation); // never mix languages inside one sentence
      return A.explanation({ home: fmt(c.home), away: fmt(c.away), unit: t.unit(c.unit), hs: fmt(c.sample.home), as: fmt(c.sample.away), basis });
    },
    omittedReason(r) { return A && same(r, ANALYZER_EN.omittedReason) ? A.omittedReason : r; },
    normalization(n) { return A && same(n, ANALYZER_EN.normalization) ? A.normalization : n; },
    coverageLabel(l) { const i = ANALYZER_EN.coverageLabels.indexOf(l); return A && i >= 0 ? A.coverageLabels[i] : l; },
    coverageBasis(b) { return A && same(b, ANALYZER_EN.coverageBasis) ? A.coverageBasis : b; },
    historyBasis(b) { return A && same(b, ANALYZER_EN.historyBasis) ? A.historyBasis : b; },
    ratingLabel(l) { return A && same(l, ANALYZER_EN.ratingLabel) ? A.ratingLabel : l; },
    formula(f) { return A && same(f, ANALYZER_EN.formula) ? A.formula : f; },
    // ---- competition: the product name for the API slug, localized; never the raw slug ----
    competition(slug) { const c = resolveComp(slug); if (!c) return humanSlug(slug); return T?.competitions?.[c.name] || c.name; },
    // ---- fatigue / XI load / rotation components ----
    indexLabel(c) { const en = INDEX_EN[c.key]; return T?.index && en && same(c.label, en.label) ? T.index[c.key].label : c.label; },
    indexDetail(c) {
      const en = INDEX_EN[c.key]; const d = c.detail;
      if (!T?.index || !en || typeof d !== 'string') return d;
      for (const [i, p] of en.detail.entries()) {
        if (typeof p === 'string' ? d === p : p.test(d)) return T.index[c.key].detail[i](...(typeof p === 'string' ? [] : p.exec(d).slice(1)));
      }
      return d;
    },
    // ---- renderer chrome with numbers (English strings are the current UI copy) ----
    ui: T?.ui || null,
  };
  return t;
}
