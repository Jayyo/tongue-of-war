#!/usr/bin/env python3
"""Slice a quadruped/winged creature parts sheet into transparent PNGs + rig.json.

Same connected-component approach as slice-siege.py (the model does not honour the
grid), with classification tuned per family. Classification is printed with the raw
measurements so the rules can be re-pinned when a sheet comes out differently —
that is how the siege slicer got fixed.

  python3 tools/slice-creature.py demon-beast beast
  python3 tools/slice-creature.py demon-flyer flyer
"""
import sys, json, math, pathlib
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parent.parent
RAW = ROOT / 'assets' / 'unit-parts' / 'raw'

PIVOTS = {
    'beast': {'body': [0.5, 0.5], 'head': [0.15, 0.55], 'frontLeg': [0.5, 0.08],
              'hindLeg': [0.5, 0.08], 'tail': [0.08, 0.4]},
    'flyer': {'body': [0.5, 0.5], 'head': [0.15, 0.6], 'wing': [0.2, 0.85],
              'hindLeg': [0.5, 0.1], 'tail': [0.08, 0.45]},
}
MOUNTS = {
    'beast': {'head': [0.86, 0.30], 'frontLeg': [0.70, 0.80], 'hindLeg': [0.24, 0.80], 'tail': [0.06, 0.35]},
    'flyer': {'head': [0.84, 0.32], 'wing': [0.45, 0.28], 'hindLeg': [0.42, 0.82], 'tail': [0.08, 0.45]},
}

def measure(name):
    im = Image.open(RAW / f'{name}.png').convert('RGB')
    a = np.asarray(im).astype(np.int16)
    green = (a[:, :, 1] > 120) & (a[:, :, 0] < 120) & (a[:, :, 2] < 120)
    fg = ndimage.binary_opening(~green, np.ones((3, 3)))
    lab, n = ndimage.label(fg)
    comps = []
    for i in range(1, n + 1):
        ys, xs = np.where(lab == i)
        if len(ys) < 2000:
            continue
        y0, y1, x0, x1 = ys.min(), ys.max(), xs.min(), xs.max()
        w, h = x1 - x0 + 1, y1 - y0 + 1
        comps.append(dict(i=i, area=len(ys), x0=int(x0), y0=int(y0), w=int(w), h=int(h),
                          ratio=w / h, fill=len(ys) / (w * h)))
    return im, fg, lab, sorted(comps, key=lambda c: -c['area'])

def classify(fam, comps):
    pool = comps[:]
    named = {}
    if fam == 'beast':
        # Measured across demon-beast and human-beast:
        #   body : largest area
        #   legs : the two tallest (ratio well under 1)
        #   head : ratio CLOSEST to 1 (a muzzle box is roughly square: 0.82 / 0.85)
        #   tail : ratio farthest from 1 (2.07 / 2.59)
        # The first pass keyed tail on lowest fill and swapped head/tail on the human
        # sheet, where the plumed tail is denser than the head.
        named['body'] = max(pool, key=lambda c: c['area']); pool.remove(named['body'])
        # A leg is NARROW and tall (ratio 0.32-0.36 measured); the head is nearly
        # square (0.85) but can still be the tallest box on the sheet, which is how
        # the human wolf's head got picked as a leg on the previous pass.
        slim = [c for c in pool if c['ratio'] < 0.55]
        legs = sorted(slim, key=lambda c: -c['h'])[:2]
        for i, key in enumerate(['hindLeg', 'frontLeg']):
            if i < len(legs):
                named[key] = legs[i]; pool.remove(legs[i])
        if pool:
            head = min(pool, key=lambda c: abs(math.log(max(1e-3, c['ratio']))))
            named['head'] = head; pool.remove(head)
        if pool:
            named['tail'] = max(pool, key=lambda c: abs(math.log(max(1e-3, c['ratio']))))
    else:
        # wing is the biggest and widest; body next; then head, tail, leg
        # Measured on demon-flyer / human-flyer (dragon and griffon respectively):
        #   tail : LOWEST fill (0.24 / 0.29) — a spiked or banded tail barely fills its box
        #   wing : largest area (58833 / 65086)
        #   leg  : lowest ratio (0.46 / 0.51)
        #   head : of the last two, the TALLER one (0.76 vs 1.64 / 0.61 vs 1.17)
        # Shape rules borrowed from the beast sheet put the dragon's head on the tail
        # slot and its wing on the body slot, so these are pinned to the flyer sheets.
        tail = min(pool, key=lambda c: c['fill'])
        named['tail'] = tail; pool.remove(tail)
        wing = max(pool, key=lambda c: c['area'])
        named['wing'] = wing; pool.remove(wing)
        if pool:
            leg = min(pool, key=lambda c: c['ratio'])
            named['hindLeg'] = leg; pool.remove(leg)
        if pool:
            head = min(pool, key=lambda c: c['ratio'])
            named['head'] = head; pool.remove(head)
        if pool:
            named['body'] = max(pool, key=lambda c: c['area'])
    return named

def main(name, fam):
    im, fg, lab, comps = measure(name)
    print(f'{name} ({fam}): {len(comps)} parts')
    for c in comps:
        print(f"   area={c['area']:7d} {c['w']:4d}x{c['h']:4d} ratio={c['ratio']:.2f} fill={c['fill']:.2f}")
    if len(comps) < 4:
        print('  too few parts'); return 1
    named = classify(fam, comps)
    out = RAW.parent / name
    out.mkdir(parents=True, exist_ok=True)
    rgba = np.dstack([np.asarray(im), (fg * 255).astype(np.uint8)])
    manifest = {'rig': fam, 'parts': {}, 'pivots': PIVOTS[fam], 'mounts': MOUNTS[fam]}
    for key, c in named.items():
        mask = (lab == c['i'])
        sub = rgba[c['y0']:c['y0'] + c['h'], c['x0']:c['x0'] + c['w']].copy()
        sub[:, :, 3] = (mask[c['y0']:c['y0'] + c['h'], c['x0']:c['x0'] + c['w']] * 255).astype(np.uint8)
        Image.fromarray(sub, 'RGBA').save(out / f'{key}.png')
        manifest['parts'][key] = {'w': c['w'], 'h': c['h']}
        print(f'   -> {key}.png {c["w"]}x{c["h"]}')
    (out / 'rig.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
    print('   -> rig.json')
    return 0

if __name__ == '__main__':
    n = sys.argv[1] if len(sys.argv) > 1 else 'demon-beast'
    f = sys.argv[2] if len(sys.argv) > 2 else ('flyer' if 'flyer' in n else 'beast')
    sys.exit(main(n, f))
