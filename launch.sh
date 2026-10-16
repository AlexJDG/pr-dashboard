#!/usr/bin/env bash
# Start the dashboard server and open it in the browser; the server exits once the page has been closed a while.
set -euo pipefail

cd "$(dirname "$0")"

# Pick up PR_DASHBOARD_* settings from .env, without overriding any already set in the environment
if [ -f .env ]; then
  while IFS="=" read -r key value || [ -n "$key" ]; do
    value="${value%\"}"; value="${value#\"}"
    if [[ $key == PR_DASHBOARD_* && -z "${!key:-}" ]]; then
      export "$key=$value"
    fi
  done < .env
fi

PORT="${1:-8765}"
URL="http://localhost:$PORT"
BROWSER="${PR_DASHBOARD_BROWSER:-/mnt/c/Program Files/Google/Chrome/Application/chrome.exe}"
PROFILE="${PR_DASHBOARD_BROWSER_PROFILE:-Default}"
# The server exits with this code after a server file changes, asking to be started again
RESTART_EXIT_CODE=75

open_page() {
  # Chromium-based browsers open it as a standalone app window in the given profile; others get a normal tab
  local name
  name="$(basename "$BROWSER" .exe)"
  case "${name,,}" in
    *chrome* | *chromium* | *msedge* | *brave*) "$BROWSER" --profile-directory="$PROFILE" --app="$URL" ;;
    *) "$BROWSER" "$URL" ;;
  esac
}

# The shortcut runs a non-interactive shell, which skips nvm in ~/.bashrc and would find the system Node
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  . "$HOME/.nvm/nvm.sh"
  nvm use --silent
  set -u
fi

if curl -sf "$URL/version" >/dev/null; then
  open_page
  exit
fi

run_server() {
  local code
  while true; do
    code=0
    IDLE_EXIT_SECONDS=180 SELF_RESTART=1 node server/server.ts "$PORT" || code=$?
    [ "$code" -eq "$RESTART_EXIT_CODE" ] || return "$code"
  done
}

run_server &
server=$!
until curl -sf "$URL/version" >/dev/null; do sleep 0.2; done
open_page
# Browsers usually hand off to their running instance and return, so stay alive on the server instead
wait "$server"
