#!/bin/zsh
# Ship landing/ as the homepage of the main checkout (justunmute.me = GitHub
# Pages from main's root). Copies only the page, fixes its ../ paths for the
# site root, and converts the captures to LOSSLESS WebP (pixel-identical).
# Does not commit or push — review `git -C $MAIN diff --stat` first.
set -euo pipefail
LANDING=${0:A:h:h}
MAIN=${MAIN:-/Users/zodpatel/tools/unmute/unmute}
[[ -z "$(git -C $MAIN status --porcelain)" ]] || { echo "main checkout is dirty — aborting"; exit 1; }

cp $LANDING/index.html $LANDING/site.css $LANDING/app.js $MAIN/
rm -rf $MAIN/ui $MAIN/assets && cp -R $LANDING/ui $MAIN/ui
mkdir -p $MAIN/assets/ui && cp $LANDING/assets/*.png $MAIN/assets/ && cp $LANDING/assets/ui/manifest.json $MAIN/assets/ui/
for f in $LANDING/assets/ui/*.png; do cwebp -quiet -lossless -z 9 $f -o $MAIN/assets/ui/${${f:t}%.png}.webp; done

python3 - "$MAIN" <<'EOF'
import sys; M = sys.argv[1]
s = open(f'{M}/ui/stage.js').read()
s = s.replace("`../assets/ui/${k}.png`", "`../assets/ui/${k}.webp`"); open(f'{M}/ui/stage.js', 'w').write(s)
h = open(f'{M}/index.html').read()
for a, b in [('href="../icon.png"', 'href="icon.png"'), ('src="../unmute-wordmark-black.png"', 'src="unmute-wordmark-black.png"'),
             ('href="../manifesto.html"', 'href="manifesto.html"')]:
    h = h.replace(a, b)
meta = '''<link rel="apple-touch-icon" href="apple-touch-icon.png" />
<link rel="canonical" href="https://justunmute.me/" />
<meta property="og:title" content="unmute — just unmute for everything" />
<meta property="og:description" content="The best interface for Claude Code and Codex. Talk to them from anywhere on your Mac." />
<meta property="og:image" content="https://justunmute.me/og.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:url" content="https://justunmute.me/" />
<meta property="og:type" content="website" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="https://justunmute.me/og.png" />
'''
if 'og:title' not in h:
    h = h.replace('<link rel="stylesheet" href="ui/wallpaper.css" />', meta + '<link rel="stylesheet" href="ui/wallpaper.css" />')
assert '../' not in h, 'unfixed relative path in index.html'
open(f'{M}/index.html', 'w').write(h)
EOF
git -C $MAIN status --short | head -20
