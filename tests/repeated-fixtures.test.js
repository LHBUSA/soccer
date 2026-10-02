// REPEATED FIXTURES (migration 20261002001500 + upsertEspnFixtures). A pairing may occur more than once per stage
// (MLS); ESPN replacement listings (postponed + replayed) never become two matches; cross-provider attachment uses a
// kickoff tolerance and queues ambiguity, never exact-timestamp equality and never the nearest of several.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { ensureCompetitionSeason, upsertEspnFixtures } from '../workers/soccer-ingest/src/espn-lane.js';

const U = n => `00000000-0000-5000-8000-${String(n).padStart(12, '0')}`;
const comp = (slug, mayFound = true) => ({ slug, name: slug, comp_type: 'league', gender: 'men', country_code: null, tier: 1, season_format: 'calendar', espn: { league: 'usa.1', may_found: mayFound }, external_ids: [{ provider: 'espn', external_id: `x.${slug}`, method: 'founding', evidence: 't' }] });
const fx = (h, a, d, st) => ({ d, h, a, st, sy: 2001, stype: '1', v: null, cap: null });
async function world() {
  const s = await openPglite(); await applyMigrations(s);
  await s.insert('soccer_teams', [1, 2, 3, 4].map(n => ({ id: U(n), slug: `t${n}`, name: `Team ${n}`, team_type: 'club', founding_provider: 'espn', founding_external_id: String(n) })));
  return { s, teamMap: new Map([['1', U(1)], ['2', U(2)], ['3', U(3)], ['4', U(4)]]) };
}
const matchesOf = s => s.select('soccer_matches', { columns: ['id', 'kickoff_at', 'home_team_id', 'away_team_id', 'result_provider'], order: 'kickoff_at.asc' });

test('F: two finished ESPN events of the same pairing on different dates are two canonical matches', async () => {
  const { s, teamMap } = await world();
  try {
    const cursor = { history: true, fixtures: { e1: fx('1', '2', '2001-05-05T19:00:00Z', 'finished'), e2: fx('1', '2', '2001-08-18T19:00:00Z', 'finished') } };
    const r = await upsertEspnFixtures(s, { comp: comp('mls'), year: 2001, cursor, teamMap, now: Date.parse('2026-10-02') });
    assert.equal(r.founded, 2); assert.equal((await matchesOf(s)).length, 2);
    // A second run is idempotent (crosswalks resolve both)
    const again = await upsertEspnFixtures(s, { comp: comp('mls'), year: 2001, cursor, teamMap, now: Date.parse('2026-10-02') });
    assert.equal(again.founded, 0); assert.equal((await matchesOf(s)).length, 2);
  } finally { await s.close(); }
});

test('G: postponed + replacement ESPN listings make ONE canonical match (near or far apart)', async () => {
  const { s, teamMap } = await world();
  try {
    const cursor = { history: true, fixtures: {
      p1: fx('1', '2', '2001-06-01T19:00:00Z', 'postponed'), r1: fx('1', '2', '2001-06-03T19:00:00Z', 'finished'), // near
      p2: fx('2', '1', '2001-04-01T19:00:00Z', 'postponed'), r2: fx('2', '1', '2001-07-01T19:00:00Z', 'finished'), // far
    } };
    const r = await upsertEspnFixtures(s, { comp: comp('mls'), year: 2001, cursor, teamMap, now: Date.parse('2026-10-02') });
    assert.equal(r.founded, 2); assert.equal(r.replacement_listings, 2);
    const ms = await matchesOf(s);
    assert.deepEqual(ms.map(m => m.kickoff_at.toISOString?.() || new Date(m.kickoff_at).toISOString()), ['2001-06-03T19:00:00.000Z', '2001-07-01T19:00:00.000Z']);
    const xw = await s.select('soccer_match_external_ids', { columns: ['external_id'], eq: { provider: 'espn' } });
    assert.deepEqual(xw.map(x => x.external_id).sort(), ['r1', 'r2'], 'the replaced listings are never a match');
  } finally { await s.close(); }
});

test('ambiguous: two finished events of a pairing within the tolerance -> one match, the other queued (never merged blind)', async () => {
  const { s, teamMap } = await world();
  try {
    const cursor = { history: true, fixtures: { a1: fx('3', '4', '2001-09-01T19:00:00Z', 'finished'), a2: fx('3', '4', '2001-09-02T19:00:00Z', 'finished') } };
    const r = await upsertEspnFixtures(s, { comp: comp('mls'), year: 2001, cursor, teamMap, now: Date.parse('2026-10-02') });
    assert.equal(r.founded, 1); assert.equal(r.queued, 1);
    const [q] = await s.select('soccer_identity_queue', { columns: ['entity_type', 'reason', 'external_id'], eq: { entity_type: 'match' } });
    assert.equal(q.reason, 'fixture_same_pairing_within_tolerance'); assert.equal(q.external_id, 'a2');
  } finally { await s.close(); }
});

