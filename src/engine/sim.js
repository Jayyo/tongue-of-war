// @ts-check
// Battle simulation. Fixed timestep, deterministic, zero DOM access —
// the same file runs in the browser and in Node for headless balance sweeps.
//
// TICK STRUCTURE (this is load-bearing):
//   plan -> move -> aggregate damage -> apply simultaneously -> deaths
// Reading and writing in one pass made left-hand units act on a world the
// right-hand units had not yet moved in, which produced 100%/0% mirror matches.
// Everything now plans against the same frozen state and damage lands at once,
// so a unit that dies this tick still lands the blow it had already thrown.
//
// Distance is 2D (x + lane), because a melee unit reaching across five lanes to
// focus-fire one target is what made split cohorts strictly worse than the math.

import { makeRng, hashString } from './rng.js';
import { CFG } from '../config.js';
import { SKILLS } from '../domain/skills.js';

export const SIDE = { L: 0, R: 1 };
export const other = (s) => (s === SIDE.L ? SIDE.R : SIDE.L);

let _uid = 1;

/**
 * @param {{seed?:number, players:{side:number,commander:any,isBot?:boolean}[]}} opts
 */
export function createBattle({ seed = 12345, players }) {
  return {
    t: 0, tick: 0, wave: 0, lastDt: 0.05, nextWaveAt: CFG.pacing.wave,
    seed, rng: makeRng(seed),
    over: false, winner: null, endReason: '',
    units: [], fx: [], log: [],
    structures: [
      { side: SIDE.L, kind: 'bastion', x: CFG.field.bastionAt, hp: CFG.structures.bastionHp, maxHp: CFG.structures.bastionHp, cd: 0 },
      { side: SIDE.R, kind: 'bastion', x: CFG.field.length - CFG.field.bastionAt, hp: CFG.structures.bastionHp, maxHp: CFG.structures.bastionHp, cd: 0 },
      { side: SIDE.L, kind: 'core', x: 0, hp: CFG.structures.coreHp, maxHp: CFG.structures.coreHp, cd: 0 },
      { side: SIDE.R, kind: 'core', x: CFG.field.length, hp: CFG.structures.coreHp, maxHp: CFG.structures.coreHp, cd: 0 },
    ],
    players: players.map((p) => ({
      side: p.side, commander: p.commander, isBot: !!p.isBot,
      essence: CFG.economy.start,
      pending: [], roster: [], upgrades: [],
      siegeStacks: 0, pushStreak: 0, reclaim: 0, marchStacks: 0,
      formationAnchor: null,
      frontBroken: false, frontMissingFor: 0, frontRecoverFor: 0,
      frontEstablished: false,
      frontSuccessorId: null,
      artilleryDepth: CFG.formation.roleDepth.artillery,
      totalSpent: 0, unitsLost: 0, damageToStructures: 0,
    })),
    // telemetry the balance harness reads
    stats: {
      waves: [], rawDamage: 0, effectiveDamage: 0, overkill: 0,
      crossLaneMelee: 0, wardProcs: 0, ageDeaths: 0, combatDeaths: 0,
      firstBastionHit: null, firstCoreHit: null, enteredOvertime: false,
      drainDamage: 0, combatStructureDamage: 0, engagements: [],
      attacks: [], charges: [], deaths: [], damageEvents: [],
      damageBySide: [
        { planned: 0, effective: 0, overkill: 0, shield: 0 },
        { planned: 0, effective: 0, overkill: 0, shield: 0 },
      ],
    },
  };
}

export function logMsg(B, kind, text) {
  B.log.push({ t: B.t, kind, text });
  if (B.log.length > 300) B.log.shift();
}

export const player = (B, side) => B.players.find((p) => p.side === side);
export const structOf = (B, side, kind) => B.structures.find((s) => s.side === side && s.kind === kind);

const dist2d = (a, b) => Math.hypot(a.x - b.x, (a.lane - b.lane) * CFG.field.laneSpacing);
/** Distance from a side's OWN core. */
const depthFromHome = (side, x) => (side === SIDE.L ? x : CFG.field.length - x);

// ---------------------------------------------------------------- economy
export function income(B, p) {
  let r = CFG.economy.income(B.t) * CFG.economy.incomeMul;
  if (p.essence > CFG.economy.softCap) r *= CFG.economy.overCapRate;
  return r;
}

export function queueContract(B, side, blueprint, cost) {
  const p = player(B, side);
  if (p.essence < cost) return false;
  if (B.t < (p.lockUntil ?? 0)) return false;
  p.essence -= cost;
  p.totalSpent += cost;
  // Immediate summon: the cohort materialises `manifestDelay` later, NOT on the
  // wave edge. The lock is what keeps typing speed from being production power.
  p.pending.push({ blueprint, cost, spawnAt: B.t + CFG.ritual.manifestDelay });
  p.lockUntil = B.t + CFG.ritual.commandLock;
  if (!p.roster.find((b) => b.name === blueprint.name && b.role === blueprint.role && b.count === blueprint.count)) {
    p.roster.push(blueprint);
  }
  return true;
}

// ---------------------------------------------------------------- waves
function runWave(B) {
  B.wave++;
  for (const p of B.players) {
    const mech = p.commander.mechanic ?? {};
    if (mech.id === 'reclaim' && p.reclaim >= mech.threshold) {
      p.reclaim -= mech.threshold;
      p.pending.push({ blueprint: spectreBlueprint(), cost: 0, free: true, spawnAt: B.t + CFG.ritual.manifestDelay });
      logMsg(B, sideKind(p.side), `${p.commander.name}: 파멸 회수 — 망령 편제가 무료로 출전한다`);
    }
  }

  for (const p of B.players) {
    const mech = p.commander.mechanic ?? {};
    if (mech.id === 'mark') {
      const enemies = B.units.filter((u) => u.side !== p.side && u.hp > 0);
      const byGroup = new Map();
      for (const u of enemies) {
        const score = u.bp.range * 2 + (u.bp.breakdown?.skill ?? 0);
        const prev = byGroup.get(u.group);
        if (!prev || score > prev.score) byGroup.set(u.group, { score, group: u.group });
      }
      const best = [...byGroup.values()].sort((a, b) => b.score - a.score)[0];
      if (best) { p.markedGroup = best.group; p.markUntil = B.t + mech.dur; }
    }
    if (mech.id === 'dominion') {
      const own = B.units.filter((u) => u.side === p.side && u.hp > 0);
      let best = null;
      for (const u of own) if (!best || u.contractCost > best.contractCost) best = u;
      p.anchorGroup = best ? best.group : null;
    }
  }

  updateSiege(B);
  B.stats.waves.push({ wave: B.wave, t: B.t, front: frontline(B) });
}

function spectreBlueprint() {
  return {
    name: '망령 편제', role: 'raider', cohort: 'swarm', count: 5, channel: 'arcane',
    attackShape: 'precision', targetPreference: 'nearest',
    hp: 60, dps: 9, totalHp: 300, totalDps: 45,
    range: CFG.roles.raider.rangeMin, speed: 4.2,
    resistPhysical: 0, resistArcane: 0.15, cadence: 0.4, cadenceLabel: '연타',
    skills: [], splash: 0, breakdown: { total: 80, budget: 80 }, confidence: 1,
  };
}

