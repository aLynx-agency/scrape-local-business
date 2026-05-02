#!/usr/bin/env bash
# Uploads every file in a directory to a Telegram chat via the Bot API.
# Useful when scp/rsync isn't available (e.g., browser-based SSH consoles).
#
# Defaults to ./diagnostics. Override with: ./scripts/send-to-telegram.sh <dir>
#
# Required env (or hardcoded fallbacks below):
#   TG_BOT_TOKEN  bot token from @BotFather
#   TG_CHAT_ID    user id or chat id to send to
#
# Note: the target user MUST have sent at least one /start (or any message)
# to the bot first. Otherwise Telegram returns "chat not found" — bots can't
# initiate conversations.

set -euo pipefail

BOT_TOKEN="${TG_BOT_TOKEN:-7232097483:AAHjSiaPyIXDKVYr2uOd-E0h4_z5MIaOeN8}"
CHAT_ID="${TG_CHAT_ID:-1183697491}"
DIR="${1:-diagnostics}"

if [[ ! -d "$DIR" ]]; then
  echo "ERROR: directory not found: $DIR" >&2
  exit 1
fi

API="https://api.telegram.org/bot${BOT_TOKEN}"

shopt -s nullglob
files=("$DIR"/*)
if [[ ${#files[@]} -eq 0 ]]; then
  echo "No files in $DIR"
  exit 0
fi

echo "Sending ${#files[@]} files from $DIR to chat $CHAT_ID…"

# Intro message so the recipient sees context before the file flood.
curl -sS -X POST "${API}/sendMessage" \
  --data-urlencode "chat_id=${CHAT_ID}" \
  --data-urlencode "text=Diagnostics from $(hostname) — $(date -Iseconds) — ${#files[@]} files in ${DIR}/" \
  >/dev/null

for f in "${files[@]}"; do
  [[ -f "$f" ]] || continue
  size=$(stat -c%s "$f" 2>/dev/null || stat -f%z "$f")
  # Telegram bot API hard limit is 50 MB per file via sendDocument.
  if (( size > 50 * 1024 * 1024 )); then
    echo "  SKIP $(basename "$f") (${size} bytes > 50MB Telegram limit)"
    continue
  fi
  echo "  → $(basename "$f") (${size} bytes)"
  resp=$(curl -sS -X POST "${API}/sendDocument" \
    -F "chat_id=${CHAT_ID}" \
    -F "document=@${f}" \
    -F "caption=$(basename "$f")")
  if ! grep -q '"ok":true' <<<"$resp"; then
    echo "    FAILED: $resp"
  fi
done

echo "Done."
