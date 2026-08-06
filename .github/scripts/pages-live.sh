#!/usr/bin/env bash
# Is the commit we just built ACTUALLY being served by GitHub Pages?
#
# actions/deploy-pages is not a reliable signal for this site: it returns a terminal
# "Deployment failed, try again later" on roughly half of attempts, and -- observed on
# run 31103852579 -- it can report failure on all five attempts for a deployment that
# published fine (/tbc/cmangos/ went 404 -> 200 while every attempt was "failing").
# So the ladder asks the live site instead of trusting the action's exit code.
#
# The build stamps dist/deploy-marker.txt with $GITHUB_SHA; this polls for it.
#
# usage: pages-live.sh <site-url> <expected-sha> [timeout-seconds]
set -uo pipefail

URL="${1:?site url}"
WANT="${2:?expected sha}"
TIMEOUT="${3:-90}"
DEADLINE=$((SECONDS + TIMEOUT))
GOT=""

while :; do
  # Cache-bust: Pages sits behind a CDN and we need the CURRENT bytes, not a cached
  # copy of the previous deploy's marker.
  GOT=$(curl -fsSL --max-time 10 -H 'Cache-Control: no-cache' -H 'Pragma: no-cache' \
        "${URL%/}/deploy-marker.txt?cb=${SECONDS}${RANDOM}" 2>/dev/null \
        | tr -d '[:space:]') || GOT=""
  if [ "$GOT" = "$WANT" ]; then
    echo "live: Pages is serving ${GOT}"
    exit 0
  fi
  if [ "$SECONDS" -ge "$DEADLINE" ]; then break; fi
  sleep 5
done

echo "not live yet: serving '${GOT:-<no marker>}', want '${WANT}'"
exit 1
