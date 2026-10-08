#!/usr/bin/env bash
# Start many agents on one objective from a task file, through the public API.
#
#   NEST_TOKEN=... scripts/many-agents.sh scripts/remeda-tests.json
#
# The file names the project, the objective, context items to add first, the worker participants to
# rotate through, and the tasks. Everything it does, a human can do from the UI; this is the same
# sequence without the clicking. Starts are spaced out because every start forks the checkpoint.
set -euo pipefail

spec=${1:?usage: NEST_TOKEN=... $0 <spec.json>}
url=${NEST_URL:-https://nestagents.dev}
token=${NEST_TOKEN:?set NEST_TOKEN to the owner token}
gap=${NEST_START_GAP:-4}

api() { curl -sS -X "$1" "$url/api$2" -H "Authorization: Bearer $token" -H 'content-type: application/json' "${@:3}"; }
field() { jq -r "$1" "$spec"; }

project=$(field .project)
objective=$(field .objective.id)

echo "project $project, objective $objective"

# Context first, so the tasks can cite it and the agents' packs carry it.
jq -c '.context[]?' "$spec" | while read -r item; do
  id=$(jq -r .id <<<"$item")
  api POST "/p/$project/context" -d "$item" | jq -r --arg id "$id" '"context \($id): version \(.version // .item.version // "?")\(if .error then " (" + .error + ")" else "" end)"'
done

api POST "/p/$project/objectives" -d "$(jq -c .objective "$spec")" | jq -r '"objective: \(.objective.title // .title // .error)"'

jq -c '.tasks[]' "$spec" | while read -r task; do
  id=$(jq -r .id <<<"$task")
  api POST "/o/$objective/tasks" -d "$task" | jq -r --arg id "$id" '"task \($id): \(.status // .error)"'
done

workers=($(field '.workers[]'))
i=0
jq -r '.tasks[].id' "$spec" | while read -r id; do
  who=${workers[$((i % ${#workers[@]}))]}
  api POST "/o/$objective/tasks/$id/start" -d "{\"participant\":\"$who\"}" | jq -r --arg id "$id" --arg who "$who" '"started \($id) on \($who): \(.repo // .error)"'
  i=$((i + 1))
  sleep "$gap"
done

echo "watch $url/o/$objective"
