-- PropBetEdge Soccer: canonical graph core.
-- Target: the SPORTS project (tkmlnhmylqnttmnsnief). Guarded below.
-- Every canonical entity is keyed by a PropBetEdge UUID. Provider ids live ONLY
-- in *_external_ids crosswalks. See docs/DATA_MODEL.md.

begin;

do $$
begin
  if to_regclass('public.ufc_bouts') is null or to_regclass('public.ufc_model_versions') is null then
    raise exception 'soccer core must target the sports project (ufc_bouts + ufc_model_versions required)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'soccer core refused: identity/billing project detected';
  end if;
end $$;

-- ---------------------------------------------------------------- evidence
create table public.soccer_source_captures (
  capture_id      text primary key check (capture_id ~ '^[0-9a-f]{24}$'),
  source_key      text not null,
  family          text not null,
  request_method  text not null default 'GET',
  request_url     text not null,
  captured_at     timestamptz not null,
  http_status     integer,
  content_type    text,
  content_sha256  text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  bytes           bigint not null check (bytes >= 0),
  raw_key         text not null,            -- R2 key: soccer-source/<family>/sha256/<aa>/<sha>
  parser_version  text,
  notes           text,
  inserted_at     timestamptz not null default now()
);
create index soccer_source_captures_family_idx on public.soccer_source_captures (family, captured_at desc);

-- ------------------------------------------------------------ competitions
create table public.soccer_competitions (
  id            uuid primary key,
  slug          text not null unique,
  name          text not null,
  comp_type     text not null check (comp_type in ('league','cup','international_tournament','club_tournament')),
  gender        text not null default 'men' check (gender in ('men','women')),
  country_code  text,                       -- ISO 3166-1 alpha-3 where a country applies
  tier          smallint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table public.soccer_seasons (
  id              uuid primary key,
  competition_id  uuid not null references public.soccer_competitions(id),
  label           text not null,            -- '2017/18' or '2018'
  start_date      date,
  end_date        date,
  created_at      timestamptz not null default now(),
  unique (competition_id, label)
);

create table public.soccer_stages (
  id          uuid primary key,
  season_id   uuid not null references public.soccer_seasons(id),
  name        text not null,
  stage_type  text not null check (stage_type in ('league','group','knockout','qualifying','playoff')),
  stage_order smallint not null default 1,
  unique (season_id, name)
);

-- ------------------------------------------------------------------ people
create table public.soccer_teams (
  id                   uuid primary key,
  slug                 text not null unique,
  name                 text not null,
  short_name           text,
  official_name        text,
  team_type            text not null check (team_type in ('club','national')),
  gender               text not null default 'men' check (gender in ('men','women')),
  country_code         text,
  city                 text,
  status               text not null default 'active' check (status in ('active','merged')),
  merged_into          uuid references public.soccer_teams(id),
  founding_provider    text not null,
  founding_external_id text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null))
);

create table public.soccer_players (
  id                   uuid primary key,
  slug                 text not null unique,
  display_name         text not null,
  short_name           text,
  first_name           text,
  middle_name          text,
  last_name            text,
  birth_date           date,
  birth_country_code   text,
  nationality_code     text,
  foot                 text check (foot in ('left','right','both')),
  height_cm            smallint check (height_cm between 140 and 220),
  weight_kg            smallint check (weight_kg between 40 and 130),
  primary_role         text check (primary_role in ('goalkeeper','defender','midfielder','forward')),
  status               text not null default 'active' check (status in ('active','merged')),
  merged_into          uuid references public.soccer_players(id),
  founding_provider    text not null,
  founding_external_id text not null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((status = 'merged') = (merged_into is not null))
);

create table public.soccer_managers (
  id                   uuid primary key,
  slug                 text not null unique,
  display_name         text not null,
  first_name           text,
  last_name            text,
  birth_date           date,
  nationality_code     text,
  founding_provider    text not null,
  founding_external_id text not null,
  created_at           timestamptz not null default now()
);

