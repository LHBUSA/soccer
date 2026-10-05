// Per-competition newsroom state (docs/COMPETITION_DESKS.md section 7, phase 2): OBSERVATIONAL metadata written after
// each competition runner, KV key `news:comp:<slug>:state`. Nothing here decides what a runner detects, builds, routes,
// gates or publishes; the runner is unchanged (tests/news-runner-parity.test.js).
// Activity comes ONLY from canonical data the runner already loaded (the season's soccer_public_matches rows and the
// recap readiness its detector computed from the enrichment ledger): zero extra reads, no provider calls, never article
// recency.
import { ENGINE_VERSION } from './engine.js';
import { GATE_V2 } from './gates2.js';
import { DESK_VERSION, QUALITY_VERSION } from './desk.js';
import { PACKET_V3 } from './depth.js';
import { ROUTER_VERSION } from './ai-router.js';
import { profileFor } from './profiles.js';
import registryData from '../../../data/registry/competitions.json' with { type: 'json' };

export const STATE_VERSION = 'soccer-news-comp-state/1.0.0';
export const REGISTRY_VERSION = registryData.registry_version || null;
export const stateKey = slug => `news:comp:${slug}:state`;

const H = 3600e3;
// Activity windows (section 8). They describe the competition; in phase 2 every enabled competition still runs every
// tick (activity-aware cadence is phase 4).
export const ACTIVITY_WINDOWS = { matchdayMs: 12 * H, preMatchMs: 26 * H, postMatchMs: 36 * H, liveMaxMs: 6 * H, horizonMs: 7 * 24 * H, maxUpcoming: 12 };
export const ACTIVITY_ORDER = ['live', 'final_ready', 'matchday', 'pre_match', 'post_match', 'quiet'];

// Facts about a loaded season at `now` (pure; S = engine.loadSeason). Kept compact so /health can re-derive the
// activity at read time from the stored timeline (a stale state must not keep claiming "quiet" past a kick-off).
export function seasonFacts(S, now) {
  if (!S) return null;
  const t = m => Date.parse(m.kickoff_at);
  // A 'live' row whose kick-off is > 6 h old is a stuck status, reported separately, never treated as live.
  const liveRows = S.matches.filter(m => m.status === 'live');
  const live = liveRows.filter(m => t(m) <= now + 15 * 6e4 && now - t(m) <= ACTIVITY_WINDOWS.liveMaxMs);
  const upcoming = S.matches.filter(m => m.status === 'scheduled' && t(m) > now).sort((a, b) => t(a) - t(b));
  const lastFinished = S.finished.length ? S.finished.reduce((x, m) => (t(m) > t(x) ? m : x)) : null;
  return {
    competition_id: S.comp.id, season: S.season.label,
    live_matches: live.length, live_status_stuck: liveRows.length - live.length,
    live_kickoffs: live.map(m => m.kickoff_at).sort(),
    upcoming_kickoffs: upcoming.filter(m => t(m) - now <= ACTIVITY_WINDOWS.horizonMs).slice(0, ACTIVITY_WINDOWS.maxUpcoming).map(m => m.kickoff_at),
    next_fixture_at: upcoming[0]?.kickoff_at || null,
    fixtures_next_24h: upcoming.filter(m => t(m) - now <= 24 * H).length,
    last_finished_at: lastFinished?.kickoff_at || null,
    last_match_update: S.matches.reduce((x, m) => (m.updated_at && (!x || String(m.updated_at) > x) ? String(m.updated_at) : x), null),
  };
}

// Activity at `now` from the stored timeline + the runner's own recap readiness (highest wins, section 8).
// final_ready = this run found a NEW recap whose match is ready (enrichment final or the 2 h fallback): the same-tick
// readiness the detector already applies. Recaps still awaiting enrichment keep the competition in post_match (or
// higher) with the count exposed, never final_ready.
export function activityAt(facts, now, { newRecaps = 0 } = {}) {
  if (!facts) return 'quiet';
  const t = iso => Date.parse(iso);
  if ((facts.live_kickoffs || []).some(k => now >= t(k) - 15 * 6e4 && now - t(k) <= ACTIVITY_WINDOWS.liveMaxMs)) return 'live';
  if (newRecaps > 0) return 'final_ready';
  const ahead = (facts.upcoming_kickoffs || []).map(t).filter(k => k > now);
  if (ahead.some(k => k - now <= ACTIVITY_WINDOWS.matchdayMs)) return 'matchday';
  if (ahead.some(k => k - now <= ACTIVITY_WINDOWS.preMatchMs)) return 'pre_match';
  // a fixture in the stored timeline that has kicked off since the state was written = a match day still in progress
  if ((facts.upcoming_kickoffs || []).some(k => t(k) <= now && now - t(k) <= ACTIVITY_WINDOWS.liveMaxMs)) return 'matchday';
  if (facts.last_finished_at && now - t(facts.last_finished_at) <= ACTIVITY_WINDOWS.postMatchMs) return 'post_match';
  return 'quiet';
}

