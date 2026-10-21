// @ts-check
// Battlefield signals + context response claims.
//
// WHY THIS EXISTS: the single biggest risk to this game is that players find one
// optimal sentence and paste it forever — at which point natural language is
// just a slower dropdown. The fix is not to punish repetition, it is to make the
// optimal sentence CHANGE WITH THE BATTLEFIELD.
//
// A signal is a public, measurable fact about what the enemy has revealed.
// If the player's sentence names a live signal AND asks for a mechanism that
// actually answers it, the summon is discounted AND the unit really gains that
// conditional behaviour. Naming a signal that isn't live earns nothing.

import { CFG } from '../config.js';

/** @typedef {{id:string, label:string, desc:string, ratio:number, answers:string[]}} Signal */

export const SIGNAL_DEFS = {
  enemy_swarm: {
    label: '적 군단', desc: '적이 다수 개체로 밀고 있다',
    answers: ['sweep', 'cleave'],
  },
  splash_pressure: {
    label: '광역 압박', desc: '적 화력의 상당수가 광역이다',
    answers: ['spread', 'ward'],
  },
  backline_battery: {
    label: '후열 포대', desc: '적 화력이 장거리 포격에 몰려 있다',
    answers: ['leap', 'veil'],
  },
  dive_pressure: {
    label: '후열 침투', desc: '적이 우리 후열을 노리고 파고든다',
    answers: ['bulwark', 'chill'],
  },
  heavy_wall: {
    label: '중장 방벽', desc: '적이 고체력 수호자로 벽을 세웠다',
    answers: ['execute', 'sweep'],
  },
  core_pressure: {
    label: '코어 압박', desc: '전선이 우리 진영 깊숙이 밀려 있다',
    answers: ['bulwark', 'ward', 'chill'],
  },
};

/**
 * Compute which signals are live for `side` (i.e. what the ENEMY is doing to us).
 * Only reads units currently on the field — the same information the player sees.
 * @returns {Signal[]} strongest first
 */
export function computeSignals(B, side) {
  const foes = B.units.filter((u) => u.side !== side && u.hp > 0);
  const out = [];
  if (!foes.length) return out;

  const value = (u) => u.hp + u.dps * 5;
  const totalV = foes.reduce((s, u) => s + value(u), 0) || 1;
  const totalDps = foes.reduce((s, u) => s + u.dps, 0) || 1;

  const swarmV = foes.filter((u) => u.bp.count >= 3).reduce((s, u) => s + value(u), 0);
  push(out, 'enemy_swarm', Math.max(swarmV / totalV, foes.length >= 8 ? 0.5 : 0), 0.45);

  const splashDps = foes.filter((u) => u.splash > 0).reduce((s, u) => s + u.dps, 0);
  push(out, 'splash_pressure', splashDps / totalDps, 0.35);

  const rangedDps = foes.filter((u) => u.range >= 5).reduce((s, u) => s + u.dps, 0);
  push(out, 'backline_battery', rangedDps / totalDps, 0.40);

  const diveV = foes.filter((u) => u.bp.targetPreference === 'backline' || u.skills.includes('leap'))
    .reduce((s, u) => s + value(u), 0);
  push(out, 'dive_pressure', diveV / totalV, 0.25);

  const wallV = foes.filter((u) => u.role === 'guard').reduce((s, u) => s + value(u), 0);
  push(out, 'heavy_wall', wallV / totalV, 0.45);

  // core pressure: enemy centroid sitting inside our third of the field
  let wsum = 0, w = 0;
  for (const u of foes) { const v = value(u); wsum += u.x * v; w += v; }
  const centroid = wsum / (w || 1);
  const depth = side === 0 ? 1 - centroid / CFG.field.length : centroid / CFG.field.length;
  push(out, 'core_pressure', depth < 0.30 ? 1 : 0, 0.5);

  return out.sort((a, b) => b.ratio - a.ratio);
}

function push(out, id, ratio, threshold) {
  if (ratio >= threshold) {
    out.push({ id, ...SIGNAL_DEFS[id], ratio, answers: SIGNAL_DEFS[id].answers });
  }
}

