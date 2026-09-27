# Rollback-only proof of the soccer migrations on the SPORTS project.
# Takes an unrelated-object catalog fingerprint, runs the always-aborting proof,
# re-takes the fingerprint and checks zero residue. Never commits anything.
#   node scripts/db/build-rollback-proof.mjs; pwsh scripts/db/run-rollback-proof.ps1
$ErrorActionPreference = "Stop"
$runner = "D:\Workers\ufc-propbetedge\scripts\db\run_sql.ps1"
$fp = "select md5(string_agg(n.nspname||'.'||c.relname||':'||c.relkind::text, ',' order by n.nspname, c.relname)) as fingerprint, count(*) as objects from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname not in ('pg_catalog','information_schema','pg_toast') and c.relname not like 'soccer\_%' and c.relname not like 'pg\_temp%'"
$residue = "select (select count(*) from pg_class where relname like 'soccer\_%') as soccer_relations, (select count(*) from pg_proc where proname like 'soccer\_%') as soccer_functions"
"BEFORE:";  pwsh -NoProfile -File $runner -Query $fp
"PROOF:";   pwsh -NoProfile -File "$PSScriptRoot\run_sql_file.ps1" -File "$PSScriptRoot\..\..\.proof\rollback-proof.sql"
"AFTER:";   pwsh -NoProfile -File $runner -Query $fp
"RESIDUE:"; pwsh -NoProfile -File $runner -Query $residue
