"""生成应用图标（InTune 声波标识）。纯 Python，无第三方依赖。

用法：python tools/make-icons.py   （在仓库根目录运行，输出到 icons/）
"""
import math, os, struct, zlib

BRAND = (0xB7, 0x5B, 0x35)   # #b75b35
WHITE = (255, 255, 255)
# 标识：80×80 画布上的 6 条竖线（与 logo-options.html 中「同频 InTune」一致），线宽 6，圆头
BARS = [(10, 35, 45), (22, 23, 57), (34, 15, 65), (46, 25, 55), (58, 23, 57), (70, 35, 45)]
STROKE = 6
SS = 4  # 每像素 4×4 超采样

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")


def in_glyph(x, y):
    """(x, y) 为 80×80 标识坐标；判断是否落在某条圆头竖线内。"""
    r = STROKE / 2
    for bx, y0, y1 in BARS:
        if abs(x - bx) > r:
            continue
        cy = min(max(y, y0), y1)
        if (x - bx) ** 2 + (y - cy) ** 2 <= r * r:
            return True
    return False


def in_rounded_rect(x, y, size, radius):
    if radius <= 0:
        return True
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius


def render(size, glyph_frac, corner_frac):
    """glyph_frac：80 单位标识框占图标边长的比例；corner_frac：圆角半径占边长比例（0 = 满版方形）。"""
    scale = size * glyph_frac / 80
    off = (size - 80 * scale) / 2
    radius = size * corner_frac
    rows = []
    n = SS * SS
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            bg = fg = 0
            for sy in range(SS):
                for sx in range(SS):
                    x = px + (sx + 0.5) / SS
                    y = py + (sy + 0.5) / SS
                    if not in_rounded_rect(x, y, size, radius):
                        continue
                    if in_glyph((x - off) / scale, (y - off) / scale):
                        fg += 1
                    else:
                        bg += 1
            cov = bg + fg
            if cov == 0:
                row += bytes(4)
                continue
            rgb = [round((BRAND[i] * bg + WHITE[i] * fg) / cov) for i in range(3)]
            row += bytes(rgb + [round(255 * cov / n)])
        rows.append(bytes(row))
    return png(size, b"".join(rows))


def png(size, raw):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b"")


def svg():
    paths = "".join(f"M{x} {a}V{b}" for x, a, b in BARS)
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">'
        f'<rect width="80" height="80" rx="18" fill="#b75b35"/>'
        f'<g transform="translate(6 6) scale(.85)"><path d="{paths}" fill="none" stroke="#fff" '
        f'stroke-width="{STROKE}" stroke-linecap="round"/></g></svg>\n'
    )


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    jobs = {
        "icon-192.png": (192, 0.66, 0.22),           # 普通图标：圆角方形
        "icon-512.png": (512, 0.66, 0.22),
        "icon-maskable-192.png": (192, 0.54, 0),     # 可遮罩：满版底色，标识留在安全区内
        "icon-maskable-512.png": (512, 0.54, 0),
        "apple-touch-icon.png": (180, 0.62, 0),      # iOS 自己加圆角
        "favicon-32.png": (32, 0.80, 0.22),
    }
    for name, args in jobs.items():
        with open(os.path.join(OUT, name), "wb") as f:
            f.write(render(*args))
        print("wrote", name)
    with open(os.path.join(OUT, "icon.svg"), "w", encoding="utf-8") as f:
        f.write(svg())
    print("wrote icon.svg")
