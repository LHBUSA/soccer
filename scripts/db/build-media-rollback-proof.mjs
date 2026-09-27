#!/usr/bin/env node
// Rollback-only proof for 20260927000500_soccer_entity_media ON TOP OF the applied
// chain (0100-0400 are live; replaying them would fail). BEGIN; the one migration;
// behavioural checks; RAISE (always aborts). Output: .proof/rollback-proof.sql,
// run with scripts/db/run-rollback-proof.ps1 (fingerprint + zero-residue checks).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const f = '20260927000500_soccer_entity_media.sql';
const sql = readFileSync(`supabase/migrations/${f}`, 'utf8').replace(/^\s*begin;\s*$/gim, '').replace(/^\s*commit;\s*$/gim, '');
const checks = `
do $$
declare ok boolean; pid uuid;
begin
  select id into pid from public.soccer_players limit 1;
  if not (select relrowsecurity from pg_class where relname = 'soccer_entity_media') then raise exception 'PROOF_FAIL rls'; end if;
  -- review_required with no licence is accepted (it is never published)
  insert into public.soccer_entity_media (id, entity_type, entity_id, media_type, url, source, source_url, rights_status)
    values ('00000000-0000-5000-8000-0000000000a1', 'player', pid, 'portrait', 'https://upload.wikimedia.org/x.jpg', 'wikimedia_commons', 'https://commons.wikimedia.org/wiki/File:X.jpg', 'review_required');
  -- approved without licence / hash / cached object is refused
  ok := false;
  begin
    insert into public.soccer_entity_media (id, entity_type, entity_id, media_type, url, source, source_url, rights_status)
      values ('00000000-0000-5000-8000-0000000000a2', 'player', pid, 'portrait', 'https://upload.wikimedia.org/y.jpg', 'wikimedia_commons', 'https://commons.wikimedia.org/wiki/File:Y.jpg', 'approved');
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'PROOF_FAIL approved row without provenance accepted'; end if;
  -- a primary that is not approved is refused
  ok := false;
  begin
    update public.soccer_entity_media set is_primary = true where id = '00000000-0000-5000-8000-0000000000a1';
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'PROOF_FAIL non-approved primary accepted'; end if;
  -- complete approved rows: only one primary per entity/media type
  insert into public.soccer_entity_media (id, entity_type, entity_id, media_type, url, source, source_url, license, license_url, attribution, rights_status, is_primary, verified_at, content_sha256, object_key)
    values ('00000000-0000-5000-8000-0000000000a3', 'player', pid, 'portrait', 'https://upload.wikimedia.org/z.jpg', 'wikimedia_commons', 'https://commons.wikimedia.org/wiki/File:Z.jpg', 'CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0', 'A. Author', 'approved', true, now(), repeat('a', 64), 'k1');
  ok := false;
  begin
    insert into public.soccer_entity_media (id, entity_type, entity_id, media_type, url, source, source_url, license, license_url, attribution, rights_status, is_primary, verified_at, content_sha256, object_key)
      values ('00000000-0000-5000-8000-0000000000a4', 'player', pid, 'portrait', 'https://upload.wikimedia.org/w.jpg', 'wikimedia_commons', 'https://commons.wikimedia.org/wiki/File:W.jpg', 'CC0', 'https://creativecommons.org/publicdomain/zero/1.0', 'B', 'approved', true, now(), repeat('b', 64), 'k2');
  exception when unique_violation then ok := true; end;
  if not ok then raise exception 'PROOF_FAIL two primaries accepted'; end if;
  raise exception 'PROOF_OK media registry checks passed (rolled back)';
end $$;
`;
mkdirSync('.proof', { recursive: true });
writeFileSync('.proof/rollback-proof.sql', `begin;\n-- ${f}\n${sql}\n${checks}\nrollback;\n`);
console.log('wrote .proof/rollback-proof.sql');
