import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMigrations, openPglite, syncRows } from '../workers/soccer-ingest/src/store.js';
import { ingestWyscoutSeason } from '../workers/soccer-ingest/src/wyscout-lane.js';
import { mintId } from '../workers/shared/ids.js';

const REGISTRY = { competitions: [{ slug: 'bundesliga', name: 'Bundesliga', comp_type: 'league', gender: 'men', country_code: 'DEU', tier: 1, external_ids: [{ provider: 'wyscout', external_id: '426', method: 'founding', evidence: 'test' }] }] };

async function fresh() {
  const store = await openPglite();
  await applyMigrations(store);
  await store.query(`insert into soccer_source_captures (capture_id, source_key, family, request_url, captured_at, http_status, content_sha256, bytes, raw_key)
    values ('aaaaaaaaaaaaaaaaaaaaaaaa','test','wyscout_figshare','https://t/','2026-09-27T00:00:00Z',200,'${'0'.repeat(64)}',1,'k')`);
  return store;
}

test('migrations refuse a non-sports target and an identity/billing target', async () => {
  const bare = await openPglite({ sportsProjectStubs: false });
  await assert.rejects(applyMigrations(bare), /must target the sports project/);
  await bare.close();
  const identity = await openPglite();
  await identity.exec('create table public.pbe_sport_entitlements (id int)');
  await assert.rejects(applyMigrations(identity), /identity\/billing project detected/);
  await identity.close();
});

test('every soccer table has RLS on and no public policy', async () => {
  const store = await fresh();
  const { rows } = await store.query(`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'soccer_%'`);
  assert.ok(rows.length >= 28, `found ${rows.length} tables`);
  for (const r of rows) assert.equal(r.relrowsecurity, true, `${r.relname} lacks RLS`);
  const { rows: pol } = await store.query(`select * from pg_policies where tablename like 'soccer_%'`);
  assert.equal(pol.length, 0);
  await store.close();
});

test('schema enforces the contracts: no merged-without-target, no published metric without backtest, frozen packets, gated publication', async () => {
  const store = await fresh();
  await assert.rejects(store.query(`insert into soccer_teams (id, slug, name, team_type, status, founding_provider, founding_external_id) values (gen_random_uuid(), 'x', 'X', 'club', 'merged', 'p', '1')`));
  await assert.rejects(store.query(`insert into soccer_metric_definitions (metric_key, version, status, formula_doc, required_inputs) values ('pbe_xg','1','published','d','{a}')`));
  await assert.rejects(store.query(`insert into soccer_team_external_ids (provider, external_id, team_id, method) values ('p','1', gen_random_uuid(), 'name_match')`));
  const ev = 'ffffffff-ffff-5fff-bfff-ffffffffffff';
  await store.query(`insert into soccer_news_events (id, story_class, desk, materiality, as_of) values ($1,'match_recap','bundesliga',0.5, now())`, [ev]);
  await store.query(`insert into soccer_article_evidence (packet_hash, news_event_id, packet_version, packet) values ($1,$2,'v','{}')`, ['a'.repeat(64), ev]);
  await assert.rejects(store.query(`update soccer_article_evidence set packet = '{"x":1}'`), /append-only/);
  await assert.rejects(store.query(`delete from soccer_article_evidence`), /append-only/);
  await assert.rejects(store.query(`insert into soccer_articles (id, slug, news_event_id, packet_hash, story_class, desk, headline, body, composer, gate_version, gate_results, status, hold_reasons)
    values (gen_random_uuid(),'s',$1,$2,'match_recap','bundesliga','H','[]','c','g','[]','published','{numeric_grounding}')`, [ev, 'a'.repeat(64)]));
  await store.close();
});

test('syncRows: insert, idempotent re-run, and mutation logged to the change ledger', async () => {
  const store = await fresh();
  const id = mintId('team', 'test', 1);
  const row = { id, slug: 'a', name: 'A', short_name: null, official_name: null, team_type: 'club', gender: 'men', country_code: 'DEU', city: null, founding_provider: 'test', founding_external_id: '1' };
  assert.deepEqual(await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: [row] }), { inserted: 1, updated: 0, unchanged: 0 });
  assert.deepEqual(await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: [row] }), { inserted: 0, updated: 0, unchanged: 1 });
  const s = await syncRows(store, { table: 'soccer_teams', key: ['id'], rows: [{ ...row, city: 'Berlin' }], provider: 'test', captureId: 'aaaaaaaaaaaaaaaaaaaaaaaa' });
  assert.equal(s.updated, 1);
  const { rows } = await store.query(`select entity_id, field, old_value, new_value from soccer_source_changes`);
  assert.deepEqual(rows, [{ entity_id: id, field: 'city', old_value: null, new_value: 'Berlin' }]);
  await store.close();
});

