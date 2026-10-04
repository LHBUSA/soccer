// Newsroom publication health (pure). Separates a DEAD pipeline from a quiet one:
//   cron_not_firing                   no tick within 2 h (failure)
//   run_failing                       the newest tick failed, or no successful run within 2 h (failure)
//   disabled                          NEWS_ENABLED is off
//   publishing                        newest published story <= 4 h old
//   healthy_material_held_by_gates    pipeline healthy, newest story > 4 h old, material exists but the gates held it
//   healthy_no_publishable_material   pipeline healthy, newest story > 4 h old, nothing new and nothing held
// A quiet newsroom is correct when there is no material; it is never "fixed" by publishing filler.
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
