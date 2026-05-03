#!/usr/bin/env bash
# Stops every process started by start-all.sh.
# Two-phase shutdown: SIGTERM → wait → SIGKILL anything still alive. Stale
# Chrome zombies block the next launch (SingletonLock), so we make sure the
# tree is gone before returning.

set -euo pipefail

stopped=0
for pat in "scripts/proxy-relay.mjs" "google-chrome" "tsx.*src/server"; do
  if pkill -f "$pat" 2>/dev/null; then
    stopped=$((stopped + 1))
  fi
done

if [[ $stopped -eq 0 ]]; then
  echo "Nothing running."
  exit 0
fi

# Give Chrome a moment to wind down its child processes gracefully.
sleep 2

# SIGKILL anything still alive.
pkill -9 -f "scripts/proxy-relay.mjs" 2>/dev/null || true
pkill -9 -f "google-chrome" 2>/dev/null || true
pkill -9 -f "tsx.*src/server" 2>/dev/null || true

# Clean up Chrome profile lock files so the next start-all isn't blocked by
# "Failed to create chrome-profile/SingletonLock: File exists".
rm -f chrome-profile/Singleton{Lock,Cookie,Socket} 2>/dev/null || true

echo "  ✓ stopped"
