#!/usr/bin/env python3
"""
Generate extension icons (16/48/128) with a simple broom mark.

Codex note (Feb 2026):
- We can't rely on external assets/fonts in this repo, so icons are generated
  programmatically using only the Python stdlib.
- Keeping this script makes it easy for Claude (or future maintainers) to tweak
  the palette/shape and regenerate consistent PNGs.
"""

from __future__ import annotations

import math
import os
import struct
import zlib


def _clamp01(x: float) -> float:
    return 0.0 if x < 0.0 else 1.0 if x > 1.0 else x


def _srgb_to_u8(v: float) -> int:
    return int(round(_clamp01(v) * 255.0))


def _blend(dst_rgba: list[float], src_rgba: tuple[float, float, float, float]) -> None:
    """Alpha-over blend into dst_rgba (in-place)."""

    sr, sg, sb, sa = src_rgba
    dr, dg, db, da = dst_rgba
    out_a = sa + da * (1.0 - sa)
    if out_a <= 0.0:
        dst_rgba[0] = dst_rgba[1] = dst_rgba[2] = 0.0
        dst_rgba[3] = 0.0
        return
    out_r = (sr * sa + dr * da * (1.0 - sa)) / out_a
    out_g = (sg * sa + dg * da * (1.0 - sa)) / out_a
    out_b = (sb * sa + db * da * (1.0 - sa)) / out_a
    dst_rgba[0], dst_rgba[1], dst_rgba[2], dst_rgba[3] = out_r, out_g, out_b, out_a


