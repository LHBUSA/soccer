"""
Original PropBetEdge Soccer stadium backdrop, rendered from geometry (no photographs, no
third-party art, no SVG). A small vectorised ray caster draws a night football stadium:
a regulation 105 x 68 m pitch in perspective (mowing stripes, every FIFA line, spots,
goals), a lit bowl of stands with a subdued crowd texture, a roof with floodlight banks,
gold LED boards, volumetric haze and bloom. Deterministic (fixed seed), so the output is
reproducible from this file.

    python scripts/brand/render-stadium.py

Outputs (public/brand/):
  soccer-stadium-2560.webp   desktop backdrop (16:9)
  soccer-stadium-1600.webp   desktop backdrop, smaller screens
  soccer-stadium-portrait-1080.webp   phone backdrop (9:16, its own camera)
  and scripts/brand/out/stadium-master-2560.png (lossless master for the share card)
"""
import os
import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'brand')
MASTER = os.path.join(ROOT, 'scripts', 'brand', 'out')
L, W = 105.0, 68.0
RNG = np.random.default_rng(20260928)


def hash2(a, b):
    """Deterministic pseudo-random in [0,1) from two integer grids."""
    h = (a.astype(np.int64) * 73856093) ^ (b.astype(np.int64) * 19349663)
    h = (h ^ (h >> 13)) * 1274126177
    return ((h ^ (h >> 16)) & 0xFFFFFF) / float(0xFFFFFF)


def value_noise(shape, scale, seed):
    r = np.random.default_rng(seed)
    small = r.random((max(2, int(shape[0] / scale) + 2), max(2, int(shape[1] / scale) + 2)))
    img = Image.fromarray((small * 255).astype(np.uint8)).resize((shape[1], shape[0]), Image.BICUBIC)
    return np.asarray(img, dtype=np.float32) / 255.0


def look_at(cam, target):
    f = target - cam; f /= np.linalg.norm(f)
    up = np.array([0.0, 1.0, 0.0])
    r = np.cross(up, f); r /= np.linalg.norm(r)
    u = np.cross(f, r)
    return r, u, f


def seg_dist(px, pz, ax, az, bx, bz):
    vx, vz = bx - ax, bz - az
    t = np.clip(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz), 0, 1)
    return np.hypot(px - (ax + t * vx), pz - (az + t * vz))


def pitch_line_distance(x, z):
    """Distance (m) from ground point (x along length, z across width) to the nearest pitch marking."""
    segs = [
        (0, 0, L, 0), (0, W, L, W), (0, 0, 0, W), (L, 0, L, W), (L / 2, 0, L / 2, W),
        # penalty areas 16.5 x 40.32 and goal areas 5.5 x 18.32
        (0, W / 2 - 20.16, 16.5, W / 2 - 20.16), (0, W / 2 + 20.16, 16.5, W / 2 + 20.16), (16.5, W / 2 - 20.16, 16.5, W / 2 + 20.16),
        (L, W / 2 - 20.16, L - 16.5, W / 2 - 20.16), (L, W / 2 + 20.16, L - 16.5, W / 2 + 20.16), (L - 16.5, W / 2 - 20.16, L - 16.5, W / 2 + 20.16),
        (0, W / 2 - 9.16, 5.5, W / 2 - 9.16), (0, W / 2 + 9.16, 5.5, W / 2 + 9.16), (5.5, W / 2 - 9.16, 5.5, W / 2 + 9.16),
        (L, W / 2 - 9.16, L - 5.5, W / 2 - 9.16), (L, W / 2 + 9.16, L - 5.5, W / 2 + 9.16), (L - 5.5, W / 2 - 9.16, L - 5.5, W / 2 + 9.16),
    ]
    d = np.full(x.shape, 1e9, dtype=np.float32)
    for s in segs:
        d = np.minimum(d, seg_dist(x, z, *s))
    # centre circle
    d = np.minimum(d, np.abs(np.hypot(x - L / 2, z - W / 2) - 9.15))
    # penalty arcs (outside the areas only)
    for sx, side in ((11.0, 1), (L - 11.0, -1)):
        arc = np.abs(np.hypot(x - sx, z - W / 2) - 9.15)
        outside = (x - (16.5 if side == 1 else L - 16.5)) * side > 0
        d = np.minimum(d, np.where(outside, arc, 1e9))
    # corner arcs r=1
    for cx, cz in ((0, 0), (L, 0), (0, W), (L, W)):
        d = np.minimum(d, np.where(np.hypot(x - cx, z - cz) <= 1.3, np.abs(np.hypot(x - cx, z - cz) - 1.0), 1e9))
    return d