// A two-team, one-match synthetic season through the real lane.
function syntheticParsed({ scorerDob = '1990-01-01' } = {}) {
  const players = [
    { provider: 'wyscout', external_id: '10', short_name: 'A. Striker', first_name: 'Anton', middle_name: null, last_name: 'Striker', birth_date: scorerDob, birth_area_code: 'DEU', passport_area_code: 'DEU', foot: 'right', height_cm: 185, weight_kg: 80, primary_role: 'forward' },
    { provider: 'wyscout', external_id: '11', short_name: 'Keeper', first_name: 'Karl', middle_name: null, last_name: 'Keeper', birth_date: '1991-02-02', birth_area_code: 'DEU', passport_area_code: 'DEU', foot: 'left', height_cm: 190, weight_kg: 85, primary_role: 'goalkeeper' },
    { provider: 'wyscout', external_id: '12', short_name: 'S. Sub', first_name: 'Sam', middle_name: null, last_name: 'Sub', birth_date: '1995-03-03', birth_area_code: 'DEU', passport_area_code: 'DEU', foot: null, height_cm: null, weight_kg: null, primary_role: 'forward' },
  ];
  const side = (team, starters, bench = [], subs = []) => ({ team_external_id: team, coach_external_id: null, has_formation: true, starters, bench, substitutions: subs });
  const matches = [{ provider: 'wyscout', external_id: '900', competition_external_id: '426', season_external_id: '181137', round_external_id: '1', gameweek: 1, kickoff_utc: '2017-08-18T18:30:00.000Z', label: 'H - A, 1 - 0', status: 'finished', duration: 'regular', venue_name: 'Test Arena',
    home: { ...side('1', ['10'], ['12'], [{ player_in: '12', player_out: '10', minute: 80 }]), score: 1, score_ht: 1, score_et: 0, score_p: 0 },
    away: { ...side('2', ['11']), score: 0, score_ht: 0, score_et: 0, score_p: 0 }, winner_external_id: '1', referees: [] }];
  const e = (id, seq, team, player, type, extra = {}) => ({ provider: 'wyscout', source_event_id: String(id), match_external_id: '900', sequence: seq, team_external_id: team, player_external_id: player, period: '1H', clock_seconds: seq * 10, minute: 1, event_type: type, subtype: type, set_piece: null, outcome: null, body_part: null, under_pressure: null, is_goal: false, is_own_goal: false, is_assist: false, is_key_pass: false, is_counter: false, card: null, source_x: 50, source_y: 50, source_end_x: 60, source_end_y: 50, source_coordinate_system: 'wyscout_pct_v1', x_m: 52.5, y_m: 34, end_x_m: 63, end_y_m: 34, tags: [], raw: { id }, ...extra });
  const events = [e(1, 1, '1', '10', 'pass', { outcome: 'success' }), e(2, 2, '1', '10', 'shot', { is_goal: true, outcome: 'goal', end_x_m: null, end_y_m: null }), e(3, 3, '2', '0', 'interruption')];
  return { teams: [{ provider: 'wyscout', external_id: '1', name: 'Home FC', official_name: 'Home FC', city: 'H', area_code: 'DEU', team_type: 'club' }, { provider: 'wyscout', external_id: '2', name: 'Away FC', official_name: 'Away FC', city: 'A', area_code: 'DEU', team_type: 'club' }],
    players, coaches: [], matches, events, unmapped: {} };
}
const CAPS = { competitions: 'aaaaaaaaaaaaaaaaaaaaaaaa', teams: 'aaaaaaaaaaaaaaaaaaaaaaaa', players: 'aaaaaaaaaaaaaaaaaaaaaaaa', coaches: 'aaaaaaaaaaaaaaaaaaaaaaaa', matches: 'aaaaaaaaaaaaaaaaaaaaaaaa', matches_at: '2026-09-27T00:00:00Z', events: 'aaaaaaaaaaaaaaaaaaaaaaaa', events_at: '2026-09-27T00:00:00Z' };

test('wyscout lane: full season write, second run writes nothing, derived minutes honour substitutions', async () => {
  const store = await fresh();
  const r1 = await ingestWyscoutSeason(store, { registry: REGISTRY, competitionExternalId: 426, parsed: syntheticParsed(), captures: CAPS });
  assert.equal(r1.counts.events.inserted, 3);
  assert.equal(r1.counts.players.inserted, 3);
  const r2 = await ingestWyscoutSeason(store, { registry: REGISTRY, competitionExternalId: 426, parsed: syntheticParsed(), captures: CAPS });
  const writes = JSON.stringify(r2.counts).match(/"(inserted|updated)":[1-9]/g);
  assert.equal(writes, null, `second run wrote: ${JSON.stringify(r2.counts)}`);
  const { rows: [m] } = await store.query(`select home_score, away_score, (select count(*)::int from soccer_match_events where is_goal) goals from soccer_matches`);
  assert.deepEqual(m, { home_score: 1, away_score: 0, goals: 1 });
  const { rows: mins } = await store.query(`select p.display_name, s.value::int v from soccer_player_match_stats s join soccer_players p on p.id = s.player_id where s.stat_key = 'minutes_nominal' order by 1`);
  assert.deepEqual(mins, [{ display_name: 'Anton Striker', v: 80 }, { display_name: 'Keeper', v: 90 }, { display_name: 'Sam Sub', v: 10 }]);
  // provider id 0 (no player) is never turned into a person
  const { rows: [n] } = await store.query(`select count(*)::int n from soccer_match_events where player_id is null`);
  assert.equal(n.n, 1);
  await store.close();
});

test('wyscout lane: a strong-attribute collision with another provider queues instead of founding', async () => {
  const store = await fresh();
  await store.query(`insert into soccer_players (id, slug, display_name, first_name, last_name, birth_date, founding_provider, founding_external_id)
    values ($1, 'anton-striker', 'Anton Striker', 'Anton', 'Striker', '1990-01-01', 'other', '77')`, [mintId('player', 'other', 77)]);
  const r = await ingestWyscoutSeason(store, { registry: REGISTRY, competitionExternalId: 426, parsed: syntheticParsed(), captures: CAPS });
  assert.deepEqual(r.queued, [{ player: '10', reason: 'collision' }]);
  const { rows } = await store.query(`select reason, candidate_ids from soccer_identity_queue`);
  assert.equal(rows[0].reason, 'strong_attribute_collision_with_other_provider');
  const { rows: [c] } = await store.query(`select count(*)::int n from soccer_players where display_name = 'Anton Striker'`);
  assert.equal(c.n, 1); // not duplicated, not merged
  await store.close();
});
