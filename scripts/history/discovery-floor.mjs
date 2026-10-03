// DISCOVERY FLOOR for a history lane (scripts/history/run-queue.mjs --min-matches). Pure; never mutates the cursor.
// The floor is a discovery ACCOUNTING correction, never a way to make an expected count pass:
//   floor = events the lane discovered - listings PROVEN to be extra representations of a discovered fixture.
// A listing is a proven extra only when ALL hold:
//   - it shares (season type, home, away) with another event of the season (a repeated pairing)
//   - its status was READ and is postponed / cancelled, or scheduled with a kickoff already past (a stale listing that
//     was never played)
//   - the pairing has at least one FINISHED event whose score was read (the fixture it represents was played)
// ABANDONED listings (owner decision 2026-10-03, "Structure proof + evidence"): an UNSCORED abandoned listing beside a
// finished, score-read meeting of the same pairing is a proven extra
//   - in a competition that registers NO repeat pairings (data/history-structure.json: a second meeting at the same
//     ground is structurally impossible), or
//   - with a reviewed, evidence-verified entry naming the finished event it represents (reviewedExtras: Map(event ->
//     represented_by), scripts/history/reviewed-extras.mjs) in a competition that allows repeats.
// Never removed: a unique event, an unread status, a finished event (two finished meetings of the same clubs are two
// matches), live / unknown listings, a scored abandoned listing, an abandoned listing in a repeats-allowed competition
// without its reviewed entry, or any listing of a pairing without a finished, score-read event.
// Incomplete discovery (an indexed event not fetched, a repeated pairing's status or finished score unread) gets NO
// adjustment: complete=false, floor = every discovered event.
const VOIDED = new Set(['postponed', 'cancelled']);

export function discoveryFloor(cursor, { now = Date.now(), repeatPairings = true, reviewedExtras = new Map() } = {}) {
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
  const played = id => fx[id]?.st === 'finished' && fx[id]?.sc;
  for (const g of repeated) {
    if (!g.some(played)) continue;
    for (const id of g) {
      const f = fx[id]; const base = { id, status: f.st, kickoff: f.d, pairing: `${f.h}-${f.a}` };
      const stale = f.st === 'scheduled' && Date.parse(f.d) < now;
      if (VOIDED.has(f.st) || stale) { removed.push({ ...base, kind: stale ? 'stale_scheduled_listing' : `${f.st}_listing` }); continue; }
      if (f.st !== 'abandoned' || f.sc) continue;
      const rep = reviewedExtras.get(String(id));
      if (repeatPairings === false) removed.push({ ...base, kind: 'abandoned_listing_structure_proven' });
      else if (rep && g.includes(rep) && played(rep)) removed.push({ ...base, kind: 'abandoned_listing_reviewed', represented_by: rep });
    }
  }
  return { complete: true, events, extras: removed.length, floor: events - removed.length, removed };
}
