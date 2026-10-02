-- Repeated fixtures (owner decision 2026-10-02). The unique index soccer_matches_natural_key on
-- (season_id, home_team_id, away_team_id, stage_id) assumed a home/away pairing happens once per stage. That is false
-- (MLS 2001: divisional rivals met four times; ESPN lists 52 repeated home/away pairings, all real matches), so the
-- graph could not represent real schedules. It is replaced by a WRITE GUARD that also includes the canonical kickoff:
--   soccer_matches_fixture_slot (season_id, home_team_id, away_team_id, stage_id, kickoff_at)
-- This is NOT the identity of a match: identity is the match UUID plus provider crosswalks
-- (soccer_match_external_ids). Resolvers never match providers on exact kickoff equality (they use a reviewed tolerance
-- and queue ambiguity; workers/soccer-ingest/src/espn-lane.js upsertEspnFixtures).
-- Additive/corrective only: no row, id, crosswalk or other index changes. Pre-apply audit
-- (docs/evidence/storage/repeated-fixtures-audit-2026-10-02.json): 0 existing rows conflict with the new guard.

begin;

do $$
begin
  if to_regclass('public.soccer_matches') is null then raise exception 'requires 20260927000100 (soccer core)'; end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then raise exception 'refused: identity/billing project detected'; end if;
  if to_regclass('public.soccer_matches_natural_key') is null then raise exception 'expected index soccer_matches_natural_key is missing'; end if;
end $$;

create unique index soccer_matches_fixture_slot on public.soccer_matches (season_id, home_team_id, away_team_id, stage_id, kickoff_at) nulls not distinct;
comment on index public.soccer_matches_fixture_slot is 'Write guard: one canonical match per season, pairing, stage AND kickoff. Not a match identity (identity = UUID + provider crosswalks); a pairing may repeat within a stage on different dates.';
drop index public.soccer_matches_natural_key;

commit;
