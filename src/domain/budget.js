// @ts-check
// The BP compiler. This is the security boundary of the whole game:
// a prompt produces a UnitIntent (enums + 0..3 priorities only), and THIS file
// is the only thing that ever turns intent into numbers. No prompt-supplied
// number ever reaches the simulation.
//
// Cost model rationale (see docs/design.md):
//  - stats multiply in combat (range x speed x dps), so linear point costs break;
//    convex costs + an explicit synergy surcharge keep min-maxing honest
//  - resistances are priced against HP so high-HP + high-resist can't stack cheaply
//  - attack cadence is a delivery style, not a purchased stat (else DPS is double-charged)

import { CFG } from '../config.js';
import { SKILLS, legalSkills, skillCost } from './skills.js';

const C = CFG.cost;

// ------------------------------------------------------------------ axis costs
export const costOf = {
  /** @param {number} totalHp */
  hp: (totalHp) => totalHp / C.hpPerBp,
  /** @param {number} totalDps */
  dps: (totalDps) => totalDps / C.dpsPerBp,
  /** @param {number} range meters */
  range: (range) => (range <= C.rangeBase ? 0 : C.rangeK * Math.pow(range - C.rangeBase, C.rangeExp)),
  /** @param {number} speed m/s */
  speed: (speed) => clamp(C.speedK * (Math.pow(speed / C.speedRef, 2) - 1), C.speedRefundCap, C.speedCostCap),
  /** @param {number} n */
  split: (n) => C.splitCost[n] ?? 0,
  /**
   * Resistance must be priced against EVERY repeatable survival pool, not just
   * base HP — otherwise a shield that refreshes gets its resistance for free.
   *   C_POOL = C_HP + C_WARD_raw
   *   C_DEF  = C_POOL * (1/(1-r̄) - 1),  r̄ = 0.5*rp + 0.5*rm
   * The 50/50 channel split is fixed on purpose: pricing against the opponent's
   * current composition would make the same blueprint cost different amounts in
   * different matches.
   * @param {number} cPool BP of all survivability pools
   * @param {number} rp physical resist
   * @param {number} rm arcane resist
   */
  defense: (cPool, rp, rm) => cPool * (1 / (1 - (0.5 * rp + 0.5 * rm)) - 1),
};

// Inverse of costOf.range / costOf.speed — used to spend a BP allowance on an axis.
const rangeFromBp = (bp) => (bp <= 0 ? C.rangeBase : C.rangeBase + Math.pow(bp / C.rangeK, 1 / C.rangeExp));
const speedFromBp = (bp) => C.speedRef * Math.sqrt(Math.max(0.35, 1 + bp / C.speedK));

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/** Extra cost for stacking multiplicative axes on one unit. */
function synergyCost(cDps, cRange, cSpeed) {
  const v = Math.max(0, cSpeed);
  return 0.01 * cDps * (cRange + v) + 0.02 * cRange * v;
}

// ------------------------------------------------------------------ intent
/**
 * @typedef {Object} UnitIntent
 * @property {'guard'|'raider'|'artillery'} role
 * @property {'elite'|'pack'|'swarm'} cohort
 * @property {'precision'|'sweep'} attackShape
 * @property {'physical'|'arcane'} damageChannel
 * @property {'compact'|'spread'} [formation]
 * @property {'steady'|'relentless'|'flexible'} [persistence]
 * @property {'physical'|'arcane'|null} [wardAgainst]
 * @property {{hp:number,damage:number,range:number,speed:number,defense:number}} priorities -3..3
 * @property {1|2|3|5} requestedCount
 * @property {string[]} skills
 * @property {'nearest'|'backline'|'highestHp'|'lowestHp'} targetPreference
 * @property {string} [flavorName]
 * @property {number} [confidence]
 */

/** Neutral priority profile per role — what the role means before the prompt speaks. */
const ROLE_BASE = {
  guard:     { hp: 3, damage: 1, range: 0, speed: 1, defense: 2 },
  raider:    { hp: 1, damage: 3, range: 0, speed: 3, defense: 0 },
  artillery: { hp: 1, damage: 2, range: 3, speed: 0, defense: 0 },
};

