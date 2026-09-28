-- Private prospective shadow for the frozen research model soccer-research-bundesliga-v1.2-dc
-- (owner approval 2026-09-28: BUILD SOCCER DIXON-COLES SHADOW). Bundesliga only.
--
-- 1. soccer_model_shadow_predictions: ONE frozen pre-kick prediction per (model_id, match_id).
--    Prediction fields can never change; outcome fields are written once, only after the
--    canonical match is finished and only with the canonical score. No deletes, no truncate.
-- 2. soccer_model_shadow_events: append-only operational evidence (issued / hold / settled /
--    missed / started).
-- 3. soccer_model_shadow_metrics: append-only prospective metric snapshots, one per settled count.
--
-- RLS on, no policies, and anon/authenticated privileges revoked: only the service role
-- (soccer-ingest) can read or write. soccer-api never reads these tables.

begin;

do $$
begin
  if to_regclass('public.soccer_match_enrichment') is null then
    raise exception 'requires 20260928000600 (soccer_match_enrichment)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

-- 1 ------------------------------------------------------------------------
create table public.soccer_model_shadow_predictions (
  id              uuid primary key default gen_random_uuid(),
  model_id        text not null,
  model_version   text not null,
  calibration_id  text not null,
  competition_id  uuid not null references public.soccer_competitions(id),
  season_id       uuid not null references public.soccer_seasons(id),
  match_id        uuid not null references public.soccer_matches(id),
  predicted_at    timestamptz not null,
  kickoff_at      timestamptz not null,
  p_home          double precision not null check (p_home > 0 and p_home < 1),
  p_draw          double precision not null check (p_draw > 0 and p_draw < 1),
  p_away          double precision not null check (p_away > 0 and p_away < 1),
  lambda_home     double precision not null check (lambda_home > 0),
  lambda_away     double precision not null check (lambda_away > 0),
  rho             double precision not null,
  input_hash      text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  model_hash      text not null check (model_hash ~ '^[0-9a-f]{64}$'),
  input_as_of     timestamptz not null,
  input_count     integer not null check (input_count > 0),
  attribution     jsonb not null,
  home_score      smallint check (home_score >= 0),
  away_score      smallint check (away_score >= 0),
  outcome         text check (outcome in ('home','draw','away')),
  settled_at      timestamptz,
  created_at      timestamptz not null default now(),
  unique (model_id, match_id),
  check (abs(p_home + p_draw + p_away - 1) < 1e-9),
  check (input_as_of < predicted_at),
  check (predicted_at < kickoff_at),
  check ((home_score is null) = (away_score is null) and (home_score is null) = (outcome is null) and (outcome is null) = (settled_at is null)),
  check (outcome is null or outcome = case when home_score > away_score then 'home' when home_score = away_score then 'draw' else 'away' end),
  check (settled_at is null or settled_at > kickoff_at)
);
create index soccer_model_shadow_predictions_open on public.soccer_model_shadow_predictions (model_id, kickoff_at) where settled_at is null;

-- Issue guard: a prediction is born unsettled, is not future-dated, and matches the canonical
-- fixture (competition, season, kickoff) of a match that has not started.
create or replace function public.soccer_model_shadow_issue_guard() returns trigger
language plpgsql as $$
declare m record;
begin
  if new.home_score is not null or new.away_score is not null or new.outcome is not null or new.settled_at is not null then
    raise exception 'shadow prediction must be issued unsettled';
  end if;
  if new.predicted_at > now() + interval '5 minutes' then
    raise exception 'shadow prediction cannot be future-dated (predicted_at %)', new.predicted_at;
  end if;
  select competition_id, season_id, kickoff_at, status into m from public.soccer_matches where id = new.match_id;
  if m.status is distinct from 'scheduled' then raise exception 'shadow prediction only for a scheduled match (status %)', m.status; end if;
  if m.competition_id <> new.competition_id or m.season_id <> new.season_id then raise exception 'competition/season do not match the canonical match'; end if;
  if m.kickoff_at is distinct from new.kickoff_at then raise exception 'kickoff_at does not match the canonical match'; end if;
  new.created_at := now();
  return new;
