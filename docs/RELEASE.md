# Release

## Current production

**Nothing is deployed yet.** The owner approved the production foundation on
2026-09-27: migrations, R2, soccer-ingest, soccer-api and the Bundesliga backfill.

This session's automation stopped at the first production action. Its permission
classifier blocked applying the migrations and classified it as a production
deploy. Every step below is therefore scripted and rehearsed, but has not been run.

| Surface | Version | Rollback |
|---|---|---|
| Supabase SPORTS (`soccer_*`) | not applied. Rollback-only proof passed; unmodified files ready | — (fix forward) |
| R2 `soccer-source` | not created | — |
| soccer-ingest | code ready (`workers/soccer-ingest`), not deployed | — |
| soccer-api | code ready (`workers/soccer-api`), not deployed | — |
| soccer.propbetedge.ai | not attached; frontend waits for API certification | — |

## Production foundation runbook (owner-approved 2026-09-27)

Run these in order from `D:\Workers\soccer` on pushed `main`. Each step writes its
evidence under `docs/evidence/`. Commit and push that evidence after each step.

1. **Pre-checks:**
   - `git fetch; git rev-parse HEAD origin/main` shows equal SHAs.
   - Guard markers are present and no `soccer_*` tables exist (the query is in `scripts/db/verify-applied.ps1`).
2. **Apply the 3 migrations, unmodified, one at a time:**
   `pwsh scripts/db/apply-migrations.ps1 20260927000100_soccer_core.sql 20260927000200_soccer_events.sql 20260927000300_soccer_news.sql`
   The script prints the sha256 of each file, takes the fingerprint before and after, and reloads the PostgREST schema.
3. **Post-apply proof:** `pwsh scripts/db/verify-applied.ps1`. This writes `docs/evidence/storage/tkmln-applied-<date>.json`. Expect:
   - 31 tables, all 31 with RLS;
   - 0 policies;
   - the trigger probe reports `blocked=true`;
   - 10 metric definitions, all `design`;
   - the non-soccer fingerprint is unchanged (`ae61aa44803aa9767d6bc93b21e7faec`, 1,499 objects on 2026-09-27);
   - 0 probe residue.
4. **Secrets file:** `pwsh scripts/db/write-soccer-env.ps1`. This writes `D:\Workers\secrets\soccer-supabase.env`; the values are never printed.
5. **Cloudflare resources:**
   - `npx wrangler r2 bucket create soccer-source`
   - `npx wrangler kv namespace create SOCCER_STATE`. Put the id into `workers/soccer-ingest/wrangler.toml` and `workers/soccer-api/wrangler.toml`, then commit and push.
   - Generate an admin token into `D:\Workers\secrets\soccer-ingest-admin-token`.
   - soccer-ingest secrets: `wrangler secret put SOCCER_MODEL_SUPABASE_URL`, `SOCCER_MODEL_SUPABASE_SERVICE_ROLE_KEY`, `INGEST_ADMIN_TOKEN`.
   - soccer-api secrets: the first two only.
6. **Deploy** from a clean archive of pushed main:
   - `bash scripts/release/deploy-worker.sh soccer-ingest upload`, check `/health` on the preview URL, then `... deploy`.
   - Same for `soccer-api`.
   - Record the version ids in the table above.
7. **Raw captures to R2:** `SOCCER_INGEST_URL=https://soccer-ingest.<acct>.workers.dev node scripts/r2/upload-captures.mjs`.
   - Uploads are write-once and content-addressed.
   - The stored sha256 is compared with the local bytes for every object.
   - Evidence: `docs/evidence/storage/r2-upload-<date>.json`.
8. **Backfill and certification:** `node scripts/backfill/prod-bundesliga.mjs`.
   - It runs Wyscout 2017/18, then OpenLigaDB 2017 (fixture-graph proof), then OpenLigaDB 2004/05 onwards.
   - A second full pass must write 0 rows.
   - Evidence: `docs/evidence/proof/production-certification-<date>.json`, reporting expected against observed.
   - Rehearsed locally with the identical code: `rehearsal-certification-2026-09-27.json`. All checks match, and the second pass writes 0 rows.
9. **Canaries:**
   - `curl -H "authorization: Bearer $(cat D:/Workers/secrets/soccer-ingest-admin-token)" https://soccer-ingest.<acct>.workers.dev/v1/canary/espn`
   - `SOCCER_API_URL=... node scripts/qa/api-timings.mjs` writes `docs/evidence/api/timings-<date>.json`.
10. **ESPN lanes.** They run from the cron: one competition per tick, 30 requests per tick. For a faster initial fill, run `node scripts/backfill/espn-rehearsal.mjs --prod --competitions bundesliga --budget 1500`.

The public frontend and an indexable newsroom stay off until the production data and canary layer is certified.

## Gates

- **Before any push:** `npm run check` (truth guard + tests).
- **Migrations:**
  - run the rollback-only proof first (`scripts/db/build-rollback-proof.mjs` + `run-rollback-proof.ps1`);
  - verify the target's applied chain, not repo HEAD;
  - apply one file at a time;
  - fix forward only.
- **Workers:**
  - `versions upload`, then `/health` on the preview, then `versions deploy`;
  - never from a dirty tree; `deploy-worker.sh` enforces this;
  - on D: use `NODE_OPTIONS=--require D:/Workers/exfat-readlink.cjs`.

## Deploy log

| Date (UTC) | Surface | Change | Version | Rollback |
|---|---|---|---|---|
| — | — | — | — | — |
