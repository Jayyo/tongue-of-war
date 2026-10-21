// Generate the six commander portraits with gpt-image-2.
//
// The six must read as ONE SET, so everything except the character is locked:
// same framing (chest-up, 3/4 turn), same lighting scheme (neutral key + one
// coloured rim light), same miniature finish, same near-black background.
// Only the rim colour changes by faction — red for 마계, steel blue for 인간계 —
// which is also the faction colour used in the HUD, so the select screen teaches
// the colour code before the match starts.
//
//   node tools/gen-portraits.mjs            all six
//   node tools/gen-portraits.mjs lucifer    just one

import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(import.meta.dirname, '..', 'assets', 'portraits');
const KEY = process.env.OPENAI_API_KEY;
if (!KEY) { console.error('OPENAI_API_KEY 없음'); process.exit(1); }

// Locked style contract shared by all six.
const STYLE = [
  'SHARED STYLE CONTRACT: premium stylized 3D miniature dark fantasy, cute but formidable, the SAME world as chibi',
  'miniature battle units — rounded bevels, matte hand-painted materials, four broad value bands, chunky readable',
  'shapes, controlled detail. A commander portrait is seen closer than a battlefield unit, so detail density is higher,',
  'but proportions stay stylized: roughly 3.5-head heroic chibi, oversized head and hands, no realistic anatomy.',
  'Framing: chest-up bust, three-quarter turn toward camera, eyes toward viewer, head slightly off-center, eye line at',
  '38% from the top. Bottom 20% low-detail for a UI text gradient.',
  'Lighting: neutral key from upper left plus one coloured rim light carving the silhouette out of the dark.',
  'Background: deep charcoal void with faint haze and one very simple abstract architectural silhouette. No scenery',
  'detail, no floating props, no text, no logos, no border, no frame.',
  'Not photorealistic, not oil-painting portraiture, not anime line art, not pixel art, not clay fingerprints.',
  'Confident characterful expression with personality — determined, sly, weary, fanatical as fits the character.',
].join(' ');

const COMMANDERS = {
  lucifer: {
    faction: 'demon',
    prompt: `A fallen archangel sovereign as a premium stylized miniature: oversized head, pale ash skin, severe beautiful features, long black hair swept back, a thin broken halo, six small charred wing-stumps fanned behind like a crown, glossy obsidian plate with sparse antique-gold inlay, one oversized hand raised in a small commanding gesture. Regal, cold, absolutely in control. Crimson rim light.`,
  },
  abaddon: {
    faction: 'demon',
    prompt: `A plague-lord of the abyss as a premium stylized miniature: bloated rounded silhouette, oversized hunched shoulders, grave-cloth wrappings fusing into grey flesh, a half-collapsed face with two dim yellow pinpoint eyes, tiny skeletal hands and beetle husks peeking from under the robe. Grotesque but toy-like, never gory. Crimson rim light with a sickly green undertone.`,
  },
  baal: {
    faction: 'demon',
    prompt: `A siege-beast war chieftain as a premium stylized miniature: enormous rounded shoulders, tiny legs, scarred red-black hide, thick blunt horns broken at the tips, chains and iron plates bolted to the chest, ember sparks puffing from the nostrils, leaning forward mid-roar. Comically massive and genuinely dangerous. Crimson rim light going orange-white at the hottest edge.`,
  },
  smith: {
    faction: 'human',
    prompt: `A master armourer as a premium stylized miniature: broad square silhouette, oversized forearms and gloves, soot-smudged cheeks, grey hair tied under a pushed-up welding hood, heavy scorched apron over riveted steel, a big forge hammer resting on one shoulder. Unhurried and immovable, faint proud smirk. Cold steel blue rim light.`,
  },
  alchemist: {
    faction: 'human',
    prompt: `A battlefield alchemist as a premium stylized miniature: slight narrow silhouette, oversized head with a brass-and-glass respirator covering the lower face, one visible pale chemically-bleached eye, stained oilcloth coat, a bandolier of glowing violet vials across the chest, holding one vial up in an oversized gloved hand. Clinical curiosity, no warmth. Cold steel blue rim light with violet secondary.`,
  },
  headsman: {
    faction: 'human',
    prompt: `A guildmaster of assassins as a premium stylized miniature: lean compact silhouette, sharp weathered face, close-cropped grey hair, a thin scar through one eyebrow, dark high-collared coat over blackened mail, a row of slim blades across the chest, oversized relaxed empty hands. Completely still, already deciding. Narrow cold steel blue rim light.`,
  },
};

async function gen(id) {
  const c = COMMANDERS[id];
  const prompt = `${c.prompt}\n\n${STYLE}`;
  const started = Date.now();
  const res = await fetch('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-image-2',
      prompt,
      size: '1024x1024',
      quality: 'high',
      n: 1,
    }),
  });
  const text = await res.text();
  if (!res.ok) { console.error(`${id}: HTTP ${res.status} ${text.slice(0, 300)}`); return false; }
  const j = JSON.parse(text);
  const b64 = j?.data?.[0]?.b64_json;
  if (!b64) { console.error(`${id}: no image in response ${text.slice(0, 300)}`); return false; }
  await fs.mkdir(OUT, { recursive: true });
  await fs.writeFile(path.join(OUT, `${id}.png`), Buffer.from(b64, 'base64'));
  console.log(`${id}: ok (${((Date.now() - started) / 1000).toFixed(1)}s)`);
  return true;
}

const only = process.argv[2];
const ids = only ? [only] : Object.keys(COMMANDERS);
const results = await Promise.all(ids.map((id) => gen(id).catch((e) => { console.error(id, String(e).slice(0, 200)); return false; })));
console.log(`\n완료: ${results.filter(Boolean).length}/${ids.length}`);
