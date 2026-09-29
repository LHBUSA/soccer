-- Rollback-proof checks for 20260929001100_soccer_news_openai_usage.sql (run inside the aborted transaction
-- built by build-single-rollback-proof.mjs; nothing here survives).
do $$
declare rid uuid; ok boolean; n_articles bigint; n_events bigint;
begin
  if not exists (select 1 from pg_class where relname = 'soccer_news_openai_usage' and relrowsecurity) then raise exception 'CHECK FAILED: RLS off'; end if;
  if exists (select 1 from pg_policies where tablename = 'soccer_news_openai_usage') then raise exception 'CHECK FAILED: policy present'; end if;
  if has_table_privilege('anon', 'public.soccer_news_openai_usage', 'select') or has_table_privilege('anon', 'public.soccer_news_openai_usage', 'insert')
     or has_table_privilege('authenticated', 'public.soccer_news_openai_usage', 'insert') then raise exception 'CHECK FAILED: anon/authenticated privilege'; end if;
  if (select count(*) from pg_indexes where tablename = 'soccer_news_openai_usage') < 4 then raise exception 'CHECK FAILED: indexes missing'; end if;

  -- existing data untouched by the migration (counts read inside the same transaction)
  select count(*) into n_articles from soccer_articles; select count(*) into n_events from soccer_news_events;

  -- a completed call and a failed call insert; update / delete / truncate are refused
  insert into soccer_news_openai_usage (occurred_at, finished_at, slug, trigger, attempt, model, response_id, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens, estimated_usd, status, desk_version)
    values (now() - interval '1 minute', now(), 'proof-slug', 'cron_new_story', 1, 'gpt-5.6-sol', 'resp_proof', 12000, 4000, 2500, 1500, 0.0380, 'completed', 'soccer-desk/2.1.1') returning id into rid;
  insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, error_code, desk_version) values (now(), 'admin_reedit', 2, 'gpt-5.6-sol', 'timeout', 'timeout', 'soccer-desk/2.1.1');
  ok := false; begin update soccer_news_openai_usage set output_tokens = 1 where id = rid; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: update allowed'; end if;
  ok := false; begin delete from soccer_news_openai_usage where id = rid; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: delete allowed'; end if;
  ok := false; begin truncate soccer_news_openai_usage; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: truncate allowed'; end if;
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version) values (now(), 'backlog_cron', 1, 'm', 'completed', 'd'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown trigger accepted'; end if;
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version) values (now(), 'canary', 1, 'm', 'maybe', 'd'); exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown status accepted'; end if;
  if (select count(*) from soccer_articles) <> n_articles or (select count(*) from soccer_news_events) <> n_events then raise exception 'CHECK FAILED: existing news data changed'; end if;
  raise notice 'CHECKS PASSED (openai usage ledger)';
end $$;