def _png_bytes(w: int, h: int, rgba_u8: bytes) -> bytes:
    """Write a minimal RGBA PNG (no color correction chunks)."""

    raw = b"".join(b"\x00" + rgba_u8[y * w * 4 : (y + 1) * w * 4] for y in range(h))
    comp = zlib.compress(raw, 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack("!I", len(data))
            + tag
            + data
            + struct.pack("!I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    out = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack("!IIBBBBB", w, h, 8, 6, 0, 0, 0)
    out += chunk(b"IHDR", ihdr)
    out += chunk(b"IDAT", comp)
    out += chunk(b"IEND", b"")
    return out


def _inside_rounded_rect(x: int, y: int, w: int, h: int, r: int) -> bool:
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    if r <= 0:
        return True
    # Fast path: inside the center rects.
    if r <= x < w - r and 0 <= y < h:
        return True
    if 0 <= x < w and r <= y < h - r:
        return True

    # Corner circles.
    cx = r - 1 if x < r else w - r
    cy = r - 1 if y < r else h - r
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= (r - 1) * (r - 1)


def _dist_point_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    abx = bx - ax
    aby = by - ay
    apx = px - ax
    apy = py - ay
    ab_len2 = abx * abx + aby * aby
    if ab_len2 <= 1e-9:
        return math.hypot(px - ax, py - ay)
    t = (apx * abx + apy * aby) / ab_len2
    t = 0.0 if t < 0.0 else 1.0 if t > 1.0 else t
    cx = ax + t * abx
    cy = ay + t * aby
    return math.hypot(px - cx, py - cy)


def _fill_polygon(canvas: list[list[list[float]]], pts: list[tuple[float, float]], color: tuple[float, float, float, float]) -> None:
    """Scanline polygon fill (convex-ish), in canvas pixel space."""

    h = len(canvas)
    w = len(canvas[0]) if h else 0
    ys = [p[1] for p in pts]
    y0 = max(0, int(math.floor(min(ys))))
    y1 = min(h - 1, int(math.ceil(max(ys))))
    for y in range(y0, y1 + 1):
        yline = y + 0.5
        xs: list[float] = []
        for i in range(len(pts)):
            x1, y1p = pts[i]
            x2, y2p = pts[(i + 1) % len(pts)]
            if (y1p <= yline < y2p) or (y2p <= yline < y1p):
                t = (yline - y1p) / (y2p - y1p)
                xs.append(x1 + t * (x2 - x1))
        xs.sort()
        for i in range(0, len(xs), 2):
            if i + 1 >= len(xs):
                break
            xa = max(0, int(math.floor(xs[i])))
            xb = min(w - 1, int(math.ceil(xs[i + 1])))
            for x in range(xa, xb + 1):
                _blend(canvas[y][x], color)


def _draw_circle(canvas: list[list[list[float]]], cx: float, cy: float, r: float, color: tuple[float, float, float, float]) -> None:
    h = len(canvas)
    w = len(canvas[0]) if h else 0
    x0 = max(0, int(math.floor(cx - r - 1)))
    x1 = min(w - 1, int(math.ceil(cx + r + 1)))
    y0 = max(0, int(math.floor(cy - r - 1)))
    y1 = min(h - 1, int(math.ceil(cy + r + 1)))
    rr = r * r
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            dx = (x + 0.5) - cx
            dy = (y + 0.5) - cy
            if dx * dx + dy * dy <= rr:
                _blend(canvas[y][x], color)


def _draw_line(canvas: list[list[list[float]]], ax: float, ay: float, bx: float, by: float, thickness: float, color: tuple[float, float, float, float]) -> None:
    h = len(canvas)
    w = len(canvas[0]) if h else 0
    pad = thickness / 2.0 + 2.0
    x0 = max(0, int(math.floor(min(ax, bx) - pad)))
    x1 = min(w - 1, int(math.ceil(max(ax, bx) + pad)))
    y0 = max(0, int(math.floor(min(ay, by) - pad)))
    y1 = min(h - 1, int(math.ceil(max(ay, by) + pad)))
    t2 = thickness / 2.0
    for y in range(y0, y1 + 1):
        py = y + 0.5
        for x in range(x0, x1 + 1):
            px = x + 0.5
            if _dist_point_to_segment(px, py, ax, ay, bx, by) <= t2:
                _blend(canvas[y][x], color)


def _render_icon(size: int) -> bytes:
    # Oversample for crisp small icons, then downsample by averaging.
    # For 16px specifically, oversample more so diagonal edges don't turn to mush.
    scale = 10 if size <= 16 else 4 if size <= 48 else 2
    w = h = size * scale

    # Canvas is list[y][x] = [r,g,b,a] floats 0..1
    canvas: list[list[list[float]]] = [[[0.0, 0.0, 0.0, 0.0] for _ in range(w)] for _ in range(h)]

    # Palette (match popup: matte dark + safety orange accent).
    # For tiny icons, favor high contrast + bold color so it reads in the toolbar.
    if size <= 16:
        bg_a = (1.00, 0.69, 0.00, 1.0)
        bg_b = (1.00, 0.82, 0.30, 1.0)
        border = (0.0, 0.0, 0.0, 0.0)
        broom = (0.06, 0.07, 0.09, 1.0)
        broom_accent = broom
        sparkle = (0.0, 0.0, 0.0, 0.0)
    else:
        bg_a = (0.04, 0.06, 0.08, 1.0)  # deep
        bg_b = (0.06, 0.09, 0.13, 1.0)  # slightly lighter
        border = (0.14, 0.18, 0.26, 1.0)
        broom = (0.93, 0.95, 0.98, 1.0)
        broom_accent = (1.00, 0.69, 0.00, 1.0)
        sparkle = (0.13, 0.83, 0.93, 1.0)

    outer_r = int(round((0.26 if size <= 16 else 0.24) * w))
    # At 16px: skip the border so the mark has more room to read.
    border_t = 0 if size <= 16 else max(2, int(round(0.045 * w)))
    inner_r = max(0, outer_r - border_t)

    # Background rounded-square + border.
    for y in range(h):
        for x in range(w):
            if not _inside_rounded_rect(x, y, w, h, outer_r):
                continue
            if border_t and not _inside_rounded_rect(x - border_t, y - border_t, w - 2 * border_t, h - 2 * border_t, inner_r):
                canvas[y][x] = [border[0], border[1], border[2], 1.0]
                continue

            # Simple diagonal gradient (matte).
            t = (x + y) / float((w - 1) + (h - 1))
            r = bg_a[0] * (1.0 - t) + bg_b[0] * t
            g = bg_a[1] * (1.0 - t) + bg_b[1] * t
            b = bg_a[2] * (1.0 - t) + bg_b[2] * t
            # Subtle highlight in top-left.
            hi = max(0.0, 0.22 - t) * 0.55
            r = _clamp01(r + hi)
            g = _clamp01(g + hi)
            b = _clamp01(b + hi)
            canvas[y][x] = [r, g, b, 1.0]

    # Broom: handle line + bristle polygon + a tiny sparkle.
    # Make 16px read: thicker handle, fewer tiny details.
    if size <= 16:
        ax, ay = 0.26 * w, 0.20 * h
        bx, by = 0.70 * w, 0.68 * h
        handle_t = 0.095 * w
    else:
        ax, ay = 0.30 * w, 0.22 * h
        bx, by = 0.66 * w, 0.64 * h
        handle_t = 0.075 * w
    _draw_line(canvas, ax, ay, bx, by, handle_t, broom)

    # Bristles: parallelogram aligned with the handle.
    br = [
        (0.56 * w, 0.58 * h),
        (0.82 * w, 0.70 * h),
        (0.72 * w, 0.88 * h),
        (0.44 * w, 0.76 * h),
    ]
    _fill_polygon(canvas, br, broom_accent)

    # Bristle stripes (3 cuts).
    for i in range(0 if size <= 16 else 3):
        sx = (0.52 + i * 0.06) * w
        sy = (0.62 + i * 0.04) * h
        _draw_line(canvas, sx, sy, sx + 0.18 * w, sy + 0.10 * h, 0.02 * w, (0.03, 0.05, 0.08, 0.70))

    # Sparkle (small cross) near the tip.
    if size > 16:
        cx, cy = 0.72 * w, 0.42 * h
        _draw_line(canvas, cx - 0.05 * w, cy, cx + 0.05 * w, cy, 0.02 * w, sparkle)
        _draw_line(canvas, cx, cy - 0.05 * h, cx, cy + 0.05 * h, 0.02 * w, sparkle)

    # A couple of swept "dust" dots.
    if size > 16:
        _draw_circle(canvas, 0.32 * w, 0.74 * h, 0.035 * w, (0.88, 0.92, 0.98, 0.55))
        _draw_circle(canvas, 0.26 * w, 0.68 * h, 0.028 * w, (0.88, 0.92, 0.98, 0.40))

    # Downsample.
    out = bytearray(size * size * 4)
    for oy in range(size):
        for ox in range(size):
            r_sum = g_sum = b_sum = a_sum = 0.0
            for sy in range(scale):
                for sx in range(scale):
                    p = canvas[oy * scale + sy][ox * scale + sx]
                    r_sum += p[0]
                    g_sum += p[1]
                    b_sum += p[2]
                    a_sum += p[3]
            denom = float(scale * scale)
            r = r_sum / denom
            g = g_sum / denom
            b = b_sum / denom
            a = a_sum / denom
            i = (oy * size + ox) * 4
            out[i + 0] = _srgb_to_u8(r)
            out[i + 1] = _srgb_to_u8(g)
            out[i + 2] = _srgb_to_u8(b)
            out[i + 3] = _srgb_to_u8(a)

    return _png_bytes(size, size, bytes(out))


def main() -> None:
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    icons_dir = os.path.join(repo_root, "icons")
    os.makedirs(icons_dir, exist_ok=True)

    for size, name in [(16, "icon16.png"), (48, "icon48.png"), (128, "icon128.png")]:
        png = _render_icon(size)
        path = os.path.join(icons_dir, name)
        with open(path, "wb") as f:
            f.write(png)
        print("wrote", path)


if __name__ == "__main__":
    main()
