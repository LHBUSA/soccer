-- Governed media registry: player portraits and club crests with per-file provenance.
-- A URL existing is NOT permission. Only rows with rights_status = 'approved' may
-- ever be exposed by the API, and an approved row must carry its licence, licence
-- URL, source page, attribution, the verified content hash and verification time
-- (enforced below). Unclear rights -> 'review_required' (never published).
-- See docs/MEDIA.md.

begin;

do $$
begin
  if to_regclass('public.soccer_players') is null then
    raise exception 'soccer media requires soccer core (20260927000100)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

create table public.soccer_entity_media (
  id              uuid primary key,                  -- uuidv5(entity_type:entity_id:media_type:source_url)
  entity_type     text not null check (entity_type in ('player','team','competition')),
  entity_id       uuid not null,
  media_type      text not null check (media_type in ('portrait','crest')),
  url             text not null check (url ~ '^https://'),        -- the source file itself
  cached_url      text,                                             -- our served copy (same-origin API route)
  object_key      text,                                             -- R2 key of the cached bytes
  source          text not null check (source in ('wikimedia_commons','provider_artwork')),
  source_url      text not null check (source_url ~ '^https://'), -- file description / licence page
  source_entity   text,                                             -- e.g. Wikidata QID that links file <-> entity
  match_evidence  jsonb not null default '{}'::jsonb,               -- why this file belongs to this entity
  license         text,
  license_url     text,
  author          text,
  attribution     text,
  rights_status   text not null check (rights_status in ('approved','restricted','review_required','rejected')),
  rights_notes    text,
  is_primary      boolean not null default false,
  verified_at     timestamptz,
  content_sha256  text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  mime            text,
  width           integer check (width is null or width > 0),
  height          integer check (height is null or height > 0),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (entity_type, entity_id, media_type, source_url),
  constraint soccer_entity_media_approved_complete check (
    rights_status <> 'approved' or (
      license is not null and license_url ~ '^https?://' and attribution is not null
      and verified_at is not null and content_sha256 is not null and object_key is not null
    )
  ),
  constraint soccer_entity_media_primary_approved check (not is_primary or rights_status = 'approved')
);

-- At most one primary per entity and media type.
create unique index soccer_entity_media_one_primary
  on public.soccer_entity_media (entity_type, entity_id, media_type) where is_primary;
create index soccer_entity_media_entity on public.soccer_entity_media (entity_type, entity_id);

alter table public.soccer_entity_media enable row level security;

commit;
