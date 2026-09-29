-- SOCCER ALGO V1: model forecasts + the public Official Pick ledger (owner direction 2026-09-29:
-- "SOCCER ALGO + PUBLIC TRACK RECORD — PHASE 1"; migration apply pre-approved after the rollback-only proof).
--
-- 1. soccer_algo_forecasts: ONE frozen pre-kick model forecast per (algo_version, match_id): every market's
--    probabilities, the lambdas, the Game Best and the input hash. Fully immutable; no delete or truncate.
-- 2. soccer_algo_picks: the OFFICIAL PICK ledger. At most one Official Pick per (algo_version, match_id).
--    A pick is created only while issued_at <= lock_at < kickoff_at and now() <= lock_at, only for a scheduled
--    canonical match, only with its forecast. Prediction fields never change. A sportsbook price may be
--    written once, only before lock. Settlement is written once: win/loss only from the canonical final score
--    (graded here in SQL), void only for a cancelled/abandoned match or a kickoff moved by more than 48 h.
--    record_no numbers the public record in issue order. No delete, no truncate.
-- 3. soccer_algo_events: append-only operational evidence (started, issued, hold, settled, void, alert).
--
-- RLS on, no policies, anon/authenticated revoked: only the service role writes (soccer-ingest) and reads
-- (soccer-api serves the public record from it).

begin;

do $$
begin
  if to_regclass('public.soccer_model_shadow_predictions') is null then
    raise exception 'requires 20260928000700 (soccer model shadow)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

-- grading (pure): the result of a selection given the canonical final score
create or replace function public.soccer_algo_grade(p_market text, p_selection text, hs integer, aw integer) returns text
language sql immutable as $$
  select case
    when p_market = '1x2' and p_selection = 'home' then case when hs > aw then 'win' else 'loss' end
    when p_market = '1x2' and p_selection = 'draw' then case when hs = aw then 'win' else 'loss' end
    when p_market = '1x2' and p_selection = 'away' then case when aw > hs then 'win' else 'loss' end
    when p_market = 'home_to_score' and p_selection = 'yes' then case when hs >= 1 then 'win' else 'loss' end
    when p_market = 'home_to_score' and p_selection = 'no' then case when hs = 0 then 'win' else 'loss' end
    when p_market = 'away_to_score' and p_selection = 'yes' then case when aw >= 1 then 'win' else 'loss' end
    when p_market = 'away_to_score' and p_selection = 'no' then case when aw = 0 then 'win' else 'loss' end
    when p_market = 'over_2_5' and p_selection = 'over' then case when hs + aw >= 3 then 'win' else 'loss' end
    when p_market = 'over_2_5' and p_selection = 'under' then case when hs + aw <= 2 then 'win' else 'loss' end
    else null end
$$;

-- 1 ------------------------------------------------------------------------
create table public.soccer_algo_forecasts (
  id                   uuid primary key default gen_random_uuid(),
  algo_version         text not null,
  model_id             text not null,
  model_hash           text not null check (model_hash ~ '^[0-9a-f]{64}$'),
  pick_policy_version  text not null,
  spec_hash            text not null check (spec_hash ~ '^[0-9a-f]{64}$'),
  competition_id       uuid not null references public.soccer_competitions(id),
  season_id            uuid not null references public.soccer_seasons(id),
  match_id             uuid not null references public.soccer_matches(id),
  issued_at            timestamptz not null,
  kickoff_at           timestamptz not null,
  input_as_of          timestamptz not null,
  input_hash           text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  input_count          integer not null check (input_count > 0),
  lambda_home          double precision not null check (lambda_home > 0),
  lambda_away          double precision not null check (lambda_away > 0),
  probabilities        jsonb not null,
  game_best            jsonb not null,
  created_at           timestamptz not null default now(),
  unique (algo_version, match_id),
  check (input_as_of < issued_at),
  check (issued_at < kickoff_at)
);

