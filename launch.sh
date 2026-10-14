#!/usr/bin/env bash
# Start the dashboard server and open it in a Chrome app window; the server exits once the window has been closed a while.
set -euo pipefail

PORT="${1:-8765}"
URL="http://localhost:$PORT"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="Default"

cd "$(dirname "$0")"

if curl -sf "$URL/version" >/dev/null; then
  "$CHROME" --profile-directory="$PROFILE" --app="$URL"
  exit
fi

IDLE_EXIT_SECONDS=180 python3 pr_dashboard.py "$PORT" &
server=$!
until curl -sf "$URL/version" >/dev/null; do sleep 0.2; done
"$CHROME" --profile-directory="$PROFILE" --app="$URL"
# Chrome hands off to its running instance and returns, so stay alive on the server instead
wait "$server"
