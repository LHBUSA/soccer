// Newsroom publication health (pure). Separates a DEAD pipeline from a quiet one:
//   cron_not_firing                   no tick within 2 h (failure)
//   run_failing                       the newest tick failed, or no successful run within 2 h (failure)
//   disabled                          NEWS_ENABLED is off
//   publishing                        newest published story <= 4 h old
//   healthy_material_held_by_gates    pipeline healthy, newest story > 4 h old, material exists but the gates held it
//   healthy_no_publishable_material   pipeline healthy, newest story > 4 h old, nothing new and nothing held
// A quiet newsroom is correct when there is no material; it is never "fixed" by publishing filler.
import { activityAt, parseState } from './runner-state.js';

export const TICK_STALE_MS = 2 * 3600e3;
export const PUBLICATION_QUIET_MS = 4 * 3600e3;

export function publicationDiagnostic({ tick, last, newestPublishedAt, now = Date.now() }) {
  const age = at => (at ? now - Date.parse(at) : null);
  const comps = Object.entries(last?.competitions || {});
  const sum = k => comps.reduce((a, [, c]) => a + (c[k] || 0), 0);
  const heldReasons = {};
  for (const [, c] of comps) for (const src of [c.holds || {}, c.existing?.held_reasons || {}]) for (const [r, n] of Object.entries(src)) heldReasons[r] = (heldReasons[r] || 0) + n;
  const per = Object.fromEntries(comps.map(([slug, c]) => [slug, { candidates: c.candidates || 0, new: c.new || 0, published: c.published || 0, held_this_run: c.held || 0, existing_published: c.existing?.published ?? null, existing_held: c.existing?.held ?? null, skipped: c.skipped || null, last_match_update: c.last_match_update || null }]));
  const out = {
    last_tick_at: tick?.at || null, last_tick_outcome: tick?.outcome || null, last_tick_age_min: tick ? Math.round(age(tick.at) / 6e4) : null,
    last_successful_run_at: last?.at || null, last_run_age_min: last ? Math.round(age(last.at) / 6e4) : null,
    newest_published_at: newestPublishedAt || null, newest_published_age_min: newestPublishedAt ? Math.round(age(newestPublishedAt) / 6e4) : null,
    candidates_detected: sum('candidates'), new_this_run: sum('new'), published_this_run: sum('published'),
    held_existing: comps.reduce((a, [, c]) => a + (c.existing?.held || 0), 0) + sum('held'), held_reasons: heldReasons, competitions: per,
  };
  if (tick?.news_enabled === false || tick?.outcome === 'disabled') return { ...out, ok: true, state: 'disabled', message: 'newsroom disabled (NEWS_ENABLED off)' };
  if (!tick || age(tick.at) > TICK_STALE_MS) return { ...out, ok: false, state: 'cron_not_firing', message: 'no newsroom cron tick in the last 2 hours' };
  if (tick.outcome === 'failed' || !last || age(last.at) > TICK_STALE_MS) return { ...out, ok: false, state: 'run_failing', message: 'the cron fires but the run is failing' };
  if (newestPublishedAt && age(newestPublishedAt) <= PUBLICATION_QUIET_MS) return { ...out, ok: true, state: 'publishing', message: 'pipeline healthy / publishing' };
  if (out.held_existing > 0) return { ...out, ok: true, state: 'healthy_material_held_by_gates', message: 'pipeline healthy / material detected but held by publication gates' };
  return { ...out, ok: true, state: 'healthy_no_publishable_material', message: 'pipeline healthy / no publishable material' };
}

