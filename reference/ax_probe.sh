#!/bin/bash
# ax_probe.sh — Does macOS Accessibility let us read + act on an app WITHOUT stealing focus?
#
# Usage:
#   ./ax_probe.sh read   "WhatsApp"        # read-only: windows + element tree
#   ./ax_probe.sh press  "WhatsApp" 1 1    # press button 1 of window 1  (DESTRUCTIVE-ish)
#   ./ax_probe.sh type   "WhatsApp" "hi"   # set value of first text field (DESTRUCTIVE-ish)
#
# The ONLY thing that matters: FRONTMOST before vs after. If it's unchanged, we win.

set -uo pipefail

frontmost() {
  osascript -e 'tell application "System Events" to return name of first process whose frontmost is true' 2>/dev/null
}

banner() { printf '\n\033[1m%s\033[0m\n' "$1"; }

APP="${2:-}"
[ -z "$APP" ] && { echo "usage: $0 <read|press|type> \"AppName\" [args]"; exit 1; }

BEFORE="$(frontmost)"
banner "FRONTMOST BEFORE: $BEFORE"

case "${1:-}" in

  read)
    banner "WINDOWS"
    osascript <<EOF
tell application "System Events"
  tell process "$APP"
    set out to ""
    repeat with w in windows
      set out to out & "  win: " & (name of w) & linefeed
    end repeat
    return out
  end tell
end tell
EOF

    banner "TREE (window 1, depth 2) — role / label / actions"
    osascript <<EOF
tell application "System Events"
  tell process "$APP"
    set out to ""
    try
      repeat with e in (UI elements of window 1)
        set r to (role of e) as text
        try
          set n to (name of e) as text
        on error
          set n to "-"
        end try
        try
          set a to (name of every action of e) as text
        on error
          set a to ""
        end try
        set out to out & "  " & r & " | " & n & " | " & a & linefeed
        try
          repeat with c in (UI elements of e)
            set cr to (role of c) as text
            try
              set cn to (name of c) as text
            on error
              set cn to "-"
            end try
            set out to out & "      " & cr & " | " & cn & linefeed
          end repeat
        end try
      end repeat
    on error errMsg
      set out to out & "  ERROR: " & errMsg
    end try
    return out
  end tell
end tell
EOF
    ;;

  press)
    W="${3:-1}"; B="${4:-1}"
    banner "PRESS button $B of window $W"
    osascript <<EOF
tell application "System Events"
  tell process "$APP"
    perform action "AXPress" of button $B of window $W
  end tell
end tell
EOF
    ;;

  type)
    TXT="${3:-hello}"
    banner "SET VALUE of first text field -> '$TXT'"
    osascript <<EOF
tell application "System Events"
  tell process "$APP"
    set value of text field 1 of window 1 to "$TXT"
  end tell
end tell
EOF
    ;;

  *)
    echo "usage: $0 <read|press|type> \"AppName\" [args]"; exit 1;;
esac

sleep 0.4
AFTER="$(frontmost)"
banner "FRONTMOST AFTER:  $AFTER"

if [ "$BEFORE" = "$AFTER" ]; then
  printf '\033[32m✓ FOCUS UNCHANGED — background control works.\033[0m\n\n'
else
  printf '\033[31m✗ FOCUS STOLEN (%s -> %s)\033[0m\n\n' "$BEFORE" "$AFTER"
fi
