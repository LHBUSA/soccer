-- Rollback-proof checks for 20260929001200_soccer_algo_picks.sql (run inside the aborted transaction built by
-- build-single-rollback-proof.mjs; nothing here survives).
do $$
declare m record; fid uuid; pid uuid; ok boolean; n_shadow bigint;
begin
  if exists (select 1 from pg_class where relname in ('soccer_algo_forecasts','soccer_algo_picks','soccer_algo_events') and not relrowsecurity) then raise exception 'CHECK FAILED: RLS off'; end if;
  if exists (select 1 from pg_policies where tablename like 'soccer_algo%') then raise exception 'CHECK FAILED: policy present'; end if;
  if has_table_privilege('anon', 'public.soccer_algo_picks', 'select') or has_table_privilege('anon', 'public.soccer_algo_picks', 'insert')
     or has_table_privilege('authenticated', 'public.soccer_algo_picks', 'insert') then raise exception 'CHECK FAILED: anon/authenticated privilege'; end if;
  select count(*) into n_shadow from soccer_model_shadow_predictions;

  -- grading
  if public.soccer_algo_grade('1x2','home',2,1) <> 'win' or public.soccer_algo_grade('1x2','home',1,1) <> 'loss' or public.soccer_algo_grade('home_to_score','yes',0,2) <> 'loss'
     or public.soccer_algo_grade('1x2','draw',0,0) <> 'win' or public.soccer_algo_grade('over_2_5','over',2,1) <> 'win' then raise exception 'CHECK FAILED: grading'; end if;

  -- a real scheduled Bundesliga league fixture more than 2 h away
  select x.id, x.competition_id, x.season_id, x.kickoff_at into m from soccer_matches x join soccer_competitions c on c.id = x.competition_id
    where c.slug = 'bundesliga' and x.status = 'scheduled' and x.kickoff_at > now() + interval '2 hours' order by x.kickoff_at limit 1;
  if m.id is null then raise exception 'CHECK FAILED: no scheduled fixture'; end if;

  insert into soccer_algo_forecasts (algo_version, model_id, model_hash, pick_policy_version, spec_hash, competition_id, season_id, match_id, issued_at, kickoff_at, input_as_of, input_hash, input_count, lambda_home, lambda_away, probabilities, game_best)
    values ('proof', 'soccer-research-bundesliga-v1.2-dc', repeat('a',64), 'p', repeat('c',64), m.competition_id, m.season_id, m.id, now(), m.kickoff_at, now() - interval '1 day', repeat('b',64), 100, 2.1, 0.8, '{}'::jsonb, '{}'::jsonb) returning id into fid;
  ok := false; begin update soccer_algo_forecasts set lambda_home = 3 where id = fid; exception when others then ok := sqlerrm like '%immutable%'; end;
  if not ok then raise exception 'CHECK FAILED: forecast updatable'; end if;

  -- a pick whose lock has already passed is refused
  ok := false; begin
    insert into soccer_algo_picks (forecast_id, algo_version, model_id, model_version, model_hash, pick_policy_version, spec_hash, competition_id, season_id, match_id, market, selection, model_probability, threshold, lambda_home, lambda_away, issued_at, lock_at, kickoff_at, input_as_of, input_hash)
      values (fid, 'proof', 'm', '1.2.0', repeat('a',64), 'p', repeat('c',64), m.competition_id, m.season_id, m.id, '1x2', 'home', 0.66, 0.6, 2.1, 0.8, now() - interval '2 hours', now() - interval '1 hour', m.kickoff_at, now() - interval '1 day', repeat('b',64));
  exception when others then ok := sqlerrm like '%after lock%'; end;
  if not ok then raise exception 'CHECK FAILED: post-lock pick accepted'; end if;

  insert into soccer_algo_picks (forecast_id, algo_version, model_id, model_version, model_hash, pick_policy_version, spec_hash, competition_id, season_id, match_id, market, selection, model_probability, threshold, lambda_home, lambda_away, issued_at, lock_at, kickoff_at, input_as_of, input_hash)
    values (fid, 'proof', 'm', '1.2.0', repeat('a',64), 'p', repeat('c',64), m.competition_id, m.season_id, m.id, '1x2', 'home', 0.66, 0.6, 2.1, 0.8, now(), m.kickoff_at - interval '60 minutes', m.kickoff_at, now() - interval '1 day', repeat('b',64)) returning id into pid;
  ok := false; begin update soccer_algo_picks set model_probability = 0.9 where id = pid; exception when others then ok := sqlerrm like '%frozen%'; end;
  if not ok then raise exception 'CHECK FAILED: prediction field update allowed'; end if;
  update soccer_algo_picks set sportsbook = 'proof-book', price_decimal = 1.55, price_american = -182, price_captured_at = now() where id = pid;
  ok := false; begin update soccer_algo_picks set price_decimal = 1.60 where id = pid; exception when others then ok := sqlerrm like '%write-once%'; end;
  if not ok then raise exception 'CHECK FAILED: second price accepted'; end if;
  ok := false; begin update soccer_algo_picks set status = 'win', settled_at = now(), final_home_score = 1, final_away_score = 0 where id = pid; exception when others then ok := sqlerrm like '%not final%'; end;
  if not ok then raise exception 'CHECK FAILED: settlement before the match is final'; end if;
  ok := false; begin update soccer_algo_picks set status = 'void', settled_at = now() where id = pid; exception when others then ok := sqlerrm like '%void only%'; end;
  if not ok then raise exception 'CHECK FAILED: void of a scheduled match'; end if;
  ok := false; begin delete from soccer_algo_picks where id = pid; exception when others then ok := sqlerrm like '%immutable%'; end;
  if not ok then raise exception 'CHECK FAILED: delete allowed'; end if;
  ok := false; begin truncate soccer_algo_events; exception when others then ok := sqlerrm like '%immutable%'; end;
  if not ok then raise exception 'CHECK FAILED: truncate allowed'; end if;
  if (select count(*) from soccer_model_shadow_predictions) <> n_shadow then raise exception 'CHECK FAILED: shadow data changed'; end if;
  raise notice 'CHECKS PASSED (algo picks ledger)';
end $$;
