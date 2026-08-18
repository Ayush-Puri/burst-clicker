#!/usr/bin/env python3
"""Render the Burst Clicker target icon at every size Chrome asks for. No deps."""
import os
import struct
import zlib

BG = (15, 23, 42)
RING = (244, 63, 94)
GLOW = (34, 211, 238)
SS = 4  # supersampling factor


def chunk(tag, data):
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path, w, h, rows):
    raw = b"".join(b"\x00" + bytes(v for px in row for v in px) for row in rows)
    blob = (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))
    with open(path, "wb") as fh:
        fh.write(blob)


def rounded(px, py, size, radius):
    x = min(px, size - px)
    y = min(py, size - py)
    if x >= radius or y >= radius:
        return px >= 0 and py >= 0 and px <= size and py <= size
    return (radius - x) ** 2 + (radius - y) ** 2 <= radius ** 2


def sample(px, py, size):
    c = size / 2.0
    d = ((px - c) ** 2 + (py - c) ** 2) ** 0.5
    if not rounded(px, py, size, size * 0.22):
        return (0, 0, 0, 0)
    if d <= size * 0.085:
        return RING + (255,)
    if size * 0.28 <= d <= size * 0.36:
        return RING + (255,)
    if size * 0.40 <= d <= size * 0.435:
        return GLOW + (150,)
    return BG + (255,)


def render(size):
    rows = []
    step = 1.0 / SS
    for y in range(size):
        row = []
        for x in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    r, g, b, a = sample(x + (sx + 0.5) * step, y + (sy + 0.5) * step, size)
                    acc[0] += r * a
                    acc[1] += g * a
                    acc[2] += b * a
                    acc[3] += a
            n = SS * SS
            a = acc[3] / n
            if a <= 0:
                row.append((0, 0, 0, 0))
            else:
                row.append((round(acc[0] / acc[3]), round(acc[1] / acc[3]),
                            round(acc[2] / acc[3]), round(a)))
        rows.append(row)
    return rows


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    for s in (16, 32, 48, 128):
        write_png(os.path.join(here, f"icon{s}.png"), s, s, render(s))
        print(f"icon{s}.png")
