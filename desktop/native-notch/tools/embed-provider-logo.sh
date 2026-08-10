#!/usr/bin/env bash
# Embed a provider logo as a drawable mark.
#
#   ./native-notch/tools/embed-provider-logo.sh claude ~/path/claude.png
#   ./native-notch/tools/embed-provider-logo.sh codex  ~/path/codex.webp
#
# THREE THINGS HAPPEN, and skipping any one of them is visible on the surface:
#
#   1. CONVERT — the logos arrive as people have them (one PNG, one WEBP, both
#      at whatever size they were saved at). sips normalises the format.
#   2. CUT OUT AND TRIM — normalize-logo.py floods the background transparent
#      from the border, trims to the ink and squares it. Sources carry their own
#      padding and their own baked backgrounds; neither belongs in a mark drawn
#      on a dark surface.
#   3. MEASURE INK COVERAGE — what fraction of the box the mark actually inks.
#      Stored, not applied: the view derives the optical scale from the ratio
#      between providers, so a solid blob and a sparse glyph read the same
#      weight — and a third provider rebalances the set without a hand-tuned
#      number. Codex fills 75% of its box, Claude 45%; matched by BOX the blob
#      looks half again as large as the glyph.
set -euo pipefail

name="${1:-}"; src="${2:-}"
case "$name" in
  claude|codex) ;;
  *) echo "usage: $0 <claude|codex> <path-to-image>" >&2; exit 2 ;;
esac
[ -f "$src" ] || { echo "no such file: $src" >&2; exit 2; }

here="$(cd "$(dirname "$0")" && pwd)"
art="$here/../Sources/unmute-notch/ProviderMarkArt.swift"
ts="$here/../../engine-overrides/renderer/remote/providerLogos.ts"
[ -f "$art" ] || { echo "missing $art" >&2; exit 1; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
/usr/bin/sips -s format png "$src" --out "$tmp/in.png" >/dev/null 2>&1 \
  || { echo "could not convert $src to PNG (sips)" >&2; exit 1; }
/usr/bin/python3 "$here/normalize-logo.py" "$tmp/in.png" "$tmp/mark.png" 128

b64="$(base64 < "$tmp/mark.png" | tr -d '\n')"
cov="$(/usr/bin/python3 - "$tmp/mark.png" "$here/normalize-logo.py" <<'PY'
import importlib.util, sys
spec = importlib.util.spec_from_file_location('nl', sys.argv[2])
nl = importlib.util.module_from_spec(spec); spec.loader.exec_module(nl)
w, h, px = nl.read_png(sys.argv[1])
ink = sum(1 for i in range(w * h) if px[i * 4 + 3] > 8)
print(round(ink / (w * h), 4))
PY
)"

/usr/bin/python3 - "$art" "$name" "$b64" "$cov" <<'PY'
import re, sys
art, name, b64, cov = sys.argv[1:5]
s = open(art).read()
s = re.sub(rf'private static let {name}B64 = "[^"]*"', f'private static let {name}B64 = "{b64}"', s)
s = re.sub(rf'private static let {name}Ink: CGFloat = [0-9.]+', f'private static let {name}Ink: CGFloat = {cov}', s)
open(art, 'w').write(s)
print(f'{name}: {len(b64)} b64 chars, ink coverage {cov}')
PY

if [ -f "$ts" ]; then
  /usr/bin/python3 - "$ts" "$name" "$b64" "$cov" <<'PY'
import re, sys
ts, name, b64, cov = sys.argv[1:5]
s = open(ts).read()
entry = "{ src: 'data:image/png;base64," + b64 + "', ink: " + cov + " }"
s2 = re.sub(r"(\n  " + name + r": )(null|\{[^}]*\})", lambda m: m.group(1) + entry, s, count=1)
if s2 == s: raise SystemExit(f'could not find the {name} entry in {ts}')
open(ts, 'w').write(s2)
print(f'{name}: renderer updated')
PY
fi