def spots(x, z):
    d = np.full(x.shape, 1e9, dtype=np.float32)
    for sx in (11.0, L / 2, L - 11.0):
        d = np.minimum(d, np.hypot(x - sx, z - W / 2))
    return d


def render(width, height, cam, target, fov_deg):
    ys, xs = np.mgrid[0:height, 0:width].astype(np.float32)
    r, u, f = look_at(np.array(cam, float), np.array(target, float))
    fl = (width / 2) / np.tan(np.radians(fov_deg) / 2)
    dx = (xs - width / 2) / fl; dy = -(ys - height / 2) / fl
    D = dx[..., None] * r + dy[..., None] * u + f  # ray directions
    D /= np.linalg.norm(D, axis=-1, keepdims=True)
    C = np.array(cam, float)
    img = np.zeros((height, width, 3), np.float32)
    depth = np.full((height, width), np.inf, np.float32)
    mat = np.zeros((height, width), np.int8)  # 0 sky 1 grass 2 stand 3 roof 4 led 5 track

    # --- ground plane y=0 (grass + dark surround up to the stands)
    with np.errstate(divide='ignore', invalid='ignore'):
        tg = -C[1] / D[..., 1]
    gx = C[0] + tg * D[..., 0]; gz = C[2] + tg * D[..., 2]
    ground = (tg > 0) & (gx > -14) & (gx < L + 14) & (gz > -30) & (gz < W + 9)
    depth = np.where(ground, tg, depth); mat[ground] = 5
    grass = ground & (gx > -4.5) & (gx < L + 4.5) & (gz > -4.5) & (gz < W + 4.5)
    mat[grass] = 1

    # --- stands: inclined planes behind the far touchline and both goal lines (a bowl)
    def stand_plane(p0, n):
        n = np.array(n, float); n /= np.linalg.norm(n)
        denom = D @ n
        with np.errstate(divide='ignore', invalid='ignore'):
            t = ((np.array(p0) - C) @ n) / denom
        return t
    # far stand rises from (z=W+9, y=0) to (z=W+48, y=34): normal points toward the pitch/camera
    tf = stand_plane((0, 0, W + 9), (0, 34, -39) / np.hypot(34, 39) * -1 * -1)
    pf = C + tf[..., None] * D
    far = (tf > 0) & (pf[..., 1] >= 0) & (pf[..., 1] <= 34) & (pf[..., 0] > -30) & (pf[..., 0] < L + 30) & (tf < depth)
    # end stands (behind each goal), rising away from the pitch
    tl = stand_plane((-14, 0, 0), (34, 0, 0) - np.array([0, -30, 0]))  # plane tilted back to the left
    tl = stand_plane((-14, 0, 0), (0.75, 0.66, 0))
    pl = C + tl[..., None] * D
    left = (tl > 0) & (pl[..., 1] >= 0) & (pl[..., 1] <= 30) & (pl[..., 2] > -40) & (pl[..., 2] < W + 48) & (tl < depth)
    tr = stand_plane((L + 14, 0, 0), (-0.75, 0.66, 0))
    pr = C + tr[..., None] * D
    right = (tr > 0) & (pr[..., 1] >= 0) & (pr[..., 1] <= 30) & (pr[..., 2] > -40) & (pr[..., 2] < W + 48) & (tr < depth)
    for m, t in ((far, tf), (left, tl), (right, tr)):
        upd = m & (t < depth)
        depth = np.where(upd, t, depth); mat[upd] = 2
    # roof: slab at y 34..38 over the far stand, front edge at z=W+40
    troof = stand_plane((0, 35.5, 0), (0, -1, 0))
    proof = C + troof[..., None] * D
    roof = (troof > 0) & (proof[..., 2] > W + 36) & (proof[..., 2] < W + 70) & (proof[..., 0] > -40) & (proof[..., 0] < L + 40) & (troof < depth)
    depth = np.where(roof, troof, depth); mat[roof] = 3

    P = C + np.where(np.isfinite(depth), depth, 0)[..., None] * D
    px, py, pz = P[..., 0], P[..., 1], P[..., 2]

    # floodlight banks along the roof front edge + two corner masts
    lights = [np.array([x, 35.0, W + 38.5]) for x in (-6, 20, 52.5, 85, 111)] + [np.array([-22, 44, -18]), np.array([L + 22, 44, -18])]

    def illum(px, py, pz, nx, ny, nz):
        acc = np.zeros(px.shape, np.float32)
        for lp in lights:
            vx, vy, vz = lp[0] - px, lp[1] - py, lp[2] - pz
            d2 = vx * vx + vy * vy + vz * vz
            cos = np.clip((vx * nx + vy * ny + vz * nz) / np.sqrt(d2), 0, 1)
            acc += cos * 2600.0 / d2
        return acc

    # --- grass shading
    stripe = np.floor(px / 5.25).astype(int) % 2
    tex = 1.0 + 0.10 * (stripe * 2 - 1)
    tex *= 1.0 + 0.035 * (np.floor(pz / 5.0).astype(int) % 2 * 2 - 1)
    grain = hash2(np.floor(px * 6).astype(int), np.floor(pz * 6).astype(int))
    tex *= 0.93 + 0.14 * grain
    E = illum(px, py, pz, 0.0, 1.0, 0.0)
    base = np.array([0.010, 0.048, 0.028])
    g = base * (tex * (0.30 + 1.05 * E))[..., None]
    # pitch markings, anti-aliased by the ground footprint of a pixel
    fp = np.maximum(np.hypot(*np.gradient(np.where(grass, px, 0))), np.hypot(*np.gradient(np.where(grass, pz, 0))))
    fp = np.clip(np.nan_to_num(fp, nan=1.0), 0.02, 3.0)
    dl = pitch_line_distance(px, pz)
    line = np.clip(1.0 - (dl - 0.06) / fp, 0, 1) * (np.abs(dl) < 3)
    line = np.maximum(line, np.clip(1.0 - (spots(px, pz) - 0.11) / fp, 0, 1))
    g = g * (1 - 0.7 * line[..., None]) + (np.array([0.42, 0.47, 0.45]) * (0.40 + 0.7 * E)[..., None]) * (0.7 * line[..., None])
    img = np.where((mat == 1)[..., None], g, img)
    # surround / track: dark slate
    s = np.array([0.012, 0.02, 0.028]) * (0.5 + 1.2 * E)[..., None]
    img = np.where((mat == 5)[..., None], s, img)

    # --- goals (posts + crossbar), drawn as bright thin features in screen space
    def project(p):
        v = np.array(p, float) - C
        z = v @ f
        return (width / 2 + fl * (v @ r) / z, height / 2 - fl * (v @ u) / z, z)
    goal_mask = np.zeros((height, width), np.float32)
    for gxp in (0.0, L):
        pts = [(gxp, 0, W / 2 - 3.66), (gxp, 2.44, W / 2 - 3.66), (gxp, 2.44, W / 2 + 3.66), (gxp, 0, W / 2 + 3.66)]
        pp = [project(q) for q in pts]
        if min(q[2] for q in pp) <= 0:
            continue
        for (x0, y0, _), (x1, y1, _) in zip(pp, pp[1:]):
            n = int(max(abs(x1 - x0), abs(y1 - y0)) * 2) + 2
            for t in np.linspace(0, 1, n):
                xi, yi = int(round(x0 + t * (x1 - x0))), int(round(y0 + t * (y1 - y0)))
                if 0 <= xi < width and 0 <= yi < height:
                    goal_mask[max(0, yi - 1):yi + 2, max(0, xi - 1):xi + 2] = 1.0
        # net: faint mesh behind the goal mouth
    img = img * (1 - goal_mask[..., None]) + np.array([0.85, 0.88, 0.9]) * goal_mask[..., None] * 0.9

    # --- stands: seat rows + subdued crowd + aisles
    stand = mat == 2
    # local coordinates on each stand: along (a) and up (b)
    a = np.where(far, px, np.where(left | right, pz, 0))
    b = np.where(far, pz - (W + 9), np.where(left, -(px + 14), px - (L + 14)))
    row = np.floor(b / 0.62).astype(int); seat = np.floor(a / 0.42).astype(int)
    hsh = hash2(row + 1000 * (left.astype(int) + 2 * right.astype(int)), seat)
    hsh2 = hash2(seat + 77, row * 3 + 5)
    palette = np.array([[0.16, 0.06, 0.07], [0.05, 0.07, 0.16], [0.30, 0.31, 0.34], [0.22, 0.17, 0.13], [0.05, 0.05, 0.06], [0.10, 0.15, 0.26], [0.26, 0.21, 0.08]])
    crowd = palette[(hsh * len(palette)).astype(int) % len(palette)]
    occupied = hsh2 > 0.08
    rowline = (np.abs(b / 0.62 - np.round(b / 0.62)) < 0.14)
    tier = far & (b > 17.0) & (b < 19.2)
    aisle = (np.abs((a / 12.0) - np.round(a / 12.0)) < 0.045)
    Es = illum(px, py, pz, 0.0, 0.66, -0.75) * 0.9
    height_fade = np.clip(1.0 - py / 38.0, 0.25, 1.0)
    sc = np.where(occupied[..., None], crowd, np.array([0.05, 0.06, 0.08]))
    sc = np.where(rowline[..., None], sc * 0.45, sc)
    sc = np.where(aisle[..., None], np.array([0.10, 0.11, 0.13]), sc)
    sc = sc * (0.06 + 0.30 * Es * height_fade)[..., None]
    # tier break: a dark hospitality band with warm windows
    win = tier & (np.abs((a / 3.0) - np.round(a / 3.0)) < 0.28) & (b > 17.6) & (b < 18.6)
    sc = np.where(tier[..., None], np.array([0.010, 0.012, 0.018]), sc)
    sc = np.where(win[..., None], np.array([0.55, 0.40, 0.16]) * 0.16, sc)
    # sparse phone-light specks in the crowd
    speck = (hash2(row * 7 + 3, seat * 13 + 1) > 0.99975) & occupied
    sc = np.where(speck[..., None], np.array([0.55, 0.55, 0.62]), sc)
    sc = gaussian_filter(sc, sigma=(width / 2400, width / 2400, 0))
    img = np.where(stand[..., None], sc, img)
    # --- roof underside with structure
    rb = np.where(roof, np.floor(proof[..., 0] / 6.0).astype(int) % 2, 0)
    rc = np.array([0.012, 0.016, 0.024]) * (1 + 0.25 * rb)[..., None]
    img = np.where(roof[..., None], rc, img)
    # --- LED boards: vertical band at the stand fronts (gold, segmented, no text)
    led = np.zeros((height, width), bool)
    tb = stand_plane((0, 0, W + 7.2), (0, 0, -1)); pb = C + tb[..., None] * D
    ledf = (tb > 0) & (pb[..., 1] > 0) & (pb[..., 1] < 0.9) & (pb[..., 0] > -8) & (pb[..., 0] < L + 8) & (tb <= depth + 1e-3)
    led |= ledf
    seg = (np.floor(np.where(ledf, pb[..., 0], 0) / 2.2).astype(int) % 2)
    ledc = np.array([1.35, 0.92, 0.30]) * (0.85 + 0.25 * seg)[..., None]
    img = np.where(led[..., None], ledc, img)
    depth = np.where(led, tb, depth); mat[led] = 4

    # --- sky
    sky = mat == 0
    vy = np.clip(D[..., 1], -0.2, 1)
    skyc = np.array([0.008, 0.014, 0.035]) + np.array([0.02, 0.03, 0.06]) * np.clip(1 - vy * 3, 0, 1)[..., None]
    img = np.where(sky[..., None], skyc, img)

    # --- floodlight emitters (screen space) + glare
    emit = np.zeros((height, width), np.float32)
    for lp in lights:
        for k in range(-4, 5):
            for j in range(0, 2):
                q = lp + np.array([k * 1.6, j * 1.3, 0.0])
                sx, sy, z = project(q)
                if z <= 0 or not (0 <= sx < width and 0 <= sy < height):
                    continue
                rad = max(1.5, 900.0 / z)
                x0, x1 = int(sx - rad), int(sx + rad) + 1; y0, y1 = int(sy - rad * 0.6), int(sy + rad * 0.6) + 1
                emit[max(0, y0):max(0, y1), max(0, x0):max(0, x1)] = 1.0
    img += emit[..., None] * np.array([6.0, 6.2, 6.6])

    # --- atmospheric haze: depth fog + glow volumes around the lights
    dist = np.where(np.isfinite(depth), depth, 400.0)
    fog = 1 - np.exp(-dist / 190.0)
    noise = value_noise((height, width), 180, 11) * 0.6 + value_noise((height, width), 60, 12) * 0.4
    fogc = np.array([0.05, 0.07, 0.11])
    img = img * (1 - 0.55 * fog[..., None]) + fogc * (0.55 * fog * (0.7 + 0.6 * noise))[..., None]
    # volumetric cones below each roof light
    cones = np.zeros((height, width), np.float32)
    for lp in lights[:5]:
        sx, sy, z = project(lp)
        if z <= 0:
            continue
        dxs = (xs - sx) / (width * 0.16); dys = np.clip((ys - sy) / (height * 0.55), 0, None)
        spread = np.exp(-(dxs ** 2) / (0.02 + 0.5 * dys ** 2)) * np.exp(-dys * 1.6) * (ys > sy)
        cones += spread.astype(np.float32)
    img += (cones * (0.5 + 0.8 * noise))[..., None] * np.array([0.075, 0.085, 0.105])

    # --- bloom
    bright = np.clip(img - 0.9, 0, None)
    bloom = gaussian_filter(bright, sigma=(width / 640, width / 640, 0)) * 0.9 + gaussian_filter(bright, sigma=(width / 160, width / 160, 0)) * 0.55 + gaussian_filter(bright, sigma=(width / 40, width / 40, 0)) * 0.35
    img += bloom * np.array([0.95, 1.0, 1.08])

    # --- tone map (ACES approximation), grade, vignette, grain
    a_, b_, c_, d_, e_ = 2.51, 0.03, 2.43, 0.59, 0.14
    x = img * 0.82
    tm = np.clip((x * (a_ * x + b_)) / (x * (c_ * x + d_) + e_), 0, 1)
    tm = tm ** (1 / 2.2)
    cxn = (xs / width - 0.5); cyn = (ys / height - 0.46)
    vig = np.clip(1 - 0.85 * (cxn ** 2 * 1.4 + cyn ** 2 * 1.9), 0.25, 1)
    tm *= vig[..., None]
    tm += (RNG.standard_normal((height, width, 1)).astype(np.float32) * 0.012)
    return np.clip(tm, 0, 1)


