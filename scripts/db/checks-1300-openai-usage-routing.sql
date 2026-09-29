-- Rollback-proof checks for 20260929001300_soccer_news_openai_usage_routing.sql (run inside the aborted transaction
-- built by build-single-rollback-proof.mjs; nothing here survives).
do $$
declare rid uuid; ok boolean; n_rows bigint; n_articles bigint;
begin
  select count(*) into n_articles from soccer_articles;
  if not exists (select 1 from pg_class where relname = 'soccer_news_openai_usage' and relrowsecurity) then raise exception 'CHECK FAILED: RLS off'; end if;
  if exists (select 1 from pg_policies where tablename = 'soccer_news_openai_usage') then raise exception 'CHECK FAILED: policy present'; end if;
  if has_table_privilege('anon', 'public.soccer_news_openai_usage', 'select') or has_table_privilege('authenticated', 'public.soccer_news_openai_usage', 'insert') then raise exception 'CHECK FAILED: anon/authenticated privilege'; end if;
  if (select count(*) from information_schema.columns where table_name = 'soccer_news_openai_usage' and column_name in ('sport','worker','story_class','routing_lane','routing_reason','pool','router_version','latency_ms','nominal_standard_cost')) <> 9 then raise exception 'CHECK FAILED: routing columns missing'; end if;

  -- existing rows keep NULL routing fields
  select count(*) into n_rows from soccer_news_openai_usage where routing_lane is not null or sport is not null;
  if n_rows <> 0 then raise exception 'CHECK FAILED: existing rows were given routing values'; end if;

  -- a routed row inserts; the old row shape (no routing fields) still inserts
  insert into soccer_news_openai_usage (occurred_at, finished_at, article_id, news_event_id, slug, trigger, attempt, model, response_id, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, estimated_usd, status, desk_version, worker_version,
                                        sport, worker, story_class, routing_lane, routing_reason, pool, router_version, latency_ms, nominal_standard_cost)
    values (now() - interval '1 minute', now(), gen_random_uuid(), gen_random_uuid(), 'proof-slug', 'canary', 1, 'gpt-5.6-sol', 'resp_proof', 12000, 0, 2500, 900, 0.04, 'completed', 'soccer-desk/2.1.1', 'soccer-news/1.5.0',
            'soccer', 'soccer-news', 'match_recap', 'STANDARD_EDITORIAL', 'standard: routine story: standard editorial', 'premium', 'soccer-ai-router/1.0.0', 15000, 0.04) returning id into rid;
  insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version) values (now(), 'cron_new_story', 1, 'gpt-5.6-sol', 'completed', 'soccer-desk/2.1.1');

  -- constraints: a DETERMINISTIC lane, an unknown pool, a negative latency are refused
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version, routing_lane) values (now(), 'canary', 1, 'm', 'completed', 'd', 'DETERMINISTIC'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: DETERMINISTIC lane accepted'; end if;
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version, pool) values (now(), 'canary', 1, 'm', 'completed', 'd', 'free'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown pool accepted'; end if;
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version, latency_ms) values (now(), 'canary', 1, 'm', 'completed', 'd', -1); exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: negative latency accepted'; end if;

  -- still append-only
  ok := false; begin update soccer_news_openai_usage set routing_lane = 'VOLUME' where id = rid; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: update allowed'; end if;
  if (select count(*) from soccer_articles) <> n_articles then raise exception 'CHECK FAILED: articles changed'; end if;
  raise notice 'CHECKS PASSED (openai usage routing columns)';
end $$;
