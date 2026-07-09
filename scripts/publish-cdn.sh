#!/usr/bin/env bash
# Publish the CDN-mirror payload for one dataset to GitHub, feeding the two extra DB
# delivery routes in src/config.js (for networks where Cloudflare R2 is blocked or
# throttled):
#
#   - raw.githubusercontent.com/<repo>/<CDN_BRANCH>/...   (Fastly, CORS-open, HEAD)
#   - cdn.jsdelivr.net/gh/<repo>@<TAG>/...                (immutable per-version tag)
#
# Both read the SAME orphan-branch commit; the branch is force-pushed to a single
# commit (no history bloat), the tag pins that commit immutably. The payload is
# assembled by the caller in PAYLOAD_DIR (data/tortoise.sqlite.br, data/version.json,
# [data/changelog.json,] icons/custom-atlas.{webp,json}).
#
# Env: REPO (owner/name), CDN_BRANCH, TAG, GH_TOKEN, PAYLOAD_DIR.
set -euo pipefail
: "${REPO:?}" "${CDN_BRANCH:?}" "${TAG:?}" "${GH_TOKEN:?}" "${PAYLOAD_DIR:?}"

WORK="$(mktemp -d)"
cp -r "$PAYLOAD_DIR"/. "$WORK"/
cd "$WORK"
git init -q
git checkout -q -b "$CDN_BRANCH"
git add -A
git -c user.email="41898282+github-actions[bot]@users.noreply.github.com" \
    -c user.name="github-actions[bot]" commit -qm "cdn: $TAG"
git tag "$TAG"

REMOTE="https://x-access-token:${GH_TOKEN}@github.com/${REPO}.git"
git push -f "$REMOTE" "$CDN_BRANCH"                       # branch = latest (raw HEAD)
git push "$REMOTE" "refs/tags/$TAG" 2>/dev/null || echo "tag $TAG exists (idempotent re-deploy)"
echo "published $CDN_BRANCH + $TAG for $REPO"
