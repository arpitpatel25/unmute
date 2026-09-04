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
pkg="$here/.."
src="$pkg/Sources/unmute-notch"
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

# THIS HARNESS HAD STOPPED RUNNING, SILENTLY, AND THAT IS THE WORST FAILURE A
# GUARD CAN HAVE.
#
# The files below now `import ConversationSupport` and `import
# SurfaceSizeSupport` — SwiftPM library targets in this same package. A bare
# `swiftc` knows nothing about them, so the compile died on IPC.swift's second
# line with "no such module 'ConversationSupport'". Piped through `tail` in a
# build script the error scrolled past and the exit status belonged to `tail`,
# so every caller read success. The decode contract this exists to protect —
# one missing key kills every notch update — has therefore been unguarded for
# as long as those imports have existed.
#
# So: build the package first, point the compiler at the emitted modules, and
# link their objects. SwiftPM emits no `.a` for a plain library target, which is
# why these are `.o` files found rather than a library named.
swift build --package-path "$pkg" >/dev/null
bin=$(swift build --package-path "$pkg" --show-bin-path)

# The support modules these files import. Test bundles are excluded on purpose:
# `*Tests.build` also holds `.o` files and linking them pulls in XCTest.
objs=""
for m in ConversationSupport SurfaceSizeSupport LifecycleSupport; do
  [ -d "$bin/$m.build" ] || { echo "MISSING: $bin/$m.build — did swift build fail?" >&2; exit 1; }
  for o in "$bin/$m.build"/*.o; do objs="$objs $o"; done
done

# shellcheck disable=SC2086  # $objs is a deliberately word-split list
swiftc -o "$out/decode-check" \
  -I "$bin/Modules" \
  "$src/IPC.swift" "$src/PillModel.swift" "$src/ScratchpadModel.swift" \
  "$src/NotchModel.swift" "$src/Theme.swift" "$src/NotchLog.swift" \
  "$src/NotchGeometry.swift" "$src/NotchShape.swift" "$src/BarContent.swift" \
  "$src/Lifecycle.swift" "$src/UnMark.swift" "$src/UnMarkArt.swift" \
  "$here/main.swift" $objs
"$out/decode-check"
