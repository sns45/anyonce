#!/usr/bin/env bash
# Fails when a bun test log reports skipped tests. Usage: bun test 2>&1 | tee test.log; scripts/no-skips.sh test.log
set -euo pipefail
log="${1:?usage: no-skips.sh <bun-test-log>}"
if grep -Eq '^\s*[1-9][0-9]* skip' "$log"; then
  echo "skipped tests are failures in CI:" >&2
  grep -E '^\s*[1-9][0-9]* skip|skip\)' "$log" >&2 || true
  exit 1
fi
echo "no skipped tests"
