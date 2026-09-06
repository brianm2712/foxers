#!/usr/bin/env python3
"""
App icons, from the Foxxers artwork.

The server and the web client have no dependencies at all. This is a
development script — it runs on a workstation when the mark changes, and its
output (the PNGs beside it) is what actually ships. Pillow is the only thing
it needs, and nothing at runtime imports it.

    python3 scripts/make-icons.py [path/to/artwork.jpg]

The source artwork sits on a grey studio background with a lot of air around
it. An icon is read at 32 pixels in a browser tab, so the mark is trimmed to
its own bounds and re-seated on the app's charcoal with a deliberate margin,
rather than being scaled down as-is.
"""
import sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

HERE = Path(__file__).resolve().parent
ICONS = HERE.parent / 'web' / 'public' / 'icons'
CHARCOAL = (0x1C, 0x1E, 0x21)

# Every size the manifest, the browser tab and iOS ask for.
SIZES = [1024, 512, 192, 180, 32]
# Fraction of the tile the mark occupies. Maskable icons are cropped to a
# circle inscribed in the square, so anything past ~0.72 risks losing an ear.
INSET = 0.68
# Corner radius as a fraction of the tile, matching the app's own cards.
RADIUS = 0.22


def trim(image):
    """The mark alone, with the studio background removed from around it."""
    rgb = image.convert('RGB')
    background = rgb.getpixel((4, 4))
    difference = ImageChops.difference(rgb, Image.new('RGB', rgb.size, background))
    mask = difference.convert('L').point(lambda v: 255 if v > 18 else 0)
    box = mask.getbbox()
    if not box:
        raise SystemExit('the artwork is a single flat colour')
    return rgb.crop(box), background


def rounded_tile(size, radius_fraction=RADIUS):
    tile = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    mask = Image.new('L', (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size * 4 - 1, size * 4 - 1],
        radius=int(size * 4 * radius_fraction), fill=255)
    tile.paste(Image.new('RGBA', (size, size), (*CHARCOAL, 255)),
               (0, 0), mask.resize((size, size), Image.LANCZOS))
    return tile


def main(source):
    mark, background = trim(Image.open(source))
    print(f'artwork {source}: mark is {mark.width}x{mark.height} on #%02X%02X%02X' % background)

    # Square the mark on its own background so scaling never distorts it.
    side = max(mark.size)
    square = Image.new('RGB', (side, side), background)
    square.paste(mark, ((side - mark.width) // 2, (side - mark.height) // 2))
    square.save(ICONS / 'foxxer.png')

    # Knock the background out so the mark can sit on the app's charcoal.
    alpha = ImageChops.difference(square, Image.new('RGB', square.size, background))
    alpha = alpha.convert('L').point(lambda v: min(255, v * 6))
    cutout = square.convert('RGBA')
    cutout.putalpha(alpha)

    for size in SIZES:
        tile = rounded_tile(size)
        inner = max(1, int(size * INSET))
        scaled = cutout.resize((inner, inner), Image.LANCZOS)
        offset = (size - inner) // 2
        tile.alpha_composite(scaled, (offset, offset))
        out = ICONS / f'icon-{size}.png'
        tile.save(out)
        print(f'  {out.name}  {size}x{size}')


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else str(ICONS / 'foxxer.png'))
