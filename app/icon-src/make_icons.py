#!/usr/bin/env python3
"""生成 GPT 生图工作室的应用图标源文件与托盘图标（依赖 Pillow）。

用法（在 app/ 目录）：
    python3 icon-src/make_icons.py          # 生成 icon-src/icon.png、tray 图标
    npx tauri icon icon-src/icon.png -o src-tauri/icons   # 生成全平台图标（ico / icns / Square*Logo …）
"""
import math
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ICONS = os.path.join(HERE, "..", "src-tauri", "icons")
S = 1024


def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(len(a)))


def gradient(size, stops):
    """对角线多段渐变。"""
    w, h = size
    img = Image.new("RGBA", size)
    px = img.load()
    for y in range(h):
        for x in range(w):
            t = (x / w * 0.55 + y / h * 0.45)
            for i in range(len(stops) - 1):
                p0, c0 = stops[i]
                p1, c1 = stops[i + 1]
                if p0 <= t <= p1:
                    px[x, y] = lerp(c0, c1, (t - p0) / (p1 - p0)) + (255,)
                    break
    return img


def star(cx, cy, r, inner=0.18, points=4, rot=0.0):
    pts = []
    for i in range(points * 2):
        a = rot + math.pi * i / points - math.pi / 2
        rr = r if i % 2 == 0 else r * inner
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return pts


def squircle_mask(size, radius_ratio=0.225):
    m = Image.new("L", (size * 4, size * 4), 0)
    d = ImageDraw.Draw(m)
    pad = int(size * 4 * 0.06)
    d.rounded_rectangle((pad, pad, size * 4 - pad, size * 4 - pad), radius=int(size * 4 * radius_ratio), fill=255)
    return m.resize((size, size), Image.LANCZOS)


def app_icon():
    small = gradient((256, 256), [(0.0, (168, 85, 247)), (0.5, (99, 102, 241)), (1.0, (34, 211, 238))])
    bg = small.resize((S, S), Image.BICUBIC)
    # 顶部高光
    hl = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(hl).ellipse((-S * 0.3, -S * 0.75, S * 1.1, S * 0.45), fill=(255, 255, 255, 46))
    bg = Image.alpha_composite(bg, hl.filter(ImageFilter.GaussianBlur(40)))

    fg = Image.new("RGBA", (S * 2, S * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(fg)
    k = 2
    # 相框（代表图片）
    d.rounded_rectangle((250 * k, 300 * k, 720 * k, 770 * k), radius=70 * k, outline=(255, 255, 255, 235), width=44 * k)
    # 山峦
    d.polygon([(292 * k, 728 * k), (430 * k, 560 * k), (520 * k, 660 * k), (590 * k, 600 * k), (690 * k, 728 * k)], fill=(255, 255, 255, 235))
    # 太阳
    d.ellipse((560 * k, 380 * k, 640 * k, 460 * k), fill=(255, 255, 255, 235))
    # 主星（AI 魔法）
    d.polygon(star(705 * k, 315 * k, 185 * k, 0.2), fill=(255, 255, 255, 255))
    d.polygon(star(830 * k, 520 * k, 62 * k, 0.24), fill=(255, 255, 255, 230))
    d.polygon(star(560 * k, 190 * k, 52 * k, 0.26), fill=(255, 255, 255, 210))
    fg = fg.resize((S, S), Image.LANCZOS)

    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.putalpha(fg.getchannel("A").point(lambda a: int(a * 0.35)))
    shadow = shadow.filter(ImageFilter.GaussianBlur(18))
    sh = Image.new("RGBA", (S, S), (40, 20, 90, 0))
    sh.putalpha(shadow.getchannel("A"))
    canvas = Image.alpha_composite(bg, sh.transform((S, S), Image.AFFINE, (1, 0, 0, 0, 1, -16)))
    canvas = Image.alpha_composite(canvas, fg)

    out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    out.paste(canvas, (0, 0), squircle_mask(S))
    return out


def tray_template(size=64):
    """macOS 菜单栏模板图标：纯黑 + 透明，系统会按明暗模式自动着色。"""
    k = 4
    img = Image.new("RGBA", (size * k, size * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    u = size * k / 64
    d.rounded_rectangle((8 * u, 16 * u, 46 * u, 54 * u), radius=7 * u, outline=(0, 0, 0, 255), width=int(5 * u))
    d.polygon([(12 * u, 50 * u), (22 * u, 37 * u), (29 * u, 44 * u), (34 * u, 40 * u), (42 * u, 50 * u)], fill=(0, 0, 0, 255))
    d.polygon(star(46 * u, 16 * u, 15 * u, 0.22), fill=(0, 0, 0, 255))
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(ICONS, exist_ok=True)
    icon = app_icon()
    icon.save(os.path.join(HERE, "icon.png"))
    # Windows / Linux 托盘：彩色小图标
    icon.resize((64, 64), Image.LANCZOS).save(os.path.join(ICONS, "tray.png"))
    # macOS 托盘：模板图标（@2x 高清）
    tray_template(64).save(os.path.join(ICONS, "tray-template.png"))
    tray_template(32).save(os.path.join(ICONS, "tray-template-32.png"))
    icon.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, "..", "public", "icon.png"))
    print("icon-src/icon.png、src-tauri/icons/tray*.png、public/icon.png 已生成")


if __name__ == "__main__":
    main()
