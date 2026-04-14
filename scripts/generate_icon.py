from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


ROOT = Path(__file__).resolve().parent.parent
PNG_PATH = ROOT / "icon.png"
ICO_PATH = ROOT / "icon.ico"

SIZE = 512
RADIUS = 112


def rounded_rectangle_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def main() -> None:
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    base = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    base_draw = ImageDraw.Draw(base)
    base_draw.rounded_rectangle(
        (18, 18, SIZE - 18, SIZE - 18),
        radius=RADIUS,
        fill=(231, 236, 244, 255),
        outline=(196, 204, 216, 255),
        width=2,
    )

    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.rounded_rectangle(
        (52, 52, SIZE - 52, SIZE - 52),
        radius=92,
        fill=(255, 255, 255, 110),
    )
    glow = glow.filter(ImageFilter.GaussianBlur(18))

    inner = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    inner_draw = ImageDraw.Draw(inner)
    inner_draw.rounded_rectangle(
        (64, 64, SIZE - 64, SIZE - 64),
        radius=86,
        fill=(210, 217, 228, 255),
        outline=(255, 255, 255, 150),
        width=2,
    )

    arrow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    arrow_draw = ImageDraw.Draw(arrow)
    shaft_left = SIZE * 0.5 - 18
    shaft_right = SIZE * 0.5 + 18
    shaft_top = 144
    shaft_bottom = 276
    arrow_draw.rounded_rectangle(
        (shaft_left, shaft_top, shaft_right, shaft_bottom),
        radius=18,
        fill=(108, 119, 136, 255),
    )
    arrow_draw.polygon(
        [
            (SIZE * 0.5, 356),
            (SIZE * 0.5 - 84, 252),
            (SIZE * 0.5 - 36, 252),
            (SIZE * 0.5 - 36, 210),
            (SIZE * 0.5 + 36, 210),
            (SIZE * 0.5 + 36, 252),
            (SIZE * 0.5 + 84, 252),
        ],
        fill=(108, 119, 136, 255),
    )

    slot = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    slot_draw = ImageDraw.Draw(slot)
    slot_draw.rounded_rectangle(
        (144, 362, SIZE - 144, 394),
        radius=16,
        fill=(108, 119, 136, 220),
    )

    detail = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    detail_draw = ImageDraw.Draw(detail)
    for offset in (116, 156, 196, 236):
        detail_draw.line(
            (offset, 112, offset + 110, 430),
            fill=(255, 255, 255, 28),
            width=3,
        )

    canvas.alpha_composite(base)
    canvas.alpha_composite(glow)
    canvas.alpha_composite(inner)
    canvas.alpha_composite(detail)
    canvas.alpha_composite(arrow)
    canvas.alpha_composite(slot)

    mask = rounded_rectangle_mask(SIZE, RADIUS)
    canvas.putalpha(mask)

    canvas.save(PNG_PATH)
    canvas.save(ICO_PATH, sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])


if __name__ == "__main__":
    main()
