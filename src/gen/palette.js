// @ts-check
// Concept palette resolution: turn a VisualIntent's `look` recipe into concrete
// tint colours the renderer can apply to existing parts.
//
// This exists because part ART is expensive (one 1024px sheet per concept, minutes
// each) while COLOUR is free. A skeleton drawn with bone-white body tint and a cold
// rune glow reads as a skeleton even on the shared biped rig — so the palette layer
// gives most of the perceived variety long before the full part library lands.
//
// Two hard rules:
//  1. The FACTION anchor is never overwritten. At least the role sigil, the health
//     bar and the rim accent stay demon-red / human-blue, because "which side is
//     that" must never depend on remembering a concept's palette.
//  2. Nothing here feeds the BP compiler. Colour cannot buy stats.

/** Material/colour vocabulary harvested from the visual lexicon's `look` recipes. */
const SWATCH = {
  // metals
  '검은 철': 0x24242c, '흑철': 0x1f1f27, '검댕 강철': 0x3a3a42, '강철': 0x9aa3b0,
  '솔질 강철': 0xa8b0bb, '광택 억제 강철': 0x767e8a, '철': 0x8b929d, '철회색': 0x6f7681,
  '녹슨 철': 0x8a5a3c, '녹슨 적갈': 0x7d4530, '주철': 0x4a4a52, '고철': 0x5b5b60,
  '은': 0xc9d1dc, '은색': 0xc9d1dc, '은회색': 0xa6aeba, '청동': 0x9c7440, '황동': 0xc09a4a,
  '구리': 0xb06a3c, '금': 0xe0b64f, '낡은 금': 0xb8974a, '왕실 금': 0xe8c661, '신성 금': 0xf0d780,
  // organics
  '뼈': 0xe6e0cc, '살': 0xc98f7a, '붉은 살': 0xb4574a, '회색 살': 0x9a9086,
  '회녹색 피부': 0x7d9468, '가죽': 0x8a6440, '피혁': 0x7c5636, '피혁 갈색': 0x7c5636,
  '털': 0x8a7458, '거친 털': 0x7a6650, '짧은 털': 0x94805f, '모피': 0x9a8464,
  '비늘': 0x5f7f6a, '얇은 비늘': 0x6f8f7a, '키틴': 0x3f3a46, '반투명 점액': 0x7fc6a8,
  '뿔': 0xd8cdb4,
  // fabrics / wood / stone
  '천': 0xb9b2c4, '검은 천': 0x2b2833, '거친 천': 0x9d96a8, '썩은 천': 0x6b6558,
  '바랜 천': 0xb2aa9c, '반투명 천': 0xcfc9d8, '그림자 천': 0x322f3c, '벨벳': 0x5a2340,
  '목재': 0x8a6338, '검은 목재': 0x3c2f26, '검은 참나무': 0x33291f, '호두나무': 0x6b4a2e,
  '주목': 0x7a5433, '현무암': 0x3a3740, '화강암': 0x8d8a90, '수정': 0x9fd8e8, '유리': 0xcfe6ef,
  '밀랍 종이': 0xe0d6b8,
  // accents & light
  '용광로 주황': 0xff7a1e, '용광로': 0xff7a1e, '용광로 틈빛': 0xff8c33, '심지 주황': 0xff9438,
  '호박색': 0xe8a83c, '호박색 심지': 0xf0b04a, '화약 호박색': 0xd99a3e, '화약': 0xa89a86,
  '불씨': 0xff6b2e, '불꽃 오라': 0xff5a24, '피색': 0xa8262a, '혈홍': 0xb02028, '피색 입': 0xa8262a,
  '냉광': 0x7fd8ff, '냉광 눈': 0x8fe0ff, '차가운 렌즈광': 0xa8dcf0, '별빛': 0xdfe8ff,
  '망령 청록': 0x6fd8c4, '회복 청록': 0x74d8b4, '독녹': 0x8fd44a, '산성 녹색': 0x9ade3c,
  '독보라': 0xa86cd8, '비술 보라': 0x9a5ad0, '자주': 0x7a3a6a, '먹색': 0x2a2730,
  '룬광': 0xb08cff, '코어광': 0xc0a0ff, '이끼': 0x6e8a4a, '이끼 녹색': 0x6e8a4a,
  '숲녹': 0x4f7a44, '병든 회녹': 0x8a9a72, '먼지 회색': 0x9a958c, '먼지색': 0x9a958c,
  '황토': 0xb8945a, '흙색': 0x8a7248, '상아': 0xefe6d2, '청회색': 0x7f8c9c, '저채도': 0x8a8794,
};
// one typo guard: the table above is hand-written, so resolve any bad literal to a neutral
for (const k of Object.keys(SWATCH)) if (typeof SWATCH[k] !== 'number') SWATCH[k] = 0x9a958c;

const FACTION_ANCHOR = { demon: 0xff4d3d, human: 0x4fb2f0 };

/** Longest-first so '검은 참나무' never resolves as '검은 철' + '나무'. */
const KEYS = Object.keys(SWATCH).sort((a, b) => b.length - a.length);

function match(text) {
  // Match longest-first (so '검은 참나무' is not read as '검은 철'), but RETURN in the
  // order the words appear: the recipe's first material is the body. '뼈·녹슨 철' must
  // give a bone body with iron gear, not the reverse.
  const found = [];
  let rest = String(text ?? '');
  for (const k of KEYS) {
    const at = rest.indexOf(k);
    if (at === -1) continue;
    found.push({ at, c: SWATCH[k] });
    rest = rest.slice(0, at) + ' '.repeat(k.length) + rest.slice(at + k.length);
  }
  return found.sort((x, y) => x.at - y.at).slice(0, 3).map((f) => f.c);
}

/**
 * @param {{look:string, accents?:string[], faction?:string, concept:string}} v VisualIntent
 * @returns {{body:number, gear:number, glow:number, anchor:number, resolved:boolean}}
 */
export function resolvePalette(v) {
  const anchor = FACTION_ANCHOR[v.faction ?? 'demon'] ?? FACTION_ANCHOR.demon;
  // the recipe reads "<materials>, F+<accent>": materials tint the body/gear,
  // the accent after F+ is the glow that sits ON TOP of the faction anchor.
  const [mats = '', accentPart = ''] = String(v.look ?? '').split('F+');
  const m = match(mats);
  const g = match(accentPart);
  const extra = (v.accents ?? []).flatMap((a) => match(a));
  const body = m[0] ?? extra[0] ?? 0x9a958c;
  const gear = m[1] ?? m[0] ?? extra[1] ?? body;
  const glow = g[0] ?? anchor;
  return { body, gear, glow, anchor, resolved: m.length > 0 || g.length > 0 };
}

/** Debug helper for the visuals harness. */
export const hex = (n) => '#' + n.toString(16).padStart(6, '0');
