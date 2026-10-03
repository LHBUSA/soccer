// DISCOVERY FLOOR for a history lane (scripts/history/run-queue.mjs --min-matches). Pure; never mutates the cursor.
// The floor is a discovery ACCOUNTING correction, never a way to make an expected count pass:
//   floor = events the lane discovered - listings PROVEN to be extra representations of a discovered fixture.
// A listing is a proven extra only when ALL hold:
//   - it shares (season type, home, away) with another event of the season (a repeated pairing)
//   - its status was READ and is postponed / cancelled, or scheduled with a kickoff already past (a stale listing that
//     was never played)
//   - the pairing has at least one FINISHED event whose score was read (the fixture it represents was played)
// Never removed: a unique event, an unread status, a finished event (two finished meetings of the same clubs are two
// matches), abandoned / live / unknown listings, or any listing of a pairing without a finished, score-read event.
// Incomplete discovery (an indexed event not fetched, a repeated pairing's status or finished score unread) gets NO
// adjustment: complete=false, floor = every discovered event.
const VOIDED = new Set(['postponed', 'cancelled']);

export function discoveryFloor(cursor, { now = Date.now() } = {}) {
  const fx = cursor?.fixtures || {};
  const ids = Object.keys(fx);
  const index = Array.isArray(cursor?.index) ? cursor.index : ids;
  const events = new Set([...index, ...ids]).size;
  const groups = new Map();
  for (const id of ids) { const f = fx[id]; const k = `${f.stype}|${f.h}|${f.a}`; groups.set(k, [...(groups.get(k) || []), id]); }
  const repeated = [...groups.values()].filter(g => g.length > 1);
  const missing = index.filter(id => !fx[id]).length;
  const unread = repeated.flat().filter(id => !fx[id].st).length;
  const unscored = repeated.flat().filter(id => fx[id].st === 'finished' && !fx[id].sc).length;
  if (missing || unread || unscored) return { complete: false, events, extras: 0, floor: events, incomplete: { missing_events: missing, repeat_status_unread: unread, finished_score_unread: unscored }, removed: [] };
  const removed = [];
  for (const g of repeated) {
    if (!g.some(id => fx[id].st === 'finished' && fx[id].sc)) continue;
    for (const id of g) {
      const f = fx[id];
      const stale = f.st === 'scheduled' && Date.parse(f.d) < now;
      if (VOIDED.has(f.st) || stale) removed.push({ id, status: f.st, kickoff: f.d, pairing: `${f.h}-${f.a}`, kind: stale ? 'stale_scheduled_listing' : `${f.st}_listing` });
    }
  }
  return { complete: true, events, extras: removed.length, floor: events - removed.length, removed };
}
