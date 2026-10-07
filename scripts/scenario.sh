#!/usr/bin/env bash
# The Harbor scenario: two competing export designs and a shared button, three agents, two model families.
#   NEST_URL=https://nest.<subdomain>.workers.dev scripts/scenario.sh [--reset]
set -euo pipefail
: "${NEST_URL:?set NEST_URL}"
TOKEN="$(cat ~/.secrets/nest_owner_token)"
api() { curl -fsS -H "authorization: Bearer $TOKEN" -H "content-type: application/json" "$@"; }

if [ "${1:-}" = "--reset" ]; then api -X POST "$NEST_URL/api/admin/reset" --data '{}' >/dev/null && echo "reset"; fi
api -X POST "$NEST_URL/api/admin/bootstrap" --data '{}' | jq -c '{checkpoint: .head.version, context: (.context | length)}'

task() {
  jq -n --arg id "$1" --arg title "$2" --arg brief "$3" --arg alt "${4:-}" '{id: $id, title: $title, brief: $brief, alternative: (if $alt == "" then null else $alt end)}' \
    | api -X POST "$NEST_URL/api/tasks" --data @- | jq -c '{id, title, alternative}'
}

task t_export-direct "Explore a direct CSV export" \
  "Make POST /api/exports return the viewer's CSV directly in the response, following req/export-api, req/export-columns and req/csv-format. Keep the work in separable commits so useful pieces can be reused even if this approach is not chosen." \
  export-strategy
task t_export-jobs "Explore a background-job export" \
  "Make POST /api/exports start a job that produces the viewer's CSV, with a status URL and a download URL, following req/export-api, req/export-columns and req/csv-format. Large tenants are expected (see ev/tenant-sizes). Keep the work in separable commits so useful pieces can be reused even if this approach is not chosen." \
  export-strategy
task t_export-ui "Export button" \
  "Add the Export CSV button described in req/export-ui. It must work with either export design that req/export-api allows: a direct CSV response, or a job with a status URL. Add tests."

start() { api -X POST "$NEST_URL/api/tasks/$1/start" --data "{\"participant\":\"$2\",\"mode\":\"agent\"}" | jq -c '{repo, epoch, workflow}'; }
start t_export-direct wren
start t_export-jobs kestrel
start t_export-ui heron
