#!/usr/bin/env python3
"""Generates the static PNG assets the manifest requires (marketplace, category-icon).

Stream Deck's validator rejects SVG for these specific manifest fields, so we
ship hand-painted PNGs. Run with: python3 scripts/render-static-pngs.py
"""

from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN_IMGS = ROOT / "com.julien.claudesessions.sdPlugin" / "imgs"

# Palette
BG = (15, 17, 21, 255)              # #0f1115
ACCENT = (249, 115, 22, 255)        # Claude orange
TEXT = (229, 231, 235, 255)         # #e5e7eb


def draw_dots_card(size: int, padding: int, with_text: bool = True) -> Image.Image:
    """Card with the three-dots motif used everywhere in the plugin."""
    img = Image.new("RGBA", (size, size), BG)
    d = ImageDraw.Draw(img)
    # Rounded border in accent color
    border_w = max(2, size // 36)
    d.rounded_rectangle(
        [padding, padding, size - padding, size - padding],
        radius=size // 14,
        outline=ACCENT,
        width=border_w,
    )
    # Centered three dots
    cy = size // 2 - (size // 12 if with_text else 0)
    spacing = size // 8
    radius = size // 22
    for i, scale in enumerate((0.85, 1.0, 0.85)):
        cx = size // 2 + (i - 1) * spacing
        r = int(radius * scale)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
    if with_text:
        try:
            font = ImageFont.truetype(
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                size // 14,
            )
        except OSError:
            font = ImageFont.load_default()
        text = "Claude Sessions"
        bbox = d.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        d.text(
            ((size - tw) // 2, size - padding - (size // 9)),
            text,
            fill=TEXT,
            font=font,
        )
    return img


def main() -> None:
    PLUGIN_IMGS.mkdir(parents=True, exist_ok=True)
    (PLUGIN_IMGS / "plugin").mkdir(exist_ok=True)
    (PLUGIN_IMGS / "actions" / "slot").mkdir(parents=True, exist_ok=True)

    # Marketplace icon: 144x144 (1x) + 288x288 (@2x), with text
    draw_dots_card(144, padding=12, with_text=True).save(PLUGIN_IMGS / "plugin" / "marketplace.png")
    draw_dots_card(288, padding=24, with_text=True).save(PLUGIN_IMGS / "plugin" / "marketplace@2x.png")

    # Category icon: 28x28, glyph only (mono accent on transparent BG)
    cat = Image.new("RGBA", (28, 28), (0, 0, 0, 0))
    cd = ImageDraw.Draw(cat)
    cd.rounded_rectangle([5, 7, 23, 21], radius=2, outline=TEXT, width=2)
    for i, x in enumerate((10, 14, 18)):
        cd.ellipse([x - 1, 13, x + 1, 15], fill=TEXT)
    cat.save(PLUGIN_IMGS / "plugin" / "category-icon.png")
    cat.resize((56, 56), Image.LANCZOS).save(PLUGIN_IMGS / "plugin" / "category-icon@2x.png")

    # Action picker icon: 40x40, glyph + small accent
    pick = Image.new("RGBA", (40, 40), BG)
    pd = ImageDraw.Draw(pick)
    pd.rounded_rectangle([0, 0, 39, 39], radius=6, outline=ACCENT, width=2)
    for i, x in enumerate((14, 20, 26)):
        pd.ellipse([x - 2, 18, x + 2, 22], fill=ACCENT)
    pick.save(PLUGIN_IMGS / "actions" / "slot" / "icon.png")
    pick.resize((80, 80), Image.LANCZOS).save(PLUGIN_IMGS / "actions" / "slot" / "icon@2x.png")

    # Default key image: empty-slot look at 144x144
    key = Image.new("RGBA", (144, 144), BG)
    kd = ImageDraw.Draw(key)
    kd.rounded_rectangle([2, 2, 141, 141], radius=14, outline=(55, 65, 81, 200), width=2)
    # dotted inner box
    kd.rectangle([20, 42, 124, 106], outline=(55, 65, 81, 220), width=2)
    # plus sign
    kd.line([72, 58, 72, 90], fill=(55, 65, 81, 220), width=5)
    kd.line([56, 74, 88, 74], fill=(55, 65, 81, 220), width=5)
    key.save(PLUGIN_IMGS / "actions" / "slot" / "key.png")
    key.resize((72, 72), Image.LANCZOS).save(PLUGIN_IMGS / "actions" / "slot" / "key.png")  # 1x
    # 2x - render at 288 then keep
    big = Image.new("RGBA", (288, 288), BG)
    bd = ImageDraw.Draw(big)
    bd.rounded_rectangle([4, 4, 283, 283], radius=28, outline=(55, 65, 81, 200), width=4)
    bd.rectangle([40, 84, 248, 212], outline=(55, 65, 81, 220), width=4)
    bd.line([144, 116, 144, 180], fill=(55, 65, 81, 220), width=10)
    bd.line([112, 148, 176, 148], fill=(55, 65, 81, 220), width=10)
    big.save(PLUGIN_IMGS / "actions" / "slot" / "key@2x.png")

    print("wrote PNG manifest assets:")
    for p in sorted(PLUGIN_IMGS.rglob("*.png")):
        print(f"  {p.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