const CADENCE_BY_COHORT = { elite: 'crush', pack: 'balanced', swarm: 'flurry' };

/**
 * Coerce an intent to the closed shape: unknown enum values become the neutral
 * choice and priorities become finite numbers in -3..3. The parser never produces
 * anything else, but this file is the boundary, so it does not take that on trust.
 * @param {any} it
 * @returns {UnitIntent}
 */
export function normalizeIntent(it) {
  const src = it && typeof it === 'object' ? it : {};
  const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
  const level = (v) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, -3, 3) : 0);
  const p = src.priorities && typeof src.priorities === 'object' ? src.priorities : {};
  return {
    ...src,
    role: oneOf(src.role, ['guard', 'raider', 'artillery'], 'guard'),
    cohort: oneOf(src.cohort, ['elite', 'pack', 'swarm'], 'pack'),
    attackShape: oneOf(src.attackShape, ['precision', 'sweep'], 'precision'),
    damageChannel: oneOf(src.damageChannel, ['physical', 'arcane'], 'physical'),
    formation: oneOf(src.formation, ['compact', 'spread'], 'compact'),
    persistence: oneOf(src.persistence, ['steady', 'relentless', 'flexible'], 'steady'),
    wardAgainst: oneOf(src.wardAgainst, ['physical', 'arcane'], null),
    priorities: { hp: level(p.hp), damage: level(p.damage), range: level(p.range), speed: level(p.speed), defense: level(p.defense) },
    requestedCount: oneOf(src.requestedCount, C.limits.counts, 1),
    skills: Array.isArray(src.skills) ? src.skills.filter((s) => typeof s === 'string') : [],
    targetPreference: oneOf(src.targetPreference, ['nearest', 'backline', 'highestHp', 'lowestHp'], 'nearest'),
    confidence: typeof src.confidence === 'number' && Number.isFinite(src.confidence) ? clamp(src.confidence, 0, 1) : 1,
  };
}

/**
 * Compile an intent into a legal blueprint inside `bp`.
 * @param {UnitIntent} rawIntent
 * @param {number} bp
 * @param {import('./commanders.js').Commander} [commander]
 * @returns {UnitBlueprint}
 */
