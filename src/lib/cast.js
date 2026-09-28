// PBEcast timeline logic (pure; tested in tests/web/pbecast.test.js).
//
// The API's `sequence` is the provider's sourced events in source order, each with the
// source's minute and period. Football minutes overlap across periods (first-half stoppage
// "45+1'" is minute 46, like the second half's 46'), so replay runs on a VIRTUAL minute axis
// that inserts each period's stoppage time: 1H 0..45+s1, 2H 45..90+s2 shifted by s1, and so on.
// Nothing is interpolated: the axis only orders and spaces sourced events; the clock shown is
// the source minute of the event at or before the cursor.

export const PERIODS = ['1H', '2H', 'E1', 'E2', 'PS'];
export const PERIOD_START = { '1H': 0, '2H': 45, E1: 90, E2: 105, PS: 120 };
export const PERIOD_END = { '1H': 45, '2H': 90, E1: 105, E2: 120, PS: 120 };
export const PERIOD_LABEL = { '1H': 'First half', '2H': 'Second half', E1: 'Extra time, first half', E2: 'Extra time, second half', PS: 'Penalty shoot-out' };

// A period stated by the source wins; a missing one (e.g. substitutions) is inferred from the
// minute: a substitution in the 46th minute is a half-time change, i.e. the second half.
export function periodOf(item) {
  if (PERIODS.includes(item?.period)) return item.period;
  const m = Number(item?.minute);
  if (!Number.isFinite(m)) return null;
  if (m <= 45) return '1H';
  if (m <= 90) return '2H';
  if (m <= 105) return 'E1';
  return 'E2';
}

export function buildTimeline(sequence = []) {
  const items = (sequence || []).map((x, i) => ({ ...x, i, p: periodOf(x) }));
  const used = PERIODS.filter(p => p !== 'PS' && items.some(x => x.p === p));
  if (!used.includes('1H')) used.unshift('1H');
  if (!used.includes('2H')) used.splice(1, 0, '2H');
  used.sort((a, b) => PERIODS.indexOf(a) - PERIODS.indexOf(b));
  // Stoppage per period = latest sourced minute beyond the period's nominal end (0 when none).
  const segs = []; let shift = 0;
  for (const p of used) {
    const over = Math.max(0, ...items.filter(x => x.p === p && Number.isFinite(x.minute)).map(x => x.minute - PERIOD_END[p]));
    const start = PERIOD_START[p] + shift; const end = PERIOD_END[p] + shift + over;
    segs.push({ period: p, start, end, stoppage: over, shift });
    shift += over;
  }
  const seg = p => segs.find(s => s.period === p) || null;
  for (const x of items) {
    const s = seg(x.p);
    x.v = s && Number.isFinite(x.minute) ? x.minute + s.shift : null;
  }
  // Events with no usable minute keep source order but cannot be placed on the axis.
  const placed = items.filter(x => x.v !== null);
  const total = Math.max(segs[segs.length - 1].end, ...placed.map(x => x.v));
  return { items, segments: segs, total };
}

// The source-style clock for a virtual minute: "23'", "45+2'", "90+4'".
export function clockAt(v, tl) {
  if (!Number.isFinite(v) || v <= 0) return "0'";
  const s = tl.segments.find(x => v <= x.end) || tl.segments[tl.segments.length - 1];
  const minute = Math.round(v - s.shift);
  const end = PERIOD_END[s.period];
  return minute > end ? `${end}+${minute - end}'` : `${Math.max(1, minute)}'`;
}

// Score and visible events at the cursor (inclusive). Items without a minute count only at the end.
export function stateAt(v, tl) {
  const atEnd = v >= tl.total;
  const seen = tl.items.filter(x => (x.v !== null ? x.v <= v : atEnd));
  const last = [...seen].reverse().find(x => x.score);
  return { seen, score: last ? last.score : { home: 0, away: 0 }, latest: seen[seen.length - 1] || null };
}

// Percent position of a virtual minute on the bar.
export const pctOf = (v, tl) => Math.max(0, Math.min(100, (100 * v) / (tl.total || 90)));

// Key moments for jump chips: goals and own goals, red cards.
export const keyMoments = tl => tl.items.filter(x => x.v !== null && (x.type === 'goal' || x.type === 'own_goal' || x.type === 'card_red'));

// Live freshness wording from the cast envelope's `live` block (never implies real time).
export function liveStatus(live, now = Date.now()) {
  if (!live || live.mode !== 'live') return null;
  if (!live.provider_observed_at) return { tone: 'noclock', label: 'LIVE', note: 'Score from the result source; this source supplies no live clock.' };
  const age = Math.max(0, Math.round((now - Date.parse(live.provider_observed_at)) / 1000));
  const ago = age < 90 ? `${age}s ago` : `${Math.round(age / 60)} min ago`;
  if (live.stale) return { tone: 'delayed', label: 'LIVE · DELAYED', note: `No fresh source update for ${ago}. Showing the last sourced state.` };
  return { tone: 'live', label: 'LIVE', note: `Source update ${ago}. About one check a minute, plus the provider's own delay.` };
}
