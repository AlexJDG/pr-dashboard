#!/usr/bin/env bash
# Start the dashboard server and open it in a Chrome app window; the server exits once the window has been closed a while.
set -euo pipefail

PORT="${1:-8765}"
URL="http://localhost:$PORT"
CHROME="/mnt/c/Program Files/Google/Chrome/Application/chrome.exe"
PROFILE="Default"
# The server exits with this code after server.ts changes, asking to be started again
RESTART_EXIT_CODE=75

cd "$(dirname "$0")"

# The shortcut runs a non-interactive shell, which skips nvm in ~/.bashrc and would find the system Node
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  . "$HOME/.nvm/nvm.sh"
  nvm use --silent
  set -u
fi

if curl -sf "$URL/version" >/dev/null; then
  "$CHROME" --profile-directory="$PROFILE" --app="$URL"
  exit
fi

run_server() {
  local code
  while true; do
    code=0
    IDLE_EXIT_SECONDS=180 SELF_RESTART=1 node server.ts "$PORT" || code=$?
    [ "$code" -eq "$RESTART_EXIT_CODE" ] || return "$code"
  done
}

run_server &
server=$!
until curl -sf "$URL/version" >/dev/null; do sleep 0.2; done
"$CHROME" --profile-directory="$PROFILE" --app="$URL"
# Chrome hands off to its running instance and returns, so stay alive on the server instead
wait "$server"
