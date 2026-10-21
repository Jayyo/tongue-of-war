#!/usr/bin/env python3
"""Convert finished PNG art under assets/ into the WebP files the game loads.

The generators and slicers write PNG because it is lossless and easy to inspect.
The game ships WebP: quality 90 with lossless alpha is indistinguishable at the
size units are drawn and roughly a tenth of the bytes. Rig manifests that name
part files are rewritten to point at the .webp files. Safe to re-run.

    python3 tools/webp.py                          # everything under assets/
    python3 tools/webp.py assets/unit-parts/demon-beast
    python3 tools/webp.py --remove-png assets/portraits

`raw/` folders (generation sheets) are skipped.
"""
import json
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
QUALITY = 90


def convert(png: pathlib.Path, remove: bool) -> int:
    im = Image.open(png)
    im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
    out = png.with_suffix(".webp")
    im.save(out, "WEBP", quality=QUALITY, alpha_quality=100, method=6)
    if remove:
        png.unlink()
    return out.stat().st_size


def fix_manifest(path: pathlib.Path) -> bool:
    data = json.loads(path.read_text())
    changed = False
    for part in (data.get("parts") or {}).values():
        f = part.get("file") if isinstance(part, dict) else None
        if f and f.endswith(".png"):
            part["file"] = f[:-4] + ".webp"
            changed = True
    if changed:
        path.write_text(json.dumps(data, indent=2) + "\n")
    return changed


def main(argv: list[str]) -> None:
    remove = "--remove-png" in argv
    targets = [pathlib.Path(a) for a in argv if not a.startswith("--")] or [ROOT / "assets"]
    total_png = total_webp = 0
    for target in targets:
        files = [target] if target.is_file() else sorted(target.rglob("*.png"))
        for png in files:
            if "raw" in png.parts:
                continue
            total_png += png.stat().st_size
            total_webp += convert(png, remove)
        manifests = sorted(target.rglob("rig.json")) if target.is_dir() else []
        for m in manifests:
            if fix_manifest(m):
                print(f"manifest -> webp: {m}")
    if total_png:
        print(f"{total_png / 1e6:.1f} MB png -> {total_webp / 1e6:.1f} MB webp")


if __name__ == "__main__":
    main(sys.argv[1:])
