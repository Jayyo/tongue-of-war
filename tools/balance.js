// @ts-check
// Headless balance harness — runs the exact sim the browser runs.
//
//   node tools/balance.js            full sweep (~45 s)
//   node tools/balance.js prompts    prompt -> stat compile table
//   node tools/balance.js mirror     order-fairness check (must be ~50/50)
//   node tools/balance.js duel       one verbose match, wave by wave

import {
  createBattle, step, queueContract, spawnCohort,
  player, other, structOf, SIDE,
} from '../src/engine/sim.js';
import { compile } from '../src/domain/budget.js';
import { stubInterpret } from '../src/gen/interpreter.js';
import { COMMANDERS, getCommander } from '../src/domain/commanders.js';
import { botThink } from '../src/ai/bot.js';
import { CFG } from '../src/config.js';
import { SKILLS } from '../src/domain/skills.js';

const DT = 0.05;

// Local sweep helper: override existing CFG leaves without editing production
// constants. Example: BALANCE_OVERRIDES='{"cost.speedK":3}' node tools/balance.js
if (process.env.BALANCE_OVERRIDES) {
  const overrides = JSON.parse(process.env.BALANCE_OVERRIDES);
  for (const [path, value] of Object.entries(overrides)) {
    const parts = path.split('.');
    let obj = parts[0] === 'skills' ? SKILLS : CFG;
    if (parts[0] === 'skills') parts.shift();
    for (const part of parts.slice(0, -1)) obj = obj[part];
    obj[parts.at(-1)] = value;
  }
}

const REFERENCE = [
  { key: 'wall',    text: '두꺼운 갑옷을 두른 방패 수문장 셋' },
  { key: 'assassin',text: '적 후열 포격수를 파고드는 날렵한 그림자 자객 셋' },
  { key: 'cannon',  text: '멀리서 쏘아붙이는 장거리 주술 포격대' },
  { key: 'sweep',   text: '광역으로 휩쓰는 화염 폭발 술사' },
  { key: 'swarm',   text: '값싼 하급 군단 다섯, 수로 밀어붙인다' },
  { key: 'elite',   text: '강력한 단독 거대 파괴자 하나' },
  { key: 'chiller', text: '얼음으로 적을 둔화시키는 냉기 술사 셋' },
  { key: 'golem',   text: '보호막을 두른 견고한 강철 골렘 둘' },
  { key: 'exec',    text: '적 탱커를 처형하는 무자비한 도끼병 셋' },
  { key: 'veiled',  text: '은폐한 채 접근하는 독칼 암살자 셋' },
  { key: 'beast',   text: '돌진하는 흉포한 야수 무리 다섯' },
  { key: 'archer',  text: '정밀하게 꿰뚫는 강철 장궁대' },
];
const byKey = Object.fromEntries(REFERENCE.map((r) => [r.key, r.text]));

const NEUTRAL = { id: 'neutral', faction: 'demon', name: 'neutral', bias: {}, mechanic: { id: 'none' } };

// ---------------------------------------------------------------- cohort duel
/**
 * Head-on cohort fight, no economy. `swapSides` mirrors the matchup so we can
 * detect processing-order bias: a fair engine gives W(A,B) + W(B,A) ~= 100%.
 */
