# Apply soccer migrations to the SPORTS project, one file at a time, UNMODIFIED.
# Owner approval required (granted 2026-09-27 for 0100/0200/0300, and 0400 attribute_corroborated).
#   pwsh scripts/db/apply-migrations.ps1 20260927000100_soccer_core.sql 20260927000200_soccer_events.sql ...
param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Files)
$ErrorActionPreference = "Stop"
$runner = "D:\Workers\ufc-propbetedge\scripts\db\run_sql.ps1"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fp = "select md5(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text, ',' order by n.nspname, c.relname)) as fingerprint, count(*) as objects from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema','pg_toast') and c.relname not like 'soccer\_%' and c.relname not like 'pg\_temp%'"
"FINGERPRINT_BEFORE:"; pwsh -NoProfile -File $runner -Query $fp
foreach ($f in $Files) {
  $path = Join-Path $root "supabase\migrations\$f"
  $sha = (Get-FileHash -Algorithm SHA256 $path).Hash.ToLower()
  "APPLY $f sha256=$sha"
  $out = pwsh -NoProfile -File "$PSScriptRoot\run_sql_file.ps1" -File $path
  $out
  if ("$out" -match "FAILED") { throw "apply failed at $f" }
}
"FINGERPRINT_AFTER:"; pwsh -NoProfile -File $runner -Query $fp
pwsh -NoProfile -File $runner -ReloadSchema