export function compile(rawIntent, bp, commander) {
  const intent = normalizeIntent(rawIntent);
  const role = intent.role;
  const roleCfg = CFG.roles[role];

  // ---- 1. priorities.
  // The role must NOT co-author the allocation whenever the sentence already
  // said something. Blending role base at a flat 45% is what made every
  // artillery prompt collapse onto the same HP/DPS: the role drowned the words.
  // Role identity is preserved by the hard RANGES below (hpShareMin, speedMin,
  // rangeMin...), not by pulling the weights back toward a template.
  const AXES = ['hp', 'damage', 'range', 'speed', 'defense'];
  const explicit = AXES.filter((k) => (intent.priorities?.[k] ?? 0) !== 0);
  const roleW = explicit.length ? 0.15 : 1.0;   // 15% only as a stabiliser
  const pr = {};
  for (const k of AXES) {
    const asked = clamp(intent.priorities?.[k] ?? 0, -3, 3);
    if (asked >= 0) {
      pr[k] = ROLE_BASE[role][k] * roleW + asked * (1 - roleW) * (explicit.length ? 1.35 : 1);
    } else {
      // A negative ask must DAMP the axis, not merely fail to add weight: "느린"
      // has to move budget OUT of speed and into whatever the sentence did ask for.
      pr[k] = Math.max(0, ROLE_BASE[role][k] * (1 + asked / 3) * 0.5);
    }
  }
  const bias = commander?.bias ?? {};

  // ---- 2. count
  let count = C.limits.counts.includes(intent.requestedCount) ? intent.requestedCount : 1;
  if (commander?.countShift) count = shiftCount(count, commander.countShift);
  if (commander?.countMax) count = Math.min(count, commander.countMax);
  const cSplit = costOf.split(count);

  // ---- 2b. formation. 'spread' is a real cost because it trades body-blocking
  // density for splash survivability — it must not be a free word.
  const formation = intent.formation === 'spread' ? 'spread' : 'compact';
  const cForm = CFG.cost.formationBp[formation] ?? 0;

  // ---- 3. skills (hard cap on share of budget)
  let skills = legalSkills(intent.skills ?? [], role);
  let cSkill = skillCost(skills);
  const skillCap = C.share.skillMax * bp + (bias.skill ?? 0);
  while (cSkill > skillCap && skills.length > 0) {
    skills = skills.slice(0, -1);
    cSkill = skillCost(skills);
  }

  // ---- 4. mobility axes (range + speed), capped as a pair
  let pool = bp - cSkill - cSplit - cForm;
  const mobShare = clamp((pr.range + pr.speed) / 12, 0.05, 1) * C.share.mobilityMax;
  let mobBudget = pool * mobShare + (bias.range ?? 0) + (bias.speed ?? 0);
  mobBudget = Math.min(mobBudget, C.share.mobilityMax * bp);

  const rw = pr.range + 0.001, sw = pr.speed + 0.001;
  let cRange = mobBudget * (rw / (rw + sw));
  let cSpeed = mobBudget * (sw / (rw + sw));

  let range = clamp(rangeFromBp(cRange), C.rangeBase, Math.min(C.limits.rangeMax, roleCfg.rangeMax ?? C.limits.rangeMax));
  if (roleCfg.rangeMin) range = Math.max(range, roleCfg.rangeMin);
  if (commander?.rangeMax) range = Math.min(range, commander.rangeMax);
  cRange = costOf.range(range);

  // A commander's speedMul is a penalty the sim applies at spawn (with the doctrine
  // multipliers). Applying it here as well charged it twice and priced it as a refund.
  const speed = clamp(speedFromBp(cSpeed), Math.max(C.limits.speedMin, roleCfg.speedMin ?? C.limits.speedMin),
                      Math.min(C.limits.speedMax, roleCfg.speedMax ?? C.limits.speedMax));
  cSpeed = costOf.speed(speed);

  // ---- 5. hp / dps / defense share the rest, then converge against synergy tax
  let cHp = 0, cDps = 0, cDef = 0, rp = 0, rm = 0;
  for (let iter = 0; iter < 12; iter++) {
    const cSyn = synergyCost(cDps, cRange, cSpeed);
    const rest = bp - cSkill - cSplit - cForm - cRange - cSpeed - cSyn;
    if (rest <= 0) break;

    // Defense is deliberately weak-weighted: resistance is the most efficient
    // stat per BP in a long fight, so it must be *asked for* to get much of it.
    const wHp = pr.hp + 0.2, wDps = pr.damage + 0.2, wDef = pr.defense * 0.45;
    const sum = wHp + wDps + wDef;

    cHp = rest * (wHp / sum) + (bias.hp ?? 0);
    cDps = rest * (wDps / sum) + (bias.dps ?? 0);
    cDef = rest * (wDef / sum) + (bias.defense ?? 0);

    // role + global share limits
    const hpMin = Math.max(C.share.hpMin, roleCfg.hpShareMin ?? 0) * bp;
    const hpMax = Math.min(C.share.hpMax, roleCfg.hpShareMax ?? 1) * bp;
    cHp = clamp(cHp, hpMin, hpMax);
    cDps = clamp(cDps, C.share.dpsMin * bp, C.share.dpsMax * bp);
    cDef = Math.max(0, cDef);

    // convert defense BP into resistance, priced against HP + shield pools.
    // A sentence that names a defence ("마법을 튕겨내는", "화살을 막는") tilts the
    // split; silence keeps it symmetric. Tilting is paid for by giving up the
    // other channel, so it is a real choice rather than free value.
    const pool = cHp + wardRawBp(cHp, skills);
    const r = solveResist(pool, cDef, intent.wardAgainst);
    rp = r.rp; rm = r.rm;
    cDef = costOf.defense(pool, rp, rm);

    // rebalance: if we overshot, shave dps (the most elastic axis)
    const total = cHp + cDps + cDef + cRange + cSpeed + cSkill + cSplit + cForm + synergyCost(cDps, cRange, cSpeed);
    const over = total - bp;
    if (Math.abs(over) < 0.4) break;
    if (over > 0) cDps = Math.max(C.share.dpsMin * bp, cDps - over * 0.8);
    else cDps = Math.min(C.share.dpsMax * bp, cDps - over * 0.6);
  }

  // ---- 6. final legalization. The budget is a HARD ceiling: role share minimums
  // can push the allocation over it, and shipping an over-budget unit would be
  // exactly the exploit this whole file exists to prevent.
  {
    const total0 = cHp + cDps + cDef + cRange + cSpeed + cSkill + cSplit + cForm + synergyCost(cDps, cRange, cSpeed);
    if (total0 > bp) {
      const elastic = cHp + cDps + cDef;
      const k = Math.max(0.2, (elastic - (total0 - bp)) / elastic);
      cHp *= k; cDps *= k; cDef *= k;
      const pool = cHp + wardRawBp(cHp, skills);
      const r = solveResist(pool, cDef, intent.wardAgainst);
      rp = r.rp; rm = r.rm;
      cDef = costOf.defense(pool, rp, rm);
    }
    // Resistance is capped, so a defense-heavy allocation can leave BP
    // unspent. Hand it back rather than silently burning it.
    const fixedTotal = () =>
      cHp + cDps + cDef + cRange + cSpeed + cSkill + cSplit + cForm +
      synergyCost(cDps, cRange, cSpeed);
    const slack = bp - fixedTotal();
    if (slack > 0.5) {
      const hpRoom = Math.max(0, Math.min(C.share.hpMax, roleCfg.hpShareMax ?? 1) * bp - cHp);
      // Extra HP also enlarges the pool the resist is priced against, so the
      // defense cost has to grow with it. Adding the raw slack let a resistant
      // unit take its resist on the new HP for free.
      const defFor = (hp) => costOf.defense(hp + wardRawBp(hp, skills), rp, rm);
      let lo = 0, hi = Math.min(slack, hpRoom);
      for (let i = 0; i < 24; i++) {
        const add = (lo + hi) / 2;
        if (fixedTotal() - cDef + defFor(cHp + add) + add <= bp) lo = add; else hi = add;
      }
      cHp += lo;
      cDef = defFor(cHp);
      const dpsRoom = Math.max(0, C.share.dpsMax * bp - cDps);
      if (dpsRoom > 0 && fixedTotal() < bp) {
        // DPS also raises the range/speed synergy surcharge. Adding the raw slack
        // directly overspent long-range designs (the archer compiled at 121/120BP).
        let lo = 0, hi = dpsRoom;
        for (let i = 0; i < 24; i++) {
          const add = (lo + hi) / 2;
          const total = fixedTotal() + add +
            (synergyCost(cDps + add, cRange, cSpeed) - synergyCost(cDps, cRange, cSpeed));
          if (total <= bp) lo = add; else hi = add;
        }
        cDps += lo;
      }
    }
  }

  const totalHp = cHp * C.hpPerBp;
  const totalDps = cDps * C.dpsPerBp;
  const cadence = CFG.combat.cadence[CADENCE_BY_COHORT[intent.cohort] ?? 'balanced'];

  const spent = cHp + cDps + cDef + cRange + cSpeed + cSkill + cSplit + cForm + synergyCost(cDps, cRange, cSpeed);

  // Fixed costs (an artillery range floor, two skills, a spread formation) can
  // leave nothing to shrink on the smallest ritual. Shed the last skill, then the
  // spread, and compile again rather than ship an over-budget unit.
  if (spent > bp + 0.01) {
    if (skills.length) return compile({ ...intent, skills: skills.slice(0, -1) }, bp, commander);
    if (formation === 'spread') return compile({ ...intent, formation: 'compact' }, bp, commander);
  }

  /** @type {UnitBlueprint} */
  const bpOut = {
    // epithet (from the prompt hash) + role noun (from the compiled role)
    name: [intent.flavorName, defaultName(role, intent.cohort)].filter(Boolean).join(' '),
    role,
    cohort: intent.cohort,
    count,
    channel: intent.damageChannel,
    attackShape: intent.attackShape,
    // The player's EXPLICIT target choice wins. Previously any raider was forced
    // to 'backline', so "적 탱커를 처형하는 도끼병" parsed correctly as highestHp
    // and then had that thrown away — a direct cause of "prompts don't matter".
    // The role default only applies when the sentence said nothing about targets.
    targetPreference: intent.targetPreference && intent.targetPreference !== 'nearest'
      ? intent.targetPreference
      : (roleCfg.target ?? 'nearest'),
    // per-unit stats (sim works on individuals)
    hp: totalHp / count,
    dps: totalDps / count,
    totalHp, totalDps,
    range, speed,
    resistPhysical: rp,
    resistArcane: rm,
    cadence: cadence.interval,
    cadenceLabel: cadence.label,
    formation,
    // Persistence maps straight onto how long a unit stays locked on a target.
    // Long locks kill a single elite faster but waste damage on swarms, so it is
    // genuinely two-sided and starts at 0 BP.
    persistence: intent.persistence ?? 'steady',
    targetLock: CFG.combat.targetLockByPersistence[intent.persistence ?? 'steady'] ?? CFG.combat.targetLock,
    skills,
    splash: intent.attackShape === 'sweep' || skills.includes('sweep') ? CFG.combat.sweepSecondary : 0,
    breakdown: {
      hp: r2(cHp), dps: r2(cDps), defense: r2(cDef), range: r2(cRange),
      speed: r2(cSpeed), skill: r2(cSkill), split: r2(cSplit), formation: r2(cForm),
      synergy: r2(synergyCost(cDps, cRange, cSpeed)),
      total: r2(spent), budget: bp,
    },
    confidence: intent.confidence ?? 1,
  };
  return bpOut;
}