function cohortDuel(aPrompt, bPrompt, seed, swapSides = false, opts = {}) {
  const B = createBattle({ seed, players: [
    { side: SIDE.L, commander: NEUTRAL }, { side: SIDE.R, commander: NEUTRAL },
  ]});
  // A cohort duel is a neutral unit test, not a siege test. Faster cohorts meet
  // deeper in enemy territory; leaving bastions active silently charged speed
  // with enemy structure DPS and made charge look harmful.
  if (!opts.withStructures) {
    for (const s of B.structures) {
      if (s.kind === 'bastion') s.hp = 0;
      else if (s.kind === 'core') s.hp = s.maxHp = Number.POSITIVE_INFINITY;
    }
  }
  let bpA = compile(stubInterpret(aPrompt, NEUTRAL), 120, NEUTRAL);
  let bpB = compile(stubInterpret(bPrompt, NEUTRAL), 120, NEUTRAL);
  if (opts.transformA) bpA = opts.transformA(cloneBlueprint(bpA));
  if (opts.transformB) bpB = opts.transformB(cloneBlueprint(bpB));
  B.players[0].essence = 9999; B.players[1].essence = 9999;
  queueContract(B, swapSides ? SIDE.R : SIDE.L, bpA, 0);
  queueContract(B, swapSides ? SIDE.L : SIDE.R, bpB, 0);

  const aSide = swapSides ? SIDE.R : SIDE.L;
  let contactAt = null;
  let spawnConfigured = false;
  for (let i = 0; i < 60 * 20 && !B.over; i++) {
    step(B, DT);
    if (!spawnConfigured && B.units.some((u) => u.side === aSide) && B.units.some((u) => u.side !== aSide)) {
      opts.afterSpawn?.(B, aSide);
      spawnConfigured = true;
    }
    const a = B.units.filter((u) => u.side === aSide && u.hp > 0);
    const b = B.units.filter((u) => u.side !== aSide && u.hp > 0);
    if (contactAt == null && a.length && b.length) {
      const near = a.some((x) => b.some((y) => Math.abs(x.x - y.x) <= Math.max(x.range, y.range)));
      if (near) contactAt = B.t;
    }
    if (B.wave >= 1 && (!a.length || !b.length)) {
      const av = a.reduce((s, u) => s + u.hp + u.dps * 5, 0);
      const bv = b.reduce((s, u) => s + u.hp + u.dps * 5, 0);
      const winner = av > bv ? 'A' : bv > av ? 'B' : 'draw';
      const winnerStartV = winner === 'A'
        ? bpA.totalHp + bpA.totalDps * 5
        : bpB.totalHp + bpB.totalDps * 5;
      const attackTimes = firstAttackTimes(B.stats.attacks);
      const aTimes = [...attackTimes.entries()]
        .filter(([id]) => B.stats.attacks.some((e) => e.unitId === id && e.side === aSide))
        .map(([, t]) => t);
      const bTimes = [...attackTimes.entries()]
        .filter(([id]) => B.stats.attacks.some((e) => e.unitId === id && e.side !== aSide))
        .map(([, t]) => t);
      const firstA = aTimes.length ? Math.min(...aTimes) : null;
      const firstB = bTimes.length ? Math.min(...bTimes) : null;
      const firstEngagement = firstA == null ? firstB
        : firstB == null ? firstA
        : Math.min(firstA, firstB);
      const dmgA = B.stats.damageBySide[aSide];
      const dmgB = B.stats.damageBySide[other(aSide)];
      return {
        winner,
        remainFrac: winner === 'draw' ? 0 : Math.max(av, bv) / winnerStartV,
        fight: contactAt == null ? 0 : B.t - contactAt,
        overkillFrac: B.stats.rawDamage ? B.stats.overkill / B.stats.rawDamage : 0,
        crossLane: B.stats.crossLaneMelee,
        firstAttackGap: firstA == null || firstB == null ? null : firstA - firstB,
        firstEngagement,
        aArrivalSpread: aTimes.length > 1 ? Math.max(...aTimes) - Math.min(...aTimes) : 0,
        bArrivalSpread: bTimes.length > 1 ? Math.max(...bTimes) - Math.min(...bTimes) : 0,
        aFirstAttackTimes: aTimes,
        bFirstAttackTimes: bTimes,
        aNoAttackDeaths: B.stats.deaths.filter((d) => d.side === aSide && d.firstAttackAt == null).length,
        bNoAttackDeaths: B.stats.deaths.filter((d) => d.side !== aSide && d.firstAttackAt == null).length,
        aDamage: { ...dmgA },
        bDamage: { ...dmgB },
        damageToABeforeFirstAttack: firstA == null ? 0 : B.stats.damageEvents
          .filter((e) => e.targetSide === aSide && e.t < firstA && e.cause === 'combat')
          .reduce((s, e) => s + e.effective + e.shield, 0),
        aCharges: B.stats.charges.filter((e) => e.side === aSide).length,
        bCharges: B.stats.charges.filter((e) => e.side !== aSide).length,
        wardProcs: B.stats.wardProcs,
        deaths: B.stats.deaths,
      };
    }
  }
  const value = (side) => B.units.filter((u) => u.side === side && u.hp > 0).reduce((s, u) => s + u.hp + u.dps * 5, 0);
  return {
    winner: 'timeout', even: value(aSide) === value(other(aSide)),
    remainFrac: 0, fight: 0, overkillFrac: 0, crossLane: 0,
    firstAttackGap: null, aArrivalSpread: 0, bArrivalSpread: 0,
    firstEngagement: null,
    aFirstAttackTimes: [], bFirstAttackTimes: [],
    aNoAttackDeaths: 0, bNoAttackDeaths: 0,
    aDamage: { planned: 0, effective: 0, overkill: 0, shield: 0 },
    bDamage: { planned: 0, effective: 0, overkill: 0, shield: 0 },
    damageToABeforeFirstAttack: 0, aCharges: 0, bCharges: 0, wardProcs: 0, deaths: [],
  };
}

function cloneBlueprint(bp) {
  return { ...bp, skills: bp.skills.slice(), breakdown: { ...bp.breakdown } };
}

function firstAttackTimes(events) {
  const out = new Map();
  for (const e of events) if (!out.has(e.unitId)) out.set(e.unitId, e.t);
  return out;
}

