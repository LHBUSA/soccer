-- soccer-news OpenAI usage ledger (owner approval 2026-09-29, "APPROVED — APPLY THE OPENAI TELEMETRY
-- MIGRATION", additive only). ONE ROW PER OpenAI REQUEST made by soccer-news: every attempt, including a first
-- attempt that later fails the gates, an explicitly requested second attempt, and failed / incomplete /
-- refused / timed-out calls. Token counts are the Responses API's own usage fields (never estimated when the
-- API returns them); estimated_usd is derived from them with the price table recorded in the Worker.
--
-- Additive: one new table, its trigger function and indexes. No existing table, row, policy or RLS setting
-- is touched. Append-only: no update, no delete, no truncate. RLS on, no policies, anon/authenticated revoked:
-- only the service role (the soccer-news / soccer-api Workers) reads or writes.

begin;

do $$
begin
  if to_regclass('public.soccer_articles') is null then
    raise exception 'requires 20260927000300 (soccer newsroom)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

create table public.soccer_news_openai_usage (
  id                   uuid primary key default gen_random_uuid(),
  occurred_at          timestamptz not null,
  finished_at          timestamptz,
  article_id           uuid,
  news_event_id        uuid,
  slug                 text,
  trigger              text not null check (trigger in ('cron_new_story','admin_reedit','manual_backfill','canary')),
  attempt              smallint not null check (attempt between 1 and 5),
  model                text not null,
  response_id          text,
  input_tokens         integer check (input_tokens >= 0),
  cached_input_tokens  integer check (cached_input_tokens >= 0),
  output_tokens        integer check (output_tokens >= 0),
  reasoning_tokens     integer check (reasoning_tokens >= 0),
  estimated_usd        numeric(12,6) check (estimated_usd >= 0),
  status               text not null check (status in ('completed','failed','incomplete','refused','timeout','error')),
  error_code           text,
  desk_version         text not null,
  worker_version       text,
  recorded_at          timestamptz not null default now(),
  check (finished_at is null or finished_at >= occurred_at)
);
create index soccer_news_openai_usage_occurred on public.soccer_news_openai_usage (occurred_at);
create index soccer_news_openai_usage_article on public.soccer_news_openai_usage (article_id);
create index soccer_news_openai_usage_trigger on public.soccer_news_openai_usage (trigger, occurred_at);

create or replace function public.soccer_news_openai_usage_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'soccer_news_openai_usage is append-only';
end $$;
create trigger soccer_news_openai_usage_no_update before update or delete on public.soccer_news_openai_usage
  for each row execute function public.soccer_news_openai_usage_append_only();
create trigger soccer_news_openai_usage_no_truncate before truncate on public.soccer_news_openai_usage
  for each statement execute function public.soccer_news_openai_usage_append_only();

alter table public.soccer_news_openai_usage enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.soccer_news_openai_usage from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.soccer_news_openai_usage from authenticated';
  end if;
end $$;

commit;
