// Soccer Pro: explainable workload indices, descriptive matchup lab, and SERVER-SIDE gating
// (no premium values ever reach a reader without All Access / owner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { playerLoad, rotationPressure, squadStructure, teamFatigueIndex, teamLoad, weighted, xiLoad } from '../workers/soccer-api/src/pro/fatigue.js';
import { matchup, teamProfile, inBox, channelOf } from '../workers/soccer-api/src/pro/matchup.js';
import { proAccess, sessionCookie } from '../workers/soccer-api/src/pro/access.js';
import { handlePro } from '../workers/soccer-api/src/pro/routes.js';
import worker, { canonicalQuery } from '../workers/soccer-api/src/index.js';

const T = 'team-a'; const O = 'team-b';
const at = d => `2026-09-${String(d).padStart(2, '0')}T19:00:00Z`;
const m = (id, d, home, comp = 'premier-league', status = 'finished') => ({ id, kickoff_at: at(d), status, home_team_id: home ? T : O, away_team_id: home ? O : T, competition_slug: comp, duration: 'regular' });

test('team load: congestion, short rest, venue sequence, competition switches; extra time never assumed', () => {
  const ms = [m('1', 6, true), m('2', 10, false, 'uefa-champions-league'), m('3', 13, true), m('4', 16, false, 'uefa-champions-league'), m('5', 20, true), m('6', 24, false, 'premier-league', 'scheduled')];
  const L = teamLoad(ms, T, '2026-09-21T12:00:00Z');
  assert.equal(L.days_since_last, 0);
  assert.deepEqual([L.matches_7, L.matches_14, L.matches_21], [2, 4, 5]);
  assert.equal(L.short_rest_sequences_21, 2); // 10->13 and 13->16 are < 4 days apart (6->10 and 16->20 are 4)
  assert.equal(L.home_away_last5, 'HAHAH');
  assert.equal(L.competition_switches_last5, 4);
  assert.equal(L.extra_time_21, 0);
  assert.equal(L.next_match.id, '6'); assert.equal(L.next_match.rest_days_before, 4);
  const idx = teamFatigueIndex(L);
  assert.ok(idx.score > 0 && idx.score <= 100);
  assert.equal(idx.components.reduce((s, c) => s + c.contribution, 0).toFixed(0), String(idx.score)); // explainable: components sum to the score
  assert.deepEqual(idx.components.map(c => c.key), ['congestion_14', 'short_rest', 'rest', 'travel_sequence', 'competition_switching']);
});

test('player load and the club -> national team -> club return sequence (workload, not fitness)', () => {
  const a = (d, minutes, started, kind = 'club', extra = {}) => ({ match_id: `p${d}`, kickoff_at: at(d), minutes, started, came_on: !started && minutes > 0, team_kind: kind, ...extra });
  const P = playerLoad([a(3, 90, true), a(6, 90, true, 'national'), a(9, 75, true, 'national', { sub_off_minute: 75 }), a(13, 90, true), a(17, 20, false)], '2026-09-20T00:00:00Z');
  assert.deepEqual([P.minutes_7, P.minutes_14, P.minutes_21], [110, 275, 365]);
  assert.equal(P.consecutive_starts, 0); // the latest appearance was off the bench
  assert.equal(P.national_team_apps_21, 2);
  assert.equal(P.international_sequence_21, 'club → national → club');
  assert.equal(P.international_return, true);
  assert.equal(P.apps_90_plus_21, 3); assert.equal(P.avg_sub_off_minute_21, 75);
  for (const k of Object.keys(P)) assert.ok(!/injur|tired|exhaust|risk/i.test(k), k);
});

test('squad structure, XI load and rotation pressure are weighted, bounded and explained', () => {
  const xi = n => Array.from({ length: 11 }, (_, i) => `p${i + n}`);
  const xis = [{ starters: xi(0), minutes: Object.fromEntries(xi(0).map(p => [p, 90])) }, { starters: xi(1), minutes: Object.fromEntries(xi(1).map(p => [p, 90])) }, { starters: xi(0), minutes: Object.fromEntries(xi(0).map(p => [p, 90])) }];
  const S = squadStructure(xis);
  assert.equal(S.xi_continuity, 0.91); assert.equal(S.lineup_changes_avg, 1); assert.equal(S.rotation_depth, 12);
  const loads = new Map(xi(0).map(p => [p, { minutes_14: 180, international_return: p === 'p0' }]));
  const X = xiLoad(S.last_xi, loads, 2);
  assert.equal(X.components[0].value, 1); assert.equal(X.players.length, 11);
  const R = rotationPressure({ score: 60 }, S);
  assert.ok(R.score >= 0 && R.score <= 100);
  assert.deepEqual(weighted([{ key: 'a', value: 2, weight: 1 }]).score, 100); // values are clamped to [0, 1]
});

