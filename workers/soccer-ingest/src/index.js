// soccer-ingest Worker. Cron every 5 minutes; each lane decides its own cadence.
//
//   GET  /health                          lane states (no secrets, no raw data)
//   POST /v1/runs?lane=<name>[&force=1]   admin: run one lane now (Bearer INGEST_ADMIN_TOKEN)
//
// Bindings: SOCCER_SOURCE (R2 soccer-source), SOCCER_STATE (KV).
// Secrets:  SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, INGEST_ADMIN_TOKEN.

import registry from '../../../data/registry/competitions.json' with { type: 'json' };
import reviewed from '../../../data/registry/team-crosswalk-reviewed.json' with { type: 'json' };
import areas from '../../../data/registry/areas.json' with { type: 'json' };
import { r2Storage } from '../../shared/archive.js';
import { storeFromEnv } from '../../shared/postgrest.js';
import { LANE as OLDB_CURRENT, runOpenLigaCurrent } from './openligadb-current.js';
import { failureState, inBackoff, readLane, successState, writeLane } from './state.js';
import { ESPN_LANES, runEspnLane } from './espn-jobs.js';
import { espnLiveCanary, espnStoreCanary } from './canary.js';
import { STANDINGS_LANE, runEspnStandings } from './espn-standings.js';
import { LIVE_LANE, runEspnLive } from './espn-live.js';
import { SHADOW_LANE, runShadow } from './shadow-lane.js';

export const VERSION = 'soccer-ingest/1.2.0';

const LANES = {
  [OLDB_CURRENT]: ctx => runOpenLigaCurrent(ctx),
  ...Object.fromEntries(ESPN_LANES.map(l => [l.name, ctx => runEspnLane(l, ctx)])),
  [STANDINGS_LANE]: ctx => runEspnStandings(ctx),
  [LIVE_LANE]: ctx => runEspnLive(ctx),
  [SHADOW_LANE]: ctx => runShadow(ctx),
};
// Priority lane runs every tick; ESPN lanes rotate one per tick (one source can
// never monopolise ticks).
const PRIORITY = [OLDB_CURRENT, LIVE_LANE];
// Only ENABLED competitions rotate (disabled lanes used to burn ticks); the standings
// lane joins the rotation and throttles itself to hourly.
const ENABLED = new Set(registry.competitions.filter(c => c.espn?.enabled).map(c => c.slug));
const ROTATING = [...ESPN_LANES.filter(l => ENABLED.has(l.competition)).map(l => l.name), STANDINGS_LANE];
// Self-throttled lanes run after the rest of every tick and decide their own cadence. The
// private model shadow (Bundesliga only, hourly) is observational and not part of /health ok.
const SELF_THROTTLED = [SHADOW_LANE];

function context(env) {
  const store = storeFromEnv(env);
  if (!store) throw new Error('SOCCER_MODEL_SUPABASE_URL / _SERVICE_ROLE_KEY not configured');
  if (!env.SOCCER_SOURCE) throw new Error('R2 binding SOCCER_SOURCE missing');
  return { store, storage: r2Storage(env.SOCCER_SOURCE), registry, reviewed, areas, kv: env.SOCCER_STATE || null };
}

export async function runLane(env, name, { force = false, now = Date.now(), budget = undefined } = {}) {
  const fn = LANES[name];
  if (!fn) throw new Error(`unknown lane ${name}`);
  let state = await readLane(env.SOCCER_STATE, name);
  if (!force && inBackoff(state, now)) return { lane: name, skipped: 'backoff', backoff_until: state.backoff_until };
  // The lane decides cadence from the PREVIOUS attempt; a cadence skip is not an
  // attempt and leaves the state untouched (stamping it first made every poll
  // outside a live window skip forever).
  const prev = state;
  state = { ...state, last_attempt_at: new Date(now).toISOString() };
  try {
    const ctx = { ...context(env), state: prev, now, force, ...(budget ? { budget } : {}) };
    const out = await fn(ctx);
    if (out?.skipped) return { lane: name, ...out };
    state = successState(state, { now, observed: out.observed, changed: out.changed, captureId: out.captureId, parserVersion: out.parserVersion, cursor: out.cursor, changedValue: out.changedValue || null });
    await writeLane(env.SOCCER_STATE, state);
    return { lane: name, observed: out.observed, changed: out.changed, capture_id: out.captureId, requests: out.requests, results: out.results };
  } catch (err) {
    state = failureState(state, err, now);
    await writeLane(env.SOCCER_STATE, state);
    return { lane: name, error: state.last_error, health: state.health, backoff_until: state.backoff_until };
  }
}

