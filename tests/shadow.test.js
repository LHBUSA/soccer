// Private Dixon-Coles shadow (migration 0700 + soccer-ingest shadow lane).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { applyMigrations, openPglite } from '../workers/soccer-ingest/src/store-pglite.js';
import { runShadow, predictShadow, sortInputs, modelMatch, SHADOW_SPEC as spec } from '../workers/soccer-ingest/src/shadow-lane.js';
import { shadowMetrics } from '../workers/soccer-ingest/src/shadow-metrics.js';
import { structuralSeries, dc1x2 } from '../scripts/research/structural-core.mjs';
import { SPLIT } from '../scripts/research/model-core.mjs';

const DAY = 864e5;
const NOW = Math.floor((Date.now() - 20 * DAY) / 3600e3) * 3600e3; // in the past, so DB now() never sees future stamps
const iso = t => new Date(t).toISOString();
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const COMP = uuid(1); const S25 = uuid(2); const S26 = uuid(3); const L25 = uuid(4); const L26 = uuid(5); const PO = uuid(6);
const TEAMS = Array.from({ length: 18 }, (_, i) => uuid(100 + i));
let mid = 1000;
// Circle-method double round-robin over the 18 teams: 34 rounds x 9 matches, every ordered pair once.
const ROUNDS = (() => {
  const ids = [...TEAMS]; const first = [];
  for (let r = 0; r < 17; r++) {
    const pairs = []; for (let i = 0; i < 9; i++) pairs.push(r % 2 ? [ids[17 - i], ids[i]] : [ids[i], ids[17 - i]]);
    first.push(pairs); ids.splice(1, 0, ids.pop());
  }
  return [...first, ...first.map(ps => ps.map(([h, a]) => [a, h]))];
})();
let nextPair = 0; // unused 2026/27 pairings for fixtures
const pair = () => { const r = Math.floor(nextPair / 9); const p = ROUNDS[r][nextPair % 9]; nextPair += 1; return p; };