// ---- Per-competition diagnostic (phase 2, docs/COMPETITION_DESKS.md section 7). Additive: the aggregate above (and the
// /health status code) is unchanged. Each competition is judged on ITS OWN state (news:comp:<slug>:state):
//   disabled                         NEWS_ENABLED off
//   cron_not_firing                  no newsroom tick in 2 h (global; true for every competition)
//   state_missing / state_malformed / state_unreadable  no readable state for an enabled competition (failure)
//   runner_stale                     the competition has not run within its window: 2 h while it has activity (fixtures
//                                    live, due, or finished < 36 h, re-derived NOW from the stored fixture timeline),
//                                    6 h while quiet (failure)
//   run_failing                      its runner threw on its latest run (failure)
//   blocked_by_runner_failure        LEGACY (phase 2 in-process ticks only): the tick failed in ANOTHER competition before
//                                    this one ran. Phase 3 isolated ticks never emit it: every runner records its own
//                                    outcome and the tick does not fail on a runner failure.
//   orchestrator_failed              the latest tick itself failed (not a runner) before this competition's state was
//                                    refreshed (failure)
//   config_missing / no_season       skipped fail-closed (failure: an enabled competition that cannot run)
//   publishing                       its newest published story is <= 4 h old
//   healthy_material_held_by_gates   ran; material detected but held (this run or existing)
//   healthy_no_publishable_material  ran; nothing to publish (activity says whether it is simply quiet)
// A quiet competition is never stale because it had no candidate; only a missing RUN makes it stale.
export const QUIET_STALE_MS = 6 * 3600e3;

export function competitionDiagnostic({ slug, raw, readError = null, tick, newestPublishedAt = null, now = Date.now(), failedThisTick = null, failedDispatch = null }) {
  const age = at => now - Date.parse(at);
  const res = (ok, state, message, extra = {}) => ({ slug, ok, state, message, ...extra });
  if (tick?.news_enabled === false || tick?.outcome === 'disabled') return res(true, 'disabled', 'newsroom disabled (NEWS_ENABLED off)');
  if (!tick || age(tick.at) > TICK_STALE_MS) return res(false, 'cron_not_firing', 'no newsroom cron tick in the last 2 hours');
  if (readError) return res(false, 'state_unreadable', `runner state could not be read: ${readError}`);
  const p = parseState(raw);
  if (p.missing) return res(false, 'state_missing', 'no runner state recorded for this competition');
  if (p.malformed) return res(false, 'state_malformed', `runner state unreadable: ${p.malformed}`);
  const s = p.state;
  const activityNow = activityAt(s.fixtures ? { ...s.fixtures, live_kickoffs: s.fixtures.live_kickoffs || [] } : null, now);
  const base = { dispatch: s.dispatch || 'in_process', activity: s.activity, activity_now: activityNow, last_run_at: s.last_run_at, last_run_age_min: Math.round(age(s.last_run_at) / 6e4), last_run_outcome: s.last_run_outcome, newest_published_at: newestPublishedAt };
  const limit = activityNow === 'quiet' ? QUIET_STALE_MS : TICK_STALE_MS;
  if (age(s.last_run_at) > limit) return res(false, 'runner_stale', `no run for ${Math.round(age(s.last_run_at) / 6e4)} min while ${activityNow} (limit ${limit / 6e4} min)`, base);
  if (s.last_run_outcome === 'failed') return res(false, 'run_failing', `runner failed: ${s.error || 'unknown error'}`, base);
  if (tick.outcome === 'failed' && Date.parse(s.last_run_at) < Date.parse(tick.at)) {
    // in-process (phase 2) tick aborted by another runner = blocked; anything else = the orchestrator itself failed
    if (failedThisTick && failedDispatch !== 'isolated') return res(false, 'blocked_by_runner_failure', `the ${tick.at} tick failed in ${failedThisTick} before this competition ran`, { ...base, blocked_by: failedThisTick });
    return res(false, 'orchestrator_failed', `the ${tick.at} newsroom tick failed before this competition's state was refreshed`, base);
  }
  if (s.last_run_outcome === 'skipped_config') return res(false, 'config_missing', `skipped fail-closed: ${s.skipped}`, base);
  if (s.last_run_outcome === 'no_season') return res(false, 'no_season', 'no published season to run', base);
  if (newestPublishedAt && age(newestPublishedAt) <= PUBLICATION_QUIET_MS) return res(true, 'publishing', 'publishing', base);
  if ((s.held || 0) + (s.existing?.held || 0) > 0) return res(true, 'healthy_material_held_by_gates', 'healthy / material detected but held by publication gates', base);
  return res(true, 'healthy_no_publishable_material', activityNow === 'quiet' ? 'healthy / quiet (no fixtures due, none live, none recent)' : 'healthy / no publishable material', base);
}
