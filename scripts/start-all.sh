#!/usr/bin/env bash
# One-shot bring-up: proxy-relay (if configured) → headless Chrome → API.
# Each service runs in the background, logs to $LOG_DIR (default /tmp/serp-api).
# Idempotent: kills any prior instances first.

set -euo pipefail

LOG_DIR="${LOG_DIR:-/tmp/serp-api}"
mkdir -p "$LOG_DIR"

if [[ ! -f .env ]]; then
  echo "ERROR: .env not found in $(pwd). Copy .env.example and fill it in." >&2
  exit 1
fi

# Source .env so we can read CDP_PORT / RELAY_PORT / PORT / UPSTREAM_PROXY here.
set -a
# shellcheck disable=SC1091
source .env
set +a

: "${TWOCAPTCHA_API_KEY:?missing in .env}"
CDP_PORT="${CDP_PORT:-9222}"
RELAY_PORT="${RELAY_PORT:-8888}"
API_PORT="${PORT:-3000}"

stop_all() {
  pkill -f "scripts/proxy-relay.mjs" 2>/dev/null || true
  pkill -f "google-chrome-stable" 2>/dev/null || true
  pkill -f "tsx.*src/server" 2>/dev/null || true
}

wait_for_port() {
  local port="$1" timeout="${2:-20}"
  for ((i = 0; i < timeout * 2; i++)); do
    ss -ltn 2>/dev/null | grep -q ":${port} " && return 0
    sleep 0.5
  done
  return 1
}

wait_for_url() {
  local url="$1" timeout="${2:-30}"
  for ((i = 0; i < timeout * 2; i++)); do
    curl -sf "$url" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

echo "[1/5] Stopping any prior instances…"
stop_all
sleep 1

if [[ -n "${UPSTREAM_PROXY:-}" ]]; then
  echo "[2/5] Starting proxy-relay → ${UPSTREAM_PROXY%%@*}@***"
  nohup npm run proxy-relay >"$LOG_DIR/proxy-relay.log" 2>&1 &
  if ! wait_for_port "$RELAY_PORT" 10; then
    echo "FAILED: proxy-relay didn't bind 127.0.0.1:$RELAY_PORT"
    tail -30 "$LOG_DIR/proxy-relay.log"
    exit 1
  fi
  echo "       ✓ relay up on 127.0.0.1:$RELAY_PORT"

  echo "[3/5] Verifying proxy chain (this can take 10–30s on first request)…"
  exit_ip=$(curl -s --max-time 60 --proxy "http://127.0.0.1:$RELAY_PORT" https://api.ipify.org || true)
  if [[ -z "$exit_ip" ]]; then
    echo "FAILED: proxy chain not working. Last 30 lines of relay log:"
    tail -30 "$LOG_DIR/proxy-relay.log"
    exit 1
  fi
  echo "       ✓ residential exit IP: $exit_ip"
else
  echo "[2-3/5] (no UPSTREAM_PROXY in .env — skipping relay; Chrome will use its direct IP)"
fi

echo "[4/5] Starting Chrome (headless)…"
nohup env HEADLESS=true bash scripts/launch-chrome.sh >"$LOG_DIR/chrome.log" 2>&1 &
if ! wait_for_port "$CDP_PORT" 15; then
  echo "FAILED: Chrome didn't bind 127.0.0.1:$CDP_PORT"
  tail -30 "$LOG_DIR/chrome.log"
  exit 1
fi
echo "       ✓ Chrome CDP up on 127.0.0.1:$CDP_PORT"

echo "[5/5] Starting API server…"
nohup npm run start >"$LOG_DIR/api.log" 2>&1 &
if ! wait_for_url "http://127.0.0.1:$API_PORT/health" 30; then
  echo "FAILED: API didn't come up. Last 30 lines of api log:"
  tail -30 "$LOG_DIR/api.log"
  exit 1
fi
health=$(curl -s "http://127.0.0.1:$API_PORT/health")
echo "       ✓ API health: $health"

cat <<EOF

All services up. Logs in $LOG_DIR/
  tail -f $LOG_DIR/api.log
  tail -f $LOG_DIR/chrome.log
  tail -f $LOG_DIR/proxy-relay.log

Test a scrape:
  curl -X POST http://127.0.0.1:$API_PORT/scrape \\
    -H 'Content-Type: application/json' \\
    -d '{"query":"dentist in Brussels","maxPages":1}'

Stop everything:
  ./scripts/stop-all.sh
EOF