create or replace function public.soccer_algo_forecast_guard() returns trigger
language plpgsql as $$
declare m record;
begin
  if new.issued_at > now() + interval '5 minutes' then raise exception 'forecast cannot be future-dated (issued_at %)', new.issued_at; end if;
  select competition_id, season_id, kickoff_at, status into m from public.soccer_matches where id = new.match_id;
  if m.status is distinct from 'scheduled' then raise exception 'forecast only for a scheduled match (status %)', m.status; end if;
  if m.competition_id <> new.competition_id or m.season_id <> new.season_id then raise exception 'competition/season do not match the canonical match'; end if;
  if m.kickoff_at is distinct from new.kickoff_at then raise exception 'kickoff_at does not match the canonical match'; end if;
  if now() >= new.kickoff_at then raise exception 'forecast after kickoff is refused'; end if;
  new.created_at := now();
  return new;
end $$;
create trigger soccer_algo_forecast_issue before insert on public.soccer_algo_forecasts
  for each row execute function public.soccer_algo_forecast_guard();

create or replace function public.soccer_algo_immutable() returns trigger
language plpgsql as $$
begin
  raise exception '% is append-only / immutable', tg_table_name;
end $$;
create trigger soccer_algo_forecasts_frozen before update or delete on public.soccer_algo_forecasts
  for each row execute function public.soccer_algo_immutable();
create trigger soccer_algo_forecasts_no_truncate before truncate on public.soccer_algo_forecasts
  for each statement execute function public.soccer_algo_immutable();

-- 2 ------------------------------------------------------------------------
create table public.soccer_algo_picks (
  id                     uuid primary key default gen_random_uuid(),
  record_no              bigint generated always as identity unique,
  forecast_id            uuid not null references public.soccer_algo_forecasts(id),
  algo_version           text not null,
  model_id               text not null,
  model_version          text not null,
  model_hash             text not null check (model_hash ~ '^[0-9a-f]{64}$'),
  pick_policy_version    text not null,
  spec_hash              text not null check (spec_hash ~ '^[0-9a-f]{64}$'),
  competition_id         uuid not null references public.soccer_competitions(id),
  season_id              uuid not null references public.soccer_seasons(id),
  match_id               uuid not null references public.soccer_matches(id),
  market                 text not null check (market in ('1x2','over_2_5','home_to_score','away_to_score')),
  selection              text not null check (selection in ('home','draw','away','over','under','yes','no')),
  model_probability      double precision not null check (model_probability > 0 and model_probability < 1),
  threshold              double precision not null check (threshold > 0 and threshold < 1),
  lambda_home            double precision not null check (lambda_home > 0),
  lambda_away            double precision not null check (lambda_away > 0),
  issued_at              timestamptz not null,
  lock_at                timestamptz not null,
  kickoff_at             timestamptz not null,
  input_as_of            timestamptz not null,
  input_hash             text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  status                 text not null default 'pending' check (status in ('pending','win','loss','push','void')),
  settled_at             timestamptz,
  final_home_score       smallint check (final_home_score >= 0),
  final_away_score       smallint check (final_away_score >= 0),
  settlement_reason      text,
  sportsbook             text,
  price_decimal          numeric(8,3) check (price_decimal > 1),
  price_american         integer,
  price_captured_at      timestamptz,
  closing_price_decimal  numeric(8,3) check (closing_price_decimal > 1),
  units                  numeric(8,3) check (units > 0),
  profit_units           numeric(9,3),
  created_at             timestamptz not null default now(),
  unique (algo_version, match_id),
  check (model_probability >= threshold),
  check (input_as_of < issued_at),
  check (issued_at <= lock_at and lock_at < kickoff_at),
  check ((status = 'pending') = (settled_at is null)),
  check (status not in ('win','loss') or (final_home_score is not null and final_away_score is not null)),
  check ((price_decimal is null) = (price_captured_at is null) and (price_decimal is null) = (sportsbook is null)),
  check (price_captured_at is null or (price_captured_at >= issued_at and price_captured_at <= lock_at)),
  check (units is null or price_decimal is not null),
  check (profit_units is null or units is not null)
);
create index soccer_algo_picks_open on public.soccer_algo_picks (algo_version, kickoff_at) where status = 'pending';

