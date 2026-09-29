# Release

## Current production (2026-09-27)

| Surface | Version | Rollback |
|---|---|---|
| Supabase SPORTS `tkmlnhmylqnttmnsnief` | migrations 0100, 0200, 0300, 0400 applied (sha256 in `docs/evidence/storage/tkmln-applied-2026-09-27.json`; apply log `.proof/apply.out`) | fix forward |
| R2 `soccer-source` | created 2026-09-27 (ENAM). 109 Wyscout/OpenLigaDB captures uploaded, all sha256-verified; ESPN captures written by the Worker | — |
| KV `SOCCER_STATE` | `3e665f75414849578249f5aed979b868` | — |
| soccer-ingest | `2beb903b-f3d8-4f95-8eda-e2e411fd074a` (https://soccer-ingest.sales-fd3.workers.dev, cron */5) | `998c92ad-2070-44a1-a20e-de736b8343f1` |
| soccer-api | `61d9558b-acd1-4269-b24a-29c494945add` (https://soccer-api.sales-fd3.workers.dev) | `162e3a57-d1c4-411d-a047-3a92f6ee7e2f` |
| soccer.propbetedge.ai (Vercel `soccer`, prj_3UgFIxhnlVcLmhnnNDc1WoHOtXGn) | web app `dpl_J3fPjcYaZE1BDYBt1E58Xb5cAYTg` (commit 84dbd4c). The newsroom has no published articles and /news is noindex | previous READY deployment |

**ESPN lanes:**
- Enabled: `bundesliga`, `premier-league`, `uefa-champions-league`.
- Everything else is disabled in the registry (`espn.enabled`), to be expanded competition by competition through the canary and identity gates.
- The Bundesliga has `espn.may_found=false`: ESPN attaches there and never founds.

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

- **Before any push:** `npm run check` (truth guard + tests), run ON ITS OWN. Its exit status is the verdict: never
  chain it through `grep`, `tail`, `|` or `&&` into a commit/push, because a pipeline reports the last command's
  status and can hide a failing suite. `npm run check` = `scripts/release/gate.mjs` (each step a direct child process,
  exit status read directly; PGlite test files run with bounded concurrency).
- **Every release is gated:** `release-worker.mjs` runs the same gate before building or uploading anything (also
  under `--dry`); any non-zero exit refuses the release and production is untouched.
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
| 2026-09-27 15:56 | Supabase SPORTS | migrations 0100–0400 applied; post-apply proof passed | — | fix forward |
| 2026-09-27 15:57 | R2 / KV | soccer-source, SOCCER_STATE created | — | — |
| 2026-09-27 16:01 | soccer-ingest | first deploy, then secrets | 2aeb3ff1 → 4cce2680 | — |
| 2026-09-27 16:02 | soccer-api | first deploy, then secrets | 9ab0df6f → f7cd4b51 | — |
| 2026-09-27 16:03 | soccer-ingest | all lanes paused via KV backoff (cron live before backfill) | — | — |
| 2026-09-27 16:06 | soccer-ingest | lane guards (ESPN may_found / enabled) | 5dc0164f | 4cce2680 |
| 2026-09-27 16:25 | soccer-ingest | ordered paging fix; admin budget | 998c92ad | 5dc0164f |
| 2026-09-27 16:26 | soccer-api | ordered paging fix | 07f9902b | f7cd4b51 |
| 2026-09-27 17:05 | soccer-api | parallel route queries | 9b62221c | 07f9902b |
| 2026-09-27 16:30–18:00 | data | production backfill certified (0-write re-passes); ESPN fill Bundesliga/EPL/UCL via the Worker (R2 captures) | — | — |
| 2026-09-27 18:05 | soccer-ingest | close proven queue entries | 2beb903b | 998c92ad |
| 2026-09-27 18:05 | soccer-api | stats basis stated in semantics | 162e3a57 | 9b62221c |
| 2026-09-27 18:16 | soccer-api | additive: match competition, from/to/order, /v1/coverage | 61d9558b | 162e3a57 |
| 2026-09-27 18:42 | web (Vercel) | soccer web app + /api/soccer proxy; production browser QA 140/140 | dpl_ESxQyNubVGawygQ9N3nAgXg27yw2 | dpl_BVJqacbK6cLQ7WZtnJa4mLHFqwKQ |
| 2026-09-27 18:47 | web (Vercel) | real 404s for unknown paths | dpl_J3fPjcYaZE1BDYBt1E58Xb5cAYTg | dpl_ESxQyNubVGawygQ9N3nAgXg27yw2 |
