-- Rollback-proof checks for 20261002001500_soccer_repeated_fixtures.sql. Run as:
--   begin; <checks-1500-before.sql>; <migration>; <this file>; rollback;
-- (scripts/db/build-1500-proof.mjs). Nothing survives.
do $$
declare cid uuid; sid uuid; stid uuid; t1 uuid; t2 uuid; ok boolean;
begin
  -- index swap
  if to_regclass('public.soccer_matches_natural_key') is not null then raise exception 'CHECK FAILED: old natural key still present'; end if;
  if to_regclass('public.soccer_matches_fixture_slot') is null then raise exception 'CHECK FAILED: fixture slot guard missing'; end if;
  -- C / D: existing Premier League + Bundesliga rows and every crosswalk unchanged (fingerprints taken in this txn before)
  if (select pl from pg_temp.fp_1500) is distinct from (select md5(string_agg(m.id::text||m.kickoff_at::text||coalesce(m.home_score,-1)||coalesce(m.away_score,-1)||m.result_provider, ',' order by m.id)) from soccer_matches m join soccer_competitions c on c.id=m.competition_id where c.slug='premier-league') then raise exception 'CHECK FAILED: Premier League rows changed'; end if;
  if (select bl from pg_temp.fp_1500) is distinct from (select md5(string_agg(m.id::text||m.kickoff_at::text||coalesce(m.home_score,-1)||coalesce(m.away_score,-1)||m.result_provider, ',' order by m.id)) from soccer_matches m join soccer_competitions c on c.id=m.competition_id where c.slug='bundesliga') then raise exception 'CHECK FAILED: Bundesliga rows changed'; end if;
  if (select xw from pg_temp.fp_1500) is distinct from (select md5(string_agg(provider||external_id||match_id::text, ',' order by provider, external_id)) from soccer_match_external_ids) then raise exception 'CHECK FAILED: crosswalks changed'; end if;
  if (select n from pg_temp.fp_1500) <> (select count(*) from soccer_matches) then raise exception 'CHECK FAILED: match count changed'; end if;
  -- A: same pairing + stage on two different dates -> two matches
  select id into cid from soccer_competitions where slug = 'mls';
  select id into t1 from soccer_teams order by id limit 1;
  select id into t2 from soccer_teams order by id offset 1 limit 1;
  sid := gen_random_uuid(); stid := gen_random_uuid();
  insert into soccer_seasons (id, competition_id, label) values (sid, cid, 'proof-1500');
  insert into soccer_stages (id, season_id, name, stage_type, stage_order) values (stid, sid, 'Regular Season', 'league', 1);
  insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, status, home_team_id, away_team_id, home_score, away_score, result_provider) values (gen_random_uuid(), cid, sid, stid, '2001-05-05T19:00:00Z', 'finished', t1, t2, 2, 1, 'espn');
  insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, status, home_team_id, away_team_id, home_score, away_score, result_provider) values (gen_random_uuid(), cid, sid, stid, '2001-08-18T19:00:00Z', 'finished', t1, t2, 0, 0, 'espn');
  if (select count(*) from soccer_matches where season_id = sid) <> 2 then raise exception 'CHECK FAILED: repeated fixture not stored'; end if;
  -- B: exact duplicate slot (same season, pairing, stage, kickoff) -> rejected
  ok := false;
  begin insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, status, home_team_id, away_team_id, result_provider) values (gen_random_uuid(), cid, sid, stid, '2001-05-05T19:00:00Z', 'scheduled', t1, t2, 'espn'); exception when unique_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: duplicate fixture slot accepted'; end if;
  raise notice 'CHECKS PASSED (repeated fixtures)';
end $$;
