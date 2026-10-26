#!/usr/bin/env bash
set -euo pipefail
for attempt in 1 2 3; do
  set +e
  output=$(xcrun stapler "$@" 2>&1)
  result=$?
  set -e
  printf '%s\n' "$output"
  [[ "$result" == 0 ]] && exit 0
  # Retry only ticket-service/network failures, not an invalid local signature.
  if [[ "$attempt" == 3 ]] || ! [[ "$output" =~ (CloudKit|network|timed\ out|Error\ 68) ]]; then exit "$result"; fi
  sleep $((attempt * 10))
done
