#!/usr/bin/env bash
# Day-1 gate: a real Artifacts fork, a push with Nest trailers, and a registered contribution.
#   NEST_URL=https://nest.<subdomain>.workers.dev scripts/roundtrip.sh
set -euo pipefail
: "${NEST_URL:?set NEST_URL to the deployed Worker URL}"
TOKEN="$(cat ~/.secrets/nest_owner_token)"
H=(-H "authorization: Bearer $TOKEN" -H "content-type: application/json")
api() { curl -fsS "${H[@]}" "$@"; }

echo "1. bootstrap"
api -X POST "$NEST_URL/api/admin/bootstrap" | jq -c '{head: .head.version, context: (.context | length)}'

TASK="t_roundtrip-$(date +%s)"
echo "2. task $TASK"
api -X POST "$NEST_URL/api/tasks" --data "{\"id\":\"$TASK\",\"title\":\"Round-trip probe\",\"brief\":\"Add a CONTRIBUTING note.\"}" | jq -c '{id, status}'
START=$(api -X POST "$NEST_URL/api/tasks/$TASK/start" --data '{"participant":"you","mode":"manual"}')
REMOTE=$(jq -r .remote <<<"$START"); REPO=$(jq -r .repo <<<"$START"); WTOKEN=$(jq -r .token <<<"$START"); EPOCH=$(jq -r .epoch <<<"$START")
echo "   fork $REPO"

WORK="$(mktemp -d)"
git -c http.extraHeader="Authorization: Bearer $WTOKEN" clone -q "$REMOTE" "$WORK/repo"
cd "$WORK/repo"
printf '# Contributing\n\nRun `node --test test/` before publishing.\n' > CONTRIBUTING.md
git add CONTRIBUTING.md
git -c user.name="Scott Hughes" -c user.email=v@deltagray.com commit -q -m "Add contributing note" -m "Nest-Task: $TASK
Nest-Attempt: $TASK/e$EPOCH
Nest-Cites: dec/0001-viewer-header@v1"
git -c http.extraHeader="Authorization: Bearer $WTOKEN" push -q origin HEAD:main
SHA=$(git rev-parse HEAD)
echo "3. pushed $SHA"

echo "4. waiting for the push event to register it (falls back to explicit publish after 45 s)"
for i in $(seq 1 15); do
  if api "$NEST_URL/api/state" | jq -e --arg sha "$SHA" '.contributions[] | select(.commit == $sha)' >/dev/null; then
    echo "   registered by the Artifacts push event after ~$((i * 3)) s"; break
  fi
  sleep 3
  if [ "$i" = 15 ]; then
    echo "   no event yet; publishing explicitly"
    api -X POST "$NEST_URL/api/publish" --data "{\"repo\":\"$REPO\",\"commit\":\"$SHA\"}" | jq -c .
  fi
done
api "$NEST_URL/api/state" | jq --arg sha "$SHA" '.contributions[] | select(.commit == $sha) | {id, title, status, paths, cites, requires}'
rm -rf "$WORK"
