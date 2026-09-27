# Release

## Current production

**Nothing is deployed.** Soccer has no Workers, no Vercel project, no R2 bucket
and no applied migrations.

| Surface | Version | Rollback |
|---|---|---|
| Supabase SPORTS (`soccer_*`) | not applied. Rollback-only proof passed 2026-09-27 (`docs/evidence/storage/tkmln-2026-09-27.json`) | — |
| R2 `soccer-source` | not created | — |
| soccer-ingest / soccer-api / soccer-news / soccer-web | not created | — |
| soccer.propbetedge.ai | not attached | — |

## Gates

**Before any push:** `npm run check` (truth guard + tests).

**Before any migration apply** (owner approval required):
1. `node scripts/db/build-rollback-proof.mjs`, then `pwsh scripts/db/run-rollback-proof.ps1`. Pass criteria:
   - the output shows `ROLLBACK_PROOF_OK`;
   - the before and after catalogue fingerprints are equal;
   - residue is 0.
2. Verify the target's **applied** migration chain, not repo HEAD.
3. Apply one migration at a time, then run `notify pgrst, 'reload schema'`.
4. Fix forward only. Never edit an applied migration; add a new one.

**Before any Worker deploy** (owner approval for the first deploy of each):
1. `npm run check`.
2. `wrangler versions upload` from a clean `git archive` of pushed main, with `NODE_OPTIONS=--require D:/Workers/exfat-readlink.cjs` on D:.
3. `/health` on the preview version URL, plus the source canary.
4. `wrangler versions deploy`, then record the version id and the rollback version id in the table above.

**Frontend:** Vercel builds from main. `vercel-build` must run `npm run check`.

## Deploy log

| Date (UTC) | Surface | Change | Version | Rollback |
|---|---|---|---|---|
| — | — | — | — | — |
