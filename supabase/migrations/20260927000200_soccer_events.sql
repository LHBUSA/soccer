-- PropBetEdge Soccer: event ledger, possessions, stats.
-- One canonical field: 105 m x 68 m, attacking frame. See docs/FIELD_COORDINATES.md.
-- Source coordinates are stored untouched next to the canonical ones.
-- These are EVENT coordinates. Nothing here is, or may be presented as,
-- continuous player tracking.

begin;

do $$
begin
  if to_regclass('public.soccer_matches') is null then
    raise exception 'soccer events requires soccer core (20260927000100)';
  end if;
end $$;

create table public.soccer_match_events (
  id                        uuid primary key,
  match_id                  uuid not null references public.soccer_matches(id),
  sequence                  integer not null check (sequence > 0),
  period                    text check (period in ('1H','2H','E1','E2','PS')),
  clock_seconds             numeric(9,3),   -- seconds since the period started
  minute                    smallint,       -- display minute (period offset + clock)
  team_id                   uuid references public.soccer_teams(id),
  player_id                 uuid references public.soccer_players(id),
  event_type                text not null check (event_type in (
                              'pass','shot','duel','foul','save','keeper_exit','clearance','touch',
                              'acceleration','interruption','offside','carry','ball_recovery',
                              'interception','tackle','block','card','substitution','goal','unmapped')),
  subtype                   text,           -- event_type 'goal' = a goal REPORTED without shot detail (no location)
  outcome                   text,
  body_part                 text check (body_part in ('left_foot','right_foot','head','head_or_body','other')),
  under_pressure            boolean,        -- null = the source does not say
  set_piece                 text check (set_piece in ('corner','free_kick','throw_in','goal_kick','penalty','kick_off')),
  is_goal                   boolean not null default false,
  is_own_goal               boolean not null default false,
  card                      text check (card in ('yellow','second_yellow','red')),
  qualifiers                jsonb not null default '{}'::jsonb,
  possession_id             uuid,
  source_x                  numeric(8,3),
  source_y                  numeric(8,3),
  source_end_x              numeric(8,3),
  source_end_y              numeric(8,3),
  source_coordinate_system  text not null,
  x_m                       numeric(6,2) check (x_m between 0 and 105),
  y_m                       numeric(6,2) check (y_m between 0 and 68),
  end_x_m                   numeric(6,2) check (end_x_m between 0 and 105),
  end_y_m                   numeric(6,2) check (end_y_m between 0 and 68),
  source_family             text not null,
  source_event_id           text not null,
  observed_at               timestamptz not null,   -- when WE captured it
  event_at                  timestamptz,            -- wall-clock time of the event, only if sourced
  raw_payload_hash          text not null check (raw_payload_hash ~ '^[0-9a-f]{64}$'),
  capture_id                text references public.soccer_source_captures(capture_id),
  parser_version            text not null,
  unique (source_family, source_event_id),
  unique (match_id, source_family, sequence)
);
create index soccer_match_events_match_idx on public.soccer_match_events (match_id, sequence);
create index soccer_match_events_player_idx on public.soccer_match_events (player_id, event_type);
create index soccer_match_events_shots_idx on public.soccer_match_events (match_id) where event_type = 'shot';

-- Possession chains are DERIVED (versioned rule), never sourced as fact unless a
-- source states them. derivation_version names the rule.
create table public.soccer_possessions (
  id                  uuid primary key,
  match_id            uuid not null references public.soccer_matches(id),
  team_id             uuid not null references public.soccer_teams(id),
  sequence            integer not null,
  period              text,
  start_event_id      uuid references public.soccer_match_events(id),
  end_event_id        uuid references public.soccer_match_events(id),
  start_clock_seconds numeric(9,3),
  end_clock_seconds   numeric(9,3),
  event_count         integer not null,
  derivation_version  text not null,
  unique (match_id, derivation_version, sequence)
);

-- Stats. `basis` says where a number came from:
--   'source'  = a provider states it (provider column says which);
--   'derived' = computed by us from the event ledger (derivation_version says how).
create table public.soccer_match_stats (
  match_id            uuid not null references public.soccer_matches(id),
  stat_key            text not null,
  home_value          numeric,
  away_value          numeric,
  basis               text not null check (basis in ('source','derived')),
  provider            text,
  derivation_version  text,
  computed_at         timestamptz not null default now(),
  primary key (match_id, stat_key, basis)
);

