// Parts sheets for the non-human rig families: quadruped (beast) and winged (flyer).
//
// The biped sheet cannot express these: a wolf has no upper/forearm split and a
// dragon needs a wing bone. Each family gets its own cell list so the rig can move
// what actually moves — legs in a gait cycle, wings in a flap.
//
//   node tools/gen-creature-parts.mjs                    # all four
//   node tools/gen-creature-parts.mjs demon-beast        # one

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'assets', 'unit-parts', 'raw');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1); }

const FAMILY = {
  beast: {
    cells: [
      'BODY (four-legged torso, side view, no legs and no head attached)',
      'HEAD (with neck stub, side view, facing screen-right)',
      'FRONT LEG (one complete foreleg, straight, side view)',
      'HIND LEG (one complete hind leg, straight, side view)',
      'TAIL (one tail, side view)',
      'EMPTY',
    ],
    grid: '3 column x 2 row',
  },
  flyer: {
    cells: [
      'BODY (winged creature torso, side view, no wings, no head, no legs attached)',
      'HEAD (with neck, side view, facing screen-right, jaws closed)',
      'WING (ONE wing, spread open, side view)',
      'HIND LEG (one clawed leg, straight, side view)',
      'TAIL (one long tail, side view)',
      'EMPTY',
    ],
    grid: '3 column x 2 row',
  },
};

const CONTRACT = (fam) => [
  'Create ONE image that is a CREATURE PARTS SHEET for a 2D cut-out animation rig.',
  '',
  `LAYOUT: exactly a ${FAMILY[fam].grid} grid of equally sized cells on a perfectly flat opaque #00FF00 chroma background.`,
  'Each cell contains EXACTLY ONE isolated part, centred, with clear empty chroma margin around it.',
  'Parts must NOT touch, NOT overlap, NOT be connected. Do not draw grid lines, borders, labels, numbers or text.',
  '',
  `CELL ORDER, left to right then top to bottom: ${FAMILY[fam].cells.join(' | ')}. The last cell is empty chroma.`,
  '',
  'EVERY part belongs to the SAME single creature: identical hide, identical palette, identical markings, identical lighting.',
  'STRICT SIDE VIEW facing SCREEN-RIGHT, neutral relaxed pose, as if cleanly separated at the joints.',
  'Each limb is drawn STRAIGHT (not bent) and slightly OVERLONG at the joint end with a rounded cap, so the rig can rotate it without gaps.',
  '',
  'STYLE CONTRACT: original premium stylized 3D miniature dark fantasy, cute but formidable, heroic-chibi miniature',
  'proportions with an oversized head and oversized paws/claws, chunky readable silhouette, rounded bevels, matte',
  'hand-painted materials, four broad value bands, controlled detail. Neutral upper-left key light.',
  'No realism, no anime line art, no pixel art. No scenery, no shadows, no particles, no effects, no gore.',
].join(' ');

const SUBJECTS = {
  // lexicon recipe: 낮은 어깨 · 이빨·발톱 · F+은회색  /  털·가죽 갑주
  'demon-beast': ['beast',
    'a demonic hunting beast: charcoal shaggy hide with plum undertone, coral ember eyes and mouth glow, ' +
    'blackened iron collar and shoulder studs, oversized clawed paws, low forward-set shoulders, short whipping tail.'],
  'human-beast': ['beast',
    'a human-realm warhound: silver-grey shaggy hide, ivory chest fur, desaturated teal harness with restrained gold ' +
    'buckles, brushed steel muzzle guard, oversized paws, alert low-shouldered stance, plumed tail.'],
  // lexicon recipe: 큰 도마뱀 머리 · 발톱 · F+불씨 (winged raider)
  'demon-flyer': ['flyer',
    'a small demonic dragon: obsidian scales with plum membrane wings, coral ember glow along the wing struts and throat, ' +
    'blunt curved horns, oversized clawed hind legs, long tapering tail with a bladed tip.'],
  'human-flyer': ['flyer',
    'a human-realm griffon: ivory and desaturated teal feathers, brushed steel talon caps and a gold-trimmed harness, ' +
    'a hooked beak, broad feathered wings, oversized talons, long banded tail.'],
};

async function gen(id) {
  const [fam, subject] = SUBJECTS[id];
  const prompt = `${CONTRACT(fam)}\n\nCREATURE: ${subject}`;
  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: '1024x1024', quality: 'high', n: 1 }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`${id}: HTTP ${res.status} ${text.slice(0, 200)}`); return false; }
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
for (const id of ids) r.push(await gen(id).catch((e) => { console.error(id, String(e).slice(0, 160)); return false; }));
console.log(`\n완료: ${r.filter(Boolean).length}/${ids.length}`);