def save(arr, name, quality):
    im = Image.fromarray((arr * 255 + 0.5).astype(np.uint8), 'RGB')
    path = os.path.join(OUT, name)
    im.save(path, 'WEBP', quality=quality, method=6)
    return im, os.path.getsize(path)


if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True); os.makedirs(MASTER, exist_ok=True)
    # Broadcast-style: high in the main stand at the halfway line, looking across the pitch.
    land = render(2560, 1440, cam=(L / 2, 27.0, -33.0), target=(L / 2, 2.0, 46.0), fov_deg=78)
    Image.fromarray((land * 255 + 0.5).astype(np.uint8)).save(os.path.join(MASTER, 'stadium-master-2560.png'))
    im, n1 = save(land, 'soccer-stadium-2560.webp', 70)
    im.resize((1600, 900), Image.LANCZOS).save(os.path.join(OUT, 'soccer-stadium-1600.webp'), 'WEBP', quality=72, method=6)
    # Phone: its own camera (taller framing), not a crop.
    port = render(1080, 1920, cam=(L / 2, 44.0, -10.0), target=(L / 2, 0.0, 30.0), fov_deg=62)
    _, n3 = save(port, 'soccer-stadium-portrait-1080.webp', 70)
    print({ 'desktop_2560_bytes': n1, 'desktop_1600_bytes': os.path.getsize(os.path.join(OUT, 'soccer-stadium-1600.webp')), 'portrait_1080_bytes': n3 })
