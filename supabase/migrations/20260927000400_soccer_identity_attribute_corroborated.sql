-- Owner decision 2026-09-27: new PLAYER crosswalk method 'attribute_corroborated'.
-- It is NOT name matching. A provider player may crosswalk onto an existing
-- canonical player only when ALL hold (enforced in workers/soccer-ingest/src/corroborate.js):
--   1. normalized full name exact match; 2. date of birth exact match;
--   3. exactly one canonical candidate satisfies 1+2;
--   4. provider and canonical graph prove membership of the SAME club in an
--      OVERLAPPING season window (never the present-day club for a historical identity);
--   5. no contradictory DOB, club, provider-id, lineup or nationality evidence;
--   6. the evidence is persisted on the crosswalk row (JSON, checked below);
--   7. anything ambiguous or contradictory stays in soccer_identity_queue.
-- Only soccer_player_external_ids is extended; team/match/etc. methods are unchanged.

begin;

do $$
begin
  if to_regclass('public.soccer_player_external_ids') is null then
    raise exception 'requires soccer core (20260927000100)';
  end if;
  if to_regclass('public.pbe_sport_entitlements') is not null then
    raise exception 'refused: identity/billing project detected';
  end if;
end $$;

alter table public.soccer_player_external_ids drop constraint soccer_player_external_ids_method_check;
alter table public.soccer_player_external_ids add constraint soccer_player_external_ids_method_check
  check (method in ('founding','exact_id','reviewed','fixture_graph','event_alignment','attribute_corroborated'));

-- An attribute-corroborated crosswalk must carry its evidence as a JSON object
-- with the rule version and at least one corroborating club window.
alter table public.soccer_player_external_ids add constraint soccer_player_external_ids_corroboration_evidence
  check (method <> 'attribute_corroborated' or (
    evidence is not null
    and evidence ~ '^\s*\{'
    and (evidence::jsonb ? 'rule')
    and jsonb_array_length(coalesce(evidence::jsonb -> 'corroborating_windows', '[]'::jsonb)) >= 1
  ));

commit;
