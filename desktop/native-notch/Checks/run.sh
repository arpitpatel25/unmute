#!/bin/sh
# Wire-format decode checks, plus the notch's layout, shape and motion maths.
#
# WHY THIS EXISTS AND WHY IT IS NOT `swift test`. The executable target has no
# test target, and adding one would change the build graph for one file's worth
# of assertions. This compiles the REAL decoders — IPC.swift's Command.decode
# and ScratchpadModel's init(from:) — and the REAL geometry, against literal
# wire lines and hand-written screen measurements, with no AppKit windows and no
# duplicated types.
#
# What it protects:
#   * every scratchpad field decodes with a default, so a partial or older
#     payload still draws instead of being dropped whole. That is the
#     CockpitData trap (no init(from:) ⇒ every key mandatory ⇒ one missing key
#     silently kills every update), and it is invisible to `swift build`
#   * the unexpanded surface is menu-bar height and pinned to the screen's top
#     edge, and the mass lands ON the cutout rather than beside it
#   * the shape is ONE path whose fillets are geometry, with a radius on the
#     outer bottom corners only
#   * there is exactly one spring, and it is the one the window frame uses
#
# None of that is visible to the compiler, and all of it is a lie the moment
# someone "simplifies" a measurement into a constant.
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
  "$src/NotchGeometry.swift" "$src/NotchShape.swift" "$src/BarContent.swift" \
  "$here/main.swift"
"$out/decode-check"
