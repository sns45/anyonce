#!/usr/bin/env bash
# CHECKLIST P1: 100 percent statement coverage on go/anyonce/engine.go.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
profile="$(mktemp)"
GO="${GO:-go}"
"$GO" test -C "$root/go" -coverprofile="$profile" ./anyonce/ >/dev/null
report="$("$GO" tool -C "$root/go" cover -func="$profile" | grep 'anyonce/engine.go' || true)"
rm -f "$profile"
if [ -z "$report" ]; then
  echo "no coverage rows for engine.go" >&2
  exit 1
fi
echo "$report"
if echo "$report" | grep -vq '100.0%'; then
  echo "engine.go is not at 100 percent statement coverage" >&2
  exit 1
fi
echo "engine.go statement coverage 100 percent"
