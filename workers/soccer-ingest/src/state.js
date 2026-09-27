// Per-lane operational state in KV (binding SOCCER_STATE), key `lane:<name>`.
// Required fields (owner contract 2026-09-27): last successful capture, last
// changed value, current season cursor, source health, parse version, records
// observed, records changed.

export const HEALTH = Object.freeze({ OK: 'ok', DEGRADED: 'degraded', BLOCKED: 'blocked', UNKNOWN: 'unknown' });

export function emptyLaneState(lane) {
  return {
    lane, health: HEALTH.UNKNOWN, parser_version: null, cursor: {},
    last_attempt_at: null, last_success_at: null, last_capture_id: null, last_change_at: null, last_changed: null,
    records_observed: 0, records_changed: 0, runs: 0, consecutive_failures: 0, backoff_until: null, last_error: null,
  };
}

export async function readLane(kv, lane) {
  if (!kv) return emptyLaneState(lane);
  const raw = await kv.get(`lane:${lane}`, 'json');
  return raw ? { ...emptyLaneState(lane), ...raw } : emptyLaneState(lane);
}

export async function writeLane(kv, state) {
  if (kv) await kv.put(`lane:${state.lane}`, JSON.stringify(state));
}

// Backoff: 1st failure 5 min, doubling, capped at 6 h. A block (403/challenge)
// goes straight to 6 h and health=blocked: we never hammer an access control.
export function failureState(state, err, now = Date.now()) {
  const n = state.consecutive_failures + 1;
  const blocked = err?.name === 'SourceBlockedError';
  const waitMs = blocked ? 6 * 3600e3 : Math.min(6 * 3600e3, 5 * 60e3 * 2 ** (n - 1));
  return { ...state, consecutive_failures: n, health: blocked ? HEALTH.BLOCKED : HEALTH.DEGRADED, backoff_until: new Date(now + waitMs).toISOString(), last_error: String(err?.message || err).slice(0, 500) };
}

export function successState(state, { now = Date.now(), observed = 0, changed = 0, captureId = null, parserVersion = null, cursor = null, changedValue = null } = {}) {
  const t = new Date(now).toISOString();
  return {
    ...state, health: HEALTH.OK, consecutive_failures: 0, backoff_until: null, last_error: null, runs: state.runs + 1,
    last_success_at: t, last_capture_id: captureId || state.last_capture_id, parser_version: parserVersion || state.parser_version,
    cursor: cursor || state.cursor, records_observed: observed, records_changed: changed,
    ...(changed > 0 ? { last_change_at: t, last_changed: changedValue } : {}),
  };
}

export function inBackoff(state, now = Date.now()) {
  return state.backoff_until && Date.parse(state.backoff_until) > now;
}
