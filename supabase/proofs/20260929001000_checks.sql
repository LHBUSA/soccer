-- Behavioural checks for 20260929001000 (run inside the rollback-only proof; always aborts).
do $$
declare sid uuid; ok boolean;
begin
  if not (select relrowsecurity from pg_class where relname = 'soccer_season_groups') then raise exception 'PROOF_FAIL rls on soccer_season_groups'; end if;
  if not (select relrowsecurity from pg_class where relname = 'soccer_video_channels') then raise exception 'PROOF_FAIL rls on soccer_video_channels'; end if;
  if (select count(*) from pg_policies where tablename in ('soccer_season_groups', 'soccer_video_channels')) <> 0 then raise exception 'PROOF_FAIL a public policy appeared'; end if;
  -- existing rows unchanged: no conference / league_phase row gained a parent
  if (select count(*) from public.soccer_season_groups where parent_group_key is not null or sort_order is not null) <> 0 then raise exception 'PROOF_FAIL existing groups changed'; end if;
  -- every channel with a competition is scoped to it
  if (select count(*) from public.soccer_video_channels where competition_id is not null and not (competition_id = any(scope_competition_ids))) <> 0 then raise exception 'PROOF_FAIL channel scope backfill'; end if;
  select id into sid from public.soccer_seasons limit 1;
  -- 'group' accepted with a tier parent
  insert into public.soccer_season_groups (id, season_id, group_key, name, abbreviation, group_type, provider, external_id, parent_group_key, parent_name, sort_order)
    values ('eeeeeeee-eeee-5eee-beee-eeeeeeeeeeee', sid, 'proof-a1', 'Group A1', 'A1', 'group', 'espn', 'proof', 'league-a', 'League A', 1);
  -- unknown type still rejected
  ok := false;
  begin insert into public.soccer_season_groups (id, season_id, group_key, name, group_type, provider, external_id) values ('eeeeeeee-eeee-5eee-beee-eeeeeeeeeeef', sid, 'proof-x', 'X', 'nations_league_group', 'espn', 'x');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'PROOF_FAIL unknown group_type accepted'; end if;
  -- parent key without a name rejected
  ok := false;
  begin insert into public.soccer_season_groups (id, season_id, group_key, name, group_type, provider, external_id, parent_group_key) values ('eeeeeeee-eeee-5eee-beee-eeeeeeeeeef0', sid, 'proof-y', 'Y', 'group', 'espn', 'y', 'league-b');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'PROOF_FAIL parent pair not enforced'; end if;
  raise exception 'PROOF_OK 1000 checks passed (rolled back)';
end $$;
