-- Generic tournament groups + governing-body video scope.
--
-- 1. soccer_season_groups: group_type gains 'group' (a competitive group of a tournament: UEFA
--    Nations League A1..D2 now; World Cup / EURO / Copa / Gold Cup groups later). Nothing is
--    competition-specific. Optional tier parent (parent_group_key / parent_name, e.g. 'league-a' /
--    'League A') and a display order keep a two-level tree without flattening it. Existing MLS
--    conference and UCL league-phase rows are untouched (the new columns are nullable).
-- 2. soccer_video_channels.scope_competition_ids: the competitions a channel may serve. A
--    governing body (UEFA) publishes for several competitions; the matcher still decides relevance
--    per video and rejects a video naming another competition. Backfilled from competition_id.
--
-- RLS: both tables already have RLS on and no public policies; ALTER keeps that.
-- Reversible: see the ROLLBACK block at the end (run manually; never part of the apply).

begin;

do $$
begin
  if to_regclass('public.soccer_season_groups') is null or to_regclass('public.soccer_video_channels') is null then
    raise exception 'requires soccer migrations 0600 and 0900';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

-- 1 -----------------------------------------------------------------------------------------------
alter table public.soccer_season_groups drop constraint soccer_season_groups_group_type_check;
alter table public.soccer_season_groups add constraint soccer_season_groups_group_type_check
  check (group_type in ('conference', 'league_phase', 'group'));

alter table public.soccer_season_groups
  add column parent_group_key text check (parent_group_key is null or parent_group_key ~ '^[a-z0-9-]+$'),
  add column parent_name      text,
  add column sort_order       integer check (sort_order is null or sort_order >= 0);
alter table public.soccer_season_groups add constraint soccer_season_groups_parent_pair
  check ((parent_group_key is null) = (parent_name is null));

comment on column public.soccer_season_groups.group_type is
  'conference (MLS East/West) | league_phase (UCL single league phase) | group (a tournament group, e.g. Nations League A1)';
comment on column public.soccer_season_groups.parent_group_key is
  'Optional tier the group belongs to (e.g. league-a for Nations League A1); null when the competition has no tier level';

-- 2 -----------------------------------------------------------------------------------------------
alter table public.soccer_video_channels
  add column scope_competition_ids uuid[] not null default '{}';
update public.soccer_video_channels
   set scope_competition_ids = array[competition_id]
 where competition_id is not null and scope_competition_ids = '{}';
comment on column public.soccer_video_channels.scope_competition_ids is
  'Competitions this channel may serve (a governing body can serve several); the matcher still rejects a video naming another competition';

commit;

-- ROLLBACK (manual, owner-approved):
-- begin;
--   delete from public.soccer_source_standings where group_id in (select id from public.soccer_season_groups where group_type = 'group');
--   delete from public.soccer_season_group_members where group_id in (select id from public.soccer_season_groups where group_type = 'group');
--   delete from public.soccer_season_groups where group_type = 'group';
--   alter table public.soccer_season_groups drop constraint soccer_season_groups_parent_pair;
--   alter table public.soccer_season_groups drop column sort_order, drop column parent_name, drop column parent_group_key;
--   alter table public.soccer_season_groups drop constraint soccer_season_groups_group_type_check;
--   alter table public.soccer_season_groups add constraint soccer_season_groups_group_type_check check (group_type in ('conference','league_phase'));
--   alter table public.soccer_video_channels drop column scope_competition_ids;
-- commit;
