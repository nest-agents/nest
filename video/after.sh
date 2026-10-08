#!/usr/bin/env bash
# After the take: Beacon back to human mode, the invited agent's token revoked, nothing left running.
set -euo pipefail
H="Authorization: Bearer $(cat ~/.secrets/nest_owner_token)"
B=https://nestagents.dev/api
echo "== policy back to human"
BODY='A human settles what agent reviewers cannot. Dependency and build changes need a human. A human accepts every checkpoint.

```nest-policy
{
  "decider": "human",
  "autoAccept": false
}
```'
curl -s -X POST "$B/p/beacon/context" -H "$H" -H 'content-type: application/json' \
  -d "$(jq -cn --arg body "$BODY" '{id: "policy/review-routing", body: $body}')" | jq -c '{version: (.version // .item.version), error: .error}'
curl -s $B/o/beacon-open | jq -c '{policy: {decider: .policy.decider, autoAccept: .policy.autoAccept}}'
echo "== revoke the invited agent"
curl -s -X POST "$B/participants/codex-laptop/rotate" -H "$H" | jq -c '{id, revoked: (.token|length > 0)}'
echo "== running tasks on beacon-open"
curl -s $B/o/beacon-open | jq -c '[.tasks[] | select(.status=="running") | .id]'