create or replace function public.soccer_algo_pick_issue() returns trigger
language plpgsql as $$
declare m record; f record;
begin
  if new.status <> 'pending' or new.settled_at is not null or new.final_home_score is not null or new.final_away_score is not null or new.settlement_reason is not null then
    raise exception 'an Official Pick is issued pending and unsettled';
  end if;
  if new.price_decimal is not null or new.closing_price_decimal is not null or new.units is not null or new.profit_units is not null then
    raise exception 'prices are captured after issue, never at insert';
  end if;
  if new.issued_at > now() + interval '5 minutes' then raise exception 'pick cannot be future-dated (issued_at %)', new.issued_at; end if;
  if now() > new.lock_at then raise exception 'pick after lock is refused (lock_at %)', new.lock_at; end if;
  select competition_id, season_id, kickoff_at, status into m from public.soccer_matches where id = new.match_id;
  if m.status is distinct from 'scheduled' then raise exception 'pick only for a scheduled match (status %)', m.status; end if;
  if m.competition_id <> new.competition_id or m.season_id <> new.season_id then raise exception 'competition/season do not match the canonical match'; end if;
  if m.kickoff_at is distinct from new.kickoff_at then raise exception 'kickoff_at does not match the canonical match'; end if;
  select match_id, algo_version, input_hash, spec_hash, lambda_home, lambda_away into f from public.soccer_algo_forecasts where id = new.forecast_id;
  if f.match_id is distinct from new.match_id or f.algo_version is distinct from new.algo_version or f.input_hash is distinct from new.input_hash or f.spec_hash is distinct from new.spec_hash
     or f.lambda_home is distinct from new.lambda_home or f.lambda_away is distinct from new.lambda_away then
    raise exception 'pick does not match its frozen forecast';
  end if;
  new.status := 'pending';
  new.created_at := now();
  return new;
end $$;
create trigger soccer_algo_pick_issue before insert on public.soccer_algo_picks
  for each row execute function public.soccer_algo_pick_issue();

-- Updates: prediction fields are frozen. Allowed, each at most once: (a) a sportsbook price, only before lock;
-- (b) a closing price; (c) settlement from the canonical match.
create or replace function public.soccer_algo_pick_freeze() returns trigger
language plpgsql as $$
declare
  m record;
  mutable text[] := array['status','settled_at','final_home_score','final_away_score','settlement_reason','sportsbook','price_decimal','price_american','price_captured_at','closing_price_decimal','units','profit_units'];
  g text;