create table public.soccer_team_match_stats (
  match_id            uuid not null references public.soccer_matches(id),
  team_id             uuid not null references public.soccer_teams(id),
  stat_key            text not null,
  value               numeric,
  basis               text not null check (basis in ('source','derived')),
  provider            text,
  derivation_version  text,
  computed_at         timestamptz not null default now(),
  primary key (match_id, team_id, stat_key, basis)
);

create table public.soccer_player_match_stats (
  match_id            uuid not null references public.soccer_matches(id),
  player_id           uuid not null references public.soccer_players(id),
  team_id             uuid not null references public.soccer_teams(id),
  stat_key            text not null,
  value               numeric,
  basis               text not null check (basis in ('source','derived')),
  provider            text,
  derivation_version  text,
  computed_at         timestamptz not null default now(),
  primary key (match_id, player_id, stat_key, basis)
);
create index soccer_player_match_stats_player_idx on public.soccer_player_match_stats (player_id, stat_key);

-- Proprietary metrics registry. Nothing is published until status = 'published',
-- which requires a documented formula, known inputs, a sample rule and a backtest.
create table public.soccer_metric_definitions (
  metric_key        text not null,
  version           text not null,
  status            text not null check (status in ('design','research','validated','published','retired')),
  formula_doc       text not null,          -- path into docs/METHODOLOGY.md
  required_inputs   text[] not null,
  min_sample        jsonb not null default '{}'::jsonb,
  backtest_ref      text,
  created_at        timestamptz not null default now(),
  primary key (metric_key, version),
  check (status not in ('validated','published') or backtest_ref is not null)
);

alter table public.soccer_match_events       enable row level security;
alter table public.soccer_possessions        enable row level security;
alter table public.soccer_match_stats        enable row level security;
alter table public.soccer_team_match_stats   enable row level security;
alter table public.soccer_player_match_stats enable row level security;
alter table public.soccer_metric_definitions enable row level security;

insert into public.soccer_metric_definitions (metric_key, version, status, formula_doc, required_inputs, min_sample) values
  ('pbe_xg',              '0', 'design', 'docs/METHODOLOGY.md#pbe-xg',              '{shot_location,body_part,set_piece,assist_type}', '{"shots_train": 50000}'),
  ('pbe_xt',              '0', 'design', 'docs/METHODOLOGY.md#pbe-xt',              '{pass_start,pass_end,outcome}',                   '{"actions_train": 500000}'),
  ('possession_value',    '0', 'design', 'docs/METHODOLOGY.md#possession-value',    '{possession_chains,pbe_xg}',                      '{"possessions_train": 200000}'),
  ('field_tilt',          '0', 'design', 'docs/METHODOLOGY.md#field-tilt',          '{event_location,team}',                           '{"matches": 1}'),
  ('pressing_intensity',  '0', 'design', 'docs/METHODOLOGY.md#pressing-intensity',  '{defensive_actions,opponent_passes,location}',     '{"matches": 3}'),
  ('transition_threat',   '0', 'design', 'docs/METHODOLOGY.md#transition-threat',   '{possession_chains,recoveries,pbe_xt}',           '{"matches": 5}'),
  ('progressive_action',  '0', 'design', 'docs/METHODOLOGY.md#progressive-action',  '{pass_start,pass_end,carry_start,carry_end}',     '{"minutes": 450}'),
  ('set_piece_threat',    '0', 'design', 'docs/METHODOLOGY.md#set-piece-threat',    '{set_piece,shots,pbe_xg}',                        '{"set_pieces": 100}'),
  ('finishing_delta',     '0', 'design', 'docs/METHODOLOGY.md#finishing-delta',     '{goals,pbe_xg}',                                  '{"shots": 60}'),
  ('goalkeeper_impact',   '0', 'design', 'docs/METHODOLOGY.md#goalkeeper-impact',   '{shots_on_target,post_shot_xg}',                  '{"shots_faced": 100}');

commit;
