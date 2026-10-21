// Generate a parts sheet for a SIEGE-family unit (rigFamily: 'siege').
//
// Why a separate generator from gen-parts.mjs: the biped sheet is 11 body parts
// (head/torso/pelvis/arms/legs). A landship has no arms — it has a hull, tracks,
// a turret ring and a barrel. Forcing it through the biped cell list is exactly
// how "탱크" would end up looking like a man holding a stick.
//
// The visual lexicon (src/gen/visual-lexicon.js) is the source of truth for what
// each concept must contain; the recipes below quote it.
//
//   node tools/gen-siege-parts.mjs                  # all
//   node tools/gen-siege-parts.mjs demon-landship   # one

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'assets', 'unit-parts', 'raw');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1); }

// 3 columns x 2 rows. A siege rig needs only a few big pieces, and fewer, larger
// cells means more pixels per part at the same 1024px sheet size.
const CELLS = [
  'HULL (low wide armoured body, side view, no wheels attached)',
  'TRACK UNIT (one continuous rune-chain track assembly with road wheels, side view)',
  'TURRET (low rotating turret ring with a hatch, side view, no barrel attached)',
  'MAIN BARREL (one long siege cannon barrel, horizontal, muzzle facing screen-right)',
  'FRONT PLATE (an angled frontal armour plate / ram prow)',
  'EMPTY',
];

const CONTRACT = [
  'Create ONE image that is a VEHICLE PARTS SHEET for a 2D cut-out animation rig.',
  '',
  'LAYOUT: exactly a 3 column x 2 row grid of equally sized cells on a perfectly flat opaque #00FF00 chroma background.',
  'Each cell contains EXACTLY ONE isolated part, centred, with clear empty chroma margin around it.',
  'Parts must NOT touch, NOT overlap, NOT be connected. Do not draw grid lines, borders, labels, numbers or text.',
  '',
  `CELL ORDER, left to right then top to bottom: ${CELLS.join(' | ')}. The last cell is empty chroma.`,
  '',
  'EVERY part belongs to the SAME single vehicle: identical palette, identical material, identical wear, identical lighting.',
  'STRICT SIDE VIEW facing SCREEN-RIGHT. Parts are drawn as if the vehicle was cleanly disassembled.',
  'Draw each part slightly OVERLONG at its mounting end so joints show no gap when rotated.',
  '',
  'STYLE CONTRACT: original premium stylized 3D miniature dark fantasy, chunky readable silhouette, oversized',
  'exaggerated proportions matching a heroic-chibi miniature range, rounded bevels, matte hand-painted materials,',
  'four broad value bands, controlled detail. Neutral upper-left key light.',
  'No realism, no anime line art, no pixel art, no blueprint look. No crew, no figures, no scenery, no shadows,',
  'no particles, no muzzle flash, no smoke.',
].join(' ');

const SUBJECTS = {
  // recipe from the lexicon: rune-landship 차체, 낮은 포탑, 룬 사슬 궤도 / 검은 철·리벳, F+용광로 주황
  'demon-landship':
    'a demonic rune landship: blackened riveted iron hull with plum panel inlays, coral-ember rune seams glowing faintly, ' +
    'heavy chain-link tracks with forge-orange heat bleeding between the plates, a squat turret with a horned hatch, ' +
    'and a long soot-stained siege cannon barrel bound with iron rings.',
  // human counterpart keeps the faction anchor (ivory / desaturated teal / restrained gold)
  'human-landship':
    'a human rune landship: ivory-painted armoured hull with desaturated teal panels and restrained gold fittings, ' +
    'brushed steel rivets, engraved warding runes along the flanks, sturdy steel-link tracks with oak road wheels, ' +
    'a low turret with a domed hatch, and a long polished siege cannon barrel with a banded muzzle.',
};

async function gen(id) {
  const prompt = `${CONTRACT}\n\nVEHICLE: ${SUBJECTS[id]}`;
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
const r = [];
for (const id of ids) {                    // sequential: one 1024px sheet at a time
  r.push(await gen(id).catch((e) => { console.error(id, String(e).slice(0, 160)); return false; }));
}
console.log(`\n완료: ${r.filter(Boolean).length}/${ids.length}`);
