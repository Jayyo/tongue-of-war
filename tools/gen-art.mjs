// Full art regeneration: chibi miniature style, chroma-key background.
//
// Style contract is IDENTICAL across every asset (see CONTRACT_*) — a shared
// contract is the only thing that stops thirteen independent generations from
// looking like thirteen different games. Only the SUBJECT line changes.
//
// Chroma #00FF00 instead of black: the previous black-background pass needed a
// shape-based mask because rim-lit dark art fades into a dark background. A
// saturated key that appears nowhere in the palette can be removed exactly.
//
//   node tools/gen-art.mjs             everything
//   node tools/gen-art.mjs units       one group (units|structs|backdrop)
//   node tools/gen-art.mjs demon-guard one asset

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1); }

const UNIT_CONTRACT =
  'SHARED STYLE CONTRACT: original premium stylized 3D miniature dark fantasy, cute but not childish, ' +
  '2.7-head heroic chibi proportions, oversized readable hands and equipment, rounded bevels, matte hand-painted ' +
  'materials, four broad value bands, controlled detail, strong silhouette readable in two seconds, no realism, ' +
  'no painterly portrait look, no anime line art, no pixel art, no clay fingerprints. The camera is a consistent ' +
  'three-quarter tactical view, slightly above eye level. The unit faces screen-right, both feet visible, ' +
  'bottom-center foot anchor, neutral upper-left key light, no baked contact shadow. One character only, no text, ' +
  'logo, border, UI, scenery, particles, or extra props. Use a perfectly flat opaque #00FF00 chroma background.';

const STRUCT_CONTRACT =
  'SHARED STYLE CONTRACT: original premium miniature dark fantasy, cute but formidable, rounded bevels, chunky ' +
  'readable masses, matte hand-painted materials, four broad value bands, controlled surface detail, coherent with ' +
  '2.7-head chibi units, no photorealism, no painterly landscape, no gothic filigree noise, no generic primitive ' +
  'tower. Use a consistent three-quarter tactical camera from slightly above, neutral upper-left key light, no baked ' +
  'ground shadow. One isolated structure only, no units, text, logo, UI, scenery, smoke, particles, or loose debris. ' +
  'Use a perfectly flat opaque #00FF00 chroma background.';

const BG_CONTRACT =
  'SHARED STYLE CONTRACT: cute but dramatic miniature world, rounded forms, matte hand-painted rendering, four broad ' +
  'value bands, low visual noise, no photorealism, no oil-painting texture, no anime line art, no text, logo, UI, ' +
  'characters, structures, projectiles, or foreground objects. The background must remain lower in contrast and ' +
  'saturation than gameplay units. Lighting comes from the upper left. Warm muted plum and ember tones belong to the ' +
  'left Abyss side; cool desaturated teal and ivory light belong to the right Human side; the center remains neutral ' +
  'gray-gold for combat readability.';

