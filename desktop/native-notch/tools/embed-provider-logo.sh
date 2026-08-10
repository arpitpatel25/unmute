#!/usr/bin/env bash
# Embed a provider logo into ProviderMarkArt.swift.
#
#   ./native-notch/tools/embed-provider-logo.sh claude ~/Downloads/logos/claude.png
#   ./native-notch/tools/embed-provider-logo.sh codex  ~/Downloads/logos/codex.png
#
# WHY A SCRIPT AND NOT A PASTE. Two things have to happen together, and doing
# only the first is what makes one logo look bigger than the other:
#
#   1. the bytes go in as base64
#   2. the logo's INK is measured, and its scale recorded
#
# Matching the frame does not match the mark. A logo drawn with generous
# internal padding reads smaller than a tight one at the same point size, and
# the eye compares the marks. So this measures the opaque bounding box of each
# PNG and stores ink-width ÷ image-width, which ProviderMark uses to make the
# two marks the same visual size regardless of how each file was exported.
set -euo pipefail

name="${1:-}"; src="${2:-}"
case "$name" in
  claude|codex) ;;
  *) echo "usage: $0 <claude|codex> <path-to-png>" >&2; exit 2 ;;
esac
[ -f "$src" ] || { echo "no such file: $src" >&2; exit 2; }

# NORMALISE FIRST — the two logos come from different places and arrive in
# different formats and sizes (one PNG, one WEBP, as it turned out). Everything
# downstream assumes 8-bit RGBA PNG, so convert and cap the raster here rather
# than making the caller care.
#
# CAPPED AT 128px because this is compiled into the binary and inlined into the
# renderer bundle: it is drawn at 12-15pt, so anything larger is bytes shipped
# to every user for pixels nobody sees. 128 keeps it crisp on a 2x display with
# room to spare.
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
png="$tmp/logo.png"
if ! /usr/bin/sips -s format png -Z 128 "$src" --out "$png" >/dev/null 2>&1; then
  echo "could not convert $src to PNG (sips)" >&2; exit 1
fi
src="$png"

here="$(cd "$(dirname "$0")" && pwd)"
art="$here/../Sources/unmute-notch/ProviderMarkArt.swift"
[ -f "$art" ] || { echo "missing $art" >&2; exit 1; }

b64="$(base64 < "$src" | tr -d '\n')"

# Ink bounds via the same Python that builds the app (no extra dependency).
scale="$(PYTHON="${PYTHON:-/usr/bin/python3}"; "$PYTHON" - "$src" <<'PY'
import sys, struct, zlib
# Minimal PNG reader: enough to find the alpha bounding box of an RGBA image.
# Falls back to 1.0 for anything it cannot decode — a wrong scale is worse than
# no scale, so it declines rather than guesses.
try:
    d = open(sys.argv[1], 'rb').read()
    assert d[:8] == b'\x89PNG\r\n\x1a\n'
    pos, idat, w, h, bd, ct = 8, b'', 0, 0, 8, 6
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos+4])[0]; typ = d[pos+4:pos+8]
        body = d[pos+8:pos+8+ln]; pos += 12 + ln
        if typ == b'IHDR': w, h, bd, ct = *struct.unpack('>II', body[:8]), body[8], body[9]
        elif typ == b'IDAT': idat += body
        elif typ == b'IEND': break
    assert ct == 6 and bd == 8, 'not 8-bit RGBA'
    raw = zlib.decompress(idat); stride = w * 4
    out = bytearray(); prev = bytearray(stride); i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i+stride]); i += stride
        for x in range(stride):
            a = line[x-4] if x >= 4 else 0
            b = prev[x]; c = prev[x-4] if x >= 4 else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p-a), abs(p-b), abs(p-c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        out += line; prev = line
    minx, maxx = w, -1
    for y in range(h):
        row = out[y*stride:(y+1)*stride]
        for x in range(w):
            if row[x*4+3] > 8:
                if x < minx: minx = x
                if x > maxx: maxx = x
    print(round((maxx - minx + 1) / w, 4) if maxx >= 0 else 1.0)
except Exception:
    print(1.0)
PY
)"

/usr/bin/python3 - "$art" "$name" "$b64" "$scale" <<'PY'
import re, sys
art, name, b64, scale = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(art).read()
s = re.sub(rf'private static let {name}B64 = "[^"]*"',
           f'private static let {name}B64 = "{b64}"', s)
s = re.sub(rf'private static let {name}Scale: CGFloat = [0-9.]+',
           f'private static let {name}Scale: CGFloat = {scale}', s)
open(art, 'w').write(s)
print(f'{name}: embedded {len(b64)} b64 chars, ink scale {scale}')
PY

# The renderer twin. Written by the SAME command, because two surfaces showing
# one fact from two hand-maintained copies is how they end up disagreeing.
ts="$here/../../engine-overrides/renderer/remote/providerLogos.ts"
if [ -f "$ts" ]; then
  /usr/bin/python3 - "$ts" "$name" "$b64" "$scale" <<'PYTS'
import re, sys
ts, name, b64, scale = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
s = open(ts).read()
entry = "{ src: 'data:image/png;base64," + b64 + "', scale: " + scale + " }"
pat = r"(\n  " + name + r": )(null|\{[^}]*\})"
s2 = re.sub(pat, lambda m: m.group(1) + entry, s, count=1)
if s2 == s:
    raise SystemExit("could not find the " + name + " entry in " + ts)
open(ts, "w").write(s2)
print(name + ": renderer updated")
PYTS
fi
