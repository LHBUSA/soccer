-- Behavioural checks for 20260928000600 (run inside the rollback-only proof).
do $$
declare mid uuid; st text; ok boolean;
begin
  select id into mid from public.soccer_matches where status = 'finished' limit 1;
  foreach st in array array['soccer_match_enrichment','soccer_season_groups','soccer_season_group_members','soccer_source_standings','soccer_media_discovery'] loop
    if not (select relrowsecurity from pg_class where relname = st) then raise exception 'PROOF_FAIL rls on %', st; end if;
  end loop;
  -- complete is never downgraded by a later failed attempt
  insert into public.soccer_match_enrichment (match_id, component, provider, status, attempts) values (mid, 'plays', 'espn', 'complete', 1);
  update public.soccer_match_enrichment set status = 'unavailable', attempts = 2, next_retry_at = now() where match_id = mid and component = 'plays';
  select status into st from public.soccer_match_enrichment where match_id = mid and component = 'plays';
  if st <> 'complete' then raise exception 'PROOF_FAIL complete component was downgraded to %', st; end if;
  -- unavailable can later become complete
  insert into public.soccer_match_enrichment (match_id, component, provider, status, attempts) values (mid, 'stats_home', 'espn', 'unavailable', 1);
  update public.soccer_match_enrichment set status = 'complete' where match_id = mid and component = 'stats_home';
  select status into st from public.soccer_match_enrichment where match_id = mid and component = 'stats_home';
  if st <> 'complete' then raise exception 'PROOF_FAIL unavailable could not complete'; end if;
  -- invalid component rejected
  ok := false;
  begin insert into public.soccer_match_enrichment (match_id, component, provider, status) values (mid, 'result', 'espn', 'complete');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'PROOF_FAIL result is not an enrichment component'; end if;
  -- media: trademark status separate from copyright; default unknown
  if (select count(*) from public.soccer_entity_media where trademark_status <> 'unknown') > 0 then raise exception 'PROOF_FAIL trademark default'; end if;
  raise exception 'PROOF_OK 0600 checks passed (rolled back)';
end $$;