// ---------------------------------------------------------------- full match
function fullMatch(cmdIdA, cmdIdB, seed, verbose = false, demonLeft = true) {
  const a = getCommander(cmdIdA), b = getCommander(cmdIdB);
  const sideA = demonLeft ? (a.faction === 'demon' ? SIDE.L : SIDE.R) : (a.faction === 'demon' ? SIDE.R : SIDE.L);
  const B = createBattle({ seed, players: [
    { side: sideA, commander: a, isBot: true },
    { side: other(sideA), commander: b, isBot: true },
  ]});
  let nextWave = 1, guard = 0;
  while (!B.over && guard++ < 60 * 20 * 10) {
    step(B, DT);
    if (B.wave >= nextWave) {
      nextWave = B.wave + 1;
      for (const p of B.players) botThink(B, p.side);
      if (verbose) {
        const l = structOf(B, SIDE.L, 'core'), r = structOf(B, SIDE.R, 'core');
        const lb = structOf(B, SIDE.L, 'bastion'), rb = structOf(B, SIDE.R, 'bastion');
        console.log(
          `w${String(B.wave).padStart(2)} ${fmt(B.t)} | front ${pct(frontPct(B))} | ` +
          `L bastion${pct(lb.hp / lb.maxHp)} core${pct(l.hp / l.maxHp)} · R bastion${pct(rb.hp / rb.maxHp)} core${pct(r.hp / r.maxHp)} | ` +
          `units ${B.units.filter((u) => u.side === SIDE.L && u.hp > 0).length}v${B.units.filter((u) => u.side === SIDE.R && u.hp > 0).length}`);
      }
    }
  }
  const fronts = B.stats.waves.map((w) => w.front);
  const mid = CFG.field.length / 2;
  let maxStall = 0, run = 0;
  for (const f of fronts) { if (Math.abs(f - mid) <= 3) { run++; maxStall = Math.max(maxStall, run); } else run = 0; }
  return {
    winner: B.winner === sideA ? cmdIdA : cmdIdB,
    t: B.t, waves: B.wave, reason: B.endReason,
    overtime: B.stats.enteredOvertime,
    normalKill: !B.stats.enteredOvertime && B.endReason === '코어 파괴',
    firstCoreHit: B.stats.firstCoreHit,
    ageDeathFrac: B.stats.ageDeaths / Math.max(1, B.stats.ageDeaths + B.stats.combatDeaths),
    ageDeaths: B.stats.ageDeaths,
    combatDeaths: B.stats.combatDeaths,
    ageHardDeaths: B.stats.deaths.filter((d) => d.cause === 'aging-hard').length,
    ageDecayDeaths: B.stats.deaths.filter((d) => d.cause === 'aging-decay').length,
    agingBeforeAttack: B.stats.deaths.filter((d) => d.cause.startsWith('aging-') && d.firstAttackAt == null).length,
    activeEnemyHardDeaths: B.stats.deaths.filter((d) =>
      d.cause === 'aging-hard' && d.lastCombatAgo <= 6 &&
      (d.side === SIDE.L ? d.x > CFG.field.length / 2 : d.x < CFG.field.length / 2)).length,
    drainShare: B.stats.drainDamage / Math.max(1, B.stats.drainDamage + B.stats.combatStructureDamage),
    stallWaves: maxStall,
  };
}

function frontPct(B) {
  const ls = B.units.filter((u) => u.side === SIDE.L && u.hp > 0);
  const rs = B.units.filter((u) => u.side === SIDE.R && u.hp > 0);
  const lMax = ls.length ? Math.max(...ls.map((u) => u.x)) : 0;
  const rMin = rs.length ? Math.min(...rs.map((u) => u.x)) : CFG.field.length;
  return ((lMax + rMin) / 2) / CFG.field.length;
}
const CADENCE = { '연타': 'flurry', '균형': 'balanced', '강타': 'crush' };
const END_REASON = {
  '코어 파괴': 'core destroyed', '균열 붕괴 중 코어 파괴': 'core destroyed in overtime',
  '동시 붕괴 — 잔여 코어 우세로 판정': 'both cores fell; higher core HP wins', '시간 종료 — 코어 잔여 판정': 'time limit; higher core HP wins',
};
const pct = (v) => `${String(Math.round(v * 100)).padStart(3)}%`;
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- reports
function reportCompile() {
  console.log('\n=== Sentence -> blueprint (neutral commander, 120 BP) ===');
  for (const r of REFERENCE) {
    const intent = stubInterpret(r.text, NEUTRAL);
    const bp = compile(intent, 120, NEUTRAL);
    console.log(
      `${r.key.padEnd(9)} ${bp.role.padEnd(9)} x${bp.count} ` +
      `HP${String(Math.round(bp.totalHp)).padStart(4)} DPS${String(Math.round(bp.totalDps)).padStart(3)} ` +
      `R${bp.range.toFixed(1)} V${bp.speed.toFixed(1)} ${bp.channel.padEnd(8)} ` +
      `${CADENCE[bp.cadenceLabel] ?? bp.cadenceLabel} res${Math.round(bp.resistPhysical * 100)} ` +
      `[${bp.skills.join(',') || '-'}] ${bp.breakdown.total}/${bp.breakdown.budget}BP`);
  }
}

