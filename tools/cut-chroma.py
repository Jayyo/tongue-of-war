#!/usr/bin/env python3
"""Cut alpha from #00FF00 chroma-key art.

Chroma beats the previous black-background approach because the key colour does
not appear anywhere in the palette, so removal is exact instead of guessed from
luminance. Two extra steps matter:

  * DESPILL — green bounces onto the subject's edges. Without removing it the
    cutout keeps a lime fringe that is very visible over a dark battlefield.
  * SOFT MATTE — a hard threshold leaves stair-stepped edges on 1024px art that
    gets drawn at ~120px, so the mask is built from chroma *distance* and then
    lightly blurred.

    python3 tools/cut-chroma.py assets/units/raw assets/units 256
    python3 tools/cut-chroma.py assets/structures/raw assets/structures 512
"""
import sys
import pathlib
import numpy as np
from PIL import Image, ImageFilter

# key colour and how far from it still counts as background
KEY = np.array([0.0, 1.0, 0.0], dtype=np.float32)
NEAR, FAR = 0.34, 0.70   # <NEAR -> background, >FAR -> subject, ramp between
FEATHER = 1.1


def chroma_distance(rgb: np.ndarray) -> np.ndarray:
    """Distance from pure green, weighted so 'greenish but not key' survives."""
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    # how much green dominates the other two channels
    dominance = g - np.maximum(r, b)
    return 1.0 - np.clip(dominance, 0.0, 1.0)


def despill(rgb: np.ndarray, alpha: np.ndarray) -> np.ndarray:
    """Pull the green bounce out of edge pixels."""
    out = rgb.copy()
    r, g, b = out[..., 0], out[..., 1], out[..., 2]
    cap = np.maximum(r, b)
    spill = np.clip(g - cap, 0.0, 1.0)
    # only edges need it; interior is already clean
    edge = (alpha > 0.02) & (alpha < 0.995)
    out[..., 1] = np.where(edge, g - spill * 0.9, g)
    return np.clip(out, 0.0, 1.0)


def cut(src: pathlib.Path, dst_dir: pathlib.Path, size: int) -> None:
    img = Image.open(src).convert("RGB")
    rgb = np.asarray(img).astype(np.float32) / 255.0

    d = chroma_distance(rgb)
    alpha = np.clip((d - NEAR) / (FAR - NEAR), 0.0, 1.0)

    a_img = Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(FEATHER))
    alpha = np.asarray(a_img).astype(np.float32) / 255.0

    rgb = despill(rgb, alpha)
    im = Image.fromarray((np.dstack([rgb, alpha]) * 255).astype(np.uint8), mode="RGBA")

    bbox = Image.fromarray((alpha > 0.15).astype(np.uint8) * 255).getbbox()
    if bbox:
        im = im.crop(bbox)

    # square, bottom-anchored: the renderer plants the feet on the ground line
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, side - h))
    canvas = canvas.resize((size, size), Image.LANCZOS)

    dst_dir.mkdir(parents=True, exist_ok=True)
    canvas.save(dst_dir / src.name)
    print(f"{src.name}: {w}x{h} -> {size}x{size}  (fill {alpha.mean()*100:.1f}%)")


def main() -> None:
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)
    src_dir = pathlib.Path(sys.argv[1])
    dst_dir = pathlib.Path(sys.argv[2])
    size = int(sys.argv[3]) if len(sys.argv) > 3 else 256
    files = sorted(src_dir.glob("*.png"))
    if not files:
        print(f"no png in {src_dir}")
        sys.exit(1)
    for f in files:
        cut(f, dst_dir, size)


if __name__ == "__main__":
    main()
