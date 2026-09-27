-- One-time backfill of soccer_match_enrichment from what the graph already holds, for
-- every finished match with an ESPN crosswalk. Idempotent (on conflict do nothing):
-- rows written later by the lane are never overwritten. Missing components become
-- 'unavailable' and are due for retry now.
insert into public.soccer_match_enrichment (match_id, component, provider, status, attempts, last_attempt_at, next_retry_at, last_error, detail)
select m.id, c.component, 'espn',
  case
    when c.component like 'lineup_%' and exists (select 1 from public.soccer_lineups l where l.match_id = m.id and l.team_id = c.team_id and l.provider <> 'espn') then 'not_applicable'
    when c.component like 'lineup_%' and exists (select 1 from public.soccer_lineups l where l.match_id = m.id and l.team_id = c.team_id) then 'complete'
    when c.component like 'stats_%' and exists (select 1 from public.soccer_team_match_stats s where s.match_id = m.id and s.team_id = c.team_id and s.basis = 'source' and s.provider = 'espn') then 'complete'
    when c.component = 'plays' and exists (select 1 from public.soccer_match_external_ids w where w.match_id = m.id and w.provider = 'wyscout') then 'not_applicable'
    when c.component = 'plays' and exists (select 1 from public.soccer_match_events e where e.match_id = m.id and e.source_family = 'espn') then 'complete'
    else 'unavailable'
  end,
  1, now(), now(), null, jsonb_build_object('backfill', '2026-09-28', 'basis', 'present in the canonical graph after the initial fill')
from public.soccer_matches m
join public.soccer_match_external_ids x on x.match_id = m.id and x.provider = 'espn'
cross join lateral (values ('lineup_home', m.home_team_id), ('lineup_away', m.away_team_id), ('stats_home', m.home_team_id), ('stats_away', m.away_team_id), ('plays', null::uuid)) as c(component, team_id)
where m.status = 'finished'
on conflict (match_id, component, provider) do nothing;

update public.soccer_match_enrichment set next_retry_at = null where status in ('complete', 'not_applicable') and next_retry_at is not null;

select c.slug, e.component, e.status, count(*) n
from public.soccer_match_enrichment e join public.soccer_matches m on m.id = e.match_id join public.soccer_competitions c on c.id = m.competition_id
where e.status <> 'complete' group by 1, 2, 3 order by 1, 2, 3;
