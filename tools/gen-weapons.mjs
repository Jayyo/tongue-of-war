// Weapon sprites, generated SEPARATELY from the body.
//
// This is what makes a real rig possible today: the body sprite stays one piece
// (so character identity never drifts between frames), while the weapon is its
// own texture on its own bone. The renderer can then swing a mace, thrust a
// sabre, and have an archer actually draw and loose a bow, because the bow is a
// transformable object rather than pixels baked into the torso.
//
// Weapons are authored PIVOT-CENTRED and pointing RIGHT so a single rotation
// about the grip reads correctly for every attack type.

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'assets', 'weapons', 'raw');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1); }

const CONTRACT =
  'SHARED STYLE CONTRACT: original premium stylized 3D miniature dark fantasy prop, matching 2.7-head chibi ' +
  'miniature units — chunky oversized readable form, rounded bevels, matte hand-painted materials, four broad value ' +
  'bands, controlled detail, strong silhouette readable at thumbnail size. No realism, no anime line art, no pixel ' +
  'art. Neutral upper-left key light, no baked shadow. ' +
  'ORIENTATION: the object lies horizontally, its business end pointing SCREEN-RIGHT, the grip/handle at screen-LEFT, ' +
  'centred in frame with generous margin. Single object only, nothing else in frame. ' +
  'No text, logo, border, UI, hand, arm, character, scenery, particles, or effects. ' +
  'Use a perfectly flat opaque #00FF00 chroma background.';

const WEAPONS = {
  'demon-guard':     'a heavy blunt demonic mace: thick basalt head with plum iron studs and faint coral ember seams, short wrapped grip.',
  'demon-raider':    'a large curved demonic crescent blade: single wide sweeping edge, charcoal steel with a coral glowing inner edge, short plum-wrapped grip.',
  'demon-artillery': 'a demonic rune mortar tube: stubby wide-mouthed basalt barrel with plum iron bands, a coral glowing rune chamber near the base, small crank handle at the grip end.',
  'human-guard':     'a short human forge hammer: brushed steel square head with restrained gold trim, ivory-wrapped grip.',
  'human-raider':    'a slim human sabre: long slightly curved bright steel blade, teal-wrapped grip, small gold guard.',
  'human-artillery': 'a human rune arbalest bow: a compound recurve bow of ivory wood with brushed steel limbs, teal cord, restrained gold fittings, drawn string visible, grip at the centre.',
  // ammunition, drawn as the projectile itself (arcane shots are plain glowing spheres)
  'ammo-physical':   'a single stylized arrow bolt: ivory wood shaft, brushed steel head, teal fletching, pointing screen-right.',
};

async function gen(id) {
  const prompt = `${CONTRACT}\n\nSUBJECT: ${WEAPONS[id]}`;
  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '1024x1024', quality: 'high', n: 1 }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`${id}: HTTP ${res.status} ${text.slice(0, 220)}`); return false; }
  const b64 = JSON.parse(text)?.data?.[0]?.b64_json;
  if (!b64) { console.error(`${id}: empty`); return false; }
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `${id}.png`), Buffer.from(b64, 'base64'));
  console.log(`${id}: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return true;
}

const only = process.argv[2];
const ids = only ? [only] : Object.keys(WEAPONS);
const r = await Promise.all(ids.map((id) => gen(id).catch((e) => { console.error(id, String(e).slice(0, 160)); return false; })));
console.log(`\n완료: ${r.filter(Boolean).length}/${ids.length}`);
