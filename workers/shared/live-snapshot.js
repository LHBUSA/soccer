// Materialized public /live snapshot policy shared by soccer-ingest and soccer-api.
// The ingest worker marks the snapshot dirty when canonical/live source state changes.
// soccer-api owns snapshot construction, stores the complete public envelope in SOCCER_STATE,
// and public /v1/live reads that snapshot instead of rebuilding ~11 PostgREST reads per cache miss.

export const PUBLIC_LIVE_COMPETITIONS = Object.freeze([
  'mls',
  'premier-league',
  'uefa-champions-league',
  'bundesliga',
  'uefa-nations-league',
]);

// Only lanes capable of changing the public /live envelope may invalidate it.
// Standings and the private model-shadow lane are deliberately absent.
export const PUBLIC_LIVE_DIRTY_LANES = Object.freeze([
  'espn_live',
  'openligadb_bl1_current',
  ...PUBLIC_LIVE_COMPETITIONS.map(slug => `espn_${slug.replace(/-/g, '_')}`),
]);

export function publicLiveDirtyChanges(results = []) {
  const lanes = new Set(PUBLIC_LIVE_DIRTY_LANES);
  return results.filter(x => Number(x?.changed) > 0 && lanes.has(x?.lane));
}

export const LIVE_SNAPSHOT_KEY = 'public:live:v1';
export const LIVE_SNAPSHOT_DIRTY_KEY = 'public:live:dirty:v1';
export const LIVE_SNAPSHOT_STATUS_KEY = 'public:live:status:v1';
export const LIVE_SNAPSHOT_VERSION = 'soccer-live-snapshot/1.1.0';

export const LIVE_SNAPSHOT_IDLE_REFRESH_MS = 15 * 60e3;
export const LIVE_SNAPSHOT_ACTIVE_REFRESH_MS = 55e3;
export const LIVE_SNAPSHOT_KICKOFF_NEAR_MS = 15 * 60e3;
export const LIVE_SNAPSHOT_IDLE_MAX_SERVE_MS = 20 * 60e3;
export const LIVE_SNAPSHOT_ACTIVE_MAX_SERVE_MS = 3 * 60e3;
export const LIVE_SNAPSHOT_TTL_S = 7 * 86400;

const ms = v => {
  const t = Date.parse(v || '');
  return Number.isFinite(t) ? t : null;
};

export function snapshotAgeMs(snapshot, now = Date.now()) {
  const t = ms(snapshot?.built_at);
  return t === null ? Infinity : Math.max(0, now - t);
}

export const snapshotHasLive = snapshot => !!snapshot?.envelope?.data?.live?.length;

export function snapshotKickoffNear(snapshot, now = Date.now()) {
  const upcoming = snapshot?.envelope?.data?.upcoming || [];
  return upcoming.some(m => {
    const t = ms(m?.kickoff_at);
    return t !== null && t >= now - LIVE_SNAPSHOT_KICKOFF_NEAR_MS && t <= now + LIVE_SNAPSHOT_KICKOFF_NEAR_MS;
  });
}

export function dirtyNewerThanSnapshot(snapshot, dirty) {
  const d = ms(dirty?.at);
  const b = ms(snapshot?.built_at);
  return d !== null && (b === null || d > b);
}

// Returns a reason string when a cron refresh should rebuild the snapshot, else null.
// Active/live and near-kickoff snapshots are rebuilt each minute; idle snapshots are
// event-driven by soccer-ingest and receive a 15-minute safety refresh for time-window drift.
export function snapshotRefreshReason(snapshot, dirty, now = Date.now()) {
  if (!snapshot || snapshot.snapshot_version !== LIVE_SNAPSHOT_VERSION || !snapshot?.envelope?.data) return 'missing_or_version';
  if (dirtyNewerThanSnapshot(snapshot, dirty)) return 'ingest_dirty';
  const age = snapshotAgeMs(snapshot, now);
  if (snapshotHasLive(snapshot) && age >= LIVE_SNAPSHOT_ACTIVE_REFRESH_MS) return 'live_active';
  if (snapshotKickoffNear(snapshot, now) && age >= LIVE_SNAPSHOT_ACTIVE_REFRESH_MS) return 'kickoff_near';
  if (age >= LIVE_SNAPSHOT_IDLE_REFRESH_MS) return 'idle_safety';
  return null;
}

// The API falls back to the canonical database builder if the materializer has stopped.
// A live snapshot gets a much tighter serve window than an idle one.
export function snapshotServeable(snapshot, now = Date.now()) {
  if (!snapshot || snapshot.snapshot_version !== LIVE_SNAPSHOT_VERSION || !snapshot?.envelope?.data) return false;
  const max = snapshotHasLive(snapshot) || snapshotKickoffNear(snapshot, now)
    ? LIVE_SNAPSHOT_ACTIVE_MAX_SERVE_MS
    : LIVE_SNAPSHOT_IDLE_MAX_SERVE_MS;
  return snapshotAgeMs(snapshot, now) <= max;
}

// Freshness ages are time-relative. Recompute them when serving a stored envelope so a
// stalled materializer can never make old secondary enrichment look fresh.
export function refreshLiveEnvelope(envelope, now = Date.now()) {
  if (!envelope?.data) return envelope;
  const out = JSON.parse(JSON.stringify(envelope));
  for (const m of out.data.live || []) {
    const e = m?.live?.enrichment;
    if (!e?.freshness) continue;
    const fetched = ms(e.fetched_at);
    const age = fetched === null ? null : Math.max(0, Math.round((now - fetched) / 1000));
    const staleAfter = Number(e.freshness.stale_after_seconds);
    e.freshness.age_seconds = age;
    e.freshness.stale = age === null || !Number.isFinite(staleAfter) || age > staleAfter;
  }
  return out;
}

export async function readLiveSnapshot(kv) {
  if (!kv) return null;
  return kv.get(LIVE_SNAPSHOT_KEY, 'json').catch(() => null);
}

export async function readLiveSnapshotInputs(kv) {
  if (!kv) return { snapshot: null, dirty: null };
  const [snapshot, dirty] = await Promise.all([
    kv.get(LIVE_SNAPSHOT_KEY, 'json').catch(() => null),
    kv.get(LIVE_SNAPSHOT_DIRTY_KEY, 'json').catch(() => null),
  ]);
  return { snapshot, dirty };
}

export async function writeLiveSnapshot(kv, envelope, { now = Date.now(), reason = 'unknown', storeRequests = null } = {}) {
  if (!kv) throw new Error('SOCCER_STATE missing');
  const builtAt = new Date(now).toISOString();
  const snapshot = {
    snapshot_version: LIVE_SNAPSHOT_VERSION,
    built_at: builtAt,
    reason,
    envelope,
  };
  const status = {
    snapshot_version: LIVE_SNAPSHOT_VERSION,
    built_at: builtAt,
    reason,
    store_requests: Number.isFinite(storeRequests) ? storeRequests : null,
    live: envelope?.data?.live?.length || 0,
    recent: envelope?.data?.recent?.length || 0,
    upcoming: envelope?.data?.upcoming?.length || 0,
  };
  await Promise.all([
    kv.put(LIVE_SNAPSHOT_KEY, JSON.stringify(snapshot), { expirationTtl: LIVE_SNAPSHOT_TTL_S }),
    kv.put(LIVE_SNAPSHOT_STATUS_KEY, JSON.stringify(status), { expirationTtl: LIVE_SNAPSHOT_TTL_S }),
  ]);
  return status;
}
