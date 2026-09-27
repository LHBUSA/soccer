-- PropBetEdge Soccer newsroom: detected events, frozen evidence packets, articles.
-- An article can only be published if its packet is frozen and every gate passed.
-- See docs/NEWS_ENGINE.md.

begin;

do $$
begin
  if to_regclass('public.soccer_matches') is null then
    raise exception 'soccer news requires soccer core (20260927000100)';
  end if;
end $$;

create table public.soccer_news_events (
  id            uuid primary key,             -- uuidv5(kind + entity ids + as_of)
  story_class   text not null check (story_class in ('match_preview','match_recap','player_form','team_trend','competition_intelligence','data_feature')),
  desk          text not null,
  match_id      uuid references public.soccer_matches(id),
  team_ids      uuid[] not null default '{}',
  player_ids    uuid[] not null default '{}',
  competition_id uuid references public.soccer_competitions(id),
  materiality   numeric(5,3) not null,
  as_of         timestamptz not null,
  detected_at   timestamptz not null default now(),
  status        text not null default 'detected' check (status in ('detected','packeted','composed','held','published','discarded'))
);

-- The packet is written once and never updated. Its hash is the article's
-- evidence identity: change one number and it is a different packet.
create table public.soccer_article_evidence (
  packet_hash     text primary key check (packet_hash ~ '^[0-9a-f]{64}$'),
  news_event_id   uuid not null references public.soccer_news_events(id),
  packet_version  text not null,
  packet          jsonb not null,
  capture_ids     text[] not null default '{}',
  frozen_at       timestamptz not null default now()
);

create or replace function public.soccer_article_evidence_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'soccer_article_evidence is append-only (packet %)', old.packet_hash;
end $$;
create trigger soccer_article_evidence_no_update before update or delete on public.soccer_article_evidence
  for each row execute function public.soccer_article_evidence_immutable();

create table public.soccer_articles (
  id              uuid primary key,
  slug            text not null unique,
  news_event_id   uuid not null references public.soccer_news_events(id),
  packet_hash     text not null references public.soccer_article_evidence(packet_hash),
  story_class     text not null,
  desk            text not null,
  headline        text not null,
  dek             text,
  body            jsonb not null,              -- structured sections, not free HTML
  entities        jsonb not null default '[]', -- resolved canonical links only
  composer        text not null,               -- e.g. 'template/soccer-recap@1.0.0'
  gate_version    text not null,
  gate_results    jsonb not null,
  status          text not null check (status in ('draft','held','published','withdrawn')),
  hold_reasons    text[] not null default '{}',
  hero_media      jsonb,                       -- only licensed media with provenance, else null
  published_at    timestamptz,
  updated_at      timestamptz not null default now(),
  check (status <> 'published' or (published_at is not null and cardinality(hold_reasons) = 0))
);
create index soccer_articles_desk_idx on public.soccer_articles (desk, published_at desc) where status = 'published';

alter table public.soccer_news_events      enable row level security;
alter table public.soccer_article_evidence enable row level security;
alter table public.soccer_articles         enable row level security;

commit;
