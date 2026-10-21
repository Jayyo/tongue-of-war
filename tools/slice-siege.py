#!/usr/bin/env python3
"""Slice a SIEGE parts sheet into individual transparent PNGs + a rig manifest.

The biped slicer assumes a strict 4x3 grid. The image model does not honour a grid
for vehicle sheets — it lays the five parts out organically — so this slicer finds
parts by CONNECTED COMPONENTS instead of by cell, then classifies them by shape.

  python3 tools/slice-siege.py demon-landship

Classification is by geometry, not by position, because the layout varies run to run:
  track  : widest, low, many circles          -> largest width/height ratio among the wide parts
  hull   : largest area, wide                 -> biggest component
  barrel : long and thin                      -> highest ratio, small area
  turret : small, low, wider than tall
  plate  : remaining (angled prow)
"""
import sys, json, pathlib
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets' / 'unit-parts' / 'raw'

def main(name):
    src = RAW / f'{name}.png'
    im = Image.open(src).convert('RGB')
    a = np.asarray(im).astype(np.int16)
    # chroma: the sheet is painted on flat #00FF00
    green = (a[:, :, 1] > 120) & (a[:, :, 0] < 120) & (a[:, :, 2] < 120)
    fg = ~green
    fg = ndimage.binary_opening(fg, np.ones((3, 3)))
    lab, n = ndimage.label(fg)
    comps = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < 2500:                       # ignore speckle
            continue
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        w, h = x1 - x0 + 1, y1 - y0 + 1
        comps.append(dict(i=i, area=len(ys), x0=int(x0), y0=int(y0), w=int(w), h=int(h),
                          ratio=w / h, fill=len(ys) / (w * h)))
    comps.sort(key=lambda c: -c['area'])
    print(f'{name}: {len(comps)} parts found')
    for c in comps:
        print(f"   area={c['area']:7d} {c['w']:4d}x{c['h']:4d} ratio={c['ratio']:.2f} fill={c['fill']:.2f}")

    if len(comps) < 4:
        print('  too few parts — sheet unusable'); return 1

    # --- classify
    named = {}
    pool = comps[:]
    # Measured on demon-landship (the first sheet the model produced):
    #   plate  area=59791 380x224 ratio=1.70 fill=0.70   <- angled prow, biggest area
    #   hull   area=56883 499x173 ratio=2.88 fill=0.66   <- widest piece
    #   track  area=56615 465x143 ratio=3.25 fill=0.85   <- HIGHEST fill (solid link belt)
    #   barrel area=31592 444x113 ratio=3.93 fill=0.63   <- highest ratio, thin
    #   turret area=28884 308x161 ratio=1.91 fill=0.58   <- what is left
    # The first pass keyed track on LOW fill and got hull/track/turret exactly wrong,
    # so the rules below are pinned to those observations instead.
    barrel = max(pool, key=lambda c: c['ratio'] / (1 + c['area'] / 40000))
    named['barrel'] = barrel; pool.remove(barrel)
    track = max(pool, key=lambda c: c['fill'] * (0.6 + min(c['ratio'], 4) / 4))
    named['track'] = track; pool.remove(track)
    hull = max(pool, key=lambda c: c['w'])
    named['hull'] = hull; pool.remove(hull)
    if pool:
        plate = max(pool, key=lambda c: c['area'])
        named['plate'] = plate; pool.remove(plate)
    if pool:
        named['turret'] = max(pool, key=lambda c: c['area'])

    out = RAW.parent / name
    out.mkdir(parents=True, exist_ok=True)
    rgba = np.dstack([np.asarray(im), (fg * 255).astype(np.uint8)])
    manifest = {'rig': 'siege', 'parts': {}}
    for key, c in named.items():
        mask = (lab == c['i'])
        sub = rgba[c['y0']:c['y0'] + c['h'], c['x0']:c['x0'] + c['w']].copy()
        sub[:, :, 3] = (mask[c['y0']:c['y0'] + c['h'], c['x0']:c['x0'] + c['w']] * 255).astype(np.uint8)
        Image.fromarray(sub, 'RGBA').save(out / f'{key}.png')
        manifest['parts'][key] = {'w': c['w'], 'h': c['h']}
        print(f'   -> {key}.png {c["w"]}x{c["h"]}')

    # Pivots are expressed as fractions of each part's own box, so the renderer can
    # scale parts without re-authoring the rig.
    manifest['pivots'] = {
        'hull':   [0.50, 0.85],   # sits on the track line
        'track':  [0.50, 0.50],
        'turret': [0.45, 0.90],   # rotates on the hull deck
        'barrel': [0.06, 0.55],   # pivots at the breech, muzzle swings
        'plate':  [0.08, 0.60],   # mounting tab on the plate's left edge
    }
    manifest['mounts'] = {
        'track':  [0.50, 1.00],
        'turret': [0.42, 0.16],
        'barrel': [0.78, 0.45],
        'plate':  [0.94, 0.70],   # hull nose: every part is drawn facing screen-right
    }
    (out / 'rig.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
    print(f'   -> rig.json')
    return 0

if __name__ == '__main__':
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else 'demon-landship'))
