-- Rollback-proof checks for 20261009001600_soccer_article_translations.sql (run inside the aborted transaction built by
-- build-single-rollback-proof.mjs; nothing here survives).
do $$
declare art record; other record; t1 uuid; t2 uuid; ok boolean; n_articles bigint; n_usage bigint; h text := repeat('a', 64);
  articles_md5 text; usage_md5 text;
begin
  select count(*), md5(string_agg(id::text || status || headline || coalesce(dek, '') || body::text || updated_at::text, ',' order by id)) into n_articles, articles_md5 from soccer_articles;
  select count(*), md5(string_agg(id::text, ',' order by id)) into n_usage, usage_md5 from soccer_news_openai_usage;
  select id, packet_hash, updated_at into art from soccer_articles where status = 'published' order by published_at desc limit 1;
  if art.id is null then raise exception 'CHECK FAILED: no published article to test against'; end if;
  select a.id, a.packet_hash into other from soccer_articles a where a.status = 'published' and a.packet_hash <> art.packet_hash limit 1;

  -- security posture
  if not exists (select 1 from pg_class where relname = 'soccer_article_translations' and relrowsecurity) then raise exception 'CHECK FAILED: RLS off'; end if;
  if exists (select 1 from pg_policies where tablename = 'soccer_article_translations') then raise exception 'CHECK FAILED: policy present'; end if;
  if has_table_privilege('anon', 'public.soccer_article_translations', 'select') or has_table_privilege('authenticated', 'public.soccer_article_translations', 'select') then raise exception 'CHECK FAILED: anon/authenticated privilege'; end if;

  -- a published translation of a published article with the same packet inserts
  insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, dek, translator, verifier, gate_version, gate_results, status, published_at)
    values (art.id, 'es', 1, h, art.updated_at, art.packet_hash, '{"h":"Titular"}', 'Titular', 'Entradilla', 'proof', 'proof', 'proof', '{}', 'published', now()) returning id into t1;
  -- a second live version for the same article+locale is refused (one live)
  ok := false; begin insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, translator, gate_version, gate_results, status, published_at)
    values (art.id, 'es', 2, h, art.updated_at, art.packet_hash, '{}', 'x', 'proof', 'proof', '{}', 'published', now()); exception when unique_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: two published versions'; end if;
  -- evidence packet must match the article
  if other.id is not null then
    ok := false; begin insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, translator, gate_version, gate_results, status, published_at)
      values (art.id, 'fr', 1, h, art.updated_at, other.packet_hash, '{}', 'x', 'proof', 'proof', '{}', 'published', now()); exception when others then ok := sqlerrm like '%evidence packet%'; end;
    if not ok then raise exception 'CHECK FAILED: foreign packet accepted'; end if;
  end if;
  -- held needs reasons; published needs none; unknown locale refused; bad revision refused
  ok := false; begin insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, translator, gate_version, gate_results, status)
    values (art.id, 'es', 3, h, art.updated_at, art.packet_hash, '{}', 'x', 'proof', 'proof', '{}', 'held'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: held without reasons'; end if;
  ok := false; begin insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, translator, gate_version, gate_results, status, hold_reasons, published_at)
    values (art.id, 'de', 1, h, art.updated_at, art.packet_hash, '{}', 'x', 'proof', 'proof', '{}', 'held', '{x}', null); exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown locale accepted'; end if;
  ok := false; begin insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, translator, gate_version, gate_results, status, hold_reasons)
    values (art.id, 'es', 4, 'nothex', art.updated_at, art.packet_hash, '{}', 'x', 'proof', 'proof', '{}', 'held', '{x}'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: bad source_revision accepted'; end if;
  insert into soccer_article_translations (article_id, locale, version, source_revision, source_updated_at, packet_hash, segments, headline, translator, gate_version, gate_results, status, hold_reasons)
    values (art.id, 'es', 2, h, art.updated_at, art.packet_hash, '{}', 'x', 'proof', 'proof', '{"numbers":"fail"}', 'held', '{translation_numbers}') returning id into t2;

  -- content immutable
  ok := false; begin update soccer_article_translations set headline = 'changed' where id = t1; exception when others then ok := sqlerrm like '%immutable%'; end;
  if not ok then raise exception 'CHECK FAILED: headline update allowed'; end if;
  ok := false; begin update soccer_article_translations set segments = '{"h":"x"}' where id = t1; exception when others then ok := sqlerrm like '%immutable%'; end;
  if not ok then raise exception 'CHECK FAILED: segments update allowed'; end if;
  -- held cannot become published
  ok := false; begin update soccer_article_translations set status = 'published' where id = t2; exception when others then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: held -> published allowed'; end if;
  -- source_updated_at moves only with a revalidation
  ok := false; begin update soccer_article_translations set source_updated_at = now() where id = t1; exception when others then ok := sqlerrm like '%revalidation%'; end;
  if not ok then raise exception 'CHECK FAILED: silent source_updated_at move'; end if;
  update soccer_article_translations set source_updated_at = now(), revalidated_at = now() where id = t1;
  -- retire: published -> superseded (needs retired_at), then final
  ok := false; begin update soccer_article_translations set status = 'superseded' where id = t1; exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: superseded without retired_at'; end if;
  update soccer_article_translations set status = 'superseded', retired_at = now(), status_reason = 'proof' where id = t1;
  ok := false; begin update soccer_article_translations set status_reason = 'again' where id = t1; exception when others then ok := sqlerrm like '%final%'; end;
  if not ok then raise exception 'CHECK FAILED: retired row changed'; end if;
  -- no delete / truncate
  ok := false; begin delete from soccer_article_translations where id = t2; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: delete allowed'; end if;
  ok := false; begin truncate soccer_article_translations; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: truncate allowed'; end if;

  -- usage ledger: old values still valid, new trigger values + task/locale accepted, unknown refused, still append-only
  insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version) values (now(), 'cron_new_story', 1, 'gpt-5.6-sol', 'completed', 'soccer-desk/2.1.1');
  insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version, task, locale) values (now(), 'admin_translation', 1, 'gpt-5.6-sol', 'completed', 'soccer-translate/1.0.0', 'translation', 'es');
  insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version, task, locale) values (now(), 'cron_translation', 1, 'gpt-5.6-sol', 'completed', 'soccer-translate/1.0.0', 'translation_check', 'es');
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version) values (now(), 'unknown', 1, 'm', 'completed', 'd'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown trigger accepted'; end if;
  ok := false; begin insert into soccer_news_openai_usage (occurred_at, trigger, attempt, model, status, desk_version, task) values (now(), 'canary', 1, 'm', 'completed', 'd', 'other'); exception when check_violation then ok := true; end;
  if not ok then raise exception 'CHECK FAILED: unknown task accepted'; end if;
  ok := false; begin update soccer_news_openai_usage set task = 'translation' where trigger = 'admin_translation'; exception when others then ok := sqlerrm like '%append-only%'; end;
  if not ok then raise exception 'CHECK FAILED: ledger update allowed'; end if;
  if (select count(*) from soccer_news_openai_usage where task is not null and model <> 'gpt-5.6-sol') <> 0 then raise exception 'CHECK FAILED: existing rows touched'; end if;

  -- the English newsroom is untouched
  if (select md5(string_agg(id::text || status || headline || coalesce(dek, '') || body::text || updated_at::text, ',' order by id)) from soccer_articles) <> articles_md5 then raise exception 'CHECK FAILED: soccer_articles changed'; end if;
  if (select count(*) from soccer_news_openai_usage) <> n_usage + 3 then raise exception 'CHECK FAILED: unexpected ledger rows'; end if;
  raise notice 'CHECKS PASSED (article translations + ledger task/locale)';
end $$;
