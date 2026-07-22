#!/bin/bash
# Relaunch an Electron desktop app in the BACKGROUND with a CDP remote-debugging
# port, so it can be driven via cdp.mjs entirely off-Space / no focus steal.
#   ./cdp-launch.sh Notion 9222
set -e
APP="${1:-Notion}"
PORT="${2:-9222}"

echo "quitting $APP..."
osascript -e "tell application \"$APP\" to quit" 2>/dev/null || true
sleep 3
pkill -x "$APP" 2>/dev/null || true
sleep 2

echo "background-launching $APP with --remote-debugging-port=$PORT..."
open -g -na "$APP" --args --remote-debugging-port="$PORT"

echo "waiting for CDP endpoint..."
for i in $(seq 1 20); do
  if curl -s --max-time 1 "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "CDP up on :$PORT"
    curl -s "http://localhost:$PORT/json/version" | grep -o '"Browser":[^,]*'
    exit 0
  fi
  sleep 1
done
echo "ERROR: CDP endpoint never came up (app may strip the flag)" >&2
exit 1
