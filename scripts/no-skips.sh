#!/usr/bin/env bash
# Fails when a test log reports skipped tests. Usage: bun test 2>&1 | tee test.log; scripts/no-skips.sh test.log
# Two summary shapes are recognised: bun's own "N skip" line, and vitest's "Tests ... N skipped" line, which is
# what the workers pool prints.
set -euo pipefail
log="${1:?usage: no-skips.sh <test-log>}"
bun_skips='^[[:space:]]*[1-9][0-9]* skip'
vitest_skips='^[[:space:]]*Tests.*[1-9][0-9]* skipped'
if grep -Eq "$bun_skips|$vitest_skips" "$log"; then
  echo "skipped tests are failures in CI:" >&2
  grep -E "$bun_skips|$vitest_skips|skip\)" "$log" >&2 || true
  exit 1
fi
echo "no skipped tests"
