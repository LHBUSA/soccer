-- Owner media policy (2026-09-28): team crests and player media are APPROVED BY THE OWNER for
-- entity identification in the product. This is an internal product decision, not a licence:
-- rows displayed under it carry rights_status = 'owner_approved_identification' and keep their
-- truthful provenance (provider, source URL, retrieval time, copyright/licence text as known,
-- trademark status, owner policy version). They are never labelled free / public domain / licensed.
-- 'approved' keeps its meaning: independently free-licensed (Commons metadata).

begin;

do $$
begin
  if to_regclass('public.soccer_entity_media') is null or to_regclass('public.soccer_media_discovery') is null then
    raise exception 'requires 20260927000500 + 20260928000600';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

alter table public.soccer_entity_media
  add column provider text,                 -- e.g. 'wikimedia_commons', 'espn'
  add column owner_policy_version text;     -- set on every row displayed under the owner policy

alter table public.soccer_entity_media drop constraint soccer_entity_media_rights_status_check;
alter table public.soccer_entity_media add constraint soccer_entity_media_rights_status_check
  check (rights_status in ('approved','owner_approved_identification','restricted','review_required','rejected'));

-- Owner-approved rows must be fully provenanced and cached exactly like free-licensed ones.
alter table public.soccer_entity_media add constraint soccer_entity_media_owner_approved_complete check (
  rights_status <> 'owner_approved_identification' or (
    owner_policy_version is not null and provider is not null and license is not null and attribution is not null
    and retrieved_at is not null and verified_at is not null and content_sha256 is not null and object_key is not null
  )
);

alter table public.soccer_entity_media drop constraint soccer_entity_media_primary_approved;
alter table public.soccer_entity_media add constraint soccer_entity_media_primary_approved
  check (not is_primary or rights_status in ('approved','owner_approved_identification'));

alter table public.soccer_media_discovery drop constraint soccer_media_discovery_outcome_check;
alter table public.soccer_media_discovery add constraint soccer_media_discovery_outcome_check
  check (outcome in ('approved','owner_approved_identification','held_review','rejected','not_found'));

commit;
