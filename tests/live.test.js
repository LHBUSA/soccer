// PBEcast live lane: per-minute refresh of active ESPN matches, the provider's clock stored
// verbatim, no enrichment ledger mid-match, exactly one final pass.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openPglite, applyMigrations } from '../workers/soccer-ingest/src/store-pglite.js';
import { runEspnLive } from '../workers/soccer-ingest/src/espn-live.js';

test('live lane: source clock verbatim, plays every tick, no ledger mid-match, one final pass', async () => {
  const store = await openPglite(); await applyMigrations(store);
  const id = n => `00000000-0000-5000-8000-0000000f00${n}`;
  await store.insert('soccer_competitions', [{ id: id(10), slug: 'mls', name: 'MLS', comp_type: 'league' }]);
  await store.insert('soccer_seasons', [{ id: id(11), competition_id: id(10), label: '2026' }]);
  await store.insert('soccer_teams', [{ id: id(12), slug: 'a', name: 'A', team_type: 'club', founding_provider: 'espn', founding_external_id: '1' }, { id: id(13), slug: 'b', name: 'B', team_type: 'club', founding_provider: 'espn', founding_external_id: '2' }]);
  await store.insert('soccer_team_external_ids', [{ provider: 'espn', external_id: '1', team_id: id(12), method: 'founding', evidence: 't' }, { provider: 'espn', external_id: '2', team_id: id(13), method: 'founding', evidence: 't' }]);
  await store.insert('soccer_matches', [{ id: id(20), competition_id: id(10), season_id: id(11), kickoff_at: '2026-09-27T23:00:00Z', home_team_id: id(12), away_team_id: id(13), status: 'scheduled', result_provider: 'espn' }]);
  await store.insert('soccer_match_external_ids', [{ provider: 'espn', external_id: '777', match_id: id(20), method: 'founding', evidence: 't' }]);
  let phase = 'live'; const calls = [];
  const body = url => {
    if (url.endsWith('/status')) return phase === 'live' ? { type: { state: 'in', shortDetail: "63'" }, displayClock: "63'", period: 2 } : { type: { state: 'post', completed: true, shortDetail: 'FT' }, displayClock: "90'+4'", period: 2 };
    if (url.includes('/competitors/1/score')) return { value: 2 };
    if (url.includes('/competitors/2/score')) return { value: 1 };
    if (url.includes('/plays')) return { items: [], pageCount: 1 };
    return {};
  };
  const fetcher = async url => { calls.push(url); return { status: 200, contentType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(body(url))) }; };
  const mem = new Map(); const storage = { async head(k) { return mem.has(k); }, async put(k, b) { mem.set(k, b); }, async get(k) { return mem.get(k) || null; } };
  const kvm = new Map(); const kv = { async get(k) { return kvm.has(k) ? JSON.parse(kvm.get(k)) : null; }, async put(k, v) { kvm.set(k, v); } };
  const reg = { competitions: [{ slug: 'mls', espn: { league: 'usa.1', enabled: true } }] };
  const now = Date.parse('2026-09-27T23:40:00Z');

  const t1 = await runEspnLive({ store, storage, registry: reg, now, fetcher, kv });
  assert.equal(t1.results[0].status, 'live'); assert.equal(t1.results[0].clock, "63'");
  assert.ok(t1.results[0].components.includes('plays'));
  const s1 = JSON.parse(kvm.get(`live:${id(20)}`));
  assert.equal(s1.display_clock, "63'"); assert.equal(s1.detail, "63'"); assert.ok(s1.observed_at);
  assert.equal((await store.select('soccer_match_enrichment', { columns: ['component'] })).length, 0, 'no ledger mid-match');
  const [m1] = await store.select('soccer_matches', { columns: ['status', 'home_score', 'away_score'], eq: { id: id(20) } });
  assert.deepEqual([m1.status, m1.home_score, m1.away_score], ['live', 2, 1]);

  // next minute: plays again, stats/lineups not yet due
  calls.length = 0;
  const t2 = await runEspnLive({ store, storage, registry: reg, now: now + 60e3, fetcher, kv });
  assert.deepEqual(t2.results[0].components, ['plays']);
  assert.ok(calls.some(u => u.includes('/plays')) && !calls.some(u => u.includes('/statistics')));

  // final: one full pass with the ledger, then nothing more to do
  phase = 'final';
  const t3 = await runEspnLive({ store, storage, registry: reg, now: now + 120e3, fetcher, kv });
  assert.equal(t3.results[0].status, 'finished');
  assert.deepEqual(new Set(t3.results[0].components), new Set(['lineups', 'stats', 'plays']));
  assert.equal(JSON.parse(kvm.get(`live:${id(20)}`)).final_done, true);
  assert.ok((await store.select('soccer_match_enrichment', { columns: ['component'] })).length > 0, 'final pass records the ledger');
  const t4 = await runEspnLive({ store, storage, registry: reg, now: now + 180e3, fetcher, kv });
  assert.equal(t4.skipped, 'no ESPN-owned match in the live window');
  await store.close();
});