create table public.soccer_venues (
  id            uuid primary key,
  slug          text not null unique,
  name          text not null,
  city          text,
  country_code  text,
  capacity      integer,
  latitude      double precision,
  longitude     double precision,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------- crosswalks (ids only)
-- method: 'founding' (the record that minted the entity), 'exact_id' (another
-- provider's id proven equal through a shared stable id), 'reviewed' (a human-
-- reviewed mapping committed with evidence), 'fixture_graph' (team identity
-- proven by an identical fixture structure across a whole season), 'event_alignment'
-- (a player id proven by every one of its goals aligning to exactly one canonical
-- scorer in the same match, team and minute window, with zero conflicts).
-- Name-only matching is NOT a method.
create table public.soccer_competition_external_ids (
  provider text not null, external_id text not null,
  competition_id uuid not null references public.soccer_competitions(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create table public.soccer_season_external_ids (
  provider text not null, external_id text not null,
  season_id uuid not null references public.soccer_seasons(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create table public.soccer_team_external_ids (
  provider text not null, external_id text not null,
  team_id uuid not null references public.soccer_teams(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create index soccer_team_external_ids_team_idx on public.soccer_team_external_ids (team_id);
create table public.soccer_player_external_ids (
  provider text not null, external_id text not null,
  player_id uuid not null references public.soccer_players(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create index soccer_player_external_ids_player_idx on public.soccer_player_external_ids (player_id);
create table public.soccer_manager_external_ids (
  provider text not null, external_id text not null,
  manager_id uuid not null references public.soccer_managers(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create table public.soccer_venue_external_ids (
  provider text not null, external_id text not null,
  venue_id uuid not null references public.soccer_venues(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);

-- ------------------------------------------------------------------ matches
create table public.soccer_matches (
  id               uuid primary key,
  competition_id   uuid not null references public.soccer_competitions(id),
  season_id        uuid not null references public.soccer_seasons(id),
  stage_id         uuid references public.soccer_stages(id),
  matchday         smallint,
  round_label      text,
  kickoff_at       timestamptz,
  venue_id         uuid references public.soccer_venues(id),
  home_team_id     uuid not null references public.soccer_teams(id),
  away_team_id     uuid not null references public.soccer_teams(id),
  status           text not null check (status in ('scheduled','live','finished','postponed','cancelled','abandoned','unknown')),
  home_score       smallint, away_score smallint,
  home_score_ht    smallint, away_score_ht smallint,
  home_score_et    smallint, away_score_et smallint,
  home_pens        smallint, away_pens smallint,
  duration         text check (duration in ('regular','extra_time','penalties')),
  winner_team_id   uuid references public.soccer_teams(id),
  result_provider  text,                    -- provider whose observation won precedence
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (home_team_id <> away_team_id)
);
create unique index soccer_matches_natural_key on public.soccer_matches (season_id, home_team_id, away_team_id, stage_id) nulls not distinct;
create index soccer_matches_kickoff_idx on public.soccer_matches (kickoff_at);

create table public.soccer_match_external_ids (
  provider text not null, external_id text not null,
  match_id uuid not null references public.soccer_matches(id),
  method text not null check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment')),
  evidence text, capture_id text references public.soccer_source_captures(capture_id),
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);
create index soccer_match_external_ids_match_idx on public.soccer_match_external_ids (match_id);

-- Every provider's view of the result, kept side by side. The canonical score
-- on soccer_matches is chosen by precedence; disagreements stay visible here.
create table public.soccer_match_source_results (
  match_id      uuid not null references public.soccer_matches(id),
  provider      text not null,
  status        text,
  home_score    smallint, away_score smallint,
  home_score_ht smallint, away_score_ht smallint,
  capture_id    text references public.soccer_source_captures(capture_id),
  observed_at   timestamptz not null,
  primary key (match_id, provider)
);

create table public.soccer_lineups (
  id          uuid primary key,
  match_id    uuid not null references public.soccer_matches(id),
  team_id     uuid not null references public.soccer_teams(id),
  formation   text,                         -- only when a source states it; never inferred
  manager_id  uuid references public.soccer_managers(id),
  provider    text not null,
  capture_id  text references public.soccer_source_captures(capture_id),
  unique (match_id, team_id)
);

create table public.soccer_lineup_players (
  lineup_id     uuid not null references public.soccer_lineups(id),
  player_id     uuid not null references public.soccer_players(id),
  is_starter    boolean not null,
  shirt_number  smallint,
  position      text,                       -- match position only when sourced
  is_captain    boolean,
  primary key (lineup_id, player_id)
);

create table public.soccer_substitutions (
  id             uuid primary key,
  match_id       uuid not null references public.soccer_matches(id),
  team_id        uuid not null references public.soccer_teams(id),
  player_out_id  uuid not null references public.soccer_players(id),
  player_in_id   uuid not null references public.soccer_players(id),
  minute         smallint,
  provider       text not null,
  capture_id     text references public.soccer_source_captures(capture_id),
  unique (match_id, team_id, player_out_id, player_in_id)
);

-- ----------------------------------------------------------- mutation ledger
create table public.soccer_source_changes (
  id            bigint generated always as identity primary key,
  entity_table  text not null,
  entity_id     text not null,
  field         text not null,
  old_value     jsonb,
  new_value     jsonb,
  provider      text,
  capture_id    text references public.soccer_source_captures(capture_id),
  detected_at   timestamptz not null default now()
);
create index soccer_source_changes_entity_idx on public.soccer_source_changes (entity_table, entity_id);

-- ------------------------------------------------------------ identity queue
-- Anything that cannot be resolved to exactly one canonical entity by an
-- allowed method lands here instead of being written. Fail closed.
create table public.soccer_identity_queue (
  id             bigint generated always as identity primary key,
  entity_type    text not null check (entity_type in ('competition','season','team','player','manager','venue','match')),
  provider       text not null,
  external_id    text not null,
  reason         text not null,
  candidate_ids  uuid[] not null default '{}',
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'open' check (status in ('open','resolved','rejected')),
  resolution     jsonb,
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  unique (entity_type, provider, external_id)
);

-- RLS on, no anon/authenticated policies: only service_role (Workers) reads/writes.
alter table public.soccer_source_captures          enable row level security;
alter table public.soccer_competitions             enable row level security;
alter table public.soccer_seasons                  enable row level security;
alter table public.soccer_stages                   enable row level security;
alter table public.soccer_teams                    enable row level security;
alter table public.soccer_players                  enable row level security;
alter table public.soccer_managers                 enable row level security;
alter table public.soccer_venues                   enable row level security;
alter table public.soccer_competition_external_ids enable row level security;
alter table public.soccer_season_external_ids      enable row level security;
alter table public.soccer_team_external_ids        enable row level security;
alter table public.soccer_player_external_ids      enable row level security;
alter table public.soccer_manager_external_ids     enable row level security;
alter table public.soccer_venue_external_ids       enable row level security;
alter table public.soccer_matches                  enable row level security;
alter table public.soccer_match_external_ids       enable row level security;
alter table public.soccer_match_source_results     enable row level security;
alter table public.soccer_lineups                  enable row level security;
alter table public.soccer_lineup_players           enable row level security;
alter table public.soccer_substitutions            enable row level security;
alter table public.soccer_source_changes           enable row level security;
alter table public.soccer_identity_queue           enable row level security;

commit;
