#!/usr/bin/env bash
# Launches a Chromium-based browser with remote debugging enabled, using a
# dedicated user-data-dir so it does not conflict with the user's normal session.
# Run this BEFORE starting the API server. Leave it running.

set -euo pipefail

CDP_PORT="${CDP_PORT:-9222}"
USER_DATA_DIR="${USER_DATA_DIR:-$(pwd)/chrome-profile}"

# Pick a sensible default per-OS if CHROME_PATH isn't set
if [[ -z "${CHROME_PATH:-}" ]]; then
  if [[ "$(uname)" == "Darwin" ]]; then
    CHROME_PATH="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
  else
    # Linux: prefer google-chrome, fall back to brave
    if command -v google-chrome-stable >/dev/null 2>&1; then
      CHROME_PATH="$(command -v google-chrome-stable)"
    elif command -v google-chrome >/dev/null 2>&1; then
      CHROME_PATH="$(command -v google-chrome)"
    elif command -v brave-browser >/dev/null 2>&1; then
      CHROME_PATH="$(command -v brave-browser)"
    else
      echo "ERROR: no Chromium-based browser found. Set CHROME_PATH." >&2
      exit 1
    fi
  fi
fi

if [[ ! -e "$CHROME_PATH" ]]; then
  echo "ERROR: CHROME_PATH does not exist: $CHROME_PATH" >&2
  exit 1
fi

mkdir -p "$USER_DATA_DIR"

# HEADLESS=true runs the browser with no visible window. Uses Chrome's "new"
# headless mode (Chrome 109+) which shares the rendering pipeline with headed,
# so it's much harder for sites to fingerprint as automation than the legacy
# --headless flag. Required for Ubuntu deployment without a display.
HEADLESS_FLAGS=""
if [[ "${HEADLESS:-false}" == "true" ]]; then
  HEADLESS_FLAGS="--headless=new --disable-gpu --window-size=1366,900"
fi

# Chrome refuses to start as root unless --no-sandbox is set. The proper fix is
# a non-root user, but on single-purpose VPS deployments running as root is
# common — auto-add the flag with a warning rather than crashing. Set
# ALLOW_NO_SANDBOX=false to opt out and force a non-root user.
SANDBOX_FLAGS=""
if [[ "$(id -u)" == "0" && "${ALLOW_NO_SANDBOX:-true}" == "true" ]]; then
  echo "WARN: running Chrome as root — adding --no-sandbox. Prefer a non-root user." >&2
  SANDBOX_FLAGS="--no-sandbox"
fi

# Optional outbound proxy. For datacenter IPs (AWS/GCP/DO/Hetzner/etc.) Google
# routes you straight to /sorry/ regardless of how good your captcha solver is —
# the IP itself is the signal. Pointing this at a residential or rotating proxy
# is usually the only thing that actually fixes it. Format: "http://host:port"
# or "socks5://host:port". Auth proxies (user:pass) require additional handling
# at the Playwright level — see SERVER_SETUP.md.
PROXY_FLAGS=""
if [[ -n "${PROXY_SERVER:-}" ]]; then
  PROXY_FLAGS="--proxy-server=$PROXY_SERVER"
fi

# Anti-detection: --disable-blink-features=AutomationControlled hides the
# `navigator.webdriver=true` flag that Google checks first when triaging bots.
# Without this, a fresh headless profile on a clean IP can still get /sorry/'d
# on the very first request.
STEALTH_FLAGS="--disable-blink-features=AutomationControlled"

echo "Launching: $CHROME_PATH"
echo "  CDP port:        $CDP_PORT"
echo "  User data dir:   $USER_DATA_DIR"
echo "  Headless:        ${HEADLESS:-false}"
echo "  Proxy:           ${PROXY_SERVER:-<none>}"
echo

exec "$CHROME_PATH" \
  --remote-debugging-port="$CDP_PORT" \
  --remote-debugging-address=127.0.0.1 \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=BraveRewards,BraveWallet,BraveAds,BraveTor \
  $HEADLESS_FLAGS \
  $SANDBOX_FLAGS \
  $STEALTH_FLAGS \
  $PROXY_FLAGS
