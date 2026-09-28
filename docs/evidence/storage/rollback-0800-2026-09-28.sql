-- Reversal of 20260928000800_soccer_media_owner_identification (run only on an explicit owner decision).
-- 1. Remove every row displayed under the owner policy (R2 objects are content-addressed and harmless;
--    the API serves bytes only while a displayable row carries the hash).
-- 2. Restore the original constraints and drop the two columns.
begin;
delete from public.soccer_entity_media where rights_status = 'owner_approved_identification';
delete from public.soccer_media_discovery where outcome = 'owner_approved_identification';
alter table public.soccer_entity_media drop constraint soccer_entity_media_owner_approved_complete;
alter table public.soccer_entity_media drop constraint soccer_entity_media_primary_approved;
alter table public.soccer_entity_media add constraint soccer_entity_media_primary_approved check (not is_primary or rights_status = 'approved');
alter table public.soccer_entity_media drop constraint soccer_entity_media_rights_status_check;
alter table public.soccer_entity_media add constraint soccer_entity_media_rights_status_check check (rights_status in ('approved','restricted','review_required','rejected'));
alter table public.soccer_media_discovery drop constraint soccer_media_discovery_outcome_check;
alter table public.soccer_media_discovery add constraint soccer_media_discovery_outcome_check check (outcome in ('approved','held_review','rejected','not_found'));
alter table public.soccer_entity_media drop column owner_policy_version, drop column provider;
commit;
-- soccer-api rollback: cd workers/soccer-api && npx wrangler versions deploy c266dbd7-cf2a-44f3-b7e7-47e8575632de@100% --yes