/** ORDER FAIRNESS: the same cohort on both sides must not favour a side. */
function reportMirror() {
  console.log('\n=== Order fairness: the same cohort on both sides (left win rate of decided games, target 45-55%) ===');
  let worst = 0, uneven = 0;
  for (const r of REFERENCE) {
    let lw = 0, wipes = 0, timeouts = 0;
    const N = 12;
    for (let s = 0; s < N; s++) {
      const out = cohortDuel(r.text, r.text, 2000 + s * 613);
      if (out.winner === 'A') lw++;
      else if (out.winner === 'draw') wipes++;
      else if (out.winner === 'timeout') { timeouts++; if (!out.even) uneven++; }
    }
    // Simultaneous wipes, and timeouts with both sides at equal value, are what a
    // fair engine produces here; they must not count toward the left-side win rate.
    const decided = N - wipes - timeouts;
    const tail = `simultaneous wipes ${wipes}, timeouts ${timeouts}`;
    if (decided === 0) {
      console.log(`  ${r.key.padEnd(9)} no winner in ${N}/${N} (${tail})`);
      continue;
    }
    const rate = Math.round((lw / decided) * 100);
    worst = Math.max(worst, Math.abs(rate - 50));
    console.log(`  ${r.key.padEnd(9)} left ${String(rate).padStart(3)}%  (decided ${decided}/${N}, ${tail})`);
  }
  const pass = worst <= 5 && uneven === 0;
  console.log(`  -> max bias ${worst} pp${uneven ? `, ${uneven} uneven timeouts` : ''} ${pass ? '(pass)' : '(FAIL: processing-order bias)'}`);
}

function reportTriangle() {
  console.log('\n=== Matchup matrix (120 BP, 6 games per pair with sides swapped; % of games the row won, draws count as not won) ===');
  const keys = REFERENCE.map((r) => r.key);
  console.log('           ' + keys.map((k) => k.slice(0, 5).padStart(6)).join(''));
  let asymWorst = 0;
  const remains = [];
  const fights = [];
  const firstEngagements = [];
  const matrix = Object.fromEntries(keys.map((k) => [k, {}]));
  for (const a of keys) {
    let row = a.padEnd(11);
    for (const b of keys) {
      if (a === b) { row += '     -'; continue; }
      let wins = 0, draws = 0, n = 0;
      for (let s = 0; s < 3; s++) {
        for (const swap of [false, true]) {
          const r = cohortDuel(byKey[a], byKey[b], 1000 + s * 37, swap);
          if (r.winner === 'A') { wins++; remains.push(r.remainFrac); }
          else if (r.winner === 'draw' || r.winner === 'timeout') draws++;
          if (r.fight > 0) fights.push(r.fight);
          if (r.firstEngagement != null) firstEngagements.push(r.firstEngagement);
          n++;
        }
      }
      matrix[a][b] = { wins, draws, n, score: (wins + draws * 0.5) / n };
      row += `${String(Math.round((wins / n) * 100)).padStart(5)}%`;
    }
    console.log(row);
  }
  // symmetry check. Simultaneous wipes are PROOF of fairness, not bias — the same
  // rule reportMirror() already uses. Counting them made two draw-heavy pairs
  // (swarm/wall, golem/wall) report 50%p while all 64 decided pairs were at 0%p.
  let undecided = 0;
  for (const a of keys) for (const b of keys) {
    if (a >= b) continue;
    const f = winRate(a, b), r = winRate(b, a);
    const decided = f.decided + r.decided;
    if (decided === 0) { undecided++; continue; }
    const w1 = (f.wins / Math.max(1, f.decided)) * 100;
    const w2 = (r.wins / Math.max(1, r.decided)) * 100;
    asymWorst = Math.max(asymWorst, Math.abs(w1 + w2 - 100));
  }
  fights.sort((x, y) => x - y);
  remains.sort((x, y) => x - y);
  const p = (arr, q) => arr.length ? arr[Math.floor(arr.length * q)] : 0;
  console.log(`\n  A-vs-B + B-vs-A win rates, max deviation from 100%: ${Math.round(asymWorst)} pp ${asymWorst <= 20 ? '(pass)' : '(FAIL)'}` +
    (undecided ? `  · ${undecided} pairs skipped (only simultaneous wipes)` : ''));
  console.log(`  fight length: p10 ${p(fights, .1).toFixed(1)}s / p50 ${p(fights, .5).toFixed(1)}s / p90 ${p(fights, .9).toFixed(1)}s  (target p50 10-14 s, p10 >= 7 s)`);
  console.log(`  winner's surviving value: p50 ${Math.round(p(remains, .5) * 100)}%  (target 15-30%)`);
  return { matrix, firstEngagements };

  /** @returns {{wins:number, decided:number}} draws/timeouts are excluded from both. */
  function winRate(a, b) {
    let wins = 0, decided = 0;
    for (let s = 0; s < 2; s++) for (const swap of [false, true]) {
      const w = cohortDuel(byKey[a], byKey[b], 1000 + s * 37, swap).winner;
      if (w === 'draw' || w === 'timeout') continue;
      decided++;
      if (w === 'A') wins++;
    }
    return { wins, decided };
  }
}

