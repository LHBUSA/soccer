// Live-first match discovery. A list of matches is shown as LIVE NOW -> UPCOMING -> FINAL, then the honest
// non-standard states (postponed / cancelled / abandoned / awaiting result). A LIVE match can never sit below a
// non-live one. Pure functions over the API's own `status`; nothing here reads a clock or changes a match.

export const STATE_GROUPS = [
  { key: 'live', label: 'LIVE NOW', statuses: ['live'] },
  { key: 'upcoming', label: 'UPCOMING', statuses: ['scheduled'] },
  { key: 'final', label: 'FINAL', statuses: ['finished'] },
  { key: 'other', label: 'POSTPONED / OTHER', statuses: null }, // everything else, never dropped
];
// The ?state= filter values a viewer may pick (ALL = no key).
export const STATE_FILTERS = ['live', 'upcoming', 'final'];

export const groupKeyOf = m => STATE_GROUPS.find(g => g.statuses?.includes(m?.status))?.key || 'other';

const t = m => { const v = Date.parse(m?.kickoff_at); return Number.isFinite(v) ? v : Infinity; };
const byId = (a, b) => String(a.id).localeCompare(String(b.id));
// LIVE and UPCOMING: earliest kickoff first (the longest-running live match leads). FINAL: most recent first.
const ORDER = {
  live: (a, b) => t(a) - t(b) || byId(a, b),
  upcoming: (a, b) => t(a) - t(b) || byId(a, b),
  final: (a, b) => t(b) - t(a) || byId(a, b),
  other: (a, b) => t(a) - t(b) || byId(a, b),
};

// One row per match id (the first occurrence wins), whatever list(s) it arrived in.
export function uniqueMatches(...lists) {
  const seen = new Set(); const out = [];
  for (const m of lists.flat()) { if (!m?.id || seen.has(m.id)) continue; seen.add(m.id); out.push(m); }
  return out;
}

// -> [{ key, label, matches }] in display order, empty groups omitted.
export function groupByState(list) {
  const rows = uniqueMatches(list || []);
  return STATE_GROUPS
    .map(g => ({ key: g.key, label: g.label, matches: rows.filter(m => groupKeyOf(m) === g.key).sort(ORDER[g.key]) }))
    .filter(g => g.matches.length);
}

export const liveFirst = list => groupByState(list).flatMap(g => g.matches);

// { all, live, upcoming, final, other } counts, for the filter bar.
export function stateCounts(list) {
  const rows = uniqueMatches(list || []);
  const c = { all: rows.length, live: 0, upcoming: 0, final: 0, other: 0 };
  for (const m of rows) c[groupKeyOf(m)] += 1;
  return c;
}

// Live matches per competition slug, for the competition filter.
export function liveByCompetition(list) {
  const out = {};
  for (const m of uniqueMatches(list || [])) if (m.status === 'live' && m.competition?.slug) out[m.competition.slug] = (out[m.competition.slug] || 0) + 1;
  return out;
}
