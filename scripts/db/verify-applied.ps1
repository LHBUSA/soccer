# Post-apply proof on the SPORTS project (read-only except one always-rolled-back probe).
# Writes docs/evidence/storage/tkmln-applied-<date>.json.
#   pwsh scripts/db/verify-applied.ps1 -FingerprintBefore ae61aa44803aa9767d6bc93b21e7faec
param([string]$FingerprintBefore = "ae61aa44803aa9767d6bc93b21e7faec")
$ErrorActionPreference = "Stop"
$runner = "D:\Workers\ufc-propbetedge\scripts\db\run_sql.ps1"
function Q($sql) { (pwsh -NoProfile -File $runner -Query $sql) -join "`n" }
$tables = Q "select count(*) as tables, count(*) filter (where c.relrowsecurity) as rls from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname like 'soccer\_%'"
$policies = Q "select count(*) as policies from pg_policies where tablename like 'soccer\_%'"
$metrics = Q "select status, count(*) as n from public.soccer_metric_definitions group by status"
$probe = @'
do $$
declare blocked boolean := false;
begin
  insert into public.soccer_news_events (id, story_class, desk, materiality, as_of) values ('ffffffff-ffff-5fff-bfff-ffffffffffff','match_recap','bundesliga',0.5,now());
  insert into public.soccer_article_evidence (packet_hash, news_event_id, packet_version, packet) values (repeat('a',64),'ffffffff-ffff-5fff-bfff-ffffffffffff','v','{}');
  begin
    update public.soccer_article_evidence set packet = '{"x":1}';
  exception when others then blocked := true;
  end;
  raise exception 'TRIGGER_PROBE blocked=%', blocked;
end $$;
'@
$trigger = Q $probe
$fp = Q "select md5(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text, ',' order by n.nspname, c.relname)) as fingerprint, count(*) as objects from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema','pg_toast') and c.relname not like 'soccer\_%' and c.relname not like 'pg\_temp%'"
$residue = Q "select count(*) as probe_rows_left from public.soccer_news_events where id='ffffffff-ffff-5fff-bfff-ffffffffffff'"
$out = [ordered]@{
  checked_at = (Get-Date).ToUniversalTime().ToString("o"); tables_rls = $tables; policies = $policies
  metric_status = $metrics; trigger_probe = $trigger; fingerprint_before = $FingerprintBefore; fingerprint_after = $fp; probe_residue = $residue
}
$path = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ("docs\evidence\storage\tkmln-applied-" + (Get-Date -Format "yyyy-MM-dd") + ".json")
$out | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $path
$out | ConvertTo-Json -Depth 5
