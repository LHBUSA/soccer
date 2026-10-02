-- Rollback-proof checks for 20261002001400_soccer_season_publication.sql (run inside the aborted transaction built by
-- build-single-rollback-proof.mjs; nothing here survives).
do $$
declare n_seasons bigint; n_matches bigint; n_articles bigint; ok boolean; cid uuid; sid uuid; tid1 uuid; tid2 uuid; stid uuid;
begin
  select count(*) into n_seasons from soccer_seasons;
  select count(*) into n_matches from soccer_matches;
  select count(*) into n_articles from soccer_articles;
  -- every existing season is published, with a timestamp and a note; nothing is held
  if exists (select 1 from soccer_seasons where publication_state <> 'published' or published_at is null or publication_note is null) then raise exception 'CHECK FAILED: an existing season is not published'; end if;
  -- the public views show exactly today's product
  if (select count(*) from soccer_public_seasons) <> n_seasons then raise exception 'CHECK FAILED: public seasons % <> %', (select count(*) from soccer_public_seasons), n_seasons; end if;
  if (select count(*) from soccer_public_matches) <> n_matches then raise exception 'CHECK FAILED: public matches % <> %', (select count(*) from soccer_public_matches), n_matches; end if;
  -- views run with the caller's privileges; no anon/authenticated access
  if not exists (select 1 from pg_class where relname = 'soccer_public_matches' and reloptions::text like '%security_invoker=true%') then raise exception 'CHECK FAILED: soccer_public_matches not security_invoker'; end if;
  if not exists (select 1 from pg_class where relname = 'soccer_public_seasons' and reloptions::text like '%security_invoker=true%') then raise exception 'CHECK FAILED: soccer_public_seasons not security_invoker'; end if;
  if has_table_privilege('anon', 'public.soccer_public_matches', 'select') or has_table_privilege('authenticated', 'public.soccer_public_seasons', 'select') then raise exception 'CHECK FAILED: anon/authenticated privilege on a public view'; end if;
  -- a new season with no state is HELD and invisible, with its matches
  select id into cid from soccer_competitions limit 1;
  select id into tid1 from soccer_teams order by id limit 1;
  select id into tid2 from soccer_teams order by id offset 1 limit 1;
  sid := gen_random_uuid(); stid := gen_random_uuid();
  insert into soccer_seasons (id, competition_id, label) values (sid, cid, 'proof-1999/00');
  if (select publication_state from soccer_seasons where id = sid) <> 'held' then raise exception 'CHECK FAILED: default is not held'; end if;
  insert into soccer_stages (id, season_id, name, stage_type, stage_order) values (stid, sid, 'Proof', 'league', 1);
  insert into soccer_matches (id, competition_id, season_id, stage_id, kickoff_at, status, home_team_id, away_team_id, home_score, away_score, result_provider) values (gen_random_uuid(), cid, sid, stid, '1999-09-01T15:00:00Z', 'finished', tid1, tid2, 1, 0, 'espn');
  if exists (select 1 from soccer_public_seasons where id = sid) or exists (select 1 from soccer_public_matches where season_id = sid) then raise exception 'CHECK FAILED: held season visible'; end if;
  -- published needs published_at; an explicit promotion makes it visible
  ok := false; begin update soccer_seasons set publication_state = 'published' where id = sid; exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: published without published_at accepted'; end if;
  update soccer_seasons set publication_state = 'published', published_at = now(), reviewed_at = now() where id = sid;
  if not exists (select 1 from soccer_public_matches where season_id = sid) then raise exception 'CHECK FAILED: promoted season not visible'; end if;
  ok := false; begin update soccer_seasons set publication_state = 'live' where id = sid; exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown state accepted'; end if;
  if (select count(*) from soccer_articles) <> n_articles then raise exception 'CHECK FAILED: articles changed'; end if;
  raise notice 'CHECKS PASSED (season publication gate: % seasons published, % matches public)', n_seasons, n_matches;
end $$;
