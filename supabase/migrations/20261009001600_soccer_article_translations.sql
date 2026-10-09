-- Soccer newsroom translations (owner approval 2026-10-09, "OWNER APPROVAL — SPANISH SOCCER NEWSROOM": additive migration
-- + OpenAI translation spend; Issue #15 stage 1). ADDITIVE ONLY:
--   1. public.soccer_article_translations: one row per translation VERSION of one published English article in one locale.
--      Separate, versioned records linked to the original article (article_id) and its frozen evidence (packet_hash).
--      The English article row is never written by this feature. Content columns are immutable once written; the only
--      changes allowed are the lifecycle ones (published -> superseded | withdrawn, held -> superseded, and recording a
--      revalidation of an unchanged source). No delete, no truncate. At most ONE published version per article+locale.
--      A row can be published only while its English article is published and carries the same evidence packet.
--   2. public.soccer_news_openai_usage gains nullable `task` and `locale` columns, and its `trigger` check is WIDENED
--      with 'cron_translation' and 'admin_translation' (every existing value stays valid; no row is touched), so
--      translation calls are recorded in the same ledger and count against the same $5/day emergency ceiling.
-- RLS on, no policies, anon/authenticated revoked: only the service role (soccer-news / soccer-api Workers).

begin;

do $$
begin
  if to_regclass('public.soccer_articles') is null or to_regclass('public.soccer_article_evidence') is null then
    raise exception 'requires 20260927000300 (soccer newsroom)';
  end if;
  if to_regclass('public.soccer_news_openai_usage') is null then
    raise exception 'requires 20260929001100 (soccer_news_openai_usage)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'soccer_news_openai_usage_trigger_check' and conrelid = 'public.soccer_news_openai_usage'::regclass) then
    raise exception 'expected constraint soccer_news_openai_usage_trigger_check not found';
  end if;
end $$;

create table public.soccer_article_translations (
  id                 uuid primary key default gen_random_uuid(),
  article_id         uuid not null references public.soccer_articles(id),
  locale             text not null check (locale in ('es','pt','fr')),
  version            integer not null check (version >= 1),
  source_revision    text not null check (source_revision ~ '^[0-9a-f]{64}$'), -- sha256 of the English source segments
  source_updated_at  timestamptz not null,                                     -- the English row's updated_at it matches
  packet_hash        text not null references public.soccer_article_evidence(packet_hash),
  segments           jsonb not null check (jsonb_typeof(segments) = 'object'), -- { segment id: translated text }
  headline           text not null,
  dek                text,
  translator         text not null,
  verifier           text,
  gate_version       text not null,
  gate_results       jsonb not null,
  status             text not null check (status in ('published','held','superseded','withdrawn')),
  hold_reasons       text[] not null default '{}',
  status_reason      text,
  created_at         timestamptz not null default now(),
  published_at       timestamptz,
  retired_at         timestamptz,
  revalidated_at     timestamptz,
  unique (article_id, locale, version),
  check (status <> 'published' or (published_at is not null and cardinality(hold_reasons) = 0)),
  check (status <> 'held' or cardinality(hold_reasons) > 0),
  check (status not in ('superseded','withdrawn') or retired_at is not null)
);
create unique index soccer_article_translations_one_live on public.soccer_article_translations (article_id, locale) where status = 'published';
create index soccer_article_translations_locale on public.soccer_article_translations (locale, status, published_at desc);
create index soccer_article_translations_article on public.soccer_article_translations (article_id, locale, version desc);

create or replace function public.soccer_article_translations_guard() returns trigger
language plpgsql as $$
declare a record;
begin
  if tg_op = 'DELETE' then
    raise exception 'soccer_article_translations is append-only (retire a version instead)';
  end if;
  if tg_op = 'INSERT' then
    if new.status = 'published' then
      select status, packet_hash into a from public.soccer_articles where id = new.article_id;
      if a.status is distinct from 'published' then raise exception 'translation of an unpublished article cannot be published'; end if;
      if a.packet_hash is distinct from new.packet_hash then raise exception 'translation evidence packet differs from the article'; end if;
    end if;
    return new;
  end if;
  -- UPDATE: content is immutable; only the lifecycle may move forward.
  if (new.id, new.article_id, new.locale, new.version, new.source_revision, new.packet_hash, new.segments, new.headline, new.dek,
      new.translator, new.verifier, new.gate_version, new.gate_results, new.hold_reasons, new.created_at, new.published_at)
     is distinct from
     (old.id, old.article_id, old.locale, old.version, old.source_revision, old.packet_hash, old.segments, old.headline, old.dek,
      old.translator, old.verifier, old.gate_version, old.gate_results, old.hold_reasons, old.created_at, old.published_at) then
    raise exception 'translation content is immutable (write a new version)';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'published' and new.status in ('superseded','withdrawn'))
    or (old.status = 'held' and new.status in ('superseded','withdrawn'))) then
    raise exception 'translation status % -> % not allowed', old.status, new.status;
  end if;
  if old.status in ('superseded','withdrawn') and new is distinct from old then
    raise exception 'a retired translation is final';
  end if;
  if new.source_updated_at is distinct from old.source_updated_at and (old.status <> 'published' or new.status <> 'published' or new.revalidated_at is null or new.revalidated_at is not distinct from old.revalidated_at) then
    raise exception 'source_updated_at moves only with a recorded revalidation of a published version';
  end if;
  return new;
end $$;
create trigger soccer_article_translations_guard before insert or update or delete on public.soccer_article_translations
  for each row execute function public.soccer_article_translations_guard();
create or replace function public.soccer_article_translations_no_truncate() returns trigger
language plpgsql as $$
begin
  raise exception 'soccer_article_translations is append-only';
end $$;
create trigger soccer_article_translations_no_truncate before truncate on public.soccer_article_translations
  for each statement execute function public.soccer_article_translations_no_truncate();

alter table public.soccer_article_translations enable row level security;

alter table public.soccer_news_openai_usage
  add column task   text check (task is null or task in ('article_desk','translation','translation_check')),
  add column locale text check (locale is null or locale in ('es','pt','fr'));
alter table public.soccer_news_openai_usage drop constraint soccer_news_openai_usage_trigger_check;
alter table public.soccer_news_openai_usage add constraint soccer_news_openai_usage_trigger_check
  check (trigger in ('cron_new_story','admin_reedit','manual_backfill','canary','cron_translation','admin_translation'));
create index soccer_news_openai_usage_task on public.soccer_news_openai_usage (task, locale, occurred_at);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.soccer_article_translations from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.soccer_article_translations from authenticated';
  end if;
end $$;

commit;