test('two finished events of a pairing 3 days apart: different dates AND results = two matches; same result = queued', async () => {
  const { s, teamMap } = await world();
  try {
    const sc = (f, h, a) => ({ ...f, sc: { h, a } });
    const cursor = { history: true, fixtures: {
      // MLS 2001 shape: San Jose 1-1 Colorado (May 30 local) and San Jose 2-1 Colorado (June 2 local), 71 h apart
      m1: sc(fx('3', '4', '2001-05-31T02:00:00Z', 'finished'), 1, 1), m2: sc(fx('3', '4', '2001-06-03T01:00:00Z', 'finished'), 2, 1),
      // a duplicate listing: same pairing, 2 days apart, SAME result -> never a second match
      d1: sc(fx('1', '2', '2001-07-01T02:00:00Z', 'finished'), 0, 0), d2: sc(fx('1', '2', '2001-07-03T02:00:00Z', 'finished'), 0, 0),
    } };
    const r = await upsertEspnFixtures(s, { comp: comp('mls'), year: 2001, cursor, teamMap, now: Date.parse('2026-10-02') });
    assert.equal(r.founded, 3, JSON.stringify(r)); assert.equal(r.queued, 1);
    const xw = (await s.select('soccer_match_external_ids', { columns: ['external_id'], eq: { provider: 'espn' } })).map(x => x.external_id).sort();
    assert.deepEqual(xw, ['d1', 'm1', 'm2']);
  } finally { await s.close(); }
});

test('E: foreign-provider match — ESPN attaches within the kickoff tolerance (not exact equality), queues outside it, never founds where may_found is false', async () => {
  const { s, teamMap } = await world();
  try {
    const c = comp('bundesliga', false);
    const { compId, seasonId, stageId } = await ensureCompetitionSeason(s, { comp: c, year: 2004 });
    await s.insert('soccer_matches', [
      { id: U(50), competition_id: compId, season_id: seasonId, stage_id: stageId, kickoff_at: '2004-10-27T18:00:00Z', status: 'finished', home_team_id: U(1), away_team_id: U(2), home_score: 4, away_score: 0, result_provider: 'openligadb' },
      { id: U(51), competition_id: compId, season_id: seasonId, stage_id: stageId, kickoff_at: '2005-03-12T14:30:00Z', status: 'finished', home_team_id: U(2), away_team_id: U(1), home_score: 1, away_score: 1, result_provider: 'openligadb' },
    ]);
    const cursor = { history: true, fixtures: {
      ok: fx('1', '2', '2004-10-27T17:30:00Z', 'finished'),   // 30 min different: attaches
      pp: fx('1', '2', '2004-10-26T13:30:00Z', 'postponed'),  // the postponed listing, 1 day earlier: attaches to the same match
      far: fx('2', '1', '2005-03-25T14:30:00Z', 'finished'),  // 13 days from the only candidate: queued, not founded
    } };
    const r = await upsertEspnFixtures(s, { comp: c, year: 2004, cursor, teamMap, now: Date.parse('2026-10-02') });
    assert.equal(r.attached_to_existing, 2); assert.equal(r.founded, 0); assert.equal(r.queued, 1);
    assert.equal((await matchesOf(s)).length, 2, 'no ESPN-founded match in an OpenLigaDB season');
    const xw = Object.fromEntries((await s.select('soccer_match_external_ids', { columns: ['external_id', 'match_id'], eq: { provider: 'espn' } })).map(x => [x.external_id, x.match_id]));
    assert.deepEqual(xw, { ok: U(50), pp: U(50) });
    const [q] = await s.select('soccer_identity_queue', { columns: ['reason'], eq: { entity_type: 'match', external_id: 'far' } });
    assert.equal(q.reason, 'fixture_kickoff_outside_tolerance');
  } finally { await s.close(); }
});

test('B (guard): an exact duplicate slot is refused by the database', async () => {
  const { s } = await world();
  try {
    const c = comp('mls'); const { compId, seasonId, stageId } = await ensureCompetitionSeason(s, { comp: c, year: 2001 });
    const row = id => ({ id: U(id), competition_id: compId, season_id: seasonId, stage_id: stageId, kickoff_at: '2001-05-05T19:00:00Z', status: 'finished', home_team_id: U(1), away_team_id: U(2), home_score: 1, away_score: 0, result_provider: 'espn' });
    await s.insert('soccer_matches', [row(60)]);
    await assert.rejects(s.insert('soccer_matches', [row(61)]), /soccer_matches_fixture_slot/);
  } finally { await s.close(); }
});
