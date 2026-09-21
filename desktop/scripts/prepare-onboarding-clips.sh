#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 /path/to/tella-video-folder" >&2
  exit 2
fi

SOURCE_DIR="$1"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT_DIR="$ROOT/engine-overrides/renderer/onboarding/clips"

command -v ffmpeg >/dev/null || { echo "ffmpeg is required" >&2; exit 1; }
[[ -d "$SOURCE_DIR" ]] || { echo "Source directory not found: $SOURCE_DIR" >&2; exit 1; }
mkdir -p "$OUTPUT_DIR"

encode() {
  local source="$1"
  local output="$2"
  shift 2
  [[ -f "$SOURCE_DIR/$source" ]] || { echo "Missing source: $source" >&2; exit 1; }
  ffmpeg -hide_banner -loglevel error -y "$@" -i "$SOURCE_DIR/$source" \
    -vf "scale=1280:-2:flags=lanczos,fps=30" \
    -c:v libx264 -preset medium -crf 22 -profile:v high -pix_fmt yuv420p \
    -c:a aac -b:a 96k -ar 44100 -movflags +faststart \
    "$OUTPUT_DIR/$output"
  echo "Prepared $output"
}

encode "Turn Ideas into Actions with Unmute (1).mp4" "welcome-product-v1.mp4"
encode "Privacy and Dictation Note.mp4" "privacy-v1.mp4"
encode "How to Enable Microphone Access.mp4" "permission-microphone-v1.mp4"
encode "Enabling Accessibility Settings (1).mp4" "permission-accessibility-v1.mp4"
encode "Configure Mac Keyboard Settings.mp4" "function-key-readiness-v1.mp4"
encode "Enabling System Audio for Unmute (1).mp4" "permission-system-audio-v1.mp4"
encode "Setting up Unmute AI Agents.mp4" "provider-readiness-v1.mp4"
encode "Using Voice Dictation in Apple Notes.mp4" "dictation-explain-v1.mp4"
encode "Smart Dictation and Clipboard Tricks.mp4" "capture-clipboard-v1.mp4"
encode "Capture Context with Dictation and Screenshots.mp4" "capture-screenshot-v1.mp4"
encode "Turn Thoughts Into Tasks with Unmute.mp4" "orchestrator-explain-v1.mp4"
encode "Introduction to Unmute Agent.mp4" "agent-explain-v1.mp4"
encode "Unmute AI Note Taker Demo.mp4" "notetaker-explain-v1.mp4"
encode "Summarize Notes with Unmute Agent.mp4" "agent-notes-v1.mp4"
# Drop the tentative “dashboard or orchestrator” opening. The clean explanation
# begins at 4.45 seconds; re-encoding keeps picture and sound synchronized.
encode "Unmute Dashboard Overview.mp4" "orientation-v1.mp4" -ss 4.45
encode "Unmute Demo and Sign-In Guide.mp4" "sign-in-v1.mp4"

echo "Onboarding clips are ready in $OUTPUT_DIR"
