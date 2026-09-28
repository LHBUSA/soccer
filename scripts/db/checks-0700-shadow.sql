-- Rollback-proof checks for 20260928000700_soccer_model_shadow.sql (run inside the aborted
-- transaction built by build-single-rollback-proof.mjs; nothing here survives).
do $$
declare
  m record; pid uuid; ok boolean;
begin
  -- RLS on, no policies, no anon/authenticated privileges
  if exists (select 1 from pg_class where relname in ('soccer_model_shadow_predictions','soccer_model_shadow_events','soccer_model_shadow_metrics') and not relrowsecurity) then raise exception 'CHECK FAILED: RLS off'; end if;
  if exists (select 1 from pg_policies where tablename like 'soccer_model_shadow%') then raise exception 'CHECK FAILED: policy present'; end if;
  if has_table_privilege('anon', 'public.soccer_model_shadow_predictions', 'select') or has_table_privilege('authenticated', 'public.soccer_model_shadow_predictions', 'select')
     or has_table_privilege('anon', 'public.soccer_model_shadow_predictions', 'insert') then raise exception 'CHECK FAILED: anon/authenticated privilege'; end if;

  -- a real scheduled Bundesliga league fixture
  select x.id, x.competition_id, x.season_id, x.kickoff_at into m from soccer_matches x join soccer_competitions c on c.id = x.competition_id
    where c.slug = 'bundesliga' and x.status = 'scheduled' and x.kickoff_at > now() order by x.kickoff_at limit 1;
  if m.id is null then raise exception 'CHECK FAILED: no scheduled fixture'; end if;

  insert into soccer_model_shadow_predictions (model_id, model_version, calibration_id, competition_id, season_id, match_id, predicted_at, kickoff_at,
    p_home, p_draw, p_away, lambda_home, lambda_away, rho, input_hash, model_hash, input_as_of, input_count, attribution)
  values ('proof', '1.2.0', 'none', m.competition_id, m.season_id, m.id, now(), m.kickoff_at, 0.45, 0.25, 0.30, 1.6, 1.2, -0.1099,
    repeat('a', 64), repeat('b', 64), now() - interval '1 day', 100, '{}'::jsonb) returning id into pid;

  ok := false; begin update soccer_model_shadow_predictions set p_home = 0.5, p_away = 0.25 where id = pid; exception when others then ok := sqlerrm like '%frozen%'; end;
  if not ok then raise exception 'CHECK FAILED: prediction field update allowed'; end if;
  ok := false; begin update soccer_model_shadow_predictions set home_score = 1, away_score = 0, outcome = 'home', settled_at = m.kickoff_at + interval '3 hours' where id = pid; exception when others then ok := sqlerrm like '%not final%' or sqlerrm like '%future%'; end;
  if not ok then raise exception 'CHECK FAILED: early settlement allowed'; end if;
  ok := false; begin delete from soccer_model_shadow_predictions where id = pid; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: delete allowed'; end if;
  ok := false; begin
    insert into soccer_model_shadow_predictions (model_id, model_version, calibration_id, competition_id, season_id, match_id, predicted_at, kickoff_at,
      p_home, p_draw, p_away, lambda_home, lambda_away, rho, input_hash, model_hash, input_as_of, input_count, attribution)
    values ('proof', '1.2.0', 'none', m.competition_id, m.season_id, m.id, now(), m.kickoff_at, 0.45, 0.25, 0.30, 1.6, 1.2, -0.1099, repeat('a', 64), repeat('b', 64), now() - interval '1 day', 100, '{}'::jsonb);
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: second issue for the same model+match allowed'; end if;
  ok := false; begin
    insert into soccer_model_shadow_predictions (model_id, model_version, calibration_id, competition_id, season_id, match_id, predicted_at, kickoff_at,
      p_home, p_draw, p_away, lambda_home, lambda_away, rho, input_hash, model_hash, input_as_of, input_count, attribution)
    values ('proof2', '1.2.0', 'none', m.competition_id, m.season_id, m.id, now(), m.kickoff_at, 0.45, 0.25, 0.30, 1.6, 1.2, -0.1099, repeat('a', 64), repeat('b', 64), now(), 100, '{}'::jsonb);
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: input_as_of >= predicted_at allowed'; end if;
  insert into soccer_model_shadow_events (model_id, event) values ('proof', 'started');
  ok := false; begin update soccer_model_shadow_events set reason = 'x' where model_id = 'proof'; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: event update allowed'; end if;
end $$;
select 'ALL SHADOW CHECKS PASSED' as result, (select count(*) from soccer_model_shadow_predictions) as rows_in_txn;
