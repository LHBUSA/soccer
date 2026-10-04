-- Season publication gate (owner decision 2026-10-02). A season is public only when explicitly PUBLISHED.
--   publication_state  'held' (default: fail closed) | 'published'
--   published_at / reviewed_at, coverage_tier (measured, additive: RESULTS < MATCH < LINEUP < STATS < EVENTS <
--   SPATIAL_EVENTS), source_families, limitations, publication_note
-- Every season that exists when this applies is the current production product and is migrated explicitly to
-- 'published' (one UPDATE, recorded in publication_note). Historical backfill lanes create seasons 'held'; a
-- season becomes public only by an explicit promotion after Pass A acceptance.
-- Public read paths (soccer-api, soccer-news) read two views that can only ever show published seasons:
--   soccer_public_seasons, soccer_public_matches (security_invoker: the caller's own privileges apply; anon and
--   authenticated have no grant, like every soccer_ table). Writers keep using the base tables.

begin;

do $$
begin
  if to_regclass('public.soccer_seasons') is null or to_regclass('public.soccer_matches') is null then
    raise exception 'requires 20260927000100 (soccer core)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

alter table public.soccer_seasons
  add column publication_state text not null default 'held' check (publication_state in ('held', 'published')),
  add column published_at      timestamptz,
  add column reviewed_at       timestamptz,
  add column coverage_tier     text check (coverage_tier is null or coverage_tier in ('RESULTS', 'MATCH', 'LINEUP', 'STATS', 'EVENTS', 'SPATIAL_EVENTS')),
  add column source_families   text[] not null default '{}',
  add column limitations       text[] not null default '{}',
  add column publication_note  text,
  add constraint soccer_seasons_published_at check (publication_state <> 'published' or published_at is not null);

update public.soccer_seasons
   set publication_state = 'published', published_at = now(), reviewed_at = now(),
       publication_note = 'production season when the publication gate was introduced (migration 20261002001400)';

create index soccer_seasons_publication on public.soccer_seasons (publication_state);

create view public.soccer_public_seasons with (security_invoker = true) as
  select * from public.soccer_seasons where publication_state = 'published';

create view public.soccer_public_matches with (security_invoker = true) as
  select m.* from public.soccer_matches m
  where exists (select 1 from public.soccer_seasons s where s.id = m.season_id and s.publication_state = 'published');

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on public.soccer_public_seasons, public.soccer_public_matches from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on public.soccer_public_seasons, public.soccer_public_matches from authenticated';
  end if;
end $$;

commit;
