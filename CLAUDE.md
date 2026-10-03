# Working rules for this repo

- **main only.** Workflow: test, commit, push immediately. No feature branches, no PRs.
- **Push only through `node scripts/release/push-main.mjs`** (runs the fail-closed gate, refuses on any non-zero exit,
  re-gates after a rebase, verifies origin). Never chain a test command through `| grep`, `| tail`, `;` or anything else
  that can replace its exit status before a commit/push (incident 0d8ec97: pushed with 3 failing tests). If a pipeline
  is unavoidable, use `set -o pipefail` and check the status explicitly.
- **Owner approval before:**
  - applying any migration
  - creating Cloudflare, Vercel or R2 resources
  - first deploys
  - any paid data source
  - posting externally
- **GitHub Actions:** never add a workflow. The guard fails the build if one exists.
- **Storage split:**
  - Sports Supabase (`tkmlnhmylqnttmnsnief`) holds soccer tables, prefix `soccer_`.
  - The identity/billing project (`rlfy…`) is never touched.
  - Every migration carries the target guard.
- **Rollback-only proof before any apply:** `node scripts/db/build-rollback-proof.mjs`, then `pwsh scripts/db/run-rollback-proof.ps1`. Apply is a separate, owner-approved step.
- **Sources:**
  - Every fetch goes through `workers/shared/http.js`.
  - 401, 403 and challenge responses throw `SourceBlockedError` and are never retried or routed around.
  - A new source needs a registry entry with evidence. Run `npm run guard`.
- **Identity:**
  - The provider id is a crosswalk, never the identity.
  - Never merge or found anything by name alone.
  - Unproven identity goes to `soccer_identity_queue`.
- **Truth:**
  - No sample or fake data files.
  - No invented stats, injuries or quotes.
  - Proprietary metrics stay unpublished until `docs/MODEL_READINESS.md` gates pass.
- **Windows file edits:**
  - Use the Write/Edit tools for anything containing backslashes. Git Bash heredocs and Python string literals mangle `\b` and `\\` (this has already happened once).
  - Python is fine for plain text edits; never use PowerShell heredocs.
- **Proof loop:** `npm run proof` (~3 min), then `npm run proof:article`, then `npm run check`.