// ---------------------------------------------------------------- claims
// Cause vocabulary — what the player says the ENEMY is doing.
const CAUSE_CUES = {
  enemy_swarm:      ['군단', '떼', '무리', '다수', '수많', '몰려', '벌레'],
  splash_pressure:  ['광역', '폭발', '휩쓸', '화염', '범위', '쓸어'],
  backline_battery: ['포격', '원거리', '후열', '장거리', '궁수', '사수', '포대', '뒤에서'],
  dive_pressure:    ['파고', '침투', '암살', '자객', '기습', '뚫고', '후열을'],
  heavy_wall:       ['방패', '벽', '수호', '탱커', '단단', '두꺼운', '막고', '골렘'],
  core_pressure:    ['코어', '본진', '밀려', '밀리고', '눈앞', '코앞'],
};

// Mechanism vocabulary — what the player asks THEIR unit to do about it.
const MECHANISM_CUES = {
  spread:   ['흩어', '산개', '벌려', '거리를', '떨어져', '분산'],
  cleave:   ['한꺼번', '몰린', '뭉친', '한번에', '쓸어', '베어넘'],
  sweep:    ['광역', '휩쓸', '폭발', '범위'],
  leap:     ['도약', '뛰어넘', '넘어', '건너뛰', '배후로'],
  veil:     ['은폐', '은신', '숨어', '몰래', '들키지'],
  bulwark:  ['가로막', '막아서', '몸으로', '유인', '지켜'],
  chill:    ['둔화', '늦추', '얼려', '묶어', '발을'],
  execute:  ['처형', '끝장', '마무리', '숨통'],
  ward:     ['방벽', '보호막', '버티', '견디', '둘러'],
};

/**
 * Extract at most ONE response claim from the sentence.
 * v0 rule (deliberately strict): the cause phrase and the mechanism phrase must
 * BOTH appear. Listing several signals earns nothing — you must commit to one
 * answer, which is what makes the decision interesting.
 * @param {string} text
 * @returns {{signal:string, mechanism:string, causeHit:string, mechHit:string}|null}
 */
export function extractClaim(text) {
  const t = (text || '').replace(/\s+/g, '');
  if (!t) return null;

  const causes = [];
  for (const [sig, words] of Object.entries(CAUSE_CUES)) {
    const hit = words.find((w) => t.includes(w));
    if (hit) causes.push({ sig, hit, at: t.indexOf(hit) });
  }
  if (!causes.length) return null;

  const mechs = [];
  for (const [mech, words] of Object.entries(MECHANISM_CUES)) {
    const hit = words.find((w) => t.includes(w));
    if (hit) mechs.push({ mech, hit, at: t.indexOf(hit) });
  }
  if (!mechs.length) return null;

  // Pair the cause with a mechanism that actually answers it.
  for (const c of causes) {
    const valid = SIGNAL_DEFS[c.sig].answers;
    const m = mechs.find((x) => valid.includes(x.mech));
    if (m) return { signal: c.sig, mechanism: m.mech, causeHit: c.hit, mechHit: m.hit };
  }
  return null;
}

/**
 * Verify a claim against the live battlefield.
 * @returns {{ok:boolean, reason:string, signal?:Signal, mechanism?:string}}
 */
export function verifyClaim(claim, liveSignals) {
  if (!claim) return { ok: false, reason: '' };
  const sig = liveSignals.find((s) => s.id === claim.signal);
  if (!sig) {
    return { ok: false, reason: `"${claim.causeHit}"은(는) 지금 전장에서 관측되지 않는다`, mechanism: claim.mechanism };
  }
  return { ok: true, reason: `${sig.label} 대응 확인 — ${claim.mechanism}`, signal: sig, mechanism: claim.mechanism };
}

// ---------------------------------------------------------------- similarity
/**
 * Semantic similarity of two intents. Used by the echo surcharge: rewording the
 * same tactic must NOT dodge the cost, and changing the tactic must always dodge it.
 */
