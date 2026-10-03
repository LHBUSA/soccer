// Reviewed extra listings (data/history-review/extra-listings.json): per-event evidence that a provider listing in a
// competition allowing repeat pairings is an extra representation of a finished event. Verified FAIL-CLOSED: every
// evidence file must hash to its pinned sha256 and every quote must appear verbatim, or nothing is accepted.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function verifyExtraEntry(entry, read = f => readFileSync(f, 'utf8')) {
  const problems = [];
  if (!entry?.event_id || !entry?.represented_by_event_id || !entry?.evidence?.length) problems.push('incomplete entry');
  for (const e of entry?.evidence || []) {
    let text = null; try { text = read(e.file); } catch { problems.push(`missing evidence ${e.file}`); continue; }
    if (createHash('sha256').update(text).digest('hex') !== e.sha256) problems.push(`evidence changed: ${e.file}`);
    const norm = text.replace(/\r\n/g, '\n');
    for (const q of e.quotes || []) if (!norm.includes(q)) problems.push(`quote not found in ${e.file}: ${q.slice(0, 50)}`);
  }
  if (problems.length) throw new Error(`reviewed extra listing ${entry?.competition} ${entry?.season} ${entry?.event_id} failed: ${problems.join('; ')}`);
  return true;
}

// -> Map(event_id -> represented_by_event_id) for one competition-season, every entry verified (throws otherwise)
export function reviewedExtras(competition, season, { file = 'data/history-review/extra-listings.json', read } = {}) {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const out = new Map();
  for (const e of doc.entries.filter(x => x.competition === competition && String(x.season) === String(season))) { verifyExtraEntry(e, read); out.set(String(e.event_id), String(e.represented_by_event_id)); }
  return out;
}