export function spawnCohort(B, p, bp, contractCost = 0) {
  const dir = p.side === SIDE.L ? 1 : -1;
  const baseX = p.side === SIDE.L ? CFG.field.spawnInset : CFG.field.length - CFG.field.spawnInset;
  const group = _uid++;
  const up = upgradeMul(p);
  const n = bp.count;
  // Formation is keyed by (seed, wave, cohort#-within-side) — NOT by group id —
  // so the two sides get mirrored formations. Keying on group made every mirror
  // match a different-formation match, which reads as side bias.
  p.cohortSeq = (p.cohortSeq ?? 0) + 1;
  const laneOrder = CFG.formation.lanePriority[bp.role] ?? CFG.formation.lanePriority.guard;
  const spawnDepth = CFG.formation.spawnCompression[bp.role] ?? 0;

  for (let i = 0; i < n; i++) {
    const spread = bp.formation === 'spread' || bp.skills.includes('spread');
    const formationCell = CFG.formation.xCellsBySlot[i] ?? 0;
    const formationOffset = formationCell *
      (spread ? SKILLS.spread.params.gap : CFG.formation.xCell);
    const rawX = baseX + dir * (spawnDepth + formationOffset);
    const x = p.side === SIDE.L
      ? Math.max(CFG.field.coreCollisionInset, rawX)
      : Math.min(CFG.field.length - CFG.field.coreCollisionInset, rawX);
    B.units.push({
      id: _uid++, group, slot: i, side: p.side, dir,
      cohortSeq: p.cohortSeq, formationCell, formationOffset,
      name: bp.name, role: bp.role, bp, contractCost,
      x,
      lane: laneOrder[i % laneOrder.length],
      hp: bp.hp * up.hp, maxHp: bp.hp * up.hp,
      dps: bp.dps * up.dps,
      range: bp.range, speed: bp.speed * up.speed, cadence: bp.cadence,
      channel: bp.channel,
      resistPhysical: bp.resistPhysical, resistArcane: bp.resistArcane,
      splash: bp.splash, skills: bp.skills.slice(),
      shield: bp.skills.includes('ward') ? bp.hp * up.hp * SKILLS.ward.params.shieldFrac : 0,
      shieldCd: 0, chillCd: 0, chargeCd: 0, tauntCd: 0,
      leapUsed: false,
      veil: bp.skills.includes('veil') ? SKILLS.veil.params.dur : 0,
      slowUntil: 0, slowAmt: 0, tauntedBy: null, tauntUntil: 0,
      cd: 0, engaged: false,
      target: null, lockUntil: 0,
      born: B.t, lastCombatAt: B.t,
    });
  }
  logMsg(B, sideKind(p.side), `${bp.name} ×${bp.count} 출전 (${roleLabel(bp.role)}, ${bp.cadenceLabel})`);
  return group;
}

function upgradeMul(p) {
  const m = { hp: 1, dps: 1, speed: 1, skillCd: 1 };
  for (const id of p.upgrades) {
    const d = CFG.upgrades.doctrines[id];
    if (!d) continue;
    if (d.hp) m.hp *= d.hp;
    if (d.dps) m.dps *= d.dps;
    if (d.speed) m.speed *= d.speed;
    if (d.skillCd) m.skillCd *= d.skillCd;
  }
  if (p.commander.speedMul) m.speed *= p.commander.speedMul;
  return m;
}

// ---------------------------------------------------------------- targeting
/**
 * Ranked by [lane-aware distance bucket, role preference, stable hash].
 * The hash tiebreak is per (attacker, target) pair, so two members of the same
 * cohort naturally pick different victims instead of all deleting one unit.
 */
function pickTarget(B, u, blocked = null) {
  const enemies = B.units.filter((e) =>
    e.side !== u.side && e.hp > 0 && e.veil <= 0 && !blocked?.has(e.id));
  if (!enemies.length) return { target: null, mode: 'advance' };

  if (u.tauntedBy && B.t < u.tauntUntil) {
    const t = enemies.find((e) => e.id === u.tauntedBy);
    if (t) return { target: t, mode: 'advance' };
  }

  // Home defence: only units already near their own core may answer, and only
  // enemies that are genuinely deep count. Decided HERE so movement and attack
  // can never disagree about who the target is.
  const intruder = pickDefenseTarget(B, u, enemies);
  if (intruder) return { target: intruder, mode: 'defend' };
  const p = player(B, u.side);
  if (p.markedGroup != null && B.t < (p.markUntil ?? 0)) {
    const marked = enemies.filter((e) => e.group === p.markedGroup);
    if (marked.length) return { target: rank(marked), mode: 'advance' };
  }
  return { target: rank(enemies), mode: 'advance' };

  function rank(list) {
    let best = null, bk = null;
    for (const e of list) {
      const d = dist2d(u, e);
      const k = [Math.floor(d / 2), prefRank(u, e), tie(u, e)];
      if (!bk || cmpKey(k, bk) < 0) { best = e; bk = k; }
    }
    return best;
  }
  // Tiebreak must be SIDE-INDEPENDENT. Hashing unit ids made left-side units
  // (spawned first, lower ids) draw a systematically different distribution.
  // Slot+lane fixed that, but the key was still PAIR-ORDER dependent: in a mirror
  // match the two sides evaluate the same pair in opposite order (L's s2 rating
  // R's s0, vs R's s2 rating L's s0), so they drew different tiebreaks and picked
  // different victims — measured at t=9.00s on the 5-member swarm. Sorting the two
  // keys makes the hash symmetric while still separating cohort members, because
  // the attacker's own key is part of every pair it forms.
  // The key must also be INTEGER-ONLY. `lane` drifts as a float (steering,
  // spacing), and mirrored sides cannot hold bit-identical floats forever —
  // `(60-x)-d` and `60-(x+d)` differ in the last bits. Feeding that into a hash
  // amplifies a 1e-15 drift into a completely different tiebreak, which is how a
  // 5-member cohort ended up picking different victims at t=9.00s.
  function tie(a, b) {
    const lo = Math.min(a.slot, b.slot), hi = Math.max(a.slot, b.slot);
    return hashString(`${B.seed}:${lo}|${hi}`) / 4294967296;
  }
}

/** @returns the deepest intruder this unit is allowed to turn back for, or null. */
function pickDefenseTarget(B, u, enemies) {
  if (depthFromHome(u.side, u.x) > CFG.field.defenseResponderRadius) return null;
  let best = null, bestDepth = Infinity;
  for (const e of enemies) {
    const d = depthFromHome(u.side, e.x);
    if (d > CFG.field.defenseThreatRadius) continue;
    if (d < bestDepth || (d === bestDepth && best && dist2d(u, e) < dist2d(u, best))) {
      best = e; bestDepth = d;
    }
  }
  return best;
}

function prefRank(u, e) {
  const pref = u.bp.targetPreference;
  if (pref === 'backline') {
    // deepest enemy first (furthest from our own core)
    const depth = u.side === SIDE.L ? e.x : CFG.field.length - e.x;
    return 1 - depth / CFG.field.length;
  }
  if (pref === 'highestHp') return 1 - e.maxHp / 3000;
  if (pref === 'lowestHp') return e.hp / Math.max(1, e.maxHp);
  return 0.5;
}

