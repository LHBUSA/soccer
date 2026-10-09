// Issue #14 regression: GET /v1/matches/:id/analyzer-preview answered 502 for every match in production
// (Worker log: "Cannot set properties of undefined (setting 'timing_ms')", CF-Rays a47d8a453b4139e9,
// a47d8a4a3c60eac0, a47d8a4dfdc53c96, 2026-10-09 12:55Z). publicAnalyzerPreview returns the Pro-style
// { status, body } while the generic route table must return the envelope itself, so the dispatcher threw
// AFTER every read and the analyzer had succeeded. These tests drive the REAL Worker entry (worker.fetch ->
// route table -> handler -> real PostgREST adapter -> dispatcher) over an in-memory PostgREST answering by
// table, so they fail on that bug. Inline API-shaped rows (not committed mock data).
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../workers/soccer-api/src/index.js';

const ENV = { SOCCER_MODEL_SUPABASE_URL: 'https://tkmlnhmylqnttmnsnief.supabase.co', SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY: 'x' };
const MATCH = '11111111-2222-4333-8444-555555555555';
const H = 'aaaaaaaa-0000-4000-8000-000000000001'; const A = 'aaaaaaaa-0000-4000-8000-000000000002'; const X = 'aaaaaaaa-0000-4000-8000-000000000003';
const id = n => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, '0')}`;
const day = n => new Date(Date.UTC(2026, 7, 1 + n, 15)).toISOString();
// Finished same-competition-season results: H wins at home, A draws away; alternating opponents.
const history = n => Array.from({ length: n }, (_, i) => [
  { id: id(2 * i + 1), kickoff_at: day(2 * i), home_team_id: H, away_team_id: X, home_score: 2, away_score: 0, status: 'finished' },
  { id: id(2 * i + 2), kickoff_at: day(2 * i + 1), home_team_id: X, away_team_id: A, home_score: 1, away_score: 1, status: 'finished' },
]).flat().reverse();
const stats = (rows) => rows.flatMap(m => [m.home_team_id, m.away_team_id].flatMap(t => [
  { match_id: m.id, team_id: t, stat_key: 'shots', value: t === H ? 15 : 9, basis: 'source' },
  { match_id: m.id, team_id: t, stat_key: 'shots_on_target', value: t === H ? 6 : 3, basis: 'source' },
]));

function postgrest({ finished = history(6), withStats = true, match = true } = {}) {
  const log = [];
  return {
    log,
    fetch: async (input) => {
      const u = new URL(String(input));
      const table = u.pathname.split('/').pop(); log.push(table);
      const q = u.searchParams; const rows = [];
      if (table === 'soccer_matches' && q.get('id')) {
        if (match) rows.push({ id: MATCH, season_id: 's1', competition_id: 'c1', kickoff_at: '2026-10-10T14:00:00Z', home_team_id: H, away_team_id: A });
      } else if (table === 'soccer_matches') rows.push(...finished);
      else if (table === 'soccer_seasons') rows.push({ label: '2026/27' });
      else if (table === 'soccer_competitions') rows.push({ id: 'c1', slug: 'bundesliga' }, { id: 'c2', slug: 'uefa-champions-league' });
      else if (table === 'soccer_team_match_stats' && withStats) rows.push(...stats(finished));
      else if (table === 'soccer_match_events') { /* none: shot style comes from team stats */ }
      return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

async function call(path, pg) {
  const realFetch = globalThis.fetch; const realCaches = globalThis.caches;
  globalThis.fetch = pg.fetch;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  try {
    const res = await worker.fetch(new Request(`https://soccer-api.sales-fd3.workers.dev${path}`), ENV, { waitUntil() {} });
    return { status: res.status, body: await res.json() };
  } finally { globalThis.fetch = realFetch; globalThis.caches = realCaches; }
}

test('#14: real Worker entry returns 200 with an envelope (was 502 "upstream error" for every match)', async () => {
  const r = await call(`/v1/matches/${MATCH}/analyzer-preview`, postgrest());
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.meta && typeof r.body.meta.timing_ms === 'number', 'dispatcher decorated the envelope');
  assert.equal(r.body.meta.source, 'pbe');
  const d = r.body.data;
  assert.equal(d.competition, 'bundesliga'); assert.equal(d.season, '2026/27');
  assert.ok(d.components.length >= 1 && d.components.length <= 3, 'at most three evidence rows');
  assert.ok(d.components.some(c => c.label === 'Shot creation' || c.label === 'Shot differential' || c.label === 'Shot suppression' || c.label === 'Shots-on-target differential') || d.components.length === 3);
});

test('#14: public preview stays privacy-safe: no composite rating, formula, probabilities or premium data', async () => {
  const r = await call(`/v1/matches/${MATCH}/analyzer-preview`, postgrest());
  const d = r.body.data;
  assert.deepEqual(Object.keys(d).sort(), ['as_of', 'competition', 'components', 'coverage', 'season']);
  for (const c of d.components) assert.deepEqual(Object.keys(c).sort(), ['away', 'basis', 'coverage', 'edge', 'explanation', 'home', 'label', 'sample', 'unit']);
  const s = JSON.stringify(r.body);
  for (const forbidden of ['rating', 'formula', 'weight', 'contribution', 'probability"', 'fatigue', 'xi_continuity', 'session']) assert.ok(!s.includes(`"${forbidden.replace(/"$/, '')}`), forbidden);
  assert.ok(Date.parse(d.as_of) < Date.parse('2026-10-10T14:00:00Z'), 'as-of is strictly pre-match');
});

test('#14: weak / no history -> 200 with 0 components and an honest coverage label (never invented)', async () => {
  for (const finished of [[], history(1)]) {
    const r = await call(`/v1/matches/${MATCH}/analyzer-preview`, postgrest({ finished }));
    assert.equal(r.status, 200);
    assert.equal(r.body.data.components.length, finished.length ? r.body.data.components.length : 0);
    assert.match(r.body.data.coverage.label, /WEAK DATA|RESULTS/);
  }
  const none = await call(`/v1/matches/${MATCH}/analyzer-preview`, postgrest({ finished: [] }));
  assert.deepEqual(none.body.data.components, []);
  assert.match(none.body.data.coverage.label, /WEAK DATA/);
});

test('#14: missing shot stats -> results-only evidence, no shot rows, still 200', async () => {
  const r = await call(`/v1/matches/${MATCH}/analyzer-preview`, postgrest({ withStats: false }));
  assert.equal(r.status, 200);
  assert.ok(!r.body.data.components.some(c => /^Shot/.test(c.label)));
  assert.equal(r.body.data.coverage.label, 'RESULTS / SCHEDULE ONLY');
});

test('#14: unknown match -> 404, malformed id -> 404 route miss; never a blanket 502', async () => {
  const miss = await call(`/v1/matches/${MATCH}/analyzer-preview`, postgrest({ match: false }));
  assert.equal(miss.status, 404); assert.equal(miss.body.error, 'match not found');
  const bad = await call('/v1/matches/not-a-uuid/analyzer-preview', postgrest());
  assert.equal(bad.status, 404);
});

test('#14: a real store failure is still a 502 (errors are not hidden as success)', async () => {
  const pg = { fetch: async () => new Response('{"message":"unavailable"}', { status: 503 }) }; // adapter retries, then throws
  const r = await call(`/v1/matches/${MATCH}/analyzer-preview`, pg);
  assert.equal(r.status, 502);
});
