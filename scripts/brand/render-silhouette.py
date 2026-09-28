"""
Render the neutral player silhouette: the portrait fallback when no approved portrait exists
(docs/MEDIA.md "Fallbacks"). Original geometry drawn here; no face, no likeness, no text, no
club or league marks. Transparent background: the CSS frame (circle, ring, backdrop) is drawn
by the page, so one asset works on the navy shell and on white canvases.

Outputs
  public/brand/player-silhouette-128.webp   1x (lists, lineups, directory cards)
  public/brand/player-silhouette-256.webp   2x / hero

    python scripts/brand/render-silhouette.py
"""
import os
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'brand')
SS = 4            # supersampling factor
BASE = 256        # master size (square)

TOP = (122, 142, 176)     # lit shoulder / crown tone
BOTTOM = (62, 83, 118)    # shadowed torso tone
RIM = (196, 210, 232)     # thin top rim light


def gradient(size, top, bottom):
    g = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / (size - 1)
        g.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return g.resize((size, size))


def shape_mask(n):
    """Head + neck + shoulders with a V jersey collar, in an n x n canvas."""
    m = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(m)
    u = n / 256
    # head: slightly taller than wide
    d.ellipse([86 * u, 36 * u, 170 * u, 134 * u], fill=255)
    # neck: short and broad
    d.rounded_rectangle([104 * u, 116 * u, 152 * u, 170 * u], radius=14 * u, fill=255)
    # trapezius slope into rounded shoulders; the torso runs off the bottom edge
    d.polygon([(26 * u, 256 * u), (34 * u, 198 * u), (72 * u, 170 * u), (100 * u, 158 * u), (156 * u, 158 * u), (184 * u, 170 * u), (222 * u, 198 * u), (230 * u, 256 * u)], fill=255)
    d.ellipse([26 * u, 166 * u, 122 * u, 254 * u], fill=255)
    d.ellipse([134 * u, 166 * u, 230 * u, 254 * u], fill=255)
    d.rectangle([26 * u, 210 * u, 230 * u, 256 * u], fill=255)
    return m


def collar_mask(n):
    m = Image.new('L', (n, n), 0)
    d = ImageDraw.Draw(m)
    u = n / 256
    d.polygon([(106 * u, 164 * u), (128 * u, 198 * u), (150 * u, 164 * u), (142 * u, 164 * u), (128 * u, 186 * u), (114 * u, 164 * u)], fill=255)
    return m


def render():
    n = BASE * SS
    mask = shape_mask(n)
    body = gradient(n, TOP, BOTTOM).convert('RGBA')
    # rim light: the shape minus itself shifted down, softened
    shifted = Image.new('L', (n, n), 0); shifted.paste(mask, (0, 3 * SS))
    rim = ImageChops.subtract(mask, shifted).filter(ImageFilter.GaussianBlur(1.5 * SS))
    body.paste(Image.new('RGBA', (n, n), RIM + (255,)), (0, 0), rim.point(lambda v: int(v * 0.55)))
    # collar: a darker V
    body.paste(Image.new('RGBA', (n, n), BOTTOM + (255,)), (0, 0), collar_mask(n).point(lambda v: int(v * 0.8)))
    body.putalpha(mask)
    return body.resize((BASE, BASE), Image.LANCZOS)


def main():
    master = render()
    os.makedirs(OUT, exist_ok=True)
    for size in (128, 256):
        img = master if size == BASE else master.resize((size, size), Image.LANCZOS)
        img.save(os.path.join(OUT, f'player-silhouette-{size}.webp'), quality=90, method=6)
    print('wrote player-silhouette-128.webp, player-silhouette-256.webp')


if __name__ == '__main__':
    main()
