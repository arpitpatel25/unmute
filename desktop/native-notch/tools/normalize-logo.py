#!/usr/bin/env python3
"""
Turn a logo saved from the web into a mark this app can draw.

WHY THIS EXISTS. The two provider logos arrived as people actually have them:
one a terracotta glyph on a WHITE background, the other a screenshot of an app
icon — grey page, white rounded card, blue blob inside. Dropped into the notch
as-is they are two pale tiles on a dark surface, at two different scales, with
two different amounts of packaging around the actual mark. Nothing about
"embed the file" fixes that.

WHAT IT DOES, in the order that matters:

  1. KEY THE BACKGROUND BY FLOOD FILL FROM THE EDGES, not by colour match.
     Matching "everything near-white" would punch holes in the white ">_" glyph
     inside the Codex blob, because that glyph is the same colour as the page it
     was screenshotted on. A fill that can only enter from the border cannot
     reach an enclosed interior, so the packaging goes and the mark survives —
     including Codex's white card, which is reachable from the edge through the
     grey, and including the gaps between the legs of the Claude glyph, which
     are genuinely background.

  2. TRIM TO THE INK. Two marks match visually when their INK matches, not when
     their files do. Trimming removes whatever padding each source happened to
     carry, so neither logo is penalised for having been exported generously.

  3. SQUARE IT, CENTRED. A wide mark and a tall mark still have to sit in the
     same row without one of them dictating the row's height.

  4. RESIZE to the target. This art is compiled into the notch binary and
     inlined into the renderer bundle, and it is drawn at 12-15pt: anything
     larger is bytes shipped to every user for pixels nobody sees.

No Pillow — this runs on a stock macOS python3, so the PNG codec is here in
full rather than as a dependency the build would have to acquire.
"""
import struct
import sys
import zlib
from collections import deque

# How far from the sampled corner colour still counts as background. Generous
# enough for a JPEG-ish gradient page, tight enough to stop at a real mark.
TOLERANCE = 32
# Alpha at or below this is treated as already-transparent.
CLEAR = 8


def read_png(path):
    """→ (w, h, RGBA bytearray). Handles the colour types sips actually emits."""
    d = open(path, 'rb').read()
    if d[:8] != b'\x89PNG\r\n\x1a\n':
        raise SystemExit(f'{path}: not a PNG')
    pos, idat, plte, trns = 8, b'', b'', b''
    w = h = bd = ct = 0
    while pos < len(d):
        ln = struct.unpack('>I', d[pos:pos + 4])[0]
        typ = d[pos + 4:pos + 8]
        body = d[pos + 8:pos + 8 + ln]
        pos += 12 + ln
        if typ == b'IHDR':
            w, h, bd, ct = *struct.unpack('>II', body[:8]), body[8], body[9]
        elif typ == b'IDAT':
            idat += body
        elif typ == b'PLTE':
            plte = body
        elif typ == b'tRNS':
            trns = body
        elif typ == b'IEND':
            break
    if bd != 8:
        raise SystemExit(f'{path}: only 8-bit PNGs (got {bd})')
    ch = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[ct]
    stride = w * ch
    raw = zlib.decompress(idat)
    rows = bytearray()
    prev = bytearray(stride)
    i = 0
    for _ in range(h):
        f = raw[i]; i += 1
        line = bytearray(raw[i:i + stride]); i += stride
        for x in range(stride):
            a = line[x - ch] if x >= ch else 0
            b = prev[x]
            c = prev[x - ch] if x >= ch else 0
            if f == 1: line[x] = (line[x] + a) & 255
            elif f == 2: line[x] = (line[x] + b) & 255
            elif f == 3: line[x] = (line[x] + (a + b) // 2) & 255
            elif f == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[x] = (line[x] + pr) & 255
        rows += line
        prev = line

    out = bytearray(w * h * 4)
    for y in range(h):
        for x in range(w):
            o = (y * w + x) * ch
            q = (y * w + x) * 4
            if ct == 6:
                out[q:q + 4] = rows[o:o + 4]
            elif ct == 2:
                out[q:q + 3] = rows[o:o + 3]; out[q + 3] = 255
            elif ct == 3:
                idx = rows[o]
                out[q:q + 3] = plte[idx * 3:idx * 3 + 3]
                out[q + 3] = trns[idx] if idx < len(trns) else 255
            elif ct == 0:
                v = rows[o]; out[q:q + 3] = bytes((v, v, v)); out[q + 3] = 255
            elif ct == 4:
                v = rows[o]; out[q:q + 3] = bytes((v, v, v)); out[q + 3] = rows[o + 1]
    return w, h, out


def write_png(path, w, h, px):
    raw = bytearray()
    for y in range(h):
        raw.append(0)                      # filter: none — the art is tiny
        raw += px[y * w * 4:(y + 1) * w * 4]
    def chunk(t, b):
        return struct.pack('>I', len(b)) + t + b + struct.pack('>I', zlib.crc32(t + b) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    png += chunk(b'IEND', b'')
    open(path, 'wb').write(png)


def key_background(w, h, px):
    """Flood the background transparent, entering only from the border.

    THE ENTRY RULE IS THE WHOLE POINT. A colour match would also erase the white
    ">_" inside the Codex mark, which is the same white as the page behind it.
    Something enclosed by the mark cannot be reached from the edge, so it stays.
    """
    def at(x, y):
        o = (y * w + x) * 4
        return px[o], px[o + 1], px[o + 2], px[o + 3]

    # Sample all four corners; a screenshot may have a gradient page.
    seeds = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1)]
    opaque = [c for c in seeds if c[3] > CLEAR]
    if not opaque:
        return px                                   # already cut out
    def near(c):
        return any(abs(c[0] - s[0]) <= TOLERANCE and abs(c[1] - s[1]) <= TOLERANCE
                   and abs(c[2] - s[2]) <= TOLERANCE for s in opaque)

    seen = bytearray(w * h)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            q.append((x, y))
    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        i = y * w + x
        if seen[i]:
            continue
        c = at(x, y)
        if c[3] <= CLEAR:
            seen[i] = 1
        elif near(c):
            seen[i] = 1
            px[i * 4 + 3] = 0
        else:
            continue                                # a real edge — stop here
        q.extend(((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)))
    return px