/**
 * Prompt viability gate. A draw is half a win because the design promise is
 * "no sentence is dead on arrival", not "every deterministic duel must resolve".
 */
function reportPromptViability(matrix) {
  const keys = REFERENCE.map((r) => r.key);
  const rows = keys.map((a) => {
    const scores = keys.filter((b) => a !== b).map((b) => matrix[a][b].score);
    return {
      key: a,
      mean: scores.reduce((s, v) => s + v, 0) / scores.length,
      best: Math.max(...scores),
      worst: Math.min(...scores),
    };
  });
  const pairScores = rows.flatMap((r) =>
    keys.filter((b) => b !== r.key).map((b) => ({ a: r.key, b, score: matrix[r.key][b].score })));
  const hardCells = pairScores.filter((c) => c.score < 0.30 || c.score > 0.70);
  const weakestMean = rows.reduce((a, b) => (a.mean < b.mean ? a : b));
  const weakestBest = rows.reduce((a, b) => (a.best < b.best ? a : b));
  const strongestMean = rows.reduce((a, b) => (a.mean > b.mean ? a : b));
  const meanOfMeans = rows.reduce((s, r) => s + r.mean, 0) / rows.length;
  const rowSd = Math.sqrt(rows.reduce((s, r) => s + (r.mean - meanOfMeans) ** 2, 0) / rows.length);
  const pass = weakestMean.mean >= 0.30 && strongestMean.mean <= 0.70 &&
    weakestBest.best >= 0.50 && rowSd <= 0.12;

  console.log('\n=== Sentence viability gate (a draw counts as half a win) ===');
  console.log('  mean score: ' + rows.map((r) => `${r.key}=${Math.round(r.mean * 100)}%`).join(' '));
  console.log(`  single matchups outside 30-70% (info only): ${hardCells.length}/${pairScores.length} cells`);
  console.log(`  weakest mean: ${weakestMean.key} ${pct(weakestMean.mean)}  (floor 30%)`);
  console.log(`  strongest mean: ${strongestMean.key} ${pct(strongestMean.mean)}  (ceiling 70%)`);
  console.log(`  best matchup of the weakest design: ${weakestBest.key} ${pct(weakestBest.best)}  (floor 50%)`);
  console.log(`  spread of mean scores (std dev): ${(rowSd * 100).toFixed(1)} pp  (ceiling 12 pp)`);
  console.log(`  PROMPT_VIABILITY=${pass ? 'PASS' : 'FAIL'}`);
}

/**
 * Headless visibility/formation gate. Geometry is sampled from mixed-role
 * fights, while first-engagement timing reuses the full 12x11 duel lattice.
 */
function reportFormationGate(firstEngagements) {
  const geometry = sampleMixedFormation();
  const gap = quantile(geometry.gaps, 0.5);
  const occupancy = quantile(geometry.occupancies, 0.95);
  const overlap = quantile(geometry.overlaps, 0.95);
  const first = quantile(firstEngagements, 0.5);
  const baseline = CFG.gates.firstEngagementBaseline;
  const change = baseline > 0 ? (first - baseline) / baseline : Infinity;
  const pass = gap >= CFG.gates.formationGapMin &&
    occupancy <= CFG.gates.meleeOccupancyP95Max &&
    overlap <= CFG.gates.allyOverlapP95Max &&
    Math.abs(change) <= CFG.gates.firstEngagementTolerance;

  console.log('\n=== Formation and readability gate (headless) ===');
  console.log(
    `  front line to artillery x gap: p50 ${gap.toFixed(2)}m ` +
    `(floor ${CFG.gates.formationGapMin.toFixed(1)}m, n=${geometry.gaps.length})`);
  console.log(
    `  melee attackers on one unit: p95 ${occupancy.toFixed(0)} ` +
    `(ceiling ${CFG.gates.meleeOccupancyP95Max})`);
  console.log(
    `  allies stacked within x±${CFG.gates.allyOverlapHalfWidth.toFixed(1)}m: ` +
    `p95 ${overlap.toFixed(0)} (ceiling ${CFG.gates.allyOverlapP95Max})`);
  console.log(
    `  first engagement: p50 ${first.toFixed(2)}s / baseline ${baseline.toFixed(2)}s / ` +
    `change ${(change * 100).toFixed(1)}% ` +
    `(allowed ±${Math.round(CFG.gates.firstEngagementTolerance * 100)}%)`);
  console.log(`  FORMATION_GATE=${pass ? 'PASS' : 'FAIL'}`);
}

