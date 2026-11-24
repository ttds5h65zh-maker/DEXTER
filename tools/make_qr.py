"""Generate the slide QR code (qr/qr.png at 1200 px and qr/qr.svg).

Deep green on ivory, high error correction (H), with the URL printed underneath.

Usage (needs `segno` and `Pillow`; install them in a virtualenv, not globally):
    python3 tools/make_qr.py https://your-user.github.io/your-repo/ [path/to/font.ttf]
"""
import sys
from pathlib import Path

import segno
from PIL import Image, ImageDraw, ImageFont

GREEN = "#2E4A3B"
IVORY = "#F6F3EA"
SIZE = 1200          # PNG is SIZE x SIZE pixels
QUIET = 4            # quiet zone, in modules (the QR standard asks for 4)

url = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
font_path = sys.argv[2] if len(sys.argv) > 2 else None
label = url.removeprefix("https://").removesuffix("/")

out = Path(__file__).resolve().parent.parent / "qr"
out.mkdir(exist_ok=True)

qr = segno.make(url, error="h", boost_error=False)
matrix = [list(row) for row in qr.matrix]
n = len(matrix)

# ---- PNG ---------------------------------------------------------------
caption_h = 150
module = (SIZE - caption_h) // (n + 2 * QUIET)
code_px = module * (n + 2 * QUIET)
img = Image.new("RGB", (SIZE, SIZE), IVORY)
draw = ImageDraw.Draw(img)
x0 = (SIZE - code_px) // 2 + QUIET * module
y0 = QUIET * module
for r, row in enumerate(matrix):
    for c, dark in enumerate(row):
        if dark:
            draw.rectangle([x0 + c * module, y0 + r * module,
                            x0 + (c + 1) * module - 1, y0 + (r + 1) * module - 1], fill=GREEN)

font_size = 46
try:
    font = ImageFont.truetype(font_path or "DejaVuSans.ttf", font_size)
except OSError:
    font = ImageFont.load_default(font_size)
while draw.textlength(label, font=font) > SIZE - 80 and font_size > 20:
    font_size -= 2
    font = font.font_variant(size=font_size)
text_y = code_px + (SIZE - code_px) // 2 - 10
draw.text((SIZE / 2, text_y), label, fill=GREEN, font=font, anchor="mm")
img.save(out / "qr.png", dpi=(300, 300))

# ---- SVG (vector, scales to any slide size) ----------------------------------
unit = 10
side = (n + 2 * QUIET) * unit
svg_h = side + 7 * unit
path = "".join(
    f"M{(c + QUIET) * unit} {(r + QUIET) * unit}h{unit}v{unit}h-{unit}z"
    for r, row in enumerate(matrix) for c, dark in enumerate(row) if dark
)
svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {side} {svg_h}" width="{side}" height="{svg_h}">
  <rect width="100%" height="100%" fill="{IVORY}"/>
  <path d="{path}" fill="{GREEN}" shape-rendering="crispEdges"/>
  <text x="{side / 2}" y="{side + 2.5 * unit}" text-anchor="middle" fill="{GREEN}"
        font-family="Jost, 'Helvetica Neue', Arial, sans-serif" font-size="{min(3.2 * unit, side * 0.9 / max(len(label), 1) * 1.8):.1f}">{label}</text>
</svg>
"""
(out / "qr.svg").write_text(svg, encoding="utf-8")
print(f"QR for {url}: version {qr.version}, error level {qr.error}, {n}x{n} modules -> {out}")
