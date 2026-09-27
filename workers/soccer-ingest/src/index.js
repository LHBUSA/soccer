// soccer-ingest Worker. Cron every 5 minutes; each lane decides its own cadence.
//
//   GET  /health                          lane states (no secrets, no raw data)
//   POST /v1/runs?lane=<name>[&force=1]   admin: run one lane now (Bearer INGEST_ADMIN_TOKEN)
//
// Bindings: SOCCER_SOURCE (R2 soccer-source), SOCCER_STATE (KV).
// Secrets:  SOCCER_MODEL_SUPABASE_URL, SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY, INGEST_ADMIN_TOKEN.

import registry from '../../../data/registry/competitions.json' with { type: 'json' };
import reviewed from '../../../data/registry/team-crosswalk-reviewed.json' with { type: 'json' };
import { r2Storage } from '../../shared/archive.js';
import { storeFromEnv } from '../../shared/postgrest.js';
import { LANE as OLDB_CURRENT, runOpenLigaCurrent } from './openligadb-current.js';
import { failureState, inBackoff, readLane, successState, writeLane } from './state.js';
import { ESPN_LANES, runEspnLane } from './espn-jobs.js';

export const VERSION = 'soccer-ingest/1.0.0';

const LANES = {
  [OLDB_CURRENT]: ctx => runOpenLigaCurrent(ctx),
  ...Object.fromEntries(ESPN_LANES.map(l => [l.name, ctx => runEspnLane(l, ctx)])),
};
// Priority lane runs every tick; ESPN lanes rotate one per tick (one source can
// never monopolise ticks).
const PRIORITY = [OLDB_CURRENT];
const ROTATING = ESPN_LANES.map(l => l.name);

function context(env) {
  const store = storeFromEnv(env);
  if (!store) throw new Error('SOCCER_MODEL_SUPABASE_URL / _SERVICE_ROLE_KEY not configured');
  if (!env.SOCCER_SOURCE) throw new Error('R2 binding SOCCER_SOURCE missing');
  return { store, storage: r2Storage(env.SOCCER_SOURCE), registry, reviewed };
}

export async function runLane(env, name, { force = false, now = Date.now() } = {}) {
  const fn = LANES[name];
  if (!fn) throw new Error(`unknown lane ${name}`);
  let state = await readLane(env.SOCCER_STATE, name);
  if (!force && inBackoff(state, now)) return { lane: name, skipped: 'backoff', backoff_until: state.backoff_until };
  state = { ...state, last_attempt_at: new Date(now).toISOString() };
  try {
    const ctx = { ...context(env), state, now, force };
    const out = await fn(ctx);
    if (out?.skipped) { await writeLane(env.SOCCER_STATE, state); return { lane: name, ...out }; }
    state = successState(state, { now, observed: out.observed, changed: out.changed, captureId: out.captureId, parserVersion: out.parserVersion, cursor: out.cursor, changedValue: out.changedValue || null });
    await writeLane(env.SOCCER_STATE, state);
    return { lane: name, observed: out.observed, changed: out.changed, capture_id: out.captureId, results: out.results };
  } catch (err) {
    state = failureState(state, err, now);
    await writeLane(env.SOCCER_STATE, state);
    return { lane: name, error: state.last_error, health: state.health, backoff_until: state.backoff_until };
  }
}

async function tick(env, now = Date.now()) {
  const out = [];
  for (const name of PRIORITY) out.push(await runLane(env, name, { now }));
  if (ROTATING.length) {
    const i = Math.floor(now / 300e3) % ROTATING.length;
    out.push(await runLane(env, ROTATING[i], { now }));
  }
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
      const priorityOk = lanes.filter(l => PRIORITY.includes(l.lane)).every(l => l.health === 'ok');
      return json({ ok: priorityOk, version: VERSION, lanes: lanes.map(({ last_error, ...l }) => ({ ...l, last_error: last_error ? 'present' : null })) }, priorityOk ? 200 : 503);
    }
    if (url.pathname === '/v1/admin/raw') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      return json(...await adminRaw(req, env, url.searchParams.get('key')));
    }
    if (url.pathname === '/v1/runs' && req.method === 'POST') {
      if (!authorized(req, env)) return json({ error: 'unauthorized' }, 401);
      const lane = url.searchParams.get('lane');
      if (!LANES[lane]) return json({ error: 'unknown lane', lanes: Object.keys(LANES) }, 400);
      return json(await runLane(env, lane, { force: url.searchParams.get('force') === '1' }));
    }
    return json({ error: 'not found' }, 404);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env, event.scheduledTime));
  },
};
