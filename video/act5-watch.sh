#!/usr/bin/env bash
# Waits for the take to invite the outside agent and create its task, then runs act 5 (the Codex terminal).
set -euo pipefail
DIR=${VIDEO_DIR:-$(pwd)}
rm -f "$DIR/act5.ready" "$DIR/act5.token"
for i in $(seq 1 1000); do
  if [ -f "$DIR/act5.ready" ] && [ -f "$DIR/act5.token" ]; then
    echo "$(date -u +%H:%M:%SZ) act 5 starts"
    bash "$DIR/act5.sh"
    exit 0
  fi
  sleep 10
done
echo "act 5 never became ready"; exit 1
