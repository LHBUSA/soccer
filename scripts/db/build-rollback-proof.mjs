#!/usr/bin/env node
// Builds the rollback-only proof SQL for the soccer migrations against the real
// sports project: BEGIN; migrations; behavioural checks; RAISE (always aborts).
// Output: .proof/rollback-proof.sql. Run it with scripts/db/run-rollback-proof.ps1.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dir = 'supabase/migrations';
const body = readdirSync(dir).filter(f => f.endsWith('.sql')).sort().map(f => {
  const sql = readFileSync(`${dir}/${f}`, 'utf8').replace(/^\s*begin;\s*$/gim, '').replace(/^\s*commit;\s*$/gim, '');
  return `-- ${f}\n${sql}`;
}).join('\n');

const checks = `
do $$
declare n_tables int; n_rls int; n_metrics int; blocked boolean := false;
begin
  select count(*) into n_tables from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'soccer\\_%';
  select count(*) into n_rls from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = 'public' and c.relkind = 'r' and c.relname like 'soccer\\_%' and c.relrowsecurity;
  select count(*) into n_metrics from public.soccer_metric_definitions where status = 'design';
  if n_tables <> n_rls then raise exception 'PROOF_FAIL rls % of %', n_rls, n_tables; end if;
  -- frozen packets are append-only
  insert into public.soccer_news_events (id, story_class, desk, materiality, as_of) values ('ffffffff-ffff-5fff-bfff-ffffffffffff','match_recap','bundesliga',0.5,now());
  insert into public.soccer_article_evidence (packet_hash, news_event_id, packet_version, packet) values (repeat('a',64),'ffffffff-ffff-5fff-bfff-ffffffffffff','v','{}');
  begin
    update public.soccer_article_evidence set packet = '{"x":1}';
  exception when others then blocked := true;
  end;
  if not blocked then raise exception 'PROOF_FAIL evidence packet was updatable'; end if;
  -- 0400: player crosswalk accepts attribute_corroborated only with structured evidence; teams unchanged
  if not exists (select 1 from pg_constraint where conname = 'soccer_player_external_ids_corroboration_evidence') then raise exception 'PROOF_FAIL corroboration evidence constraint missing'; end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'soccer_team_external_ids_method_check')) like '%attribute_corroborated%' then raise exception 'PROOF_FAIL team methods were widened'; end if;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'soccer_player_external_ids_method_check')) not like '%attribute_corroborated%' then raise exception 'PROOF_FAIL player method not extended'; end if;
  raise exception 'ROLLBACK_PROOF_OK tables=% rls=% metric_seeds=% packet_immutable=%', n_tables, n_rls, n_metrics, blocked;
end $$;`;

mkdirSync('.proof', { recursive: true });
writeFileSync('.proof/rollback-proof.sql', `begin;\n${body}\n${checks}\ncommit;\n`);
console.log('.proof/rollback-proof.sql', readFileSync('.proof/rollback-proof.sql').length, 'bytes');
