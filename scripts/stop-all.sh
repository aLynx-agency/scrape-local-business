#!/usr/bin/env bash
# Stops every process started by start-all.sh.

set -euo pipefail

stopped=0
if pkill -f "scripts/proxy-relay.mjs" 2>/dev/null; then
  echo "  ✓ proxy-relay stopped"
  stopped=$((stopped + 1))
fi
if pkill -f "google-chrome-stable" 2>/dev/null; then
  echo "  ✓ chrome stopped"
  stopped=$((stopped + 1))
fi
if pkill -f "tsx.*src/server" 2>/dev/null; then
  echo "  ✓ api stopped"
  stopped=$((stopped + 1))
fi

if [[ $stopped -eq 0 ]]; then
  echo "Nothing running."
fi
