#!/bin/sh
# Decode checks for the scratchpad wire format.
#
# WHY THIS EXISTS AND WHY IT IS NOT `swift test`. The executable target has no
# test target, and adding one would change the build graph for one file's worth
# of assertions. This compiles the REAL decoders — IPC.swift's Command.decode
# and ScratchpadModel's init(from:) — against literal wire lines, with no
# AppKit windows and no duplicated types.
#
# What it protects: every scratchpad field decodes with a default, so a partial
# or older payload still draws instead of being dropped whole. That is the
# CockpitData trap (no init(from:) ⇒ every key mandatory ⇒ one missing key
# silently kills every update), and it is invisible to `swift build`.
#
# Run from anywhere:  sh desktop/native-notch/Checks/run.sh
set -e
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../Sources/unmute-notch"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
swiftc -o "$out/decode-check" \
  "$src/IPC.swift" "$src/PillModel.swift" "$src/ScratchpadModel.swift" \
  "$src/NotchModel.swift" "$src/Theme.swift" "$src/NotchLog.swift" \
  "$here/main.swift"
"$out/decode-check"
