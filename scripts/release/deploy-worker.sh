#!/usr/bin/env bash
# Deploy one Worker from a clean git archive of PUSHED main (never from a dirty tree).
#   scripts/release/deploy-worker.sh soccer-ingest|soccer-api [first|upload|deploy]
# first  -> initial creation of the Worker (versions upload needs an existing Worker)
# upload -> prints the version id + preview URL; check /health there, then run with deploy.
set -euo pipefail
W="$1"; MODE="${2:-upload}"
cd "$(dirname "$0")/../.."
git fetch -q origin
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "HEAD != origin/main: push first"; exit 1; }
[ -z "$(git status --porcelain -- workers data)" ] || { echo "uncommitted changes under workers/ or data/"; exit 1; }
OUT="D:/Workers/_deploy/soccer-$(git rev-parse --short HEAD)"
rm -rf "$OUT"; mkdir -p "$OUT"
git archive HEAD workers data package.json | tar -x -C "$OUT"
cd "$OUT/workers/$W"
export NODE_OPTIONS="--require D:/Workers/exfat-readlink.cjs"
if [ "$MODE" = "first" ]; then
  npx wrangler deploy --message "soccer first deploy $(basename "$OUT")"
elif [ "$MODE" = "upload" ]; then
  npx wrangler versions upload --message "soccer $(basename "$OUT")"
else
  npx wrangler versions deploy --yes
fi