def ink_bounds(w, h, px):
    minx, miny, maxx, maxy = w, h, -1, -1
    for y in range(h):
        row = y * w
        for x in range(w):
            if px[(row + x) * 4 + 3] > CLEAR:
                if x < minx: minx = x
                if x > maxx: maxx = x
                if y < miny: miny = y
                if y > maxy: maxy = y
    return (0, 0, w - 1, h - 1) if maxx < 0 else (minx, miny, maxx, maxy)


def square_and_scale(w, h, px, box, target):
    """Trim to the ink, centre it in a square, then resample to `target`.

    Box-filtered downscale (average over the source footprint) rather than
    nearest: these are drawn at 12-15pt, and nearest-neighbour on a 768px source
    turns an antialiased edge into a staircase at exactly the size it shows.
    """
    minx, miny, maxx, maxy = box
    iw, ih = maxx - minx + 1, maxy - miny + 1
    side = max(iw, ih)
    ox, oy = (side - iw) // 2, (side - ih) // 2
    sq = bytearray(side * side * 4)
    for y in range(ih):
        src = ((miny + y) * w + minx) * 4
        dst = ((oy + y) * side + ox) * 4
        sq[dst:dst + iw * 4] = px[src:src + iw * 4]

    out = bytearray(target * target * 4)
    ratio = side / target
    for ty in range(target):
        y0, y1 = int(ty * ratio), max(int(ty * ratio) + 1, int((ty + 1) * ratio))
        for tx in range(target):
            x0, x1 = int(tx * ratio), max(int(tx * ratio) + 1, int((tx + 1) * ratio))
            r = g = b = a = n = 0
            for sy in range(y0, min(y1, side)):
                for sx in range(x0, min(x1, side)):
                    o = (sy * side + sx) * 4
                    al = sq[o + 3]
                    # Premultiply: averaging colour across transparent pixels
                    # drags the edge toward whatever the cut-out left behind.
                    r += sq[o] * al; g += sq[o + 1] * al; b += sq[o + 2] * al
                    a += al; n += 1
            q = (ty * target + tx) * 4
            if n and a:
                out[q] = min(255, r // a); out[q + 1] = min(255, g // a)
                out[q + 2] = min(255, b // a); out[q + 3] = min(255, a // n)
    return target, out


def main():
    if len(sys.argv) < 3:
        raise SystemExit('usage: normalize-logo.py <in.png> <out.png> [target=128]')
    src, dst = sys.argv[1], sys.argv[2]
    target = int(sys.argv[3]) if len(sys.argv) > 3 else 128
    w, h, px = read_png(src)
    px = key_background(w, h, px)
    box = ink_bounds(w, h, px)
    side, out = square_and_scale(w, h, px, box, target)
    write_png(dst, side, side, out)
    iw, ih = box[2] - box[0] + 1, box[3] - box[1] + 1
    print(f'{src}: {w}x{h} → ink {iw}x{ih} → {side}x{side}')


if __name__ == '__main__':
    main()
