// soccer-video-autopilot: every cron tick leaves a trace, a failing run is recorded (never swallowed), health tells
// cron-not-firing / run-failing / healthy apart, and provenance reports the mechanism actually used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { discoveryMechanism } from '../workers/soccer-video-autopilot/src/index.js';

const kv = (init = {}) => { const m = new Map(Object.entries(init).map(([k, v]) => [k, JSON.stringify(v)])); return { m, async get(k, t) { const v = m.get(k); return v === undefined ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { m.set(k, v); } }; };
const health = async env => (await worker.fetch(new Request('https://x/health'), env)).json();
const iso = msAgo => new Date(Date.now() - msAgo).toISOString();

test('discovery mechanism is the one actually used: keyless without a key', () => {
  assert.equal(discoveryMechanism({}), 'youtube_atom_feed_oembed');
  assert.equal(discoveryMechanism({ YOUTUBE_API_KEY: 'k' }), 'youtube_data_api_v3');
});

test('a failing scheduled run records its tick AND its error (no silent failure)', async () => {
  const store = kv(); const waits = [];
  await worker.scheduled({ cron: '13,43 * * * *', scheduledTime: Date.now() }, { SOCCER_STATE: store }, { waitUntil: p => waits.push(p) });
  await Promise.all(waits);
  const tick = JSON.parse(store.m.get('video:last_tick')); const err = JSON.parse(store.m.get('video:last_error'));
  assert.equal(tick.cron, '13,43 * * * *'); assert.equal(tick.discovery, 'youtube_atom_feed_oembed');
  assert.match(err.error, /store_not_configured/); assert.equal(err.tick_at, tick.at);
  assert.equal(store.m.has('video:last_run'), false);
  const h = await health({ SOCCER_STATE: store });
  assert.equal(h.ok, false); assert.equal(h.state, 'run_failing'); assert.equal(h.discovery, 'youtube_atom_feed_oembed');
});

test('health distinguishes cron not firing, run failing, stale and healthy', async () => {
  assert.equal((await health({ SOCCER_STATE: kv() })).state, 'cron_not_firing');
  assert.equal((await health({ SOCCER_STATE: kv({ 'video:last_tick': { at: iso(3 * 3600e3) }, 'video:last_run': { at: iso(3 * 3600e3) } }) })).state, 'cron_not_firing');
  const ok = await health({ SOCCER_STATE: kv({ 'video:last_tick': { at: iso(60e3) }, 'video:last_run': { at: iso(60e3), discovery: 'youtube_atom_feed_oembed' } }) });
  assert.equal(ok.state, 'healthy'); assert.equal(ok.ok, true);
  const recovered = await health({ SOCCER_STATE: kv({ 'video:last_tick': { at: iso(60e3) }, 'video:last_error': { at: iso(40 * 60e3) }, 'video:last_run': { at: iso(60e3) } }) });
  assert.equal(recovered.state, 'healthy', 'an error older than the last successful run no longer fails health');
  assert.equal((await health({ SOCCER_STATE: kv({ 'video:last_tick': { at: iso(60e3) }, 'video:last_run': { at: iso(3 * 3600e3) } }) })).state, 'run_stale');
});

test('a feed thumbnail on i1-i4.ytimg.com is stored on the canonical host; an invalid row is skipped, never aborting the batch', async () => {
  const { rowProblem } = await import('../workers/soccer-video-autopilot/src/index.js');
  const ok = { provider_video_id: '1cBh7MDY2fE', channel_id: 'UCgqlho3-8a6FmDqQm7Q6gJw', channel_name: 'Fenerbahçe SK', title: 't', thumbnail_url: 'https://i.ytimg.com/vi/1cBh7MDY2fE/hqdefault.jpg', url: 'https://www.youtube.com/watch?v=1cBh7MDY2fE', video_type: 'other', duration_sec: null };
  assert.equal(rowProblem(ok), null);
  assert.equal(rowProblem({ ...ok, thumbnail_url: 'https://i2.ytimg.com/vi/1cBh7MDY2fE/hqdefault.jpg' }), 'thumbnail_url', 'the production 23514 failure of 2026-10-03 02:13');
  assert.equal(rowProblem({ ...ok, video_type: 'clip' }), 'video_type');
  assert.equal(rowProblem({ ...ok, duration_sec: 0 }), 'duration_sec');
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('workers/soccer-video-autopilot/src/index.js', 'utf8');
  assert.match(src, /thumbnail_url: 'https:\/\/i\.ytimg\.com\/vi\/' \+ e\.video_id/, 'keyless rows use the canonical thumbnail host');
  assert.match(src, /const dedup = unique\.filter\(v => \{ const why = rowProblem\(v\)/);
});
