"""
Build the PropBetEdge Soccer identity package from the canonical, owned PropBetEdge artwork
(the WNBA / NBA builder method; see docs/BRAND.md).

Canonical source:
  https://propbetedge.ai/logo/pbe-full-600.png
  sha256 53d5f2a15297578b323db7ef216dcb34d3eb2fe3e9a9b46401634ae3609af7e5
  = propbetedge-news-site/public/logo/pbe-full-600.png = wnba/scripts/brand/src/pbe-full-600.png
Copied here as scripts/brand/src/pbe-full-600.png; the build refuses any other bytes.
Stadium art: scripts/brand/render-stadium.py (original render, run it first).

Outputs
  public/brand/pbe-mark-{32,64,96,160}.webp + pbe-mark-64.png   header/footer PBE mark (letters only)
  public/favicon.ico (16/32/48), favicon-16x16.png, favicon-32x32.png, favicon.svg (raster glyph inside)
  public/apple-touch-icon.png (180, opaque), icon-192.png, icon-512.png, icon-maskable-512.png
  public/site.webmanifest
  public/share/propbetedge-soccer-social-v1.jpg   master 1200x630 share card
  public/share/propbetedge-logo-v3-512.png        JSON-LD Organization / publisher logo
  server/brand-mark.js                            the PBE mark as base64 PNG for dynamic OG cards

Icon glyphs: the favicon (16-48 px) uses the orange "B" isolated from the PBE mark (the network
precedent: the 2.6:1 "PBE" is unreadable at 16 px); app icons (180+) carry the full PBE mark.
No soccer ball, no league or club marks, nothing redrawn.

    python scripts/brand/build-brand-assets.py
"""
import base64, hashlib, io, json, os
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageEnhance

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PUB = os.path.join(ROOT, 'public')
SRC = os.path.join(ROOT, 'scripts', 'brand', 'src', 'pbe-full-600.png')
SRC_SHA256 = '53d5f2a15297578b323db7ef216dcb34d3eb2fe3e9a9b46401634ae3609af7e5'
FONTS = os.path.join(ROOT, 'scripts', 'brand', 'fonts')
STADIUM = os.path.join(ROOT, 'scripts', 'brand', 'out', 'stadium-master-2560.png')
SHELL = (10, 22, 40)        # --shell #0a1628
GOLD = (212, 167, 58)       # --gold  #d4a73a
GOLD_B = (240, 198, 90)     # --gold-2 #f0c65a
PAPER = (244, 247, 252)
DIM = (170, 184, 206)


def font(name, size):
    return ImageFont.truetype(os.path.join(FONTS, name), size)


