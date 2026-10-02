#!/usr/bin/env node
// Rollback-only proof for migration 1500 with IN-TRANSACTION fingerprints (live lanes keep writing outside it):
// begin; fingerprints -> temp table; migration; checks; rollback. Run with scripts/db/run-rollback-proof.ps1.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
const strip = s => s.replace(/^\s*begin;\s*$/gim, '').replace(/^\s*commit;\s*$/gim, '');
const fp = `create temp table fp_1500 on commit drop as select
  (select md5(string_agg(m.id::text||m.kickoff_at::text||coalesce(m.home_score,-1)||coalesce(m.away_score,-1)||m.result_provider, ',' order by m.id)) from soccer_matches m join soccer_competitions c on c.id=m.competition_id where c.slug='premier-league') pl,
  (select md5(string_agg(m.id::text||m.kickoff_at::text||coalesce(m.home_score,-1)||coalesce(m.away_score,-1)||m.result_provider, ',' order by m.id)) from soccer_matches m join soccer_competitions c on c.id=m.competition_id where c.slug='bundesliga') bl,
  (select md5(string_agg(provider||external_id||match_id::text, ',' order by provider, external_id)) from soccer_match_external_ids) xw,
  (select count(*) from soccer_matches) n;`;
const mig = strip(readFileSync('supabase/migrations/20261002001500_soccer_repeated_fixtures.sql', 'utf8'));
const checks = readFileSync('scripts/db/checks-1500-repeated-fixtures.sql', 'utf8');
mkdirSync('.proof', { recursive: true });
writeFileSync('.proof/rollback-proof.sql', `begin;\n${fp}\n${mig}\n${checks}\nrollback;\n`);
console.log('wrote .proof/rollback-proof.sql');