/**
 * Solve for the symmetric resistance a defense allowance buys.
 * No channel tilt: biasing resistance toward your OWN attack channel was free
 * value — you don't get to choose what the enemy hits you with.
 * @param {number} cPool BP of HP + shield pools
 * @param {number} cDef BP allocated to defense
 */
function solveResist(cPool, cDef, wardAgainst) {
  if (cPool <= 0 || cDef <= 0) return { rp: 0, rm: 0 };
  let lo = 0, hi = C.maxResist;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (costOf.defense(cPool, mid, mid) < cDef) lo = mid; else hi = mid;
  }
  const base = lo;
  if (!wardAgainst) return { rp: base, rm: base };
  // Same total EHP, concentrated on one channel: strong against it, weak to the other.
  const tilt = C.resistTilt;
  const up = Math.min(C.maxResist, base * (1 + tilt));
  const down = Math.max(0, base * (1 - tilt));
  return wardAgainst === 'physical' ? { rp: up, rm: down } : { rp: down, rm: up };
}

/** Raw BP value of the shield pool a ward will generate over a unit's life. */
function wardRawBp(cHp, skills) {
  if (!skills.includes('ward')) return 0;
  return cHp * SKILLS.ward.params.shieldFrac * C.wardProcsRef;
}

function shiftCount(n, dir) {
  const order = C.limits.counts;
  const i = order.indexOf(n);
  return order[clamp(i + dir, 0, order.length - 1)];
}

function defaultName(role, cohort) {
  const r = { guard: '수문대', raider: '추격대', artillery: '포문대' }[role] ?? '부대';
  const c = { elite: '정예 ', pack: '', swarm: '군단 ' }[cohort] ?? '';
  return `${c}${r}`;
}

const r2 = (v) => Math.round(v * 10) / 10;

/**
 * @typedef {Object} UnitBlueprint
 * @property {string} name
 * @property {'guard'|'raider'|'artillery'} role
 * @property {string} cohort
 * @property {number} count
 * @property {'physical'|'arcane'} channel
 * @property {string} attackShape
 * @property {string} targetPreference
 * @property {number} hp per-unit
 * @property {number} dps per-unit
 * @property {number} totalHp
 * @property {number} totalDps
 * @property {number} range
 * @property {number} speed
 * @property {number} resistPhysical
 * @property {number} resistArcane
 * @property {number} cadence
 * @property {string} cadenceLabel
 * @property {string[]} skills
 * @property {number} splash
 * @property {Object} breakdown
 * @property {number} confidence
 */