// Cron runs every minute. The live lane (PBEcast) runs every minute and only works when an
// ESPN-owned match is in its live window; every other lane keeps its 5-minute cadence.
async function tick(env, now = Date.now()) {
  const out = [await runLane(env, LIVE_LANE, { now })];
  if (new Date(now).getUTCMinutes() % 5 !== 0) return out;
  for (const name of PRIORITY.filter(n => n !== LIVE_LANE)) out.push(await runLane(env, name, { now }));
  if (ROTATING.length) {
    const i = Math.floor(now / 300e3) % ROTATING.length;
    out.push(await runLane(env, ROTATING[i], { now }));
  }
  for (const name of SELF_THROTTLED) out.push(await runLane(env, name, { now }));
  return out;
}

const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function authorized(req, env) {
  const tok = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.INGEST_ADMIN_TOKEN || tok.length !== env.INGEST_ADMIN_TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < tok.length; i++) diff |= tok.charCodeAt(i) ^ env.INGEST_ADMIN_TOKEN.charCodeAt(i);
  return diff === 0;
}

// Write-once raw archive upload (backfill of captures made on a workstation).
// Payload keys are content addressed: the body's sha256 must equal the key's.
// An existing object is never rewritten. Every write is read back and re-hashed.
const RAW_KEY = /^soccer-source\/[a-z0-9_]+\/(sha256\/[0-9a-f]{2}\/[0-9a-f]{64}|captures\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{24}\.json)$/;
async function sha256(buf) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join(''); }
export async function adminRaw(req, env, key) {
  if (!key || !RAW_KEY.test(key)) return [{ error: 'bad key' }, 400];
  const existing = await env.SOCCER_SOURCE.get(key);
  if (req.method === 'GET') {
    if (!existing) return [{ key, exists: false }, 404];
    const b = await existing.arrayBuffer();
    return [{ key, exists: true, bytes: b.byteLength, sha256: await sha256(b) }, 200];
  }
  if (req.method !== 'PUT') return [{ error: 'method' }, 405];
  const body = await req.arrayBuffer();
  const sha = await sha256(body);
  const addressed = key.match(/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})$/);
  if (addressed && addressed[1] !== sha) return [{ error: 'content does not match content address', key, sha256: sha }, 422];
  if (existing) {
    const prev = await sha256(await existing.arrayBuffer());
    return [{ key, existed: true, identical: prev === sha, sha256: prev }, prev === sha ? 200 : 409];
  }
  await env.SOCCER_SOURCE.put(key, body, { httpMetadata: { contentType: req.headers.get('content-type') || 'application/octet-stream' } });
  const back = await env.SOCCER_SOURCE.get(key);
  const verified = back ? await sha256(await back.arrayBuffer()) : null;
  return [{ key, written: true, bytes: body.byteLength, sha256: sha, verified: verified === sha }, verified === sha ? 201 : 500];
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      const lanes = await Promise.all(Object.keys(LANES).map(n => readLane(env.SOCCER_STATE, n)));
      // The OpenLigaDB lane must be ok; the live lane only counts once it has failed
      // (with no match in the live window it legitimately never runs).
      const priorityOk = lanes.filter(l => PRIORITY.includes(l.lane)).every(l => l.health === 'ok' || (l.lane === LIVE_LANE && !l.consecutive_failures));
      return json({ ok: priorityOk, version: VERSION, lanes: lanes.map(({ last_error, ...l }) => ({ ...l, last_error: last_error ? 'present' : null })) }, priorityOk ? 200 : 503);
    }
    if (url.pathname === '/v1/admin/raw') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      return json(...await adminRaw(req, env, url.searchParams.get('key')));
    }
    if (url.pathname === '/v1/canary/espn') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const live = await espnLiveCanary();
      const store = storeFromEnv(env);
      const storePart = store ? await espnStoreCanary(store) : { pass: false, checks: [{ name: 'store_configured', pass: false }] };
      const result = { pass: live.pass && storePart.pass, live, store: storePart };
      if (env.SOCCER_STATE) await env.SOCCER_STATE.put('canary:espn', JSON.stringify(result));
      return json(result, result.pass ? 200 : 503);
    }
    if (url.pathname === '/v1/runs' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const lane = url.searchParams.get('lane');
      if (!LANES[lane]) return json({ error: 'unknown lane', lanes: Object.keys(LANES) }, 400);
      const budget = Math.max(1, Math.min(120, Number(url.searchParams.get('budget')) || 0)) || undefined;
      return json(await runLane(env, lane, { force: url.searchParams.get('force') === '1', budget }));
    }
    return json({ error: 'not found' }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.scheduledTime));
  },
};
