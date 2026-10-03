// Reviewed season format manifests (MLS 2004): ESPN's raw classification stays source evidence, the reviewed manifest
// alone decides the canonical stage, and the league-stage structure check sees only reviewed league matches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classifyFormatReview, leagueGamesPerTeam } from '../scripts/history/format-review-lib.mjs';

const manifest = JSON.parse(readFileSync(new URL('../data/history-review/mls-2004.json', import.meta.url), 'utf8'));
const snapshot = JSON.parse(readFileSync(new URL('../docs/evidence/history/review/mls-2004-canonical-snapshot.json', import.meta.url), 'utf8'));
const RECLASSIFIED = { 168949: 'Conference Finals', 168950: 'Conference Finals', 168975: 'MLS Cup' };
const counts = xs => xs.reduce((o, x) => ({ ...o, [x]: (o[x] || 0) + 1 }), {});
const games = (ms, keep) => { const n = {}; for (const m of ms) if (keep(m)) for (const t of [m.home, m.away]) n[t] = (n[t] || 0) + 1; return n; };

test('raw ESPN classification is preserved unchanged (input untouched, recorded per match)', () => {
  const before = structuredClone(snapshot.matches);
  const r = classifyFormatReview(manifest, snapshot.matches);
  assert.deepEqual(snapshot.matches, before, 'classification never mutates the provider-classified input');
  assert.deepEqual(counts(snapshot.matches.map(m => m.provider_stage)), { 'Regular Season': 153, Playoffs: 8 });
  for (const a of r.assignment) assert.equal(a.provider_stage, snapshot.matches.find(m => m.id === a.match_id).provider_stage);
});

test('the reviewed manifest controls canonical stage assignment', () => {
  const r = classifyFormatReview(manifest, snapshot.matches);
  assert.equal(r.ready, true);
  assert.deepEqual(counts(r.assignment.map(a => a.reviewed_stage)), { 'Regular Season': 150, 'Conference Semifinals': 8, 'Conference Finals': 2, 'MLS Cup': 1 });
  assert.deepEqual(Object.fromEntries(r.reclassified.map(x => [x.espn_event, x.reviewed_stage])), RECLASSIFIED);
  for (const x of r.reclassified) { assert.equal(x.provider_stage, 'Regular Season'); assert.ok(x.evidence.reviewed_fixture && x.evidence.sources.length >= 3); }
  assert.deepEqual(r.standings_differences, []);
});

test('league games-per-team is uneven on the raw classification and uniform (30) after the manifest', () => {
  const raw = games(snapshot.matches, m => m.provider_stage === 'Regular Season' && m.status === 'finished');
  assert.ok(new Set(Object.values(raw)).size > 1, 'raw ESPN league stage carries playoff matches (30/31/32)');
  const r = classifyFormatReview(manifest, snapshot.matches);
  const after = leagueGamesPerTeam(r.assignment, snapshot.matches, manifest.regular_season.stage);
  assert.equal(Object.keys(after).length, 10);
  assert.deepEqual([...new Set(Object.values(after))], [30]);
});

test('playoff matches never contaminate the league-stage structure', () => {
  const r = classifyFormatReview(manifest, snapshot.matches);
  const league = new Set(r.assignment.filter(a => a.reviewed_stage === manifest.regular_season.stage).map(a => a.match_id));
  for (const id of r.playoff.keys()) assert.ok(!league.has(id));
  const after = leagueGamesPerTeam(r.assignment, snapshot.matches, manifest.regular_season.stage);
  assert.equal(Object.values(after).reduce((a, n) => a + n, 0), 2 * 150, 'club appearances = 2 x league matches');
});

test('an unprovable fixture keeps the season HELD (no fallback to date or pairing)', () => {
  const m2 = structuredClone(manifest);
  const cup = m2.playoffs.fixtures.find(f => f.stage === 'MLS Cup'); cup.goals_a = 1; // reviewed score no longer agrees
  const r = classifyFormatReview(m2, snapshot.matches);
  assert.equal(r.ready, false);
  assert.equal(r.fixtures.find(f => f.stage === 'MLS Cup').outcome, 'no_match');
  const m3 = structuredClone(manifest); m3.playoffs.fixtures.find(f => f.stage === 'MLS Cup').date_local = '2004-11-20';
  assert.equal(classifyFormatReview(m3, snapshot.matches).ready, false, 'same pairing and score on another date is never accepted');
});
