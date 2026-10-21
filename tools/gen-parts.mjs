// Generate a CUT-OUT PARTS SHEET for one unit: every body part laid out in a
// grid on one canvas, so all parts share identical costume, palette and lighting.
//
// Generating parts one-by-one drifts (different armour, different reds). One
// sheet keeps them consistent because the model paints them in a single pass.
// The sheet is then sliced by tools/slice-parts.py into an atlas + rig manifest.
//
// Part list is chosen so the rig can play a real archer: RAISE, DRAW to the
// cheek, HOLD, and LOOSE. That needs two independent arms with elbows, which
// means upper arm and forearm are separate cells.

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'assets', 'unit-parts', 'raw');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1); }

// 4 columns x 3 rows, read left-to-right, top-to-bottom.
const CELLS = [
  'HEAD', 'TORSO', 'PELVIS', 'FRONT UPPER ARM',
  'FRONT FOREARM WITH HAND', 'BACK UPPER ARM', 'BACK FOREARM WITH HAND', 'FRONT THIGH',
  'FRONT SHIN WITH FOOT', 'BACK THIGH', 'BACK SHIN WITH FOOT', 'EMPTY',
];

const CONTRACT = [
  'Create ONE image that is a CHARACTER PARTS SHEET for a 2D cut-out animation rig.',
  '',
  'LAYOUT: exactly a 4 column x 3 row grid of equally sized cells on a perfectly flat opaque #00FF00 chroma background.',
  'Each cell contains EXACTLY ONE isolated body part, centred in its cell, with clear empty margin around it.',
  'Parts must NOT touch, NOT overlap, and must NOT be connected by any line. Do not draw grid lines, borders, labels, numbers or text.',
  '',
  `CELL ORDER, left to right then top to bottom: ${CELLS.join(', ')}. The last cell is empty chroma.`,
  '',
  'EVERY part belongs to the SAME single character: identical costume, identical palette, identical material, identical lighting.',
  'Parts are drawn in STRICT SIDE VIEW facing SCREEN-RIGHT, in a neutral relaxed pose, as if the character was cleanly',
  'separated at the joints. Each limb piece is drawn straight, not bent, so it can be rotated by the rig.',
  'Draw each limb piece slightly OVERLONG at the joint end (a rounded cap) so joints do not show gaps when rotated.',
  '',
  'STYLE CONTRACT: original premium stylized 3D miniature dark fantasy, cute but not childish, 2.7-head heroic chibi',
  'proportions, oversized readable hands, rounded bevels, matte hand-painted materials, four broad value bands,',
  'controlled detail. Neutral upper-left key light. No realism, no anime line art, no pixel art.',
  'No weapons in any cell (the weapon is a separate asset). No shadows, no particles, no effects, no scenery.',
].join(' ');

const SUBJECTS = {
  'human-artillery':
    'a human arcane arbalist / archer: ivory wood and desaturated teal cloth, brushed steel brigandine, restrained gold ' +
    'fittings, a focused engineer face with goggles pushed up, sturdy boots, gloved oversized hands.',
  'demon-artillery':
    'a demonic bombardier: charcoal frame, plum robes, coral ember trim, small curved horns, a grim focused face, ' +
    'thick stabilizing boots, clawed oversized hands.',
  'human-guard':
    'a human tower-shield bearer: ivory and desaturated teal plate, brushed steel edges, restrained gold trim, a compact ' +
    'closed helmet, calm brave face, heavy boots, armoured oversized hands.',
  'demon-guard':
    'a demonic shield bearer: charcoal armour with plum panels, coral ember seams, short curved horns, a determined ' +
    'blunt face, thick gauntlets, heavy hooved boots.',
  'human-raider':
    'a human duelist: compact ivory and teal leather armour, gold clasp, a short sash, a confident focused face, light ' +
    'boots, slim gloved hands.',
  'demon-raider':
    'a demonic skirmisher: asymmetric charcoal and plum light armour, a coral scarf, swept-back horns, a mischievous ' +
    'determined face, compact boots, clawed hands.',
  // GIANT family (rigFamily 'giant'): same 11-part biped sheet, but the rig scales it
  // with a heavier proportion table. Recipe from the visual lexicon: 살집 큰 상체 /
  // 통나무 몽둥이 / F+흙색 (demon) and 화강암·이끼 (human colossus).
  'demon-colossus':
    'a demonic colossus: a hulking brute with an enormous barrel chest and tiny legs, scarred red-black hide over ' +
    'charcoal plates, thick blunt broken horns, chains bolted across the ribs, a small sunken face, huge oversized fists.',
  'human-colossus':
    'a human-realm stone colossus: a broad granite-bodied guardian with moss in its seams, ivory and desaturated teal ' +
    'banners strapped to its shoulders, restrained gold rune plates, a blank carved face, enormous slab hands.',
};

async function gen(id) {
  const prompt = `${CONTRACT}\n\nCHARACTER: ${SUBJECTS[id]}`;
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
const ids = only ? [only] : Object.keys(SUBJECTS);
const r = await Promise.all(ids.map((id) => gen(id).catch((e) => { console.error(id, String(e).slice(0, 160)); return false; })));
console.log(`\n완료: ${r.filter(Boolean).length}/${ids.length}`);