export function intentSimilarity(a, b) {
  if (!a || !b) return 0;
  const eq = (x, y) => (x === y ? 1 : 0);
  const jac = (xs, ys) => {
    const A = new Set(xs), Bs = new Set(ys);
    if (!A.size && !Bs.size) return 1;
    const inter = [...A].filter((v) => Bs.has(v)).length;
    return inter / (A.size + Bs.size - inter);
  };
  const prSim = (() => {
    const keys = ['hp', 'damage', 'range', 'speed', 'defense'];
    let d = 0;
    for (const k of keys) d += Math.abs((a.priorities?.[k] ?? 0) - (b.priorities?.[k] ?? 0));
    return Math.max(0, 1 - d / 12);
  })();

  return 0.15 * eq(a.role, b.role)
    + 0.10 * eq(a.cohort, b.cohort)
    + 0.10 * eq(a.attackShape, b.attackShape)
    + 0.05 * eq(a.damageChannel, b.damageChannel)
    + 0.15 * eq(a.targetPreference, b.targetPreference)
    + 0.20 * jac(a.skills ?? [], b.skills ?? [])
    + 0.15 * prSim
    + 0.10 * eq(a.claimSignal ?? null, b.claimSignal ?? null);
}

/**
 * Echo surcharge multiplier for a new intent against recent scroll history.
 * Engraved cards never pay this — buying a slot is the intended way to repeat.
 */
export function echoMultiplier(intent, history) {
  const R = CFG.ritual;
  const recent = history.slice(-R.echoWindow);
  const n = recent.filter((h) => intentSimilarity(intent, h) >= R.echoSimilarity).length;
  return 1 + R.echoStep * Math.min(n, R.echoMaxSteps);
}


// ---------------------------------------------------------------- suggestions
/**
 * Sentence suggestions for a player who doesn't know what to write.
 *
 * These are deliberately NOT complete optimal answers. Each one names the live
 * threat and one mechanism, and leaves the rest of the sentence (unit fantasy,
 * scale, channel) blank — so taking a suggestion still requires a decision and
 * the result differs from another player's. If suggestions were full sentences
 * the game would collapse into the dropdown this design exists to avoid.
 */
const STEMS = {
  enemy_swarm:      ['뭉친 적을 한꺼번에 베어넘기는 ', '몰린 적을 휩쓰는 '],
  splash_pressure:  ['광역을 피해 흩어지는 ', '폭발을 견디는 방벽을 두른 '],
  backline_battery: ['적 후열 포대로 도약하는 ', '적 포격대를 은폐한 채 노리는 '],
  dive_pressure:    ['파고드는 적을 가로막는 ', '침투하는 적의 발을 묶는 '],
  heavy_wall:       ['적 방벽을 처형하는 ', '중장 방벽을 꿰뚫는 '],
  core_pressure:    ['코어 앞을 몸으로 막는 ', '밀려오는 적을 얼려붙이는 '],
};

/** Fantasy tails, so two players answering the same signal don't type the same line. */
const TAILS = {
  demon: ['심연의 야수 셋', '재의 군단 다섯', '피에 굶주린 광전사 셋', '역병 술사 둘'],
  human: ['강철 창병 셋', '서약한 방패병 셋', '장궁대 셋', '연금 술사 둘'],
};

/**
 * @param {any} B battle
 * @param {number} side
 * @param {'demon'|'human'} faction
 * @returns {{text:string, signal:string, label:string}[]}
 */
export function suggestPrompts(B, side, faction) {
  const live = computeSignals(B, side);
  const out = [];
  const tails = TAILS[faction] ?? TAILS.human;
  for (const sig of live.slice(0, 3)) {
    const stems = STEMS[sig.id] ?? [];
    if (!stems.length) continue;
    // deterministic per (signal, wave) so the list is stable while you read it
    const i = (sig.id.length + B.wave) % stems.length;
    const j = (sig.id.length * 3 + B.wave) % tails.length;
    out.push({ text: stems[i] + tails[j], signal: sig.id, label: sig.label });
  }
  // opening / no-threat fallback: cover the three roles so the player learns the triangle
  if (!out.length) {
    const openers = faction === 'demon'
      ? ['앞을 막아서는 두꺼운 방패 수문장 셋', '적 후열을 파고드는 날렵한 자객 셋', '멀리서 쏘아붙이는 역병 포격대 셋']
      : ['앞을 막아서는 두꺼운 방패병 셋', '적 후열을 파고드는 날렵한 척후병 셋', '멀리서 쏘아붙이는 장궁대 셋'];
    for (const t of openers) out.push({ text: t, signal: 'open', label: '개전' });
  }
  return out;
}