/** @type {Record<string,{group:string,size:string,contract:string,subject:string}>} */
const ASSETS = {
  // ---------------------------------------------------------------- units
  'demon-guard': { group: 'units', size: '1024x1024', contract: UNIT_CONTRACT, subject:
    'a broad low-centered demonic shield bearer with a shield occupying roughly one third of the silhouette, short ' +
    'curved horns, charcoal armor with plum panels, restrained coral ember seams, thick gauntlets, and a blunt mace. ' +
    'The overall silhouette must be a wide rectangle. Friendly and determined expression, not grotesque. Keep the ' +
    'weapon and shield separated from the torso for later 2D rigging.' },
  'demon-raider': { group: 'units', size: '1024x1024', contract: UNIT_CONTRACT, subject:
    'a forward-leaning demonic skirmisher with a clear triangular silhouette, swept-back horns, a large diagonal ' +
    'crescent blade, asymmetrical charcoal and plum light armor, one coral scarf, compact boots, and a mischievous ' +
    'determined expression. The blade must remain unmistakable at thumbnail size.' },
  'demon-artillery': { group: 'units', size: '1024x1024', contract: UNIT_CONTRACT, subject:
    'a narrow tall demonic bombardier carrying an oversized rune mortar above and behind the shoulders, charcoal ' +
    'frame, plum robes, coral rune chamber, small curved horns, thick stabilizing boots, and large readable crank ' +
    'handles. The silhouette must clearly indicate long-range area damage without resembling the guardian.' },
  'human-guard': { group: 'units', size: '1024x1024', contract: UNIT_CONTRACT, subject:
    'a broad low-centered human tower-shield bearer with an ivory and desaturated teal shield occupying roughly one ' +
    'third of the silhouette, rounded battlements, brushed steel edges, restrained gold trim, a compact helmet, and ' +
    'a short hammer. The overall silhouette is a wide rectangle. Calm brave expression.' },
  'human-raider': { group: 'units', size: '1024x1024', contract: UNIT_CONTRACT, subject:
    'a forward-leaning human duelist with a clear triangular silhouette, oversized diagonal saber, compact ivory and ' +
    'teal leather armor, gold clasp, short trailing sash, light boots, and a confident focused expression. Avoid a ' +
    'generic medieval knight. The saber and forward pose must read at thumbnail size.' },
  'human-artillery': { group: 'units', size: '1024x1024', contract: UNIT_CONTRACT, subject:
    'a narrow tall human arcane arbalist with an oversized vertical rune arbalest mounted above and behind the ' +
    'shoulder, ivory wood, desaturated teal cloth, brushed steel, restrained gold fittings, sturdy boots, and a ' +
    'focused engineer expression. The silhouette must signal long-range fire immediately.' },

  // ---------------------------------------------------------------- structures
  'demon-core': { group: 'structs', size: '1024x1024', contract: STRUCT_CONTRACT, subject:
    'an asymmetrical but stable demonic core fortress formed from three interlocking basalt masses, rounded broken ' +
    'horn shapes, a large protected coral ember heart visible through one central opening, plum metal braces, broad ' +
    'readable entrances, thick beveled edges, and deliberate large-scale detailing. Premium fortress, not a jagged ' +
    'cone or stacked rectangles.' },
  'demon-bastion': { group: 'structs', size: '1024x1024', contract: STRUCT_CONTRACT, subject:
    'a low wide basalt bulwark with a shallow inward curve, two thick end buttresses, plum iron caps, restrained ' +
    'coral cracks protected inside recessed channels, large rounded crenellations, one clear gate seam, and layered ' +
    'stone blocks large enough to read at game scale. Avoid a plain rectangle, spike fence, or toy cube.' },
  'human-core': { group: 'structs', size: '1024x1024', contract: STRUCT_CONTRACT, subject:
    'a compact layered human citadel built around a glowing cyan crystal core, wide stable base, two offset rounded ' +
    'towers, ivory stone, desaturated teal roofs, brushed steel braces, restrained gold focal trim, one large arched ' +
    'portal, and simplified premium ornament. Avoid a tall thin cathedral, generic chess rook, or repeated boxes.' },
  'human-bastion': { group: 'structs', size: '1024x1024', contract: STRUCT_CONTRACT, subject:
    'a low wide ivory stone bulwark with a shallow inward curve, two thick end buttresses, desaturated teal metal ' +
    'caps, restrained gold trim, large rounded crenellations, one clear reinforced gate seam, and layered blocks ' +
    'large enough to read at game scale. Engineered and disciplined, not a plain rectangle or toy cube.' },

  // ---------------------------------------------------------------- backdrop
  'sky': { group: 'backdrop', size: '1536x1024', contract: BG_CONTRACT, subject:
    'an expansive overcast sky with large soft sculpted cloud masses, subtle dawn light breaking through the center, ' +
    'restrained warm glow at far left and cool blue haze at far right. High horizon, calm center, no lightning, no ' +
    'dramatic focal object. Full opaque image intended as the farthest parallax layer. NO chroma key, fully painted.' },
  'ridge': { group: 'backdrop', size: '1536x1024', contract: BG_CONTRACT, subject:
    'a single continuous distant ridge occupying only the middle third of the image height. Left side contains broad ' +
    'rounded basalt citadels and horn-like arches; right side contains compact pale towers with teal roofs; the ' +
    'center descends into a neutral ruined valley. Simplified silhouettes, atmospheric color, no tiny windows or ' +
    'sharp clutter. Use a perfectly flat opaque #00FF00 background outside the isolated ridge for later cutout.' },
  'ground': { group: 'backdrop', size: '1024x1024', contract: BG_CONTRACT, subject:
    'a SEAMLESS TILEABLE top-down ground texture: compacted dark earth and broad worn stone paths. Left third has ' +
    'subtle muted plum basalt flecks, right third has subtle desaturated teal-gray paving fragments, center is ' +
    'neutral charcoal-brown. Five extremely understated lane grooves formed by wear and embedded rune stones, ' +
    'readable only at gameplay scale and never brighter than units. No perspective, no horizon, no baked lighting, ' +
    'no shadows. Full opaque seamless texture. NO chroma key, fully painted.' },
};

const DIRS = {
  units: path.join(ROOT, 'assets', 'units', 'raw'),
  structs: path.join(ROOT, 'assets', 'structures', 'raw'),
  backdrop: path.join(ROOT, 'assets', 'backdrops', 'raw'),
};

async function gen(id) {
  const a = ASSETS[id];
  const prompt = `${a.contract}\n\nSUBJECT: ${a.subject}`;
  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, size: a.size, quality: 'high', n: 1 }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`${id}: HTTP ${res.status} ${text.slice(0, 220)}`); return false; }
  const b64 = JSON.parse(text)?.data?.[0]?.b64_json;
  if (!b64) { console.error(`${id}: empty`); return false; }
  const dir = DIRS[a.group];
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${id}.png`), Buffer.from(b64, 'base64'));
  console.log(`${id}: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return true;
}

const arg = process.argv[2];
let ids;
if (!arg) ids = Object.keys(ASSETS);
else if (DIRS[arg]) ids = Object.keys(ASSETS).filter((k) => ASSETS[k].group === arg);
else ids = [arg];

const r = await Promise.all(ids.map((id) => gen(id).catch((e) => { console.error(id, String(e).slice(0, 160)); return false; })));
console.log(`\n완료: ${r.filter(Boolean).length}/${ids.length}`);
