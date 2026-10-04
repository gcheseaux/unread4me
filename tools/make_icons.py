#!/usr/bin/env python3
"""Generate the unread4me PNG icons.

Renders a blue disc with three tweet-like bars, the last one faded out to
suggest a hidden row. Drawn oversized and box-downsampled so the edges are
antialiased without needing an image library.
"""

import os
import struct
import zlib

SUPERSAMPLE = 512
SIZES = (16, 32, 48, 128)
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")

DISC = (29, 155, 240)
BAR = (255, 255, 255)


def render():
    """Draw the icon at SUPERSAMPLE resolution as an RGBA pixel list."""
    n = SUPERSAMPLE
    center = n / 2.0
    radius = n * 0.5
    pixels = [(0, 0, 0, 0)] * (n * n)

    # Bars as (top, bottom, left, right, alpha) in fractions of the canvas.
    bars = [
        (0.30, 0.385, 0.24, 0.76, 1.0),
        (0.455, 0.54, 0.24, 0.64, 1.0),
        (0.61, 0.695, 0.24, 0.70, 0.32),
    ]
    radius_bar = 0.0425 * n

    for y in range(n):
        for x in range(n):
            dx, dy = x + 0.5 - center, y + 0.5 - center
            if dx * dx + dy * dy > radius * radius:
                continue

            color, alpha = DISC, 1.0
            for top, bottom, left, right, bar_alpha in bars:
                t, b, l, r = top * n, bottom * n, left * n, right * n
                # Rounded rectangle: clamp the point into the inner box, then
                # measure the distance out to the corner radius.
                cx = min(max(x + 0.5, l + radius_bar), r - radius_bar)
                cy = min(max(y + 0.5, t + radius_bar), b - radius_bar)
                bdx, bdy = x + 0.5 - cx, y + 0.5 - cy
                if bdx * bdx + bdy * bdy <= radius_bar * radius_bar:
                    color = BAR
                    alpha = bar_alpha
                    break

            r_, g_, b_ = color
            if alpha < 1.0:
                r_ = round(r_ * alpha + DISC[0] * (1 - alpha))
                g_ = round(g_ * alpha + DISC[1] * (1 - alpha))
                b_ = round(b_ * alpha + DISC[2] * (1 - alpha))
            pixels[y * n + x] = (r_, g_, b_, 255)

    return pixels


def downsample(pixels, size):
    """Box-filter the supersampled buffer down to `size` square."""
    n = SUPERSAMPLE
    step = n // size
    out = []
    for oy in range(size):
        for ox in range(size):
            r = g = b = a = 0
            for y in range(oy * step, (oy + 1) * step):
                row = y * n
                for x in range(ox * step, (ox + 1) * step):
                    pr, pg, pb, pa = pixels[row + x]
                    # Premultiply so transparent pixels do not darken the edge.
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            if a == 0:
                out.append((0, 0, 0, 0))
            else:
                count = step * step
                out.append((round(r / a), round(g / a), round(b / a), round(a / count)))
    return out


def write_png(path, pixels, size):
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter type: none
        for x in range(size):
            raw.extend(pixels[y * size + x])

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + chunk(b"IEND", b"")
    )
    with open(path, "wb") as handle:
        handle.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    pixels = render()
    for size in SIZES:
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        write_png(path, downsample(pixels, size), size)
        print("wrote", os.path.normpath(path))


if __name__ == "__main__":
    main()