def source():
    raw = open(SRC, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != SRC_SHA256:
        raise SystemExit('pbe-full-600.png is not the canonical PropBetEdge artwork (sha256 mismatch)')
    return Image.open(io.BytesIO(raw)).convert('RGBA')


def b_glyph(im):
    c = im.crop((388, 0, 662, 420))
    w, h = c.size
    px = c.load()
    m = Image.new('L', (w, h), 0); mp = m.load()
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a > 160 and r > 120 and r - g > 45 and r - b > 60:
                mp[x, y] = 255
    m = m.filter(ImageFilter.MaxFilter(7)).filter(ImageFilter.MinFilter(3))
    pad = Image.new('L', (w + 2, h + 2), 0); pad.paste(m, (1, 1))
    ImageDraw.floodfill(pad, (0, 0), 128)
    filled = pad.point(lambda v: 0 if v == 128 else 255).crop((1, 1, w + 1, h + 1)).filter(ImageFilter.MaxFilter(3))
    out = c.copy(); out.putalpha(ImageChops.multiply(c.getchannel('A'), filled))
    return out.crop(out.getbbox())


def pbe_mark(im):
    top = im.crop((0, 0, im.width, 425))
    return top.crop(top.getbbox())


def fit(img, bw, bh):
    s = min(bw / img.width, bh / img.height)
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def by_height(img, h):
    return img.resize((max(1, round(img.width * h / img.height)), h), Image.LANCZOS)


def tile(glyph, size, pad_ratio, rounded):
    bg = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(bg)
    if rounded:
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=round(size * 0.22), fill=SHELL + (255,))
    else:
        d.rectangle((0, 0, size - 1, size - 1), fill=SHELL + (255,))
    inner = round(size * (1 - 2 * pad_ratio))
    g = fit(glyph, inner, inner)
    bg.alpha_composite(g, ((size - g.width) // 2, (size - g.height) // 2))
    return bg


def save_png(img, rel):
    path = os.path.join(PUB, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, optimize=True)


def build_marks(mark):
    os.makedirs(os.path.join(PUB, 'brand'), exist_ok=True)
    for h in (32, 64, 96, 160):
        by_height(mark, h).save(os.path.join(PUB, 'brand', f'pbe-mark-{h}.webp'), quality=92, method=6)
    save_png(by_height(mark, 64), 'brand/pbe-mark-64.png')
    return by_height(mark, 64).size


def build_icons(glyph, mark):
    frames = [tile(glyph, s, 0.06, True) for s in (16, 32, 48)]
    frames[-1].save(os.path.join(PUB, 'favicon.ico'), sizes=[(16, 16), (32, 32), (48, 48)], append_images=frames[:-1])
    save_png(frames[0], 'favicon-16x16.png')
    save_png(frames[1], 'favicon-32x32.png')
    # favicon.svg: a wrapper around the owned raster glyph (no vector redraw of the artwork).
    buf = io.BytesIO(); g = fit(glyph, 112, 112); g.save(buf, 'PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    x, y = (128 - g.width) / 2, (128 - g.height) / 2
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#0a1628"/>'
           f'<image x="{x:g}" y="{y:g}" width="{g.width}" height="{g.height}" href="data:image/png;base64,{b64}"/></svg>\n')
    open(os.path.join(PUB, 'favicon.svg'), 'w', encoding='utf-8', newline='\n').write(svg)
    save_png(tile(mark, 180, 0.10, False).convert('RGB'), 'apple-touch-icon.png')
    save_png(tile(mark, 192, 0.09, True), 'icon-192.png')
    save_png(tile(mark, 512, 0.09, True), 'icon-512.png')
    save_png(tile(mark, 512, 0.20, False).convert('RGB'), 'icon-maskable-512.png')


def build_manifest():
    manifest = {
        'name': 'PropBetEdge Soccer', 'short_name': 'PBE Soccer',
        'description': 'Soccer intelligence from PropBetEdge: live PBEcast, Player DNA, event maps, team intelligence and data-backed news.',
        'id': '/', 'start_url': '/', 'scope': '/', 'display': 'standalone',
        'background_color': '#0a1628', 'theme_color': '#0a1628',
        'icons': [
            {'src': '/icon-192.png', 'sizes': '192x192', 'type': 'image/png'},
            {'src': '/icon-512.png', 'sizes': '512x512', 'type': 'image/png'},
            {'src': '/icon-maskable-512.png', 'sizes': '512x512', 'type': 'image/png', 'purpose': 'maskable'},
        ],
    }
    open(os.path.join(PUB, 'site.webmanifest'), 'w', encoding='utf-8', newline='\n').write(json.dumps(manifest, indent=2) + '\n')


def build_logo(mark):
    img = Image.new('RGBA', (512, 512), SHELL + (255,))
    m = fit(mark, 452, 452)
    img.alpha_composite(m, ((512 - m.width) // 2, (512 - m.height) // 2))
    save_png(img.convert('RGB'), 'share/propbetedge-logo-v3-512.png')


def tracked(d, xy, text, fnt, fill, track):
    x, y = xy
    for ch in text:
        d.text((x, y), ch, font=fnt, fill=fill)
        x += d.textlength(ch, font=fnt) + track
    return x - track


def build_social(mark):
    W, H = 1200, 630
    st = Image.open(STADIUM).convert('RGB')
    # 1200x630 window from the render: the far stand, floodlights and the top of the pitch.
    crop = st.resize((1400, 788), Image.LANCZOS).crop((200, 40, 1400, 670))
    crop = ImageEnhance.Brightness(crop).enhance(1.25)
    img = crop.convert('RGBA')
    # Readability: a navy wash over the text column only, clearing by 65% of the width.
    wash = Image.new('RGBA', (W, H), SHELL + (0,))
    ramp = Image.new('L', (W, 1))
    for x in range(W):
        t = x / W
        ramp.putpixel((x, 0), int(245 * max(0.0, 1 - t / 0.65) ** 1.4))
    wash.putalpha(ramp.resize((W, H)))
    img = Image.alpha_composite(img, wash)
    bottom = Image.new('RGBA', (W, H), (4, 10, 20, 0))
    bottom.putalpha(Image.linear_gradient('L').resize((W, H)).point(lambda v: int(v * 0.55)))
    img = Image.alpha_composite(img, bottom)
    d = ImageDraw.Draw(img)
    # top gold rail
    for x in range(W):
        t = x / (W - 1); a = round(255 * min(1, 2.2 * min(t, 1 - t) + 0.35))
        c = tuple(round(p + (q - p) * t) for p, q in zip(GOLD_B, GOLD))
        d.line((x, 0, x, 4), fill=c + (a,))
    # the canonical mark with depth
    m = fit(mark, 300, 150)
    mx, my = 72, 62
    alpha = m.getchannel('A')
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0)); shadow.paste(Image.new('RGBA', m.size, (0, 0, 0, 200)), (mx, my + 12), alpha)
    img = Image.alpha_composite(img, shadow.filter(ImageFilter.GaussianBlur(14)))
    halo = Image.new('RGBA', (W, H), (0, 0, 0, 0)); halo.paste(Image.new('RGBA', m.size, GOLD + (60,)), (mx, my), alpha)
    img = Image.alpha_composite(img, halo.filter(ImageFilter.GaussianBlur(22)))
    img.alpha_composite(m, (mx, my))
    d = ImageDraw.Draw(img)
    X = 72
    tracked(d, (X, 244), 'PROPBETEDGE', font('barlow-condensed-700.ttf', 40), GOLD_B, 7)
    d.text((X - 4, 280), 'SOCCER', font=font('barlow-condensed-700.ttf', 150), fill=PAPER)
    tracked(d, (X, 438), 'INTELLIGENCE', font('barlow-condensed-700.ttf', 46), PAPER, 10)
    d.rounded_rectangle((X, 500, X + 110, 505), radius=3, fill=GOLD)
    items = ['Live PBEcast', 'Player DNA', 'Event maps', 'Team DNA', 'News']
    f_strip = font('inter-700.ttf', 22); x, y = X, 522
    for i, it in enumerate(items):
        if i:
            d.ellipse((x + 10, y + 11, x + 16, y + 17), fill=GOLD); x += 28
        d.text((x, y), it, font=f_strip, fill=DIM); x += d.textlength(it, font=f_strip)
    d.line((X, 568, W - 64, 568), fill=PAPER + (30,), width=1)
    d.text((X, 582), '@PROPBETEDGE', font=font('inter-700.ttf', 22), fill=GOLD_B)
    dom = 'soccer.propbetedge.ai'; fd = font('inter-500.ttf', 20)
    d.text((W - 64 - d.textlength(dom, font=fd), 584), dom, font=fd, fill=DIM)
    out = img.convert('RGB')
    os.makedirs(os.path.join(PUB, 'share'), exist_ok=True)
    out.save(os.path.join(PUB, 'share', 'propbetedge-soccer-social-v1.jpg'), quality=88, optimize=True, progressive=True)
    return out


def build_server_mark(mark):
    m = by_height(mark, 120); buf = io.BytesIO(); m.save(buf, 'PNG', optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode()
    js = ('// SERVER-ONLY. Generated by scripts/brand/build-brand-assets.py from the canonical PropBetEdge artwork\n'
          f'// (https://propbetedge.ai/logo/pbe-full-600.png, sha256 {SRC_SHA256[:16]}...). Do not edit.\n'
          f'export const PBE_MARK_W = {m.width};\nexport const PBE_MARK_H = {m.height};\n'
          f"export const PBE_MARK_PNG = 'data:image/png;base64,{b64}';\n")
    open(os.path.join(ROOT, 'server', 'brand-mark.js'), 'w', encoding='utf-8', newline='\n').write(js)


if __name__ == '__main__':
    im = source(); mark = pbe_mark(im); glyph = b_glyph(im)
    print('header mark 64px:', build_marks(mark))
    build_icons(glyph, mark); build_manifest(); build_logo(mark); build_server_mark(mark)
    print('social:', build_social(mark).size, os.path.getsize(os.path.join(PUB, 'share', 'propbetedge-soccer-social-v1.jpg')))