async function world() {
  const store = await openPglite();
  await applyMigrations(store);
  await store.query(`insert into soccer_competitions (id, slug, name, comp_type) values ($1,'bundesliga','Bundesliga','league')`, [COMP]);
  await store.query(`insert into soccer_seasons (id, competition_id, label) values ($1,$3,'2025/26'), ($2,$3,'2026/27')`, [S25, S26, COMP]);
  await store.query(`insert into soccer_stages (id, season_id, name, stage_type) values ($1,$4,'Regular Season','league'), ($2,$5,'Regular Season','league'), ($3,$5,'Relegation Playoff','playoff')`, [L25, L26, PO, S25, S26]);
  for (const [i, t] of TEAMS.entries()) await store.query(`insert into soccer_teams (id, slug, name, team_type, founding_provider, founding_external_id) values ($1,$2,$2,'club','test',$3)`, [t, `team-${i}`, String(i)]);
  // Deterministic double round-robin: 2025/26 complete (weekly), 2026/27 rounds 1-20 before NOW.
  let k = 0;
  for (let r = 0; r < 34; r++) for (const [h, a] of ROUNDS[r]) { k += 1; await match(store, { season: S25, stage: L25, t: NOW - 420 * DAY + r * 7 * DAY, h, a, status: 'finished', hs: (k * 7) % 4, as: (k * 5) % 3 }); }
  for (let r = 0; r < 20; r++) for (const [h, a] of ROUNDS[r]) { k += 1; await match(store, { t: NOW - 150 * DAY + r * 7 * DAY, h, a, status: 'finished', hs: (k * 7) % 4, as: (k * 5) % 3 }); }
  nextPair = 20 * 9;
  return store;
}
async function match(store, { season = S26, stage = L26, t, h, a, status = 'scheduled', hs = null, as = null }) {
  const id = uuid(mid++);
  await store.query(`insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, home_team_id, away_team_id, status, home_score, away_score) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [id, COMP, season, stage, iso(t), h, a, status, hs, as]);
  return id;
}
const preds = async store => (await store.query(`select * from soccer_model_shadow_predictions order by kickoff_at`)).rows;

test('shadow-model.json is regenerated exactly from the frozen card and core', () => {
  execFileSync(process.execPath, ['scripts/shadow/build-model-spec.mjs', '--check'], { stdio: 'pipe' });
  assert.equal(spec.rho, -0.1099); assert.equal(spec.calibration_id, 'none'); assert.equal(spec.model_id, 'soccer-research-bundesliga-v1.2-dc');
});

test('the shadow computation reproduces the frozen research predictions bit-for-bit (hash 19b72fed)', () => {
  const raw = readFileSync('docs/evidence/research/frozen/bundesliga-results-snapshot.json', 'utf8');
  const matches = JSON.parse(raw).map(m => ({ ...m, t: Date.parse(m.kickoff_at) }));
  const series = structuralSeries(matches, { homeHl: 540 });
  const ordered = sortInputs(matches.map(modelMatch));
  const rows = []; let mismatch = 0;
  matches.forEach((m, i) => {
    if (!series[i] || m.season <= '2005/06') return;
    // Research semantics: every match that kicked off strictly before the target.
    const prior = ordered.filter(x => x.t < m.t);
    const p = predictShadow(prior, m);
    const ref = dc1x2(series[i].lh, series[i].la, spec.rho);
    if (!p || p.probs.some((v, c) => v !== ref[c])) mismatch += 1;
    rows.push([m.id, ...p.probs.map(x => +x.toFixed(10))]);
  });
  assert.equal(mismatch, 0);
  assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'), spec.sources.research_prediction_hash);
  void SPLIT;
});

test('inputs at or after the target kickoff never influence the prediction', () => {
  const inputs = sortInputs(Array.from({ length: 120 }, (_, i) => modelMatch({ id: uuid(5000 + i), kickoff_at: iso(NOW - (200 - i) * DAY), home_team_id: TEAMS[i % 18], away_team_id: TEAMS[(i + 5) % 18], home_score: i % 4, away_score: i % 3 })));
  const target = { kickoff_at: iso(NOW), home_team_id: TEAMS[0], away_team_id: TEAMS[1] };
  const base = predictShadow(inputs, target);
  const polluted = sortInputs([...inputs, modelMatch({ id: uuid(9998), kickoff_at: iso(NOW), home_team_id: TEAMS[0], away_team_id: TEAMS[1], home_score: 9, away_score: 0 }), modelMatch({ id: uuid(9999), kickoff_at: iso(NOW + DAY), home_team_id: TEAMS[2], away_team_id: TEAMS[3], home_score: 0, away_score: 9 })]);
  assert.deepEqual(predictShadow(polluted, target).probs, base.probs);
});

test('lane issues once per match, freezes the first issue, holds instead of guessing, settles once, snapshots metrics once', async () => {
  const store = await world();
  const [p1, p2, p3] = [pair(), pair(), pair()];
  const f1 = await match(store, { t: NOW + 2 * DAY, h: p1[0], a: p1[1] });
  const f2 = await match(store, { t: NOW + 5 * DAY, h: p2[0], a: p2[1] });
  await match(store, { t: NOW + 9 * DAY, h: p3[0], a: p3[1] }); // outside the 7-day window
  const po = await match(store, { stage: PO, t: NOW + 3 * DAY, h: TEAMS[6], a: TEAMS[7] });
  const r1 = await runShadow({ store, storage: null, now: NOW, force: true });
  assert.equal(r1.results.issued, 2);
  assert.deepEqual(r1.results.holds, [{ match_id: po, reason: 'not_league_stage' }]);
  let rows = await preds(store);
  assert.equal(rows.length, 2);
  for (const r of rows) {
    assert.ok(Math.abs(r.p_home + r.p_draw + r.p_away - 1) < 1e-12);
    assert.ok(Date.parse(r.input_as_of) < Date.parse(r.predicted_at) && Date.parse(r.predicted_at) < Date.parse(r.kickoff_at));
    assert.equal(r.model_id, spec.model_id); assert.equal(r.calibration_id, 'none'); assert.equal(r.rho, -0.1099); assert.equal(r.model_hash, spec.model_hash);
    assert.deepEqual(Object.keys(r.attribution).filter(k => /dna|form_score|injur|market/i.test(k)), []);
  }
  const frozen = rows.map(r => [r.match_id, r.p_home, r.p_draw, r.p_away, r.input_hash]);

  // Upstream data changes after issue: the issued rows are never refreshed.
  await store.query(`update soccer_matches set home_score = 7 where id = (select id from soccer_matches where status = 'finished' order by kickoff_at desc limit 1)`);
  const r2 = await runShadow({ store, storage: null, now: NOW + 3600e3, force: true });
  assert.equal(r2.results.issued, 0);
  assert.deepEqual((await preds(store)).map(r => [r.match_id, r.p_home, r.p_draw, r.p_away, r.input_hash]), frozen);

  // Triggers: prediction fields are immutable; no early settlement; no delete; one row per model+match.
  await assert.rejects(store.query(`update soccer_model_shadow_predictions set p_home = 0.5 where match_id = $1`, [f1]), /frozen/);
  await assert.rejects(store.query(`update soccer_model_shadow_predictions set home_score = 1, away_score = 0, outcome = 'home', settled_at = $2 where match_id = $1`, [f1, iso(NOW + 3 * DAY)]), /not final/);
  await assert.rejects(store.query(`delete from soccer_model_shadow_predictions where match_id = $1`, [f1]), /append-only/);
  const dup = { ...(await preds(store))[0] }; delete dup.id; delete dup.created_at;
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [dup]), /duplicate key|unique/);

  // A missing earlier result holds new fixtures (never guessed).
  const late = (await store.query(`select id from soccer_matches where status = 'finished' order by kickoff_at desc limit 1`)).rows[0].id;
  await store.query(`update soccer_matches set status = 'live' where id = $1`, [late]);
  const p4 = pair(); const f3 = await match(store, { t: NOW + 6 * DAY, h: p4[0], a: p4[1] });
  const r3 = await runShadow({ store, storage: null, now: NOW + 2 * 3600e3, force: true });
  assert.equal(r3.results.issued, 0);
  assert.ok(r3.results.holds.some(h => h.match_id === f3 && h.reason === 'prior_result_unavailable'));
  await store.query(`update soccer_matches set status = 'finished' where id = $1`, [late]);
  const r4 = await runShadow({ store, storage: null, now: NOW + 3 * 3600e3, force: true });
  assert.equal(r4.results.issued, 1);

  // A league match that kicks off without a prediction is counted as missed.
  const p5 = pair(); await match(store, { t: NOW + 3.5 * 3600e3, h: p5[0], a: p5[1], status: 'finished', hs: 1, as: 1 });
  const r5 = await runShadow({ store, storage: null, now: NOW + 5 * 3600e3, force: true });
  assert.equal(r5.results.missed, 1);

  // Settlement: only after final, with the canonical score, once; predictions unchanged; one snapshot.
  await store.query(`update soccer_matches set status = 'finished', home_score = 2, away_score = 1 where id = $1`, [f1]);
  const before = (await preds(store)).find(r => r.match_id === f1);
  const r6 = await runShadow({ store, storage: null, now: NOW + 2 * DAY + 3 * 3600e3, force: true });
  assert.equal(r6.results.settled, 1); assert.equal(r6.results.metrics_snapshot, true);
  const after = (await preds(store)).find(r => r.match_id === f1);
  assert.deepEqual([after.p_home, after.p_draw, after.p_away, after.predicted_at.getTime()], [before.p_home, before.p_draw, before.p_away, before.predicted_at.getTime()]);
  assert.deepEqual([after.home_score, after.away_score, after.outcome], [2, 1, 'home']);
  await assert.rejects(store.query(`update soccer_model_shadow_predictions set settled_at = settled_at + interval '1 minute' where match_id = $1`, [f1]), /already settled/);
  const r7 = await runShadow({ store, storage: null, now: NOW + 2 * DAY + 5 * 3600e3, force: true });
  assert.equal(r7.results.metrics_snapshot, false);
  const snaps = (await store.query(`select * from soccer_model_shadow_metrics`)).rows;
  assert.equal(snaps.length, 1); assert.equal(snaps[0].settled_count, 1);
  assert.equal(snaps[0].metrics.counts.settled, 1); assert.equal(snaps[0].metrics.counts.missed, 1);
  await assert.rejects(store.query(`update soccer_model_shadow_metrics set settled_count = 9`), /append-only/);
  const ev = (await store.query(`select event, count(*)::int n from soccer_model_shadow_events group by event order by event`)).rows;
  assert.deepEqual(Object.fromEntries(ev.map(e => [e.event, e.n])), { hold: 2, issued: 4, missed: 1, settled: 1, started: 1 }); // the +9 d fixture enters the window by the settlement run
  void f2;
  await store.close();
});

test('issue guard rejects future-dated, non-scheduled and time-unsafe rows', async () => {
  const store = await world();
  const p1 = pair(); const f = await match(store, { t: NOW + 2 * DAY, h: p1[0], a: p1[1] });
  const base = { model_id: 'm', model_version: '1', calibration_id: 'none', competition_id: COMP, season_id: S26, match_id: f, predicted_at: iso(NOW), kickoff_at: iso(NOW + 2 * DAY), p_home: 0.5, p_draw: 0.25, p_away: 0.25, lambda_home: 1.5, lambda_away: 1.1, rho: -0.1099, input_hash: 'a'.repeat(64), model_hash: 'b'.repeat(64), input_as_of: iso(NOW - DAY), input_count: 10, attribution: {} };
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [{ ...base, input_as_of: iso(NOW) }]), /check/);
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [{ ...base, p_home: 0.6 }]), /check/);
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [{ ...base, predicted_at: iso(Date.now() + DAY), kickoff_at: iso(NOW + 2 * DAY) }]), /check|future/);
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [{ ...base, kickoff_at: iso(NOW + 3 * DAY) }]), /kickoff_at does not match/);
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [{ ...base, home_score: 1, away_score: 0, outcome: 'home', settled_at: iso(NOW + 3 * DAY) }]), /unsettled/);
  await store.query(`update soccer_matches set status = 'live' where id = $1`, [f]);
  await assert.rejects(store.insert('soccer_model_shadow_predictions', [base]), /scheduled/);
  await store.close();
});

test('metrics use the declared baseline and roll 30/60/100 only on complete windows', () => {
  const rows = Array.from({ length: 64 }, (_, i) => ({ match_id: uuid(i), season_id: S26, predicted_at: iso(NOW + i * DAY), kickoff_at: iso(NOW + i * DAY + 3 * DAY), p_home: 0.5, p_draw: 0.25, p_away: 0.25, outcome: ['home', 'draw', 'away'][i % 3], settled_at: iso(NOW + i * DAY + 4 * DAY) }));
  const m = shadowMetrics({ rows, seasonLabel: { [S26]: '2026/27' }, missed: 2, baseline: spec.baseline });
  assert.equal(m.overall.n, 64); assert.equal(m.rolling.last_30.n, 30); assert.equal(m.rolling.last_60.n, 60); assert.equal(m.rolling.last_100.complete, false);
  assert.equal(m.counts.missed, 2); assert.equal(m.counts.late_issues, 0); assert.ok(m.by_season['2026/27'].n === 64);
  assert.ok(m.overall.baseline.log_loss > 0 && m.overall.classwise.length === 3);
});

test('no public surface: soccer-api, news, the web app and its build never reference the shadow', () => {
  const files = [];
  const walk = d => { if (!existsSync(d)) return; for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(m?js|jsx|ts|html|json|css)$/.test(f)) files.push(p); } };
  for (const d of ['workers/soccer-api', 'workers/soccer-news', 'src', 'api', 'server', 'public', 'dist']) walk(d);
  for (const f of ['middleware.js', 'index.html', 'vercel.json']) if (existsSync(f)) files.push(f);
  const hits = files.filter(f => /model_shadow|shadow_predictions|soccer-research-bundesliga|v1\.2-dc/.test(readFileSync(f, 'utf8')));
  assert.deepEqual(hits, []);
});
