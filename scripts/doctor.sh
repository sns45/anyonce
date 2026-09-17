#!/bin/sh
# Toolchain doctor (questions.md Q6). One line per tool, exit 1 if any check fails.
# Set CI=true and DOCTOR_SKIP_GOLANGCI=1 where a dedicated job runs golangci-lint instead.
set -u

fail=0

say() {
  printf '%-14s %s\n' "$1" "$2"
}

# bun: any 1.x
if command -v bun >/dev/null 2>&1; then
  bun_version=$(bun --version 2>/dev/null)
  case "$bun_version" in
    1.*) say bun "ok $bun_version" ;;
    *)
      say bun "OLD $bun_version (want 1.x)"
      fail=1
      ;;
  esac
else
  say bun "MISSING (install from bun.sh)"
  fail=1
fi

# go: 1.26 or newer, preferring the homebrew binary over an older toolchain on PATH
go_bin=""
if [ -x /opt/homebrew/bin/go ]; then
  go_bin=/opt/homebrew/bin/go
elif command -v go >/dev/null 2>&1; then
  go_bin=$(command -v go)
fi
if [ -n "$go_bin" ]; then
  go_report=$("$go_bin" version 2>/dev/null)
  go_number=$(printf '%s\n' "$go_report" | awk '{print $3}' | sed 's/^go//')
  go_major=$(printf '%s\n' "$go_number" | cut -d. -f1)
  go_minor=$(printf '%s\n' "$go_number" | cut -d. -f2)
  case "$go_major" in
    '' | *[!0-9]*) go_major_numeric="" ;;
    *) go_major_numeric=$go_major ;;
  esac
  case "$go_minor" in
    '' | *[!0-9]*) go_minor_numeric="" ;;
    *) go_minor_numeric=$go_minor ;;
  esac
  if [ -z "$go_major_numeric" ] || [ -z "$go_minor_numeric" ]; then
    say go "warn $go_report ($go_bin, non-numeric version, cannot compare against 1.26)"
  elif [ "$go_major_numeric" -gt 1 ] || { [ "$go_major_numeric" -eq 1 ] && [ "$go_minor_numeric" -ge 26 ]; }; then
    say go "ok $go_report ($go_bin)"
  else
    say go "OLD $go_report ($go_bin, want 1.26 or newer)"
    fail=1
  fi
  path_go=$(command -v go 2>/dev/null || true)
  if [ -n "$path_go" ] && [ "$path_go" != "$go_bin" ]; then
    path_number=$("$path_go" version 2>/dev/null | awk '{print $3}' | sed 's/^go//')
    path_minor=$(printf '%s\n' "$path_number" | cut -d. -f2)
    case "$path_minor" in
      '' | *[!0-9]*) path_minor_numeric="" ;;
      *) path_minor_numeric=$path_minor ;;
    esac
    if [ -z "$path_minor_numeric" ] || [ -z "$go_minor_numeric" ]; then
      : # non-numeric minor on either side, skip the PATH-order comparison
    elif [ "$path_minor_numeric" -lt "$go_minor_numeric" ]; then
      say "go(PATH)" "warn $path_go is go$path_number; put $go_bin first on PATH"
    fi
  fi
else
  say go "MISSING (want 1.26 or newer)"
  fail=1
fi

# docker: the daemon has to answer, not just the client
if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    say docker "ok daemon reachable"
  else
    say docker "MISSING (client present, daemon not reachable)"
    fail=1
  fi
else
  say docker "MISSING"
  fail=1
fi

# golangci-lint: pinned to one version locally and in CI
want_golangci=2.13.2
if command -v golangci-lint >/dev/null 2>&1; then
  golangci_version=$(golangci-lint --version 2>/dev/null | awk '{print $4}')
  if [ "$golangci_version" = "$want_golangci" ]; then
    say golangci-lint "ok $golangci_version"
  else
    say golangci-lint "OLD $golangci_version (want $want_golangci)"
    fail=1
  fi
elif [ "${CI:-}" = "true" ] && [ "${DOCTOR_SKIP_GOLANGCI:-}" = "1" ]; then
  say golangci-lint "ok skipped on CI (the go job runs the pinned action)"
else
  say golangci-lint "MISSING (want $want_golangci)"
  fail=1
fi

exit "$fail"