// The next newsroom tick after `now` for a "M,M * * * *" cron (phase 2: every enabled competition runs every tick).
export function nextTickAt(cron, now) {
  const mins = String(cron).split(' ')[0].split(',').map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const d = new Date(now); d.setUTCSeconds(0, 0);
  for (let i = 0; i < 2 * 60; i++) { d.setUTCMinutes(d.getUTCMinutes() + 1); if (mins.includes(d.getUTCMinutes())) return d.toISOString(); }
  return null;
}

const routedCalls = routing => Object.entries(routing?.lanes || {}).filter(([lane]) => lane !== 'DETERMINISTIC').reduce((a, [, n]) => a + n, 0);

// One competition's state after its runner. result = runCompetition's return; error = the runner's exception (the tick
// still fails exactly as before: phase 2 adds no isolation).
export function competitionState({ slug, result = null, error = null, facts = null, now, elapsedMs = null, cron, cfg = {}, stories = [], mode = 'live' }) {
  const out = result?.out || null;
  const outcome = error ? 'failed' : !out ? 'not_applicable' : out.skipped?.startsWith('config_missing') ? 'skipped_config' : out.skipped === 'no season' ? 'no_season' : 'ran';
  const newRecaps = (out?.stories || []).filter(s => s.story_class === 'match_recap').length;
  const profile = profileFor(slug, new Date(now).toISOString(), cfg);
  const d = out?.diagnostics || {};
  return {
    slug, state_version: STATE_VERSION, mode,
    activity: activityAt(facts, now, { newRecaps }),
    last_run_at: new Date(now).toISOString(), last_run_outcome: outcome, elapsed_ms: elapsedMs,
    ...(error ? { error: String(error?.message || error).slice(0, 200) } : {}),
    ...(out?.skipped ? { skipped: out.skipped } : {}),
    next_due_at: nextTickAt(cron, now), cadence: 'every_tick',
    season: facts?.season ?? out?.season ?? null, competition_id: facts?.competition_id ?? null,
    candidates: out ? out.candidates : null, new: out ? out.new : null, duplicates: out ? out.duplicates : null,
    published: out ? out.published : null, held: out ? out.held : null,
    hold_reasons: out?.holds || {}, by_class: out?.by_class || {},
    existing: out?.existing ? { published: out.existing.published, held: out.existing.held, other: out.existing.other, held_reasons: out.existing.held_reasons } : null,
    new_recaps: newRecaps,
    desk_calls: routedCalls(result?.routing),
    fixtures: facts ? {
      live_matches: facts.live_matches, live_status_stuck: facts.live_status_stuck, live_kickoffs: facts.live_kickoffs,
      fixtures_next_24h: facts.fixtures_next_24h, next_fixture_at: facts.next_fixture_at, upcoming_kickoffs: facts.upcoming_kickoffs,
      last_finished_at: facts.last_finished_at, last_match_update: facts.last_match_update,
    } : null,
    recaps: out?.diagnostics ? { finished_in_window: d.finished_in_window ?? null, ready: d.eligible ?? null, awaiting_enrichment: d.awaiting_enrichment ?? null, too_soon: d.too_soon ?? null } : null,
    enabled_story_classes: stories,
    profile: profile?.key || null,
    versions: { engine: ENGINE_VERSION, gates: GATE_V2, desk: DESK_VERSION, quality: QUALITY_VERSION, packet: PACKET_V3, router: ROUTER_VERSION, state: STATE_VERSION },
    registry_version: REGISTRY_VERSION,
  };
}

// Parse a stored state; anything that is not a state of this contract is reported as malformed, never trusted.
export function parseState(raw) {
  if (raw == null) return { missing: true };
  let s = raw;
  if (typeof raw === 'string') { try { s = JSON.parse(raw); } catch { return { malformed: 'not json' }; } }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { malformed: 'not an object' };
  if (typeof s.state_version !== 'string' || !s.state_version.startsWith('soccer-news-comp-state/')) return { malformed: 'unknown state_version' };
  if (!Number.isFinite(Date.parse(s.last_run_at))) return { malformed: 'no last_run_at' };
  if (!ACTIVITY_ORDER.includes(s.activity)) return { malformed: 'unknown activity' };
  return { state: s };
}