test('matchup lab: descriptive components, penalty-area and channel geometry, missing inputs skipped (never zero-filled)', () => {
  assert.equal(inBox({ x_m: 95, y_m: 34 }), true); assert.equal(inBox({ x_m: 80, y_m: 34 }), false);
  assert.equal(channelOf({ y_m: 5 }), 'right'); assert.equal(channelOf({ y_m: 60 }), 'left'); assert.equal(channelOf({ y_m: 34 }), 'centre');
  const g = (gf, ga, shots, home = true) => ({ home, gf, ga, stats: { shots, shots_on_target: 4 }, opp_stats: { shots: 8, shots_on_target: 3 }, shots: [{ x_m: 95, y_m: 34 }, { x_m: 80, y_m: 10, set_piece: 'free_kick' }], goals: [{ minute: 30 }], conceded: [] });
  const H = teamProfile([g(2, 0, 16), g(3, 1, 14), g(1, 1, 12, false)]);
  const A = teamProfile([{ home: false, gf: 0, ga: 2, stats: null, opp_stats: null, shots: [], goals: [], conceded: [{ minute: 60 }] }]);
  assert.equal(H.inside_box_share, 0.5); assert.deepEqual(H.form_last5, ['W', 'W', 'D']);
  assert.equal(A.shots_for_pg, null); // no stats: null, not zero
  const lab = matchup(H, A, {});
  assert.ok(lab.rating.home > 50 && lab.rating.home + lab.rating.away === 100);
  assert.match(lab.rating_label, /Not a win probability/);
  assert.equal(lab.components.find(c => c.key === 'attack_edge').edge, null); // away side has no shot stats -> skipped
  assert.ok(lab.rating.components_used < lab.rating.components_total);
  assert.ok(!JSON.stringify(lab).match(/probability\b(?! )/i) || /Not a win probability/.test(lab.rating_label));
});

// ---- server-side gating --------------------------------------------------------------------
const authBinding = state => ({ fetch: async (url, init) => {
  assert.equal(new URL(url).pathname, '/membership'); assert.equal(new URL(url).searchParams.get('sport'), 'soccer');
  assert.match(init.headers.cookie, /^pbe_session=/);
  if (state === 'down') throw new Error('network');
  if (state === '500') return new Response('x', { status: 500 });
  const entitled = state === 'all_access' || state === 'owner';
  return Response.json({ authenticated: state !== 'anon', membership: { sport: 'soccer', state: entitled ? state : 'free', label: state.toUpperCase(), entitled, email: 'r@example.com', show_purchase_cta: !entitled, show_manage: state === 'all_access', manage_url: 'https://billing.stripe.com/p/login/x' } });
} });
const TOKEN = 'test-session-token-not-a-real-jwt-0123456789';
const req = (path, cookie = `pbe_session=${TOKEN}`) => new Request(`https://soccer-api.example/v1/pro/${path}`, { headers: cookie ? { cookie } : {} });

test('public cache query keys are canonical and reject fragmentation inputs', () => {
  assert.equal(canonicalQuery(new URLSearchParams('limit=5&competition=bundesliga'), ['competition', 'limit']), 'competition=bundesliga&limit=5');
  assert.equal(canonicalQuery(new URLSearchParams('token=x&limit=5'), ['limit']), null);
  assert.equal(canonicalQuery(new URLSearchParams('limit=5&limit=6'), ['limit']), null);
  assert.equal(canonicalQuery(new URLSearchParams(''), []), '');
  assert.equal(canonicalQuery(new URLSearchParams(`q=${'x'.repeat(65)}`), ['q']), null);
});

test('access: only all_access and owner are Pro; sport-only, lapsed, anonymous, auth down -> FREE (fail closed)', async () => {
  assert.equal(sessionCookie(req('access', `a=1; pbe_session=${TOKEN}; b=2`)), TOKEN);
  assert.equal(sessionCookie(req('access', 'pbe_session=<script>')), null);
  for (const [state, pro] of [['all_access', true], ['owner', true], ['free', false], ['sport_pro', false]]) {
    const a = await proAccess(req('access'), { AUTH: authBinding(state) });
    assert.equal(a.granted, pro, state);
  }
  assert.equal((await proAccess(req('access', null), { AUTH: authBinding('all_access') })).granted, false); // no cookie: auth never asked
  for (const s of ['down', '500']) { const a = await proAccess(req('access'), { AUTH: authBinding(s) }); assert.deepEqual([a.granted, a.check], [false, 'unavailable'], s); }
  assert.equal((await proAccess(req('access'), {})).granted, false); // no binding
});

test('premium without entitlement: 403 all_access_required and NO values; never cached', async () => {
  const store = { select: async () => { throw new Error('premium data must not be read for a free reader'); }, count: async () => 0 };
  for (const path of ['board', 'matches/96fdfa45-cde7-5a8d-887a-b9620fb7b0e7', 'teams/italy']) {
    const r = await handlePro(req(path), { AUTH: authBinding('free') }, store, path);
    assert.equal(r.status, 403, path);
    assert.deepEqual(r.body, { error: 'all_access_required', membership: 'free', check: 'ok' });
  }
  const res = await worker.fetch(req('board'), { AUTH: authBinding('free'), SOCCER_MODEL_SUPABASE_URL: 'https://tkmlnhmylqnttmnsnief.supabase.co', SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY: 'x' }, { waitUntil() {} });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('cache-control'), /^private, no-store(, no-transform)?$/);
  assert.deepEqual(await res.json(), { error: 'all_access_required', membership: 'free', check: 'ok' });
});

test('catalog is public and carries no premium values; model lab stays research', async () => {
  const store = { select: async () => [{ slug: 'uefa-nations-league', name: 'UEFA Nations League' }], count: async () => 7 };
  const r = await handlePro(req('catalog', null), {}, store, 'catalog');
  assert.equal(r.status, 200);
  const s = JSON.stringify(r.body);
  assert.ok(!/team_fatigue_index|"score"|rating/.test(s.replace(/TEAM FATIGUE INDEX|PBE MATCHUP RATING/g, '')));
  assert.equal(r.body.data.model_lab.label, 'RESEARCH IN PROGRESS');
  assert.equal(r.body.data.offer.promo_code, 'THEEDGE25');
});
