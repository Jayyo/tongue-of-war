// @ts-check
// ALL balance constants live here. Nothing else in the codebase should hardcode
// a tunable number. Scaled to a ~6 minute target match (see docs/design.md).

export const CFG = {
  // ---------------------------------------------------------------- field
  field: {
    length: 52,          // meters, core to core (was 60 before the range rescale)
    spawnInset: 4,       // spawn this far in front of own core
    bastionAt: 10,       // bastion sits this far in front of own core
    spawnGap: 0.9,       // spacing between members of one cohort
    lanes: 5,            // visual/collision spread lanes
    laneSpacing: 1.2,    // collision metres represented by one lane step
    // Home defence uses TWO radii, not one. With a single radius, one intruder on
    // the core made the entire army — including units 50m away at the front —
    // turn around and walk home.
    //   threat:    how deep an enemy must be for it to count as an intrusion
    //   responder: how close a friendly must already be to be allowed to answer
    defenseThreatRadius: 8,
    defenseResponderRadius: 14,
    coreCollisionInset: 0.5,   // never walk into our own core
  },

  // ---------------------------------------------------------------- pacing
  // 6-minute target derived as wave(12s) x 30 waves; hard cap = 40 waves.
  pacing: {
    wave: 12,
    // The 60-second core endgame is a deliberate cost: it buys an HP bar that actually
    // reports the last minute instead of emptying in one burst. The pacing window moves
    // with it rather than fighting it.
    targetMedian: 390,   // 6:30
    overtimeAt: 520,     // 8:40 — measured p90 match is 8:21, so 7:48 was cutting
                         // into normal finishes and pushed rift-collapse entry to 26%
    hardLimit: 540,      // 9:00 absolute cap; nobody sees a draw
    overtimeCoreDrain: 0.02083, // full-HP core dies in ~48s of pure overtime
    overtimeStructMul: 2.0,
  },

  // ---------------------------------------------------------------- structures
  structures: {
    // Bastion DPS is NOT scaled down with match length: if it were, the bastion
    // would stop being a defensive building and become a second HP bar.
    // Bastion DPS at 135 matched a whole standard cohort and never decayed,
    // which is what kept every match alive until the overtime timer.
    // Tried 3000 to claw back the time the 60s endgame added: it moved first-core-hit
    // 5:09 -> 4:58 but STRETCHED the kill 58s -> 86s, because the attacker arrives with
    // fewer bodies and stops saturating the core cap. Net match length unchanged. Kept
    // at 3800 and the pacing window was moved instead.
    bastionHp: 3800,
    bastionRange: 10,
    bastionDps: 45,
    bastionTargets: 3,
    coreHp: 17000,
    // A core cannot be deleted faster than this, no matter how many bodies reach it.
    // Measured reason: lowering coreDamageMul alone moved the UNDEFENDED kill time
    // (77-175s) but barely moved the real one (23.6s), because by the time a core is
    // exposed the winning side has its whole army standing on it. Without a floor the
    // HP bar stays full for 99% of the match and then vanishes — the biggest element
    // on screen reporting nothing. Lifted during overtime so a match still ends.
    // NOTE this is a floor on CONTACT time, not on wall-clock: measured matches only
    // land damage on the core about 45% of the time between the first scratch and the
    // kill (defenders keep pushing the attackers off). A 60s floor therefore produced
    // a 132s endgame. With the current coreDamageMul, 13 measures out at a median of
    // ~70s from first core hit to kill in bot-vs-bot matches (tools/feel.mjs).
    coreMinBreakSeconds: 13,
    // Structure damage ramp, expressed in WAVES (w = t/12) rather than seconds,
    // because what matters is how many response opportunities have passed.
    structMul(t) {
      const w = t / CFG.pacing.wave;
      if (w < 12) return 0.55;
      return Math.min(1.5, 0.55 + 0.0475 * (w - 12));
    },
    // Units defending near their own core take less damage — comeback room,
    // decaying to zero by late game so stalls end. Weaker than the 15-minute
    // design because 12s reinforcement waves are already a defensive advantage.
    homeDefenseRadius: 8,
    homeDefenseMax: 0.15,
    homeDefenseFadeFrom: 216,
    homeDefenseFadeTo: 336,
  },

  // ---------------------------------------------------------------- economy
  economy: {
    start: 160,
    incomeMul: 1.0,
    // Tuned to preserve PURCHASING POWER PER WAVE (100 at start -> 172 at 6:00),
    // not seconds-scaled income.
    income(t) { return Math.min(15, 25 / 3 + t / 60); },
    softCap: 600,
    overCapRate: 0.25,   // income beyond soft cap is heavily taxed
  },

  // ---------------------------------------------------------------- summoning
  ritual: {
    // tier -> {cost, bp}. Cost and budget are 1:1 by design: the prompt cannot
    // buy a bigger unit by sounding more impressive.
    tiers: {
      small:    { cost: 80,  bp: 80,  label: '소형' },
      standard: { cost: 120, bp: 120, label: '표준' },
      greater:  { cost: 180, bp: 180, label: '대형' },
    },
    // Scrolls are ONE-SHOT. Engraving turns a discovered design into a card you
    // can re-cast with one click — at a discount, but never for free.
    // Break-even is 3 re-casts (0.6C / 0.2C), so situational units stay scrolls
    // and only a real staple is worth one of the 3 slots.
    // A summon is IMMEDIATE. Waiting for the 12s wave edge read as a bug ("why
    // didn't it come out?"), and the wave edge was never needed to stop typing
    // speed from being power: the cheapest cohort costs 80 and starting income is
    // ~8.3/s, so the natural gap between affordable summons is already ~9.6s.
    // The wave counter survives as 국면 — income steps, AI turns, doctrine unlocks.
    manifestDelay: 0.6,   // seconds from cast to the cohort physically appearing
    commandLock: 4,       // no further summon/recast for this long after one lands
    engraveSlots: 3,
    engraveCostMul: 0.6,   // cost to engrave = 0.6 x tier cost
    engravedCastMul: 0.8,  // re-cast an engraved card at 0.8 x tier cost
    contextDiscount: 0.8,  // verified context response: 0.8 x tier cost (no stacking)
    // Semantic repetition surcharge — repeating the same TACTICAL MEANING costs
    // more, regardless of wording. Engraved cards are exempt (that is what the
    // slot was for).
    echoStep: 0.12,
    echoMaxSteps: 2,
    echoSimilarity: 0.82,
    echoWindow: 5,
  },

  // ---------------------------------------------------------------- BP costs
  // Convex/coupled cost functions: extreme min-maxing gets expensive on its own,
  // which is what makes "HP 999999" structurally impossible rather than filtered.
  cost: {
    // Raised 20 -> 24: with 20, a contested fight resolved in ~8s, which made the
    // opening volley decide everything (winner kept ~49% of its value instead of
    // the intended 15-30%). More HP per BP = longer fights = less first-hit luck.
    hpPerBp: 24,         // 1 BP = 24 total HP
    dpsPerBp: 2,         // 1 BP = 2 total DPS
    rangeBase: 1.6,      // melee floor
    // A first guess of 1.26 only preserved the nominal BP of the old ranges. In measured
    // fights it made the 7m first-volley window dominant; 3.6 was still slightly
    // cheap in the full matrix, so the measured convergence point is 4.0.
    rangeK: 4.0,
    rangeExp: 1.35,
    speedRef: 3.0,
    speedK: 3,           // lowered so fast raiders stop overpaying for movement that never turned into fighting power
    speedRefundCap: -4,  // slow units can only refund this much
    speedCostCap: 18,
    // Two-body cohorts lose more board coverage under the two-melee-slot rule,
    // so they receive a small cohesion refund; a lone body still pays for full
    // DPS retention down to 1 HP.
    splitCost: { 1: 2, 2: -4, 3: 0, 5: 0 },
    // Formation is a purchased axis: spreading out survives splash but gives up
    // the body-blocking density that holds a lane.
    formationBp: { compact: 0, spread: 8 },
    // 35% was a +54% EHP swing on one channel — past "soft counter" territory.
    maxResist: 0.25,
    wardProcsRef: 1.5,   // expected ward refreshes per unit lifetime, for pricing
    // How far an explicit "ward against X" request skews the two resistances.
    // Same total EHP, just concentrated — so it is a gamble on what you'll face.
    resistTilt: 0.7,
    // shares of the budget each axis may occupy
    share: {
      hpMin: 0.25, hpMax: 0.60,
      dpsMin: 0.25, dpsMax: 0.60,
      skillMax: 0.25,
      mobilityMax: 0.38,  // C_range + max(0, C_speed) — 0.30 pinned every artillery at its range floor
    },
    limits: {
      rangeMax: 8.5, speedMin: 2.4, speedMax: 5.0, skillsMax: 2,
      counts: [1, 2, 3, 5],
    },
  },

  // ---------------------------------------------------------------- combat
  combat: {
    // Attack cadence is a delivery style, not a purchased stat — otherwise DPS
    // would be double-charged.
    cadence: {
      flurry:  { interval: 0.2, label: '연타' },
      balanced:{ interval: 0.4, label: '균형' },
      crush:   { interval: 0.8, label: '강타' },
    },
    targetLock: 0.8,     // seconds a unit sticks to its target (stops perfect focus fire)
    // First-shot preparation is role-specific so ranged setup can be tuned without
    // changing sustained DPS. All roles currently preserve the original 0.5 cadence.
    engageWindupMul: { guard: 0.5, raider: 0.5, artillery: 0.5 },
    engageFixedDelay: 0.45,
    // Fraction of a fallen cohort member's DPS redistributed among survivors.
    // Zero preserves ordinary per-unit attrition; higher values reduce the hidden
    // "one body keeps 100% DPS until death" advantage of elite cohorts.
    // 1.0 = a cohort's TOTAL dps survives its casualties, but never exceeds what it
    // started with. Above 1.0 (it was 1.3) a 5-cohort down to its last member hit for
    // 124% of its original output — "I killed four of them and it got stronger" is not
    // a thing a player can be asked to accept.
    cohortDpsRetention: 1.0,
    // Removed: a wounded unit hitting 45% harder at 10% HP had no readable logic.
    // First-volley snowball is already handled by dps retention + the engage windup.
    woundedDpsBonus: 0,
    // Survivor value resisted BOTH directions: 1.42 ended exchanges sooner (36%) and
    // 1.18 with a slower entry made them longer but even more lopsided (39%). The real
    // driver is dpsRetention 1.0 — a cohort no longer gets stronger as it dies, so the
    // loser stops clawing value back. 1.42 measured best across every other gate.
    unitDamageMul: 1.42,
    // Infinity preserves spawn-time charge. A finite value makes the dash an
    // actual gap-closer that waits until an enemy is within this distance.
    chargeTriggerRange: 7,   // the dash used to fire on spawn; now it is a real 7 m gap-closer
    meleeLaneHold: true,
    activeHardAgeExempt: true, // 333 of 338 age deaths were units still fighting in enemy territory
    // Formation fights can stay on the defending half for more than one age
    // window. Recent combat, not territory, is the meaningful exemption.
    activeAgeExemptAnyTerritory: true,
    activeAgeWindow: 48,
    // Sideways (lane) movement as a fraction of forward speed. Below 1 so the
    // formation still reads as lanes instead of collapsing into a blob.
    laneSpeedFactor: 0.45,
    // Personal space: how close (in metres / lane units) before units slide apart.
    // Lane steering alone made every army converge into one clump at midfield.
    personalSpace: 1.9,
    spacingFactor: 0.7,
    // How stubbornly a unit holds its target, chosen by the sentence.
    targetLockByPersistence: { flexible: 0.35, steady: 0.8, relentless: 2.0 },
    // Longer lock while defending: stops units oscillating at the radius edge.
    defenseTargetLock: 1.5,
    sweepSecondary: 0.30, // splash hits up to 3 extra for 30% each
    sweepMaxTargets: 3,
    // Five structure slots and real backlines sharply reduce siege uptime.
    // This multiplier restores the six-minute match target after that change.
    // Target: once a core starts taking damage it should last ~60s, so the HP bar
    // actually reports the endgame instead of vanishing in one burst. Measured and
    // re-tuned with tools/feel.mjs.
    // Kept high on purpose: with the core break floor doing the pacing, the multiplier
    // only has to guarantee that a real siege force SATURATES the cap. Lowering it as
    // well stacked two brakes and stretched the endgame to 126s.
    coreDamageMul: 21.0,
    // Role rock-paper-scissors. Attacker role -> defender role -> multiplier.
    roleCounter: {
      guard:     { guard: 1.0, raider: 1.1, artillery: 1.0 },
      raider:    { guard: 1.0, raider: 1.0, artillery: 1.1 },
      artillery: { guard: 1.1, raider: 1.0, artillery: 1.0 },
    },
    counterCap: 1.4,     // product of all multipliers is clamped here
    // Units decay so late-game backlines can't stack forever. Expressed in
    // GENERATIONS: decay starts at 3 waves old, death is guaranteed at 4.
    // 4 waves free, guaranteed removal at 6. Units still fighting in ENEMY
    // territory are exempt from the decay (see applyAging) — otherwise aging
    // dissolves the winning push and recreates the stalemate.
    ageFree: 48,
    ageDecayPerSec: 0.04,
    ageHardDeath: 72,
  },

  // ---------------------------------------------------------------- formation
  // Every value below is simulation-space data. The renderer only chooses how
  // far apart those lanes look; collision and targeting use field.laneSpacing.
  formation: {
    roleDepth: { guard: 0, raider: 2.2, artillery: 6.2 },
    spawnCompression: { guard: 1.4, raider: 0, artillery: -1.8 },
    xCell: 1.6,
    // At most two members share an x cell, including a five-member cohort.
    xCellsBySlot: [0, 0, -1, -1, 1],
    lanePriority: {
      guard: [2, 1, 3, 0, 4],
      raider: [0, 4, 1, 3, 2],
      artillery: [1, 3, 2, 0, 4],
    },
    meleeSlots: 2,
    structureMeleeSlots: 5,
    artilleryPreferred: { min: 6.4, max: 7.6, softMin: 5.5 },
    frontBroken: {
      guardLead: 3.0,
      confirm: 0.6,
      advancedDepth: 4.6,
      anchorAdvanceSpeed: 1.2,
      retreatSpeed: 1.4,
      recoverConfirm: 1.0,
    },
    xSpacingRadius: 1.6,
    xSpacingFactor: 2.4,
    positionQuantum: 0.000001,
    laneClampMin: -0.4,
    laneClampMaxInset: 0.6,
  },

  // ---------------------------------------------------------------- roles
  roles: {
    guard: {
      label: '수호자', rangeMin: 1.6, rangeMax: 1.8,
      speedMin: 2.4, speedMax: 3.0, hpShareMin: 0.40, target: 'nearest',
    },
    raider: {
      label: '습격자', rangeMin: 1.6, rangeMax: 2.6,
      speedMin: 3.8, speedMax: 5.0, hpShareMin: 0.25, hpShareMax: 0.45, target: 'backline',
    },
    artillery: {
      label: '포격수', rangeMin: 7.0, rangeMax: 8.0,
      speedMin: 2.4, speedMax: 3.0, hpShareMax: 0.40, target: 'nearest',
    },
  },

  // ---------------------------------------------------------------- presentation
  render: {
    lanePitch: 4.4,
    camera: { margin: 18, minDist: 68, drift: 0.05 },
    projectile: {
      baseFlight: 0.42,
      perMeter: 0.035,
      minFlight: 0.48,
      maxFlight: 0.78,
    },
  },

  // ---------------------------------------------------------------- regression gates
  gates: {
    formationGapMin: 4.5,
    meleeOccupancyP95Max: 2,
    allyOverlapHalfWidth: 0.8,
    allyOverlapP95Max: 2,
    firstEngagementBaseline: 7.55,
    firstEngagementTolerance: 0.10,
    formationSampleSeeds: 6,
    formationSampleDuration: 35,
    formationSampleSeedBase: 9100,
    formationSampleSeedStep: 137,
  },

  commanderCaps: {
    // An earlier 6 m cap would violate the mandatory 7 m artillery floor.
    baalRangeMax: 7.0,
  },

  skillTuning: {
    executeBp: 9,
  },

  // ---------------------------------------------------------------- upgrades
  // ONE doctrine choice at 3:00, not three tiers. Engraving is already the
  // progression system; three upgrade tiers on top only makes decisions noisy.
  upgrades: {
    tiers: [
      { unlockAt: 180, cost: 120 },
    ],
    doctrines: {
      ruin:   { label: '파괴 교리', dps: 1.10 },
      ward:   { label: '수호 교리', hp: 1.12 },
      swift:  { label: '기동 교리', speed: 1.08, moveCd: 0.94 },
      arcane: { label: '비술 교리', skillCd: 0.90 },
    },
  },

  // ---------------------------------------------------------------- siege stacks
  // Pressure stacks fire EARLY (3m past centre, 3 waves) so they actually break
  // a midfield deadlock instead of only rewarding an already-won game.
  siege: {
    thresholdMeters: 3,
    confirmWaves: 3,
    unitPerStack: 0.03,
    structPerStack: 0.05,
    maxStacks: 3,
  },
};
