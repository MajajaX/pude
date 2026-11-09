#!/usr/bin/env bash
# Runs a command with a time limit per attempt and retries it when it fails or stalls.
# Usage: ci-retry.sh <attempts> <seconds-per-attempt> <command> [arguments...]
set -u

attempts="$1"
seconds_per_attempt="$2"
shift 2

for attempt in $(seq 1 "$attempts"); do
  if timeout --kill-after=15 "$seconds_per_attempt" "$@"; then
    exit 0
  fi
  echo "Attempt $attempt of $attempts failed or timed out after ${seconds_per_attempt}s: $*" >&2
  if [ "$attempt" -lt "$attempts" ]; then
    sleep $((attempt * 15))
  fi
done

exit 1
