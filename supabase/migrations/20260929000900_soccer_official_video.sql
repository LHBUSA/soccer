-- Official video layer (soccer): YouTube videos from VERIFIED, allowlisted official publishers only,
-- linked to articles / matches / teams / players / competitions by an explainable matcher.
-- Nothing is downloaded or rehosted: a row is a YouTube video id + metadata; the site builds the
-- privacy-enhanced embed URL at render time behind a poster-first click. See docs/VIDEO.md.

begin;

do $$
begin
  if to_regclass('public.soccer_articles') is null or to_regclass('public.soccer_matches') is null then
    raise exception 'requires the soccer core + newsroom migrations';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

create table public.soccer_video_channels (
  channel_id      text primary key check (channel_id ~ '^UC[A-Za-z0-9_-]{22}$'),
  provider        text not null default 'youtube' check (provider = 'youtube'),
  channel_name    text not null,
  channel_handle  text,
  publisher_type  text not null check (publisher_type in ('competition','club','governing_body','publisher')),
  competition_id  uuid references public.soccer_competitions(id),
  team_id         uuid references public.soccer_teams(id),
  verified        boolean not null default false,
  enabled         boolean not null default false,
  language        text,
  region_notes    text,
  source_url      text not null check (source_url ~ '^https://'),
  verification    jsonb not null default '{}'::jsonb,   -- how the id was proven (Wikidata P2397, channel page ...)
  checked_at      timestamptz not null default now(),
  constraint soccer_video_channels_enabled_verified check (not enabled or verified)
);

create table public.soccer_videos (
  provider_video_id text primary key check (provider_video_id ~ '^[A-Za-z0-9_-]{11}$'),
  provider          text not null default 'youtube' check (provider = 'youtube'),
  channel_id        text not null references public.soccer_video_channels(channel_id),
  channel_name      text not null,
  title             text not null,
  description       text,
  published_at      timestamptz,
  duration_sec      integer check (duration_sec is null or duration_sec > 0),
  thumbnail_url     text check (thumbnail_url is null or thumbnail_url ~ '^https://i\.ytimg\.com/'),
  url               text not null check (url ~ '^https://www\.youtube\.com/watch\?v='),
  embeddable        boolean,                              -- oEmbed / watch page; null = not yet known
  region_restriction jsonb,                               -- e.g. {"blocked":["US"],"source":"watch_page_available_countries"}
  language          text,
  video_type        text not null default 'other' check (video_type in ('highlights','match_recap','goals','interview','press_conference','preview','analysis','other')),
  is_short          boolean,
  source_metadata   jsonb not null default '{}'::jsonb,
  retrieved_at      timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index soccer_videos_published on public.soccer_videos (published_at desc);
create index soccer_videos_channel on public.soccer_videos (channel_id, published_at desc);

-- Explainable links (graph data). 'linked' = score >= the matcher threshold; 'rejected' rows record why a
-- candidate did not attach (so a wrong game is never shown and the decision is auditable).
create table public.soccer_video_links (
  provider_video_id text not null references public.soccer_videos(provider_video_id),
  article_id        uuid not null references public.soccer_articles(id),
  match_id          uuid references public.soccer_matches(id),
  team_ids          uuid[] not null default '{}',
  player_ids        uuid[] not null default '{}',
  competition_id    uuid references public.soccer_competitions(id),
  score             integer not null,
  reasons           jsonb not null default '[]'::jsonb,
  status            text not null check (status in ('linked','rejected')),
  matcher_version   text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (provider_video_id, article_id)
);
create index soccer_video_links_article on public.soccer_video_links (article_id) where status = 'linked';

alter table public.soccer_video_channels enable row level security;
alter table public.soccer_videos         enable row level security;
alter table public.soccer_video_links    enable row level security;

commit;
