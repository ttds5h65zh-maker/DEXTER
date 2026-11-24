"""Generate the slide-ready QR code: qr/qr-slide.png and qr/qr-slide.svg.

Transparent background (the slide shows through), deep green code, a row of gold
beads and the line "Try on the golden beads" above it, and the URL in gold below,
matching the deck: deep green #2E4A3B, muted gold #B08D3C.
The SVG text is converted to outlines, so it looks right even where the fonts
aren't installed.

Usage (needs segno, Pillow and fonttools in a virtualenv, plus two TTF fonts):
    python3 tools/make_qr_slide.py URL CormorantGaramond-Italic.ttf Jost.ttf
"""
import sys
from pathlib import Path

import segno
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFont

GREEN = "#2E4A3B"
GOLD = "#B08D3C"
GOLD_LIGHT = "#E2CB8E"

if len(sys.argv) < 4:
    sys.exit(__doc__)
url, serif_path, sans_path = sys.argv[1:4]
label = url.removeprefix("https://").removesuffix("/")
out = Path(__file__).resolve().parent.parent / "qr"
out.mkdir(exist_ok=True)

qr = segno.make(url, error="h", boost_error=False)
matrix = [list(row) for row in qr.matrix]
n = len(matrix)

# ---- Layout (in output pixels; the PNG is 1200 px wide) -------------------
W = 1200
MOD = 26                          # module size → 37 modules = 962 px
CODE = n * MOD
BEADS = [12, 16, 20, 20, 20, 16, 12]  # bead diameters, like the landing-page ornament
BEAD_GAP = 14
BEAD_Y = 40
HEAD_SIZE = 100
HEAD_BASELINE = 190
HEAD_PARTS = [("Try on the ", GREEN), ("golden beads", GOLD)]
CODE_Y = HEAD_BASELINE + 40 + 3 * MOD   # 3 modules of clear space under the line
URL_SIZE = 44
URL_BASELINE = CODE_Y + CODE + 3 * MOD + 30
H = URL_BASELINE + 40
CODE_X = (W - CODE) // 2


def bead_positions():
    total = sum(BEADS) + BEAD_GAP * (len(BEADS) - 1)
    x = (W - total) / 2
    for d in BEADS:
        yield x + d / 2, BEAD_Y, d / 2
        x += d + BEAD_GAP


# ---- PNG (drawn at 2x, then reduced for smooth edges) ---------------------------
S = 2
img = Image.new("RGBA", (W * S, H * S), (0, 0, 0, 0))
draw = ImageDraw.Draw(img)

for cx, cy, r in bead_positions():
    draw.ellipse([(cx - r) * S, (cy - r) * S, (cx + r) * S, (cy + r) * S], fill=GOLD)
    hr = r * 0.45  # small highlight, up and to the left
    hx, hy = cx - r * 0.3, cy - r * 0.3
    draw.ellipse([(hx - hr) * S, (hy - hr) * S, (hx + hr) * S, (hy + hr) * S], fill=GOLD_LIGHT)

head_font = ImageFont.truetype(serif_path, HEAD_SIZE * S)
widths = [draw.textlength(t, font=head_font) for t, _ in HEAD_PARTS]
x = (W * S - sum(widths)) / 2
for (text, colour), w in zip(HEAD_PARTS, widths):
    draw.text((x, HEAD_BASELINE * S), text, font=head_font, fill=colour, anchor="ls")
    x += w

for r, row in enumerate(matrix):
    for c, dark in enumerate(row):
        if dark:
            x0, y0 = (CODE_X + c * MOD) * S, (CODE_Y + r * MOD) * S
            draw.rectangle([x0, y0, x0 + MOD * S - 1, y0 + MOD * S - 1], fill=GREEN)

url_font = ImageFont.truetype(sans_path, URL_SIZE * S)
draw.text((W * S / 2, URL_BASELINE * S), label, font=url_font, fill=GOLD, anchor="ms")

img.resize((W, H), Image.LANCZOS).save(out / "qr-slide.png")


# ---- SVG (vector; text converted to outlines) -------------------------------------
def text_paths(font_path, text, size, x, baseline, colour, align="left"):
    font = TTFont(font_path)
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    scale = size / font["head"].unitsPerEm
    names = [cmap.get(ord(ch), ".notdef") for ch in text]
    width = sum(hmtx[g][0] for g in names) * scale
    if align == "center":
        x -= width / 2
    parts = []
    for g in names:
        pen = SVGPathPen(glyphs)
        glyphs[g].draw(pen)
        d = pen.getCommands()
        if d:
            parts.append(f'<path transform="translate({x:.2f} {baseline}) scale({scale:.5f} {-scale:.5f})" d="{d}"/>')
        x += hmtx[g][0] * scale
    return f'<g fill="{colour}">{"".join(parts)}</g>', width


def text_width(font_path, text, size):
    return text_paths(font_path, text, size, 0, 0, "#000")[1]


svg = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">',
       '<title>Try on the golden beads</title>',
       f'<defs><radialGradient id="bead" cx="35%" cy="30%" r="70%">'
       f'<stop offset="0" stop-color="{GOLD_LIGHT}"/><stop offset="0.55" stop-color="{GOLD}"/>'
       f'<stop offset="1" stop-color="#8A6B26"/></radialGradient></defs>']
for cx, cy, r in bead_positions():
    svg.append(f'<circle cx="{cx:.1f}" cy="{cy}" r="{r}" fill="url(#bead)"/>')

head_w = [text_width(serif_path, t, HEAD_SIZE) for t, _ in HEAD_PARTS]
x = (W - sum(head_w)) / 2
for (text, colour), w in zip(HEAD_PARTS, head_w):
    svg.append(text_paths(serif_path, text, HEAD_SIZE, x, HEAD_BASELINE, colour)[0])
    x += w

code_path = "".join(
    f"M{CODE_X + c * MOD} {CODE_Y + r * MOD}h{MOD}v{MOD}h-{MOD}z"
    for r, row in enumerate(matrix) for c, dark in enumerate(row) if dark
)
svg.append(f'<path d="{code_path}" fill="{GREEN}" shape-rendering="crispEdges"/>')
svg.append(text_paths(sans_path, label, URL_SIZE, W / 2, URL_BASELINE, GOLD, align="center")[0])
svg.append("</svg>")
(out / "qr-slide.svg").write_text("\n".join(svg) + "\n", encoding="utf-8")
print(f"Slide QR for {url}: {W}x{H}px, version {qr.version}, error level {qr.error} -> {out}")