function sampleMixedFormation() {
  const gaps = [];
  const occupancies = [];
  const overlaps = [];
  const blueprints = [
    compile(stubInterpret(byKey.wall, NEUTRAL), 120, NEUTRAL),
    compile(stubInterpret(byKey.assassin, NEUTRAL), 120, NEUTRAL),
    compile(stubInterpret(byKey.archer, NEUTRAL), 120, NEUTRAL),
  ];

  for (let seedIndex = 0; seedIndex < CFG.gates.formationSampleSeeds; seedIndex++) {
    const B = createBattle({
      seed: CFG.gates.formationSampleSeedBase + seedIndex * CFG.gates.formationSampleSeedStep,
      players: [
      { side: SIDE.L, commander: NEUTRAL },
      { side: SIDE.R, commander: NEUTRAL },
      ],
    });
    for (const s of B.structures) {
      if (s.kind === 'bastion') s.hp = 0;
      else s.hp = s.maxHp = Number.POSITIVE_INFINITY;
    }
    for (const bp of blueprints) {
      spawnCohort(B, player(B, SIDE.L), bp, 0);
      spawnCohort(B, player(B, SIDE.R), bp, 0);
    }

    for (let tick = 0; tick < CFG.gates.formationSampleDuration / DT; tick++) {
      step(B, DT);
      if (!B.stats.attacks.length) continue;
      const live = B.units.filter((u) => u.hp > 0);

      for (const side of [SIDE.L, SIDE.R]) {
        const guards = live.filter((u) => u.side === side && u.role === 'guard');
        const artillery = live.filter((u) => u.side === side && u.role === 'artillery');
        if (guards.length && artillery.length) {
          gaps.push(Math.abs(
            quantile(guards.map((u) => u.x), 0.5) -
            quantile(artillery.map((u) => u.x), 0.5)));
        }
      }

      for (const target of live) {
        const meleeAtTarget = live.filter((u) =>
          u.side !== target.side && u.role !== 'artillery' &&
          u.target === target &&
          Math.hypot(
            u.x - target.x,
            (u.lane - target.lane) * CFG.field.laneSpacing,
          ) <= u.range + Number.EPSILON).length;
        if (meleeAtTarget) occupancies.push(meleeAtTarget);
      }

      for (const u of live) {
        overlaps.push(live.filter((e) =>
          e.side === u.side &&
          Math.abs(e.x - u.x) <= CFG.gates.allyOverlapHalfWidth + Number.EPSILON).length);
      }
    }
  }
  return { gaps, occupancies, overlaps };
}

function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length * q)] : 0;
}

/** Isolate the split axis: identical design, only the member count differs. */
function reportSplit() {
  console.log('\n=== Split check (one design as 1/2/3/5 bodies vs a crushing elite) ===');
  const base = stubInterpret('강철 창병', NEUTRAL);
  for (const n of [1, 2, 3, 5]) {
    const intent = { ...base, requestedCount: n, cohort: n === 1 ? 'elite' : n >= 5 ? 'swarm' : 'pack' };
    const bp = compile(intent, 120, NEUTRAL);
    let wins = 0, ok = 0;
    for (let s = 0; s < 3; s++) for (const swap of [false, true]) {
      const B = createBattle({ seed: 500 + s * 91, players: [
        { side: SIDE.L, commander: NEUTRAL }, { side: SIDE.R, commander: NEUTRAL }]});
      const foe = compile(stubInterpret(byKey.elite, NEUTRAL), 120, NEUTRAL);
      B.players[0].essence = 9999; B.players[1].essence = 9999;
      queueContract(B, swap ? SIDE.R : SIDE.L, bp, 0);
      queueContract(B, swap ? SIDE.L : SIDE.R, foe, 0);
      const mySide = swap ? SIDE.R : SIDE.L;
      for (let i = 0; i < 60 * 20 && !B.over; i++) {
        step(B, DT);
        const mine = B.units.filter((u) => u.side === mySide && u.hp > 0);
        const th = B.units.filter((u) => u.side !== mySide && u.hp > 0);
        if (B.wave >= 1 && (!mine.length || !th.length)) {
          if (mine.length) wins++;
          ok++;
          console.log(`  x${n}: total HP ${Math.round(bp.totalHp)}, overkill ${Math.round((B.stats.overkill / Math.max(1, B.stats.rawDamage)) * 100)}%`);
          break;
        }
      }
    }
    console.log(`  -> x${n} win rate ${Math.round((wins / 6) * 100)}%  (split cost ${CFG.cost.splitCost[n]} BP)`);
  }
}

