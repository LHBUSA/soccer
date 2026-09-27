-- 1. Match enrichment ledger: per-component completeness with retry state.
--    A result is never touched by this table; optional components (lineups, team
--    statistics, play-by-play) are tracked separately so an upstream failure marks
--    only that component, is retried with backoff, and a component once 'complete'
--    is never downgraded by a later failed request (enforced by trigger).
-- 2. Season groups (MLS conferences, UCL league phase) with membership and the
--    provider's published standings, kept apart from our own computed tables so the
--    two can be cross-checked before anything is shown.
-- 3. Media: trademark status stored separately from copyright status, retrieval
--    time, rejection reason, and a discovery ledger that also records NOT_FOUND.

begin;

do $$
begin
  if to_regclass('public.soccer_entity_media') is null then
    raise exception 'requires 20260927000500 (soccer_entity_media)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

-- 1 ------------------------------------------------------------------------
create table public.soccer_match_enrichment (
  match_id        uuid not null references public.soccer_matches(id),
  component       text not null check (component in ('lineup_home','lineup_away','stats_home','stats_away','plays')),
  provider        text not null,
  status          text not null check (status in ('complete','unavailable','empty','not_applicable')),
  attempts        integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  next_retry_at   timestamptz,
  last_error      text,
  detail          jsonb not null default '{}'::jsonb,
  updated_at      timestamptz not null default now(),
  primary key (match_id, component, provider)
);
create index soccer_match_enrichment_retry on public.soccer_match_enrichment (provider, next_retry_at) where status in ('unavailable','empty');

create or replace function public.soccer_match_enrichment_no_downgrade() returns trigger
language plpgsql as $$
begin
  if old.status = 'complete' and new.status <> 'complete' then
    -- keep the complete record; only the attempt bookkeeping may move
    new.status := 'complete';
    new.next_retry_at := null;
    new.detail := old.detail;
  end if;
  return new;
end $$;
create trigger soccer_match_enrichment_keep_complete before update on public.soccer_match_enrichment
  for each row execute function public.soccer_match_enrichment_no_downgrade();

-- 2 ------------------------------------------------------------------------
create table public.soccer_season_groups (
  id            uuid primary key,
  season_id     uuid not null references public.soccer_seasons(id),
  group_key     text not null,                 -- 'east' | 'west' | 'league-phase'
  name          text not null,
  abbreviation  text,
  group_type    text not null check (group_type in ('conference','league_phase')),
  provider      text not null,
  external_id   text not null,
  capture_id    text references public.soccer_source_captures(capture_id),
  updated_at    timestamptz not null default now(),
  unique (season_id, group_key)
);

create table public.soccer_season_group_members (
  group_id    uuid not null references public.soccer_season_groups(id),
  team_id     uuid not null references public.soccer_teams(id),
  provider    text not null,
  capture_id  text references public.soccer_source_captures(capture_id),
  observed_at timestamptz not null default now(),
  primary key (group_id, team_id)
);

-- The provider's published standings row (rank applies the competition's official
-- tie-breakers; note is the provider's stated zone, e.g. "Qualifies for round of 16").
create table public.soccer_source_standings (
  group_id        uuid not null references public.soccer_season_groups(id),
  team_id         uuid not null references public.soccer_teams(id),
  provider        text not null,
  rank            integer,
  played          integer, won integer, drawn integer, lost integer,
  goals_for       integer, goals_against integer, goal_difference integer, points integer,
  deductions      integer,
  note            text,
  note_rank       integer,
  capture_id      text references public.soccer_source_captures(capture_id),
  observed_at     timestamptz not null,
  primary key (group_id, team_id, provider)
);

-- 3 ------------------------------------------------------------------------
alter table public.soccer_entity_media
  add column trademark_status text not null default 'unknown' check (trademark_status in ('none','trademark_notice','unknown')),
  add column retrieved_at timestamptz,
  add column rejection_reason text;

create table public.soccer_media_discovery (
  entity_type   text not null check (entity_type in ('player','team')),
  entity_id     uuid not null,
  media_type    text not null check (media_type in ('portrait','crest')),
  outcome       text not null check (outcome in ('approved','held_review','rejected','not_found')),
  method        text not null,
  external_id   text,
  source_url    text,
  reason        text,
  evidence      jsonb not null default '{}'::jsonb,
  checked_at    timestamptz not null default now(),
  primary key (entity_type, entity_id, media_type)
);

alter table public.soccer_match_enrichment      enable row level security;
alter table public.soccer_season_groups         enable row level security;
alter table public.soccer_season_group_members  enable row level security;
alter table public.soccer_source_standings      enable row level security;
alter table public.soccer_media_discovery       enable row level security;

commit;