begin
  if (to_jsonb(new) - mutable) is distinct from (to_jsonb(old) - mutable) then
    raise exception 'Official Pick % is frozen: prediction fields cannot change', old.record_no;
  end if;
  -- price: once, before lock
  if (new.price_decimal, new.price_american, new.sportsbook, new.price_captured_at) is distinct from (old.price_decimal, old.price_american, old.sportsbook, old.price_captured_at) then
    if old.price_decimal is not null then raise exception 'pick % : price already captured (write-once)', old.record_no; end if;
    if now() > old.lock_at then raise exception 'pick % : price after lock is refused', old.record_no; end if;
  end if;
  if new.closing_price_decimal is distinct from old.closing_price_decimal and old.closing_price_decimal is not null then
    raise exception 'pick % : closing price already recorded', old.record_no;
  end if;
  -- settlement: once
  if (new.status, new.settled_at, new.final_home_score, new.final_away_score, new.settlement_reason, new.units, new.profit_units)
     is distinct from (old.status, old.settled_at, old.final_home_score, old.final_away_score, old.settlement_reason, old.units, old.profit_units) then
    if old.status <> 'pending' then raise exception 'pick % is already settled (write-once)', old.record_no; end if;
    if new.status = 'pending' then raise exception 'pick % : a settlement update must settle', old.record_no; end if;
    if new.settled_at > now() + interval '5 minutes' then raise exception 'settled_at cannot be future-dated'; end if;
    select status, kickoff_at, home_score, away_score into m from public.soccer_matches where id = old.match_id;
    if new.status in ('win','loss') then
      if m.status is distinct from 'finished' or m.home_score is null or m.away_score is null then raise exception 'pick % : match is not final (status %)', old.record_no, m.status; end if;
      if new.final_home_score <> m.home_score or new.final_away_score <> m.away_score then raise exception 'pick % : settlement score differs from the canonical score', old.record_no; end if;
      if abs(extract(epoch from (m.kickoff_at - old.kickoff_at))) > 48 * 3600 then raise exception 'pick % : kickoff moved more than 48 h: void, not graded', old.record_no; end if;
      g := public.soccer_algo_grade(old.market, old.selection, m.home_score, m.away_score);
      if g is distinct from new.status then raise exception 'pick % : graded % but the canonical score says %', old.record_no, new.status, g; end if;
    elsif new.status = 'void' then
      if not (m.status in ('cancelled','abandoned') or abs(extract(epoch from (m.kickoff_at - old.kickoff_at))) > 48 * 3600) then
        raise exception 'pick % : void only for a cancelled/abandoned match or a kickoff moved by more than 48 h', old.record_no;
      end if;
    elsif new.status = 'push' then
      raise exception 'pick % : no V1 market can push', old.record_no;
    end if;
    -- units/profit only from a stored price
    if new.profit_units is not null then
      if old.price_decimal is null or new.units is null then raise exception 'pick % : profit needs a stored pre-lock price and units', old.record_no; end if;
      if new.profit_units <> round(case new.status when 'win' then new.units * (old.price_decimal - 1) when 'loss' then -new.units else 0 end, 3) then
        raise exception 'pick % : profit_units must follow the stored price', old.record_no;
      end if;
    end if;
  end if;
  return new;
end $$;
create trigger soccer_algo_pick_frozen before update on public.soccer_algo_picks
  for each row execute function public.soccer_algo_pick_freeze();
create trigger soccer_algo_picks_no_delete before delete on public.soccer_algo_picks
  for each row execute function public.soccer_algo_immutable();
create trigger soccer_algo_picks_no_truncate before truncate on public.soccer_algo_picks
  for each statement execute function public.soccer_algo_immutable();

-- 3 ------------------------------------------------------------------------
create table public.soccer_algo_events (
  id            uuid primary key default gen_random_uuid(),
  algo_version  text not null,
  match_id      uuid references public.soccer_matches(id),
  event         text not null check (event in ('started','forecast','issued','hold','settled','void','alert')),
  reason        text,
  detail        jsonb not null default '{}'::jsonb,
  at            timestamptz not null default now()
);
create index soccer_algo_events_match on public.soccer_algo_events (algo_version, match_id, event);
create trigger soccer_algo_events_append_only before update or delete on public.soccer_algo_events
  for each row execute function public.soccer_algo_immutable();
create trigger soccer_algo_events_no_truncate before truncate on public.soccer_algo_events
  for each statement execute function public.soccer_algo_immutable();

alter table public.soccer_algo_forecasts enable row level security;
alter table public.soccer_algo_picks     enable row level security;
alter table public.soccer_algo_events    enable row level security;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.soccer_algo_forecasts, public.soccer_algo_picks, public.soccer_algo_events from anon';
    execute 'revoke execute on function public.soccer_algo_grade(text, text, integer, integer) from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.soccer_algo_forecasts, public.soccer_algo_picks, public.soccer_algo_events from authenticated';
  end if;
end $$;

commit;