function reportMatches() {
  console.log('\n=== Commander matches, bot vs bot (sides alternate, 8 seeds per pairing) ===');
  const demons = COMMANDERS.filter((c) => c.faction === 'demon').map((c) => c.id);
  const humans = COMMANDERS.filter((c) => c.faction === 'human').map((c) => c.id);
  const lens = [], all = [];
  for (const d of demons) {
    for (const h of humans) {
      let dw = 0, n = 0;
      for (let s = 0; s < 4; s++) for (const dl of [true, false]) {
        const r = fullMatch(d, h, 7000 + s * 991, false, dl);
        lens.push(r.t); all.push(r);
        if (r.winner === d) dw++;
        n++;
      }
      console.log(`  ${`${d} vs ${h}`.padEnd(26)} demon win rate ${String(Math.round((dw / n) * 100)).padStart(3)}%`);
    }
  }
  lens.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.floor(arr.length * p)];
  const otRate = all.filter((r) => r.overtime).length / all.length;
  const normal = all.filter((r) => !r.overtime).length / all.length;
  const stall = all.filter((r) => r.stallWaves >= 6).length / all.length;
  const ageFrac = all.reduce((s, r) => s + r.ageDeathFrac, 0) / all.length;
  const ageDeaths = all.reduce((s, r) => s + r.ageDeaths, 0);
  const combatDeaths = all.reduce((s, r) => s + r.combatDeaths, 0);
  const ageHard = all.reduce((s, r) => s + r.ageHardDeaths, 0);
  const ageDecay = all.reduce((s, r) => s + r.ageDecayDeaths, 0);
  const agingBeforeAttack = all.reduce((s, r) => s + r.agingBeforeAttack, 0);
  const activeEnemyHard = all.reduce((s, r) => s + r.activeEnemyHardDeaths, 0);
  const pooledAgeFrac = ageDeaths / Math.max(1, ageDeaths + combatDeaths);
  console.log(`\n  match length: p10 ${fmt(q(lens, .1))} / median ${fmt(q(lens, .5))} / p90 ${fmt(q(lens, .9))}  (target median ${fmt(CFG.pacing.targetMedian)})`);
  console.log(`  decided before overtime: ${Math.round(normal * 100)}%  (target >= 80%)`);
  console.log(`  reached overtime: ${Math.round(otRate * 100)}%  (target <= 15%)`);
  console.log(`  stalled front (centre ±3 m for 6+ waves): ${Math.round(stall * 100)}%  (target < 25%)`);
  console.log(`  deaths from old age: pooled ${Math.round(pooledAgeFrac * 100)}% / per-match mean ${Math.round(ageFrac * 100)}%  (target < 5%)`);
  console.log(`    hard ${ageHard} · decay ${ageDecay} · before first attack ${agingBeforeAttack} · hard while fighting in enemy half ${activeEnemyHard} / all ${ageDeaths}`);
}

function reportDiagnosis() {
  console.log('\n=== Why raiders lose: counterfactual duels (6 games, sides swapped; survival vs the winner\'s own starting value) ===');
  diagnosticRow('assassin->archer baseline', 'assassin', 'archer');
  diagnosticRow('beast->archer baseline', 'beast', 'archer');
  diagnosticRow('beast->golem baseline', 'beast', 'golem');
  diagnosticRow('elite->archer baseline', 'elite', 'archer');
  diagnosticRow('assassin: old lane-sort bug', 'assassin', 'archer', {}, () =>
    withSetting(CFG.combat, 'meleeLaneHold', false));
  diagnosticRow('beast: old lane-sort bug', 'beast', 'archer', {}, () =>
    withSetting(CFG.combat, 'meleeLaneHold', false));
  diagnosticRow('assassin: no bastions', 'assassin', 'archer', { withStructures: false });
  diagnosticRow('beast: no bastions', 'beast', 'archer', { withStructures: false });

  diagnosticRow('assassin: no range first-shot', 'assassin', 'archer', {
    transformB: (bp) => ({ ...bp, range: CFG.cost.rangeBase }),
  });
  diagnosticRow('beast: no lane distance', 'beast', 'archer', {}, () =>
    withSetting(CFG.field, 'laneSpacing', 0));
  diagnosticRow('beast: no charge', 'beast', 'archer', {
    transformA: (bp) => ({ ...bp, skills: bp.skills.filter((s) => s !== 'charge') }),
  });
  diagnosticRow('beast: 12 BP moved to HP', 'beast', 'archer', {
    transformA: (bp) => shiftDpsToHp(bp, 12),
  });
  diagnosticRow('assassin: 12 BP moved to HP', 'assassin', 'archer', {
    transformA: (bp) => shiftDpsToHp(bp, 12),
  });
  diagnosticRow('beast->golem: no ward', 'beast', 'golem', {
    transformB: (bp) => ({ ...bp, skills: bp.skills.filter((s) => s !== 'ward') }),
  });

  const oldRaider = CFG.combat.engageWindupMul.raider;
  const oldArtillery = CFG.combat.engageWindupMul.artillery;
  CFG.combat.engageWindupMul.raider = 0.5;
  CFG.combat.engageWindupMul.artillery = 1.25;
  diagnosticRow('assassin: artillery windup 1.0s', 'assassin', 'archer');
  diagnosticRow('beast: artillery windup 1.0s', 'beast', 'archer');
  CFG.combat.engageWindupMul.raider = oldRaider;
  CFG.combat.engageWindupMul.artillery = oldArtillery;

  const oldChargeDash = SKILLS.charge.params.dash;
  SKILLS.charge.params.dash = 8;
  diagnosticRow('beast: charge 4→8m', 'beast', 'archer');
  SKILLS.charge.params.dash = oldChargeDash;
}

