// Phase 4 (docs/COMPETITION_DESKS.md section 8): ACTIVITY-AWARE SCHEDULING. Changes HOW OFTEN a competition's runner
// looks, never WHAT its detectors may publish (same windows, materiality, story keys, dedupe, gates).
// Activity comes from ONE canonical read per tick (soccer_public_matches of the enabled competitions, kick-off in
// [now - 36 h, now + 26 h]) plus the competition's own phase 2 state (pending recaps, deferred stories, failures).
// Never from article recency, never from a provider.
// Cadence: live / final_ready / matchday every tick (30 min), pre_match hourly, post_match every 2 h, quiet every 6 h.
// A recap is never delayed: any match that kicked off in the last 8 h, any recap awaiting enrichment or too soon, any
// story deferred by the runner time budget and any failed last run make the competition due on EVERY tick.
// FAIL OPEN to today's behaviour: if the activity read fails, every competition runs (scheduling can only ever skip a
// runner when it is certain the runner has nothing time-critical to do).
import { chunkArr } from '../../soccer-ingest/src/store.js';
import { parseState, pendingWork } from './runner-state.js';
export { pendingWork };

export const SCHEDULE_VERSION = 'soccer-news-schedule/1.0.0';
const M = 60e3; const H = 3600e3;
export const CADENCE_MS = { live: 30 * M, final_ready: 30 * M, matchday: 30 * M, pre_match: 60 * M, post_match: 120 * M, quiet: 360 * M };
// cron ticks fire at :07 / :37 but a run's recorded instant may land a little after the minute; a runner whose
// cadence is up within this tolerance runs on this tick rather than waiting a whole extra tick.
export const TICK_TOLERANCE_MS = 5 * M;
export const WINDOW = { pastMs: 36 * H, aheadMs: 26 * H, recentKickoffMs: 8 * H, liveMaxMs: 6 * H, matchdayMs: 12 * H };

// Activity from canonical rows of ONE competition (kick-off inside the read window).
export function scheduleActivity(matches, now) {
  const t = m => Date.parse(m.kickoff_at);
  const rows = (matches || []).filter(m => Number.isFinite(t(m)));
  if (rows.some(m => m.status === 'live' && t(m) <= now + 15 * M && now - t(m) <= WINDOW.liveMaxMs)) return 'live';
  // a match that kicked off in the last 8 h (finished, or still in progress per the canonical status): its recap may be
  // ready now or within the enrichment window -> run every tick
  if (rows.some(m => t(m) <= now && now - t(m) <= WINDOW.recentKickoffMs && m.status !== 'postponed' && m.status !== 'cancelled')) return 'final_ready';
  if (rows.some(m => m.status === 'scheduled' && t(m) > now && t(m) - now <= WINDOW.matchdayMs)) return 'matchday';
  if (rows.some(m => m.status === 'scheduled' && t(m) > now && t(m) - now <= WINDOW.aheadMs)) return 'pre_match';
  if (rows.some(m => m.status === 'finished' && t(m) <= now && now - t(m) <= WINDOW.pastMs)) return 'post_match';
  return 'quiet';
}

// One competition's decision at `now`.
export function decide({ slug, matches, raw, now }) {
  const activity = scheduleActivity(matches, now);
  const cadence = CADENCE_MS[activity];
  const p = parseState(raw ?? null);
  const base = { slug, activity, cadence_min: cadence / M };
  if (p.missing) return { ...base, due: true, reason: 'no_state' };
  if (p.malformed) return { ...base, due: true, reason: `state_malformed:${p.malformed}` };
  const s = p.state;
  const last = Date.parse(s.last_run_at);
  const next = new Date(last + cadence).toISOString();
  const pending = pendingWork(s);
  if (pending) return { ...base, due: true, reason: pending, last_run_at: s.last_run_at, next_due_at: next };
  if (cadence <= CADENCE_MS.matchday) return { ...base, due: true, reason: `every_tick:${activity}`, last_run_at: s.last_run_at, next_due_at: next };
  if (now - last >= cadence - TICK_TOLERANCE_MS) return { ...base, due: true, reason: `cadence_elapsed:${activity}`, last_run_at: s.last_run_at, next_due_at: next };
  return { ...base, due: false, reason: `not_due:${activity}`, last_run_at: s.last_run_at, next_due_at: next };
}

// The canonical activity read (2 reads per tick: competition ids, then the matches inside the window).
export async function loadActivityMatches(store, slugs, now) {
  const comps = await store.select('soccer_competitions', { columns: ['id', 'slug'], in: { slug: slugs } });
  const bySlug = new Map(slugs.map(s => [s, []]));
  const idSlug = new Map(comps.map(c => [c.id, c.slug]));
  const ids = [...idSlug.keys()];
  for (const part of chunkArr(ids, 100)) {
    const rows = await store.select('soccer_public_matches', { columns: ['id', 'competition_id', 'kickoff_at', 'status'], in: { competition_id: part }, gte: { kickoff_at: new Date(now - WINDOW.pastMs).toISOString() }, lte: { kickoff_at: new Date(now + WINDOW.aheadMs).toISOString() }, order: 'id.asc' });
    for (const r of rows) bySlug.get(idSlug.get(r.competition_id))?.push({ kickoff_at: new Date(r.kickoff_at).toISOString(), status: r.status });
  }
  return bySlug;
}

// The tick plan: { version, mode, competitions: { slug: decision } }. kv = SOCCER_STATE (phase 2 states).
export async function planTick({ kv, store, now, competitions }) {
  let matches = null; let readError = null;
  try {
    if (!store) throw new Error('store not configured');
    matches = await loadActivityMatches(store, competitions, now);
  } catch (e) { readError = String(e?.message || e).slice(0, 160); }
  const out = { version: SCHEDULE_VERSION, at: new Date(now).toISOString(), ...(readError ? { mode: 'fail_open_run_all', read_error: readError } : { mode: 'activity' }), competitions: {} };
  for (const slug of competitions) {
    let raw = null; let kvError = null;
    try { raw = kv ? await kv.get(`news:comp:${slug}:state`) : null; } catch (e) { kvError = String(e?.message || e).slice(0, 120); }
    if (readError) { out.competitions[slug] = { slug, due: true, reason: 'activity_read_failed_run_all' }; continue; }
    if (kvError) { out.competitions[slug] = { slug, due: true, reason: `state_read_failed_run:${kvError}`, activity: scheduleActivity(matches.get(slug), now) }; continue; }
    out.competitions[slug] = decide({ slug, matches: matches.get(slug), raw, now });
  }
  return out;
}