function cmpKey(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ---------------------------------------------------------------- damage
export function damageMultiplier(B, src, tgt, opts = {}) {
  let mult = 1;
  const reasons = [];
  const sp = player(B, src.side);
  const mech = sp.commander.mechanic ?? {};

  if (!opts.isStructure) {
    const rc = CFG.combat.roleCounter[src.role]?.[tgt.role] ?? 1;
    if (rc !== 1) { mult *= rc; reasons.push(`${roleLabel(src.role)}→${roleLabel(tgt.role)} ×${rc}`); }

    const resist = src.channel === 'physical' ? tgt.resistPhysical : tgt.resistArcane;
    if (resist > 0) { mult *= 1 - resist; reasons.push(`저항 -${Math.round(resist * 100)}%`); }

    if (src.skills.includes('execute') && tgt.hp / tgt.maxHp <= SKILLS.execute.params.threshold) {
      mult *= 1 + SKILLS.execute.params.bonus; reasons.push('처형');
    }
    if (mech.id === 'mark' && tgt.group === sp.markedGroup && B.t < (sp.markUntil ?? 0)) {
      mult *= 1 + mech.dmgBonus; reasons.push('표식');
    }
    const homeX = tgt.side === SIDE.L ? 0 : CFG.field.length;
    if (Math.abs(tgt.x - homeX) <= CFG.structures.homeDefenseRadius) {
      const S = CFG.structures;
      const fade = B.t <= S.homeDefenseFadeFrom ? 1
        : B.t >= S.homeDefenseFadeTo ? 0
        : 1 - (B.t - S.homeDefenseFadeFrom) / (S.homeDefenseFadeTo - S.homeDefenseFadeFrom);
      const red = S.homeDefenseMax * fade;
      if (red > 0.001) { mult *= 1 - red; reasons.push(`본진 방어 -${Math.round(red * 100)}%`); }
    }
    mult = Math.min(mult, CFG.combat.counterCap);
    mult *= CFG.combat.unitDamageMul;
    // Pressure stacks sit OUTSIDE the counter cap on purpose: they are the
    // anti-stalemate lever, not a counter.
    mult *= 1 + sp.siegeStacks * CFG.siege.unitPerStack;
  }

  if (mech.id === 'bloodmarch' && sp.marchStacks > 0) {
    const per = opts.isStructure ? mech.structPerStack : mech.perStack;
    mult *= 1 + per * sp.marchStacks;
  }
  if (opts.isStructure) {
    let sm = CFG.structures.structMul(B.t);
    if (B.t >= CFG.pacing.overtimeAt) sm = CFG.pacing.overtimeStructMul;
    mult *= sm * (1 + sp.siegeStacks * CFG.siege.structPerStack);
  }
  return { mult, reasons };
}

// ---------------------------------------------------------------- formation + reservations
/**
 * Formation state is derived from the previous tick, then committed for both
 * sides together. No unit can observe a half-updated anchor/frontBroken state.
 */
function updateFormationStates(B, live, dt) {
  const planned = B.players.map((p) => planFormationState(p, live, dt));
  for (const { p, next } of planned) Object.assign(p, next);
  return new Map(planned.map(({ p, own, guards, raiders, artillery }) => [p.side, {
    anchor: p.formationAnchor,
    broken: p.frontBroken,
    successorId: p.frontSuccessorId,
    artilleryDepth: p.artilleryDepth,
    hasGuard: guards.length > 0,
    hasRaider: raiders.length > 0,
    own,
  }]));

  function planFormationState(p, all, stepDt) {
    const F = CFG.formation;
    const dir = p.side === SIDE.L ? 1 : -1;
    const own = all.filter((u) => u.side === p.side);
    const guards = own.filter((u) => u.role === 'guard');
    const raiders = own.filter((u) => u.role === 'raider');
    const artillery = own.filter((u) => u.role === 'artillery');

    const covered = artillery.length === 0 || artillery.every((a) =>
      guards.some((g) => (g.x - a.x) * dir >= F.frontBroken.guardLead));
    const established = p.frontEstablished ||
      (artillery.length > 0 && guards.length > 0 && covered);
    let missing = covered || !established ? 0 : p.frontMissingFor + stepDt;
    let recovering = p.frontBroken && covered ? p.frontRecoverFor + stepDt : 0;
    let broken = p.frontBroken;
    if (!broken && missing >= F.frontBroken.confirm) broken = true;
    if (broken && recovering >= F.frontBroken.recoverConfirm) {
      broken = false;
      missing = 0;
      recovering = 0;
    }
    if (!artillery.length) {
      broken = false;
      missing = 0;
      recovering = 0;
    }

    let successor = null;
    if (broken && raiders.length) {
      const artilleryX = artillery.length
        ? median(artillery.map((u) => u.x))
        : (Number.isFinite(p.formationAnchor) ? p.formationAnchor : median(raiders.map((u) => u.x)));
      successor = [...raiders].sort((a, b) =>
        Math.abs(a.x - artilleryX) - Math.abs(b.x - artilleryX) || unitOrder(a, b))[0];
    }

    let anchor = p.formationAnchor;
    if (guards.length) {
      anchor = median(guards.map((u) => u.x - dir * u.formationOffset));
    } else if (successor) {
      anchor = successor.x - dir * successor.formationOffset;
    } else if (!Number.isFinite(anchor) && raiders.length) {
      anchor = median(raiders.map((u) =>
        u.x - dir * u.formationOffset + dir * F.roleDepth.raider));
    } else if (!Number.isFinite(anchor) && artillery.length) {
      anchor = median(artillery.map((u) =>
        u.x - dir * u.formationOffset + dir * F.roleDepth.artillery));
    }

    const depthGoal = broken && successor
      ? F.frontBroken.advancedDepth
      : F.roleDepth.artillery;
    const artilleryDepth = approach(
      p.artilleryDepth ?? F.roleDepth.artillery,
      depthGoal,
      F.frontBroken.anchorAdvanceSpeed * stepDt,
    );

    return {
      p, own, guards, raiders, artillery,
      next: {
        formationAnchor: anchor,
        frontBroken: broken,
        frontMissingFor: missing,
        frontRecoverFor: recovering,
        frontEstablished: established,
        frontSuccessorId: successor?.id ?? null,
        artilleryDepth,
      },
    };
  }
}

/**
 * Reserve melee targets from the frozen tick. Capacity is updated only in this
 * local map; unit.target is committed later, after every unit has planned.
 */
function planTargets(B, live) {
  const plans = new Map();
  for (const side of [SIDE.L, SIDE.R]) {
    const counts = new Map();
    const own = live.filter((u) => u.side === side).sort(unitOrder);
    for (const u of own) {
      const melee = u.role !== 'artillery';
      const blocked = melee
        ? new Set([...counts].filter(([, n]) => n >= CFG.formation.meleeSlots).map(([id]) => id))
        : null;
      const oldValid = u.target && u.target.hp > 0 && u.target.side !== u.side &&
        u.target.veil <= 0 && !blocked?.has(u.target.id);
      let picked;
      if (oldValid && B.t < u.lockUntil) {
        picked = { target: u.target, mode: u.mode ?? 'advance' };
      } else {
        picked = pickTarget(B, u, blocked);
      }
      if (melee && picked.target) {
        counts.set(picked.target.id, (counts.get(picked.target.id) ?? 0) + 1);
      }
      const waitTarget = melee && !picked.target ? pickTarget(B, u).target : null;
      const changed = picked.target !== u.target || picked.mode !== u.mode;
      plans.set(u.id, {
        target: picked.target,
        waitTarget,
        mode: picked.mode,
        lockUntil: changed
          ? B.t + (picked.mode === 'defend'
            ? CFG.combat.defenseTargetLock
            : (u.bp.targetLock ?? CFG.combat.targetLock))
          : u.lockUntil,
      });
    }
  }
  return plans;
}

/** Five melee bodies may occupy a structure; ranged units are not slot-limited. */
function planStructureSlots(B, live, targetPlans) {
  const allowed = new Set();
  for (const side of [SIDE.L, SIDE.R]) {
    const structTarget = structOf(B, other(side), 'bastion')?.hp > 0
      ? structOf(B, other(side), 'bastion')
      : structOf(B, other(side), 'core');
    const candidates = live
      .filter((u) => u.side === side && u.role !== 'artillery' &&
        !targetPlans.get(u.id)?.target && !targetPlans.get(u.id)?.waitTarget)
      .sort((a, b) =>
        Math.abs(a.x - structTarget.x) - Math.abs(b.x - structTarget.x) || unitOrder(a, b));
    for (const u of candidates.slice(0, CFG.formation.structureMeleeSlots)) allowed.add(u.id);
  }
  return allowed;
}

function unitOrder(a, b) {
  return (a.cohortSeq ?? 0) - (b.cohortSeq ?? 0) || a.slot - b.slot;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function approach(value, goal, maxStep) {
  if (value === goal) return value;
  return value + Math.sign(goal - value) * Math.min(Math.abs(goal - value), maxStep);
}

// ---------------------------------------------------------------- main step
export function step(B, dt) {
  if (B.over) return;
  B.lastDt = dt;
  B.t += dt;
  B.tick++;
  if (B.t >= CFG.pacing.overtimeAt) B.stats.enteredOvertime = true;

  for (const p of B.players) p.essence = Math.min(CFG.economy.softCap * 2, p.essence + income(B, p) * dt);

  if (B.t >= B.nextWaveAt) {
    B.nextWaveAt += CFG.pacing.wave;
    runWave(B);
  }

  // Cohorts materialise on their own clock, not the wave edge.
  for (const p of B.players) {
    if (!p.pending.length) continue;
    const due = p.pending.filter((c) => B.t >= c.spawnAt);
    if (!due.length) continue;
    p.pending = p.pending.filter((c) => B.t < c.spawnAt);
    for (const c of due) spawnCohort(B, p, c.blueprint, c.cost);
    updateSiege(B);
  }

  for (const p of B.players) {
    const mech = p.commander.mechanic ?? {};
    if (mech.id !== 'bloodmarch') continue;
    const own = B.units.filter((u) => u.side === p.side && u.hp > 0);
    const past = own.filter((u) => (p.side === SIDE.L ? u.x > CFG.field.length / 2 : u.x < CFG.field.length / 2));
    p.marchStacks = past.length && past.length >= own.length * 0.34
      ? Math.min(mech.maxStacks, p.marchStacks + dt) : 0;
  }

  // ---- PHASE 0: advance every per-unit timer BEFORE anyone plans.
  // Decaying timers inside planUnit broke the frozen-state promise: on the tick
  // a veil expired, units processed earlier in the array had already dropped
  // their veil (so they were targetable) while later units still read the old
  // value — measured as 12/12 mirror asymmetry on the veiled cohort at t=16s,
  // exactly the tick veil runs out.
  const live = B.units.filter((u) => u.hp > 0);
  for (const u of live) tickTimers(u, dt);
  for (const u of live) tickSkillState(B, u);

  // Formation transitions and melee reservations are both calculated from the
  // same frozen tick. Neither pass mutates unit position or target state.
  const formationBySide = updateFormationStates(B, live, dt);
  const targetPlans = planTargets(B, live);
  const structureSlots = planStructureSlots(B, live, targetPlans);

  // ---- PHASE 1: plan against frozen state
  /** @type {{u:any, kind:string, target?:any, amount?:number, nextX?:number}[]} */
  const plans = [];
  for (const u of live) {
    plans.push(planUnit(
      B, u, dt,
      targetPlans.get(u.id),
      formationBySide.get(u.side),
      structureSlots.has(u.id),
    ));
  }

  // ---- PHASE 2: movement (all at once, so nobody reacts to a half-moved world)
  for (const pl of plans) {
    pl.u.target = pl.targetState.target;
    pl.u.mode = pl.targetState.mode;
    pl.u.lockUntil = pl.targetState.lockUntil;
    if (pl.nextX != null) pl.u.x = snapPosition(pl.nextX);
    if (pl.nextLane != null) pl.u.lane = pl.nextLane;
    if (pl.leap) {
      pl.u.leapUsed = true;
      B.fx.push({ type: 'leap', x: pl.u.x, lane: pl.u.lane, t: B.t });
    }
    if (pl.charge) {
      pl.u.chargeCd = SKILLS.charge.params.cd;
      B.stats.charges.push({ t: B.t, side: pl.u.side, unitId: pl.u.id, group: pl.u.group });
      B.fx.push({ type: 'leap', x: pl.u.x, lane: pl.u.lane, t: B.t });
    }
  }

  // ---- PHASE 3: aggregate damage, then apply
  /** @type {Map<any, number>} */
  const incoming = new Map();
  for (const pl of plans) {
    if (pl.kind === 'attack') {
      for (const [tgt, amt] of pl.hits) {
        const inc = incoming.get(tgt) ?? { amount: 0, side: pl.u.side, cause: 'combat' };
        inc.amount += amt;
        incoming.set(tgt, inc);
      }
      if (pl.reveal) pl.u.veil = 0;                       // deferred from phase 1
      for (const [tgt, until, amt] of pl.slows) {
        if (until > tgt.slowUntil) { tgt.slowUntil = until; tgt.slowAmt = amt; }
      }
    } else if (pl.kind === 'struct') {
      const inc = incoming.get(pl.target) ?? { amount: 0, side: pl.u.side, cause: 'combat' };
      inc.amount += pl.amount;
      incoming.set(pl.target, inc);
      player(B, pl.u.side).damageToStructures += pl.amount;
      B.stats.combatStructureDamage += pl.amount;
      if (pl.target.kind === 'bastion' && B.stats.firstBastionHit == null) B.stats.firstBastionHit = B.t;
      if (pl.target.kind === 'core' && B.stats.firstCoreHit == null) B.stats.firstCoreHit = B.t;
    }
  }
  for (const [tgt, inc] of incoming) applyDamage(B, tgt, inc.amount, inc.side, inc.cause);

  stepBastions(B, dt, incoming);

  // ---- PHASE 4: aging, deaths, cleanup
  applyAging(B, dt);
  reapDeaths(B);
  if (B.tick % 5 === 0) B.units = B.units.filter((u) => u.hp > 0);
  B.fx = B.fx.filter((f) => B.t - f.t < (f.dur ?? 0.6) + 0.25);

  if (B.t >= CFG.pacing.overtimeAt) {
    for (const s of B.structures) {
      if (s.kind === 'core' && s.hp > 0) {
        const d = s.maxHp * CFG.pacing.overtimeCoreDrain * dt;
        s.hp -= d;
        B.stats.drainDamage += d;
      }
    }
  }
  checkEnd(B);
}

/** PHASE 0a — pure timer decay. Must run for ALL units before anyone plans. */
function tickTimers(u, dt) {
  u.cd -= dt;
  if (u.veil > 0) u.veil -= dt;
  if (u.shieldCd > 0) u.shieldCd -= dt;
  if (u.chargeCd > 0) u.chargeCd -= dt;
  if (u.tauntCd > 0) u.tauntCd -= dt;
  if (u.chillCd > 0) u.chillCd -= dt;
}

/** PHASE 0b — skill state that must be settled before targets are picked. */
function tickSkillState(B, u) {
  const upg = upgradeMul(player(B, u.side));

  // ward: only refreshes after the post-break cooldown, never mid-fight for free
  if (u.skills.includes('ward') && u.shield <= 0 && u.shieldCd <= 0) {
    u.shield = u.maxHp * SKILLS.ward.params.shieldFrac;
    u.shieldCd = SKILLS.ward.params.cd * upg.skillCd;
    B.stats.wardProcs++;
  }

  if (u.skills.includes('bulwark') && u.tauntCd <= 0) {
    const r = SKILLS.bulwark.params.radius;
    const victims = B.units.filter((e) => e.side !== u.side && e.hp > 0 && e.role === 'raider' && dist2d(e, u) <= r);
    if (victims.length) {
      for (const v of victims) { v.tauntedBy = u.id; v.tauntUntil = B.t + SKILLS.bulwark.params.dur; }
      u.tauntCd = SKILLS.bulwark.params.cd * upg.skillCd;
      B.fx.push({ type: 'taunt', x: u.x, lane: u.lane, t: B.t });
    }
  }
}

function planUnit(B, u, dt, targetState, formation, structureAllowed) {
  const p = player(B, u.side);
  const upg = upgradeMul(p);
  const finish = (plan) => ({ ...plan, targetState });

  const enemyBastion = structOf(B, other(u.side), 'bastion');
  const enemyCore = structOf(B, other(u.side), 'core');
  const structTarget = enemyBastion && enemyBastion.hp > 0 ? enemyBastion : enemyCore;

  const tgt = targetState.target;
  const dTgt = tgt ? dist2d(u, tgt) : Infinity;
  const dStruct = Math.abs(structTarget.x - u.x);

  // Leap position is deferred to PHASE 2. Moving here would let later units
  // choose targets against a half-moved world.
  if (u.skills.includes('leap') && !u.leapUsed && tgt && dTgt > u.range * 1.5) {
    const enemies = B.units.filter((e) => e.side !== u.side && e.hp > 0);
    if (enemies.length >= 2) {
      const deepest = u.side === SIDE.L
        ? enemies.reduce((a, b) => (b.x > a.x ? b : a))
        : enemies.reduce((a, b) => (b.x < a.x ? b : a));
      return finish({
        u, kind: 'move', leap: true,
        nextX: clampToStruct(u, deepest.x + u.dir * SKILLS.leap.params.behind, structTarget),
        nextLane: deepest.lane,
      });
    }
  }

  const artilleryBand = CFG.formation.artilleryPreferred;
  if (u.role === 'artillery' && tgt && dTgt <= u.range &&
      ((dTgt > artilleryBand.max) ||
       (dTgt < artilleryBand.softMin && formation?.broken &&
        !formation?.hasGuard && !formation?.hasRaider))) {
    return finish({
      u, kind: 'move',
      ...computeArtilleryReposition(B, u, dt, tgt, structTarget, formation, dTgt),
    });
  }

  if (tgt && dTgt <= u.range) {
    // wind-up: entering a fight costs half a cadence, so a slow heavy hitter
    // does not get a free opening blow the moment contact happens
    if (!u.engaged) {
      u.engaged = true;
      u.cd = Math.max(
        u.cd,
        u.cadence * (CFG.combat.engageWindupMul[u.role] ?? 0.5) +
          CFG.combat.engageFixedDelay,
      );
    }
    if (u.cd > 0) {
      return finish({
        u, kind: 'idle',
        ...computeAttackReflow(B, u, dt, formation, structTarget),
      });
    }
    u.cd = u.cadence * dominionSpeed(B, u);
    u.lastCombatAt = B.t;
    u.firstAttackAt ??= B.t;
    // stamped for the renderer: procedural lunge/recoil needs to know WHEN and
    // WHICH WAY, which is far cheaper than authoring attack frames per unit
    u.lastAttackAt = B.t;
    u.attackDir = Math.sign(tgt.x - u.x) || u.dir;
    if (u.range <= 2 && u.lane !== tgt.lane) B.stats.crossLaneMelee++;
    // `reveal` and `slows` are DEFERRED to phase 3: mutating them here would let
    // units planned later in the array see a half-updated world (a revealed
    // attacker they may now target, a target already slowed this very tick).
    const slows = [];
    const hits = buildHits(B, u, tgt, upg, slows);
    B.stats.attacks.push({
      t: B.t, side: u.side, unitId: u.id, group: u.group,
      targetId: tgt.id, range: u.range, distance: dTgt,
    });
    return finish({
      u, kind: 'attack', hits, slows, reveal: u.veil > 0,
      ...computeAttackReflow(B, u, dt, formation, structTarget),
    });
  }

  const canUseStructure = u.role === 'artillery' || structureAllowed;
  if (!targetState.waitTarget && canUseStructure && dStruct <= u.range) {
    if (!u.engaged) {
      u.engaged = true;
      u.cd = Math.max(
        u.cd,
        u.cadence * (CFG.combat.engageWindupMul[u.role] ?? 0.5) +
          CFG.combat.engageFixedDelay,
      );
    }
    if (u.cd > 0) {
      return finish({
        u, kind: 'idle',
        ...computeAttackReflow(B, u, dt, formation, structTarget),
      });
    }
    u.cd = u.cadence * dominionSpeed(B, u);
    u.lastCombatAt = B.t;
    u.lastAttackAt = B.t;
    u.attackDir = u.dir;
    const raw = u.dps * u.cadence;
    const { mult } = damageMultiplier(B, u, structTarget, { isStructure: true });
    B.fx.push({ type: 'corehit', x: structTarget.x, side: structTarget.side, t: B.t });
    return finish({
      u, kind: 'struct', target: structTarget,
      amount: raw * mult * CFG.combat.coreDamageMul,
      ...computeAttackReflow(B, u, dt, formation, structTarget),
    });
  }

  u.engaged = false;
  if (targetState.waitTarget) {
    return finish({
      u, kind: 'move',
      ...computeMeleeWait(B, u, dt, targetState.waitTarget, structTarget),
    });
  }
  if (!tgt && u.role !== 'artillery' && !structureAllowed) {
    return finish({
      u, kind: 'move',
      ...computeFormationHold(B, u, dt, formation, structTarget),
    });
  }
  return finish({
    u, kind: 'move',
    ...computeMove(B, u, dt, tgt, structTarget, targetState.mode, formation),
  });
}

function buildHits(B, u, tgt, upg, slows) {
  /** @type {[any, number][]} */
  const hits = [];
  let cohortDps = u.dps;
  const retention = CFG.combat.cohortDpsRetention;
  if (retention > 0 && u.bp.count > 1) {
    const alive = B.units.filter((e) => e.group === u.group && e.hp > 0).length;
    const fallen = Math.max(0, u.bp.count - alive);
    cohortDps *= 1 + retention * fallen / Math.max(1, alive);
  }
  cohortDps *= 1 + CFG.combat.woundedDpsBonus *
    (1 - Math.max(0, u.hp) / Math.max(1, u.maxHp));
  const raw = cohortDps * u.cadence;
  const { mult, reasons } = damageMultiplier(B, u, tgt);
  hits.push([tgt, raw * mult]);
  B.stats.rawDamage += raw;

  let splashing = u.splash > 0;
  if (!splashing && u.skills.includes('cleave')) {
    const P = SKILLS.cleave.params;
    const clumped = B.units.filter((e) => e.side !== u.side && e.hp > 0 && dist2d(e, tgt) <= P.radius).length;
    splashing = clumped >= P.need;
  }
  if (splashing) {
    // Secondary targets are chosen by DISTANCE, not array order — array order is
    // spawn order, which is side-dependent.
    const near = B.units
      .filter((e) => e.side !== u.side && e.hp > 0 && e !== tgt && dist2d(e, tgt) <= 1.8)
      .sort((a, b) => dist2d(a, tgt) - dist2d(b, tgt) || a.slot - b.slot)
      .slice(0, CFG.combat.sweepMaxTargets);
    for (const e of near) {
      const mit = e.skills.includes('spread') ? 1 - SKILLS.spread.params.splashReduction : 1;
      const m2 = damageMultiplier(B, u, e).mult;
      hits.push([e, raw * CFG.combat.sweepSecondary * m2 * mit]);
    }
  }
  if (u.skills.includes('chill') && u.chillCd <= 0) {
    slows.push([tgt, B.t + SKILLS.chill.params.dur, SKILLS.chill.params.slow]);
    u.chillCd = SKILLS.chill.params.cd * upg.skillCd;
  }
  // Ranged attacks emit a projectile so the player can SEE who is shooting whom.
  // Melee (range <= 2m) stays a contact flash — a projectile there would be noise.
  if (u.range > 2) {
    const projectile = CFG.render.projectile;
    const flight = projectile.baseFlight + dist2d(u, tgt) * projectile.perMeter;
    B.fx.push({
      type: 'shot', t: B.t,
      x: u.x, lane: u.lane, tx: tgt.x, tlane: tgt.lane,
      channel: u.channel, arc: u.splash > 0 || u.skills.includes('cleave'),
      dur: Math.max(projectile.minFlight, Math.min(projectile.maxFlight, flight)),
    });
  }
  B.fx.push({ type: 'hit', x: tgt.x, lane: tgt.lane, t: B.t });
  if (reasons.length && tgt.hp - hits[0][1] <= 0) {
    logMsg(B, sideKind(u.side), `${u.name} → ${tgt.name} 격파 (${reasons.join(', ')})`);
  }
  return hits;
}

/** Applies damage and books overkill separately so the harness can see waste. */
function applyDamage(B, tgt, amount, sourceSide = null, cause = 'combat') {
  let dmg = amount;
  // Core break floor: cap incoming damage per tick so the endgame is a readable
  // 60-second push rather than a one-burst deletion. Overtime removes the cap.
  if (tgt.kind === 'core' && cause === 'combat' && B.t < CFG.pacing.overtimeAt) {
    const cap = (tgt.maxHp / CFG.structures.coreMinBreakSeconds) * B.lastDt;
    if (dmg > cap) {
      if (sourceSide != null) B.stats.damageBySide[sourceSide].planned += 0;
      dmg = cap;
    }
  }
  const sideStats = sourceSide == null ? null : B.stats.damageBySide[sourceSide];
  if (sideStats) sideStats.planned += amount;
  let shieldAbsorbed = 0;
  if (tgt.shield > 0) {
    const absorbed = Math.min(tgt.shield, dmg);
    tgt.shield -= absorbed;
    dmg -= absorbed;
    shieldAbsorbed = absorbed;
    if (sideStats) sideStats.shield += absorbed;
    if (tgt.shield <= 0) tgt.shieldCd = SKILLS.ward.params.cd; // cooldown starts on BREAK
  }
  const before = Math.max(0, tgt.hp);
  const effective = Math.min(before, dmg);
  tgt.hp = before - effective;
  if (effective > 0) {
    tgt.lastHurtAt = B.t;
    if (tgt.hp <= 0) tgt.deathCause = cause;
  }
  B.stats.effectiveDamage += effective;
  B.stats.overkill += dmg - effective;
  if (sideStats) {
    sideStats.effective += effective;
    sideStats.overkill += dmg - effective;
  }
  if (sourceSide != null) {
    B.stats.damageEvents.push({
      t: B.t, sourceSide, targetSide: tgt.side,
      planned: amount, effective, overkill: dmg - effective,
      shield: shieldAbsorbed, cause,
    });
  }
}

function computeAttackReflow(B, u, dt, formation, structTarget) {
  let x = spaceOutX(B, u, u.x, u.speed, dt);
  if (x === u.x) return {};
  x = clampToStruct(u, x, structTarget);
  x = u.side === SIDE.L
    ? Math.max(CFG.field.coreCollisionInset, x)
    : Math.min(CFG.field.length - CFG.field.coreCollisionInset, x);
  return { nextX: x, nextLane: u.lane };
}

function computeMove(B, u, dt, tgt, structTarget, mode, formation) {
  let sp = u.speed;
  if (B.t < u.slowUntil) sp *= 1 - u.slowAmt;
  const p = player(B, u.side);
  const mech = p.commander.mechanic ?? {};
  if (mech.id === 'mark' && tgt && tgt.group === p.markedGroup && B.t < (p.markUntil ?? 0)) {
    sp *= 1 + mech.speedBonus;
  }

  // ---- HOME DEFENCE -----------------------------------------------------
  // Units otherwise advance in one direction only, which meant an enemy that
  // reached our core (x~1) could never be reached by our own reinforcements
  // (spawned at x=4 facing away). It was effectively invulnerable.
  // Fix: inside our own defence radius, a unit may turn around and walk BACK to
  // an intruder. Outside it, the one-way advance of the genre is preserved, so
  // the front line still means something and raiders can't yo-yo across the map.
  // Defending: walk to the target we are already committed to attacking, even if
  // that means going backwards. Offensive dashes are suppressed while defending.
  if (mode === 'defend' && tgt) {
    const toward = Math.sign(tgt.x - u.x) || u.dir;
    const nextX = u.x + toward * sp * dt;
    const clamped = u.side === SIDE.L
      ? Math.max(CFG.field.coreCollisionInset, nextX)
      : Math.min(CFG.field.length - CFG.field.coreCollisionInset, nextX);
    const lane = steerLane(u, tgt, sp, dt);
    return finishMove(
      B, u, isBlocked(B, u, clamped, toward) ? u.x : clamped,
      lane, sp, dt, structTarget,
    );
  }

  // If the target is already alongside us in X, close the lane gap before moving
  // farther forward. Without this hold, melee units in an unmatched lane walked
  // past their locked target forever and eventually died to the enemy bastion
  // without making a single attack.
  if (CFG.combat.meleeLaneHold && tgt && Math.abs(tgt.x - u.x) <= u.range) {
    const nextLane = steerLane(u, tgt, sp, dt);
    return finishMove(B, u, u.x, nextLane, sp, dt, structTarget);
  }

  if (u.skills.includes('charge') && u.chargeCd <= 0 && tgt &&
      dist2d(u, tgt) <= CFG.combat.chargeTriggerRange) {
    return {
      ...finishMove(
        B, u, u.x + u.dir * SKILLS.charge.params.dash,
        u.lane, sp, dt, structTarget,
      ),
      charge: true,
    };
  }

  const followsGuard = formation?.hasGuard;
  const raiderFollower = u.role === 'raider' && followsGuard &&
    u.id !== formation.successorId &&
    (!tgt || dist2d(u, tgt) > CFG.formation.roleDepth.raider + u.range);
  const artilleryFollower = u.role === 'artillery' &&
    (formation?.hasGuard || formation?.hasRaider);
  if ((raiderFollower || artilleryFollower) && Number.isFinite(formation?.anchor)) {
    const desired = formationDesiredX(u, formation);
    const maxSpeed = u.role === 'artillery' && formation.broken
      ? Math.min(sp, CFG.formation.frontBroken.anchorAdvanceSpeed)
      : sp;
    const nextX = approach(u.x, desired, maxSpeed * dt);
    const nextLane = u.role === 'artillery' ? u.lane : steerLane(u, tgt, sp, dt);
    return finishMove(B, u, nextX, nextLane, sp, dt, structTarget);
  }

  const nextX = u.x + u.dir * sp * dt;
  const nextLane = steerLane(u, tgt, sp, dt);
  return finishMove(
    B, u, isBlocked(B, u, nextX, u.dir) ? u.x : nextX,
    nextLane, sp, dt, structTarget,
  );
}

function computeArtilleryReposition(B, u, dt, tgt, structTarget, formation, distance) {
  const P = CFG.formation.artilleryPreferred;
  if (distance >= P.min && distance <= P.max) return {};
  const toward = Math.sign(tgt.x - u.x) || u.dir;
  let speed;
  let nextX;
  if (distance < P.min) {
    const unsupported = !formation?.hasGuard && !formation?.hasRaider;
    speed = unsupported && distance < P.softMin
      ? CFG.formation.frontBroken.retreatSpeed
      : CFG.formation.frontBroken.anchorAdvanceSpeed;
    nextX = u.x - toward * speed * dt;
  } else {
    speed = Math.min(u.speed, CFG.formation.frontBroken.anchorAdvanceSpeed);
    nextX = u.x + toward * speed * dt;
  }
  return finishMove(B, u, nextX, u.lane, speed, dt, structTarget);
}

function computeMeleeWait(B, u, dt, waitTarget, structTarget) {
  let sp = u.speed;
  if (B.t < u.slowUntil) sp *= 1 - u.slowAmt;
  const standoff = u.range + CFG.formation.xCell + Math.abs(u.formationOffset);
  const desired = waitTarget.x - u.dir * standoff;
  return finishMove(
    B, u, approach(u.x, desired, sp * dt),
    u.lane, sp, dt, structTarget,
  );
}

function computeFormationHold(B, u, dt, formation, structTarget) {
  let sp = u.speed;
  if (B.t < u.slowUntil) sp *= 1 - u.slowAmt;
  const desired = Number.isFinite(formation?.anchor)
    ? formationDesiredX(u, formation)
    : u.x;
  return finishMove(
    B, u, approach(u.x, desired, sp * dt),
    u.lane, sp, dt, structTarget,
  );
}

function formationDesiredX(u, formation) {
  const depth = u.role === 'artillery'
    ? formation.artilleryDepth
    : (u.id === formation.successorId ? 0 : CFG.formation.roleDepth[u.role] ?? 0);
  return formation.anchor - u.dir * depth + u.dir * u.formationOffset;
}

function finishMove(B, u, nextX, nextLane, sp, dt, structTarget) {
  const spaced = spaceOut(B, u, nextX, nextLane, sp, dt);
  let x = clampToStruct(u, spaced.nextX, structTarget);
  x = u.side === SIDE.L
    ? Math.max(CFG.field.coreCollisionInset, x)
    : Math.min(CFG.field.length - CFG.field.coreCollisionInset, x);
  return { nextX: x, nextLane: spaced.nextLane };
}

/**
 * Personal space. Without it, lane steering pulls everyone onto the same target
 * and the whole army collapses into one dot in the middle of the screen. Units
 * that are too close slide apart across lanes, which spreads a melee into a
 * front line instead of a pile. X separation is side-local and uses only
 * integer cohort/slot order to break exact ties; floats never enter a hash.
 */
function spaceOut(B, u, x, lane, sp, dt) {
  const R = CFG.combat.personalSpace;
  let lanePush = 0;
  for (const e of B.units) {
    if (e === u || e.hp <= 0) continue;
    if (Math.abs(e.x - u.x) > R) continue;
    const dl = lane - e.lane;
    if (Math.abs(dl) <= R) {
      const away = dl === 0 ? (u.slot % 2 ? 1 : -1) : Math.sign(dl);
      lanePush += away * (1 - Math.abs(dl) / R);
    }
  }
  const laneStep = Math.sign(lanePush) * Math.min(Math.abs(lanePush), 1) *
    sp * CFG.combat.spacingFactor * dt;
  const lo = CFG.formation.laneClampMin;
  const hi = CFG.field.lanes - CFG.formation.laneClampMaxInset;
  return {
    nextX: spaceOutX(B, u, x, sp, dt),
    nextLane: Math.max(lo, Math.min(hi, lane + laneStep)),
  };
}

function spaceOutX(B, u, x, sp, dt) {
  let push = 0;
  const neighbours = B.units.filter((e) =>
    e !== u && e.hp > 0 && e.side === u.side &&
    Math.abs(snapPosition(e.x - u.x)) < CFG.formation.xSpacingRadius);
  if (neighbours.length < CFG.gates.allyOverlapP95Max) return x;
  for (const e of neighbours) {
    const dx = snapPosition((u.x - e.x) * u.dir);
    const away = dx === 0 ? (unitOrder(u, e) < 0 ? 1 : -1) : Math.sign(dx);
    push += away * (1 - Math.abs(dx) / CFG.formation.xSpacingRadius);
  }
  const step = Math.sign(push) * Math.min(Math.abs(push), 1) *
    sp * CFG.formation.xSpacingFactor * dt;
  return x + u.dir * step;
}

function snapPosition(value) {
  const quantum = CFG.formation.positionQuantum;
  return Math.round(value / quantum) * quantum;
}

/**
 * Lane steering. Units used to move on x only, so a melee unit could never reach
 * an enemy sitting two lanes over — it would walk past forever, and an intruder
 * on our core in a different lane was literally unkillable.
 * Lane is a float; sideways movement is deliberately slower than forward movement
 * so the formation still reads as lanes rather than a soup.
 */
function steerLane(u, tgt, sp, dt) {
  if (!tgt) return u.lane;
  const d = tgt.lane - u.lane;
  if (Math.abs(d) < 0.02) return tgt.lane;
  const stepLane = Math.min(Math.abs(d), sp * CFG.combat.laneSpeedFactor * dt);
  return u.lane + Math.sign(d) * stepLane;
}

/** Bodies within half a lane block movement; wider gaps flow past. */
function isBlocked(B, u, nextX, dir) {
  return B.units.some((e) =>
    e.side !== u.side && e.hp > 0 && Math.abs(e.lane - u.lane) < 0.5 &&
    (dir > 0 ? e.x > u.x && e.x < nextX + 0.8 : e.x < u.x && e.x > nextX - 0.8));
}

function clampToStruct(u, nextX, structTarget) {
  const limit = structTarget.x - u.dir * Math.min(u.range, 1.0);
  return u.dir > 0 ? Math.min(nextX, limit) : Math.max(nextX, limit);
}

function dominionSpeed(B, u) {
  const p = player(B, u.side);
  const mech = p.commander.mechanic ?? {};
  if (mech.id !== 'dominion' || p.anchorGroup == null) return 1;
  const anchors = B.units.filter((a) => a.group === p.anchorGroup && a.hp > 0);
  if (!anchors.length) return 1;
  return anchors.some((a) => dist2d(a, u) <= mech.radius) ? 1 - mech.atkSpeed : 1;
}

function stepBastions(B, dt, incoming) {
  for (const s of B.structures) {
    if (s.kind !== 'bastion' || s.hp <= 0) continue;
    s.cd -= dt;
    if (s.cd > 0) continue;
    const R = CFG.structures;
    const inRange = B.units
      .filter((u) => u.side !== s.side && u.hp > 0 && Math.abs(u.x - s.x) <= R.bastionRange)
      .slice(0, R.bastionTargets);
    if (!inRange.length) continue;
    s.cd = 1.0;
    const per = R.bastionDps / Math.max(1, inRange.length);
    for (const u of inRange) {
      applyDamage(B, u, per, s.side, 'structure');
      B.fx.push({ type: 'hit', x: u.x, lane: u.lane, t: B.t });
    }
  }
}

/**
 * Aging exists to stop backlines stacking forever — but the old version also
 * dissolved the winning army mid-push, which recreated the stalemate it was
 * supposed to prevent. Units actively fighting in enemy territory are exempt.
 */
function applyAging(B, dt) {
  const C = CFG.combat;
  for (const u of B.units) {
    if (u.hp <= 0) continue;
    const age = B.t - u.born;
    const inOwnHalf = u.side === SIDE.L ? u.x < CFG.field.length / 2 : u.x > CFG.field.length / 2;
    const idle = B.t - u.lastCombatAt > C.activeAgeWindow;
    const activeExempt = C.activeHardAgeExempt && !idle &&
      (C.activeAgeExemptAnyTerritory || !inOwnHalf);
    if (activeExempt) continue;
    if (age > C.ageHardDeath) {
      u.hp = 0;
      u.ageKilled = true;
      u.deathCause = 'aging-hard';
      continue;
    }
    if (age <= C.ageFree) continue;
    if (inOwnHalf || idle) {
      u.hp -= u.maxHp * C.ageDecayPerSec * dt;
      if (u.hp <= 0) {
        u.ageKilled = true;
        u.deathCause = 'aging-decay';
      }
    }
  }
}

function reapDeaths(B) {
  for (const u of B.units) {
    if (u.hp > 0 || u.dead) continue;
    u.dead = true;
    B.fx.push({ type: 'death', x: u.x, lane: u.lane, side: u.side, t: B.t });
    if (u.ageKilled) B.stats.ageDeaths++; else B.stats.combatDeaths++;
    B.stats.deaths.push({
      t: B.t, side: u.side, unitId: u.id, group: u.group,
      cause: u.deathCause ?? 'unknown', age: B.t - u.born,
      x: u.x, lane: u.lane, firstAttackAt: u.firstAttackAt ?? null,
      lastCombatAgo: B.t - u.lastCombatAt,
    });
    const p = player(B, u.side);
    p.unitsLost++;
    const mech = p.commander.mechanic ?? {};
    if (mech.id === 'reclaim') p.reclaim += (u.contractCost / Math.max(1, u.bp.count)) * mech.recoverFrac;
  }
}

// ---------------------------------------------------------------- siege
export function frontline(B) {
  const ls = B.units.filter((u) => u.side === SIDE.L && u.hp > 0);
  const rs = B.units.filter((u) => u.side === SIDE.R && u.hp > 0);
  if (!ls.length && !rs.length) return CFG.field.length / 2;
  const lMax = ls.length ? Math.max(...ls.map((u) => u.x)) : 0;
  const rMin = rs.length ? Math.min(...rs.map((u) => u.x)) : CFG.field.length;
  return (lMax + rMin) / 2;
}

/**
 * Pressure stacks: the anti-stalemate lever. Awarded for holding ground just
 * past midfield for several waves — early enough to break a deadlock, and paid
 * in damage rather than income so the winner doesn't also out-economy you.
 */
function updateSiege(B) {
  const mid = CFG.field.length / 2;
  for (const p of B.players) {
    const own = B.units.filter((u) => u.side === p.side && u.hp > 0);
    if (!own.length) { p.pushStreak = 0; p.siegeStacks = Math.max(0, p.siegeStacks - 1); continue; }
    let wsum = 0, w = 0;
    for (const u of own) { const v = u.hp + u.dps * 5; wsum += u.x * v; w += v; }
    const centroid = wsum / w;
    const past = p.side === SIDE.L ? centroid - mid : mid - centroid;
    if (past >= CFG.siege.thresholdMeters) {
      p.pushStreak++;
      if (p.pushStreak >= CFG.siege.confirmWaves) p.siegeStacks = Math.min(CFG.siege.maxStacks, p.siegeStacks + 1);
    } else {
      p.pushStreak = 0;
      p.siegeStacks = Math.max(0, p.siegeStacks - 1);
    }
  }
}

// ---------------------------------------------------------------- end
function checkEnd(B) {
  const lCore = structOf(B, SIDE.L, 'core');
  const rCore = structOf(B, SIDE.R, 'core');
  if (lCore.hp <= 0 || rCore.hp <= 0) {
    B.over = true;
    if (lCore.hp <= 0 && rCore.hp <= 0) {
      B.winner = lCore.hp >= rCore.hp ? SIDE.L : SIDE.R;
      B.endReason = '동시 붕괴 — 잔여 코어 우세로 판정';
    } else {
      B.winner = lCore.hp <= 0 ? SIDE.R : SIDE.L;
      B.endReason = B.stats.enteredOvertime ? '균열 붕괴 중 코어 파괴' : '코어 파괴';
    }
    lCore.hp = Math.max(0, lCore.hp);
    rCore.hp = Math.max(0, rCore.hp);
    return;
  }
  if (B.t >= CFG.pacing.hardLimit) {
    B.over = true;
    B.winner = lCore.hp >= rCore.hp ? SIDE.L : SIDE.R;
    B.endReason = '시간 종료 — 코어 잔여 판정';
  }
}

export const roleLabel = (r) => CFG.roles[r]?.label ?? r;
export const sideKind = (s) => (s === SIDE.L ? 'demon' : 'human');