function reportTrace() {
  for (const [a, b] of [['assassin', 'archer'], ['beast', 'archer'], ['beast', 'golem']]) {
    const r = cohortDuel(byKey[a], byKey[b], 3100, false, { withStructures: true });
    console.log(`\n${a}→${b}: ${JSON.stringify({
      winner: r.winner,
      remainFrac: r.remainFrac,
      firstAttackGap: r.firstAttackGap,
      aFirstAttackTimes: r.aFirstAttackTimes,
      bFirstAttackTimes: r.bFirstAttackTimes,
      aDamage: r.aDamage,
      bDamage: r.bDamage,
      damageToABeforeFirstAttack: r.damageToABeforeFirstAttack,
      charges: r.aCharges,
      deaths: r.deaths,
    }, null, 2)}`);
  }
}

function diagnosticRow(label, a, b, opts = {}, setting = null) {
  opts = { withStructures: true, ...opts };
  const restore = setting?.();
  const out = [];
  for (let s = 0; s < 3; s++) for (const swap of [false, true]) {
    out.push(cohortDuel(byKey[a], byKey[b], 3100 + s * 137, swap, opts));
  }
  restore?.();
  const wins = out.filter((r) => r.winner === 'A').length;
  const draws = out.filter((r) => r.winner === 'draw' || r.winner === 'timeout').length;
  const score = (wins + draws * 0.5) / out.length;
  const median = (xs) => {
    const ys = xs.filter(Number.isFinite).sort((x, y) => x - y);
    return ys.length ? ys[Math.floor(ys.length / 2)] : 0;
  };
  const aPlanned = out.reduce((s, r) => s + r.aDamage.planned, 0);
  const bPlanned = out.reduce((s, r) => s + r.bDamage.planned, 0);
  const aOverkill = out.reduce((s, r) => s + r.aDamage.overkill, 0) / Math.max(1, aPlanned);
  const bOverkill = out.reduce((s, r) => s + r.bDamage.overkill, 0) / Math.max(1, bPlanned);
  const shield = out.reduce((s, r) => s + r.aDamage.shield, 0) / out.length;
  const noAttack = out.reduce((s, r) => s + r.aNoAttackDeaths, 0);
  const charges = out.reduce((s, r) => s + r.aCharges, 0) / out.length;
  console.log(
    `  ${label.padEnd(32)} score${String(Math.round(score * 100)).padStart(4)}% ` +
    `kept${String(Math.round(median(out.map((r) => r.remainFrac)) * 100)).padStart(4)}% ` +
    `first-hit gap${median(out.map((r) => r.firstAttackGap)).toFixed(2).padStart(6)}s ` +
    `dmg before own hit${Math.round(median(out.map((r) => r.damageToABeforeFirstAttack))).toString().padStart(5)} ` +
    `arrival spread${median(out.map((r) => r.aArrivalSpread)).toFixed(2).padStart(6)}s ` +
    `died unattacking${String(noAttack).padStart(3)} ` +
    `overkill A/B ${Math.round(aOverkill * 100)}/${Math.round(bOverkill * 100)}% ` +
    `ward absorbed${Math.round(shield).toString().padStart(4)} charges ${charges.toFixed(1)}`);
}

function shiftDpsToHp(bp, amountBp) {
  const n = bp.count;
  bp.totalHp += amountBp * CFG.cost.hpPerBp;
  bp.totalDps = Math.max(0, bp.totalDps - amountBp * CFG.cost.dpsPerBp);
  bp.hp = bp.totalHp / n;
  bp.dps = bp.totalDps / n;
  return bp;
}

function withSetting(obj, key, value) {
  const old = obj[key];
  obj[key] = value;
  return () => { obj[key] = old; };
}

// ---------------------------------------------------------------- main
const mode = process.argv[2] ?? 'all';
if (mode === 'duel') {
  console.log('=== One match, wave by wave (lucifer vs smith) ===');
  const r = fullMatch('lucifer', 'smith', 4242, true);
  console.log(`\nresult: ${r.winner} wins · ${fmt(r.t)} · ${r.waves} waves · ${END_REASON[r.reason] ?? r.reason}`);
} else if (mode === 'prompts') reportCompile();
else if (mode === 'mirror') reportMirror();
else if (mode === 'triangle') {
  reportCompile();
  const triangle = reportTriangle();
  reportPromptViability(triangle.matrix);
  reportFormationGate(triangle.firstEngagements);
}
else if (mode === 'matches') reportMatches();
else if (mode === 'split') reportSplit();
else if (mode === 'diagnose') reportDiagnosis();
else if (mode === 'trace') reportTrace();
else {
  reportCompile();
  reportMirror();
  const triangle = reportTriangle();
  reportPromptViability(triangle.matrix);
  reportFormationGate(triangle.firstEngagements);
  reportMatches();
}