end $$;
create trigger soccer_model_shadow_issue before insert on public.soccer_model_shadow_predictions
  for each row execute function public.soccer_model_shadow_issue_guard();

-- Freeze: every prediction field is immutable; the four outcome fields may be written exactly
-- once, only when the canonical match is finished, and only with the canonical score.
create or replace function public.soccer_model_shadow_freeze() returns trigger
language plpgsql as $$
declare m record;
begin
  if (to_jsonb(new) - array['home_score','away_score','outcome','settled_at']) is distinct from (to_jsonb(old) - array['home_score','away_score','outcome','settled_at']) then
    raise exception 'shadow prediction % is frozen: prediction fields cannot change', old.id;
  end if;
  if old.settled_at is not null then
    raise exception 'shadow prediction % is already settled (write-once)', old.id;
  end if;
  if new.settled_at is null then
    raise exception 'shadow prediction % : an update must settle the row', old.id;
  end if;
  select status, home_score, away_score into m from public.soccer_matches where id = old.match_id;
  if m.status is distinct from 'finished' or m.home_score is null or m.away_score is null then
    raise exception 'shadow prediction % : match is not final (status %)', old.id, m.status;
  end if;
  if new.home_score <> m.home_score or new.away_score <> m.away_score then
    raise exception 'shadow prediction % : settlement score differs from the canonical score', old.id;
  end if;
  if new.settled_at > now() + interval '5 minutes' then
    raise exception 'settled_at cannot be future-dated';
  end if;
  return new;
end $$;
create trigger soccer_model_shadow_frozen before update on public.soccer_model_shadow_predictions
  for each row execute function public.soccer_model_shadow_freeze();

create or replace function public.soccer_model_shadow_no_delete() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger soccer_model_shadow_predictions_no_delete before delete on public.soccer_model_shadow_predictions
  for each row execute function public.soccer_model_shadow_no_delete();
create trigger soccer_model_shadow_predictions_no_truncate before truncate on public.soccer_model_shadow_predictions
  for each statement execute function public.soccer_model_shadow_no_delete();

-- 2 ------------------------------------------------------------------------
create table public.soccer_model_shadow_events (
  id          uuid primary key default gen_random_uuid(),
  model_id    text not null,
  match_id    uuid references public.soccer_matches(id),
  event       text not null check (event in ('started','issued','hold','settled','missed')),
  reason      text,
  detail      jsonb not null default '{}'::jsonb,
  at          timestamptz not null default now()
);
create index soccer_model_shadow_events_match on public.soccer_model_shadow_events (model_id, match_id, event);

-- 3 ------------------------------------------------------------------------
create table public.soccer_model_shadow_metrics (
  model_id       text not null,
  settled_count  integer not null check (settled_count >= 0),
  computed_at    timestamptz not null default now(),
  metrics        jsonb not null,
  primary key (model_id, settled_count)
);

create or replace function public.soccer_model_shadow_append_only() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger soccer_model_shadow_events_append_only before update or delete on public.soccer_model_shadow_events
  for each row execute function public.soccer_model_shadow_append_only();
create trigger soccer_model_shadow_metrics_append_only before update or delete on public.soccer_model_shadow_metrics
  for each row execute function public.soccer_model_shadow_append_only();
create trigger soccer_model_shadow_events_no_truncate before truncate on public.soccer_model_shadow_events
  for each statement execute function public.soccer_model_shadow_append_only();
create trigger soccer_model_shadow_metrics_no_truncate before truncate on public.soccer_model_shadow_metrics
  for each statement execute function public.soccer_model_shadow_append_only();

alter table public.soccer_model_shadow_predictions enable row level security;
alter table public.soccer_model_shadow_events      enable row level security;
alter table public.soccer_model_shadow_metrics     enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.soccer_model_shadow_predictions, public.soccer_model_shadow_events, public.soccer_model_shadow_metrics from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.soccer_model_shadow_predictions, public.soccer_model_shadow_events, public.soccer_model_shadow_metrics from authenticated';
  end if;
end $$;

commit;
