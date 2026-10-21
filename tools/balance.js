// @ts-check
// Headless balance harness — runs the exact sim the browser runs.
//
//   node tools/balance.js            full sweep
//   node tools/balance.js prompts    prompt -> stat compile table
//   node tools/balance.js mirror     order-fairness check (must be ~50/50)
//   node tools/balance.js duel       one verbose match, wave by wave

import {
  createBattle, step, queueContract, spawnCohort,
  player, other, structOf, SIDE, roleLabel,
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

const NEUTRAL = { id: 'neutral', faction: 'demon', name: '중립', bias: {}, mechanic: { id: 'none' } };

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
  return {
    winner: 'timeout', remainFrac: 0, fight: 0, overkillFrac: 0, crossLane: 0,
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
          `w${String(B.wave).padStart(2)} ${fmt(B.t)} | 전선 ${pct(frontPct(B))} | ` +
          `L 보루${pct(lb.hp / lb.maxHp)} 코어${pct(l.hp / l.maxHp)} · R 보루${pct(rb.hp / rb.maxHp)} 코어${pct(r.hp / r.maxHp)} | ` +
          `유닛 ${B.units.filter((u) => u.side === SIDE.L && u.hp > 0).length}v${B.units.filter((u) => u.side === SIDE.R && u.hp > 0).length}`);
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
const pct = (v) => `${String(Math.round(v * 100)).padStart(3)}%`;
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- reports
function reportCompile() {
  console.log('\n=== 프롬프트 해석 & BP 컴파일 (중립 사령관, 120BP) ===');
  for (const r of REFERENCE) {
    const intent = stubInterpret(r.text, NEUTRAL);
    const bp = compile(intent, 120, NEUTRAL);
    console.log(
      `${r.key.padEnd(9)} ${roleLabel(bp.role).padEnd(4)} ${String(bp.count).padStart(2)}기 ` +
      `HP${String(Math.round(bp.totalHp)).padStart(4)} DPS${String(Math.round(bp.totalDps)).padStart(3)} ` +
      `R${bp.range.toFixed(1)} V${bp.speed.toFixed(1)} ${bp.channel === 'arcane' ? '비술' : '물리'} ` +
      `${bp.cadenceLabel} 저항${Math.round(bp.resistPhysical * 100)} ` +
      `[${bp.skills.join(',') || '-'}] ${bp.breakdown.total}/${bp.breakdown.budget}BP`);
  }
}

/** ORDER FAIRNESS: the same cohort on both sides must not favour a side. */
function reportMirror() {
  console.log('\n=== 순서 공정성 — 동일 편제 미러전 (좌측 승률, 목표 45~55%) ===');
  let worst = 0;
  for (const r of REFERENCE) {
    let lw = 0, draws = 0;
    const N = 12;
    for (let s = 0; s < N; s++) {
      const out = cohortDuel(r.text, r.text, 2000 + s * 613);
      if (out.winner === 'A') lw++;
      else if (out.winner === 'draw' || out.winner === 'timeout') draws++;
    }
    // Simultaneous wipes are PROOF of symmetry, not evidence of bias — they must
    // not count toward the left-side win rate.
    const decided = N - draws;
    if (decided === 0) {
      console.log(`  ${r.key.padEnd(9)} 완전 대칭 (${N}/${N} 동시 전멸)`);
      continue;
    }
    const rate = Math.round((lw / decided) * 100);
    worst = Math.max(worst, Math.abs(rate - 50));
    console.log(`  ${r.key.padEnd(9)} 좌측 ${String(rate).padStart(3)}%  (승부 ${decided}/${N}, 동시전멸 ${draws})`);
  }
  console.log(`  → 최대 편향 ${worst}%p ${worst <= 20 ? '(합격)' : '(불합격: 처리 순서 편향 잔존)'}`);
}

function reportTriangle() {
  console.log('\n=== 상성 행렬 (120BP, 좌우 교대 6쌍 평균, 행이 열을 이긴 비율) ===');
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
  console.log(`\n  역방향 승률 합 편차(최대): ${Math.round(asymWorst)}%p ${asymWorst <= 20 ? '(합격)' : '(불합격)'}` +
    (undecided ? `  · 전부 동시전멸이라 판정 제외한 쌍 ${undecided}개` : ''));
  console.log(`  교전 지속: p10 ${p(fights, .1).toFixed(1)}s / p50 ${p(fights, .5).toFixed(1)}s / p90 ${p(fights, .9).toFixed(1)}s  (목표 p50 10~14s, p10 ≥7s)`);
  console.log(`  승자 잔존 전투가치: p50 ${Math.round(p(remains, .5) * 100)}%  (목표 15~30%)`);
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

  console.log('\n=== 프롬프트 생존성 게이트 (무승부=0.5승) ===');
  console.log('  편제 평균: ' + rows.map((r) => `${r.key}=${Math.round(r.mean * 100)}%`).join(' '));
  console.log(`  개별 상성 셀 30~70% 이탈(정보용): ${hardCells.length}/${pairScores.length} cells`);
  console.log(`  최약 평균: ${weakestMean.key} ${pct(weakestMean.mean)}  (하한 30%)`);
  console.log(`  최강 평균: ${strongestMean.key} ${pct(strongestMean.mean)}  (상한 70%)`);
  console.log(`  최약 편제의 최고 상성: ${weakestBest.key} ${pct(weakestBest.best)}  (하한 50%)`);
  console.log(`  편제별 평균 승점 표준편차: ${(rowSd * 100).toFixed(1)}%p  (상한 12%p)`);
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

  console.log('\n=== 진형·가시성 게이트 (헤드리스 실측) ===');
  console.log(
    `  전열↔포격 후열 x 간격: p50 ${gap.toFixed(2)}m ` +
    `(하한 ${CFG.gates.formationGapMin.toFixed(1)}m, n=${geometry.gaps.length})`);
  console.log(
    `  일반 타깃 근접 점유: p95 ${occupancy.toFixed(0)}기 ` +
    `(상한 ${CFG.gates.meleeOccupancyP95Max}기)`);
  console.log(
    `  동일 x±${CFG.gates.allyOverlapHalfWidth.toFixed(1)}m 아군 중첩: ` +
    `p95 ${overlap.toFixed(0)}기 (상한 ${CFG.gates.allyOverlapP95Max}기)`);
  console.log(
    `  첫 교전 시각: p50 ${first.toFixed(2)}s / 기준 ${baseline.toFixed(2)}s / ` +
    `변화 ${(change * 100).toFixed(1)}% ` +
    `(허용 ±${Math.round(CFG.gates.firstEngagementTolerance * 100)}%)`);
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
  console.log('\n=== 분할 검증 (동일 설계를 1/2/3/5기로 복제, vs 강타 엘리트) ===');
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
          console.log(`  ${n}기: 총HP${Math.round(bp.totalHp)} 오버킬 ${Math.round((B.stats.overkill / Math.max(1, B.stats.rawDamage)) * 100)}%` + (ok === 1 ? '' : ''));
          break;
        }
      }
    }
    console.log(`  → ${n}기 승률 ${Math.round((wins / 6) * 100)}%  (분할세 ${CFG.cost.splitCost[n]}BP)`);
  }
}

function reportMatches() {
  console.log('\n=== 사령관 풀매치 (좌우 교대, 조합당 8시드) ===');
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
      console.log(`  ${`${d} vs ${h}`.padEnd(26)} 마계 승률 ${String(Math.round((dw / n) * 100)).padStart(3)}%`);
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
  console.log(`\n  경기 길이: p10 ${fmt(q(lens, .1))} / 중앙값 ${fmt(q(lens, .5))} / p90 ${fmt(q(lens, .9))}  (목표 중앙값 ${fmt(CFG.pacing.targetMedian)})`);
  console.log(`  오버타임 전 정상 결착: ${Math.round(normal * 100)}%  (목표 ≥80%)`);
  console.log(`  균열 붕괴 진입률: ${Math.round(otRate * 100)}%  (목표 ≤15%)`);
  console.log(`  전선 교착(중앙±3m 6웨이브 이상): ${Math.round(stall * 100)}%  (목표 <25%)`);
  console.log(`  노화 사망 비율: pooled ${Math.round(pooledAgeFrac * 100)}% / 경기별 평균 ${Math.round(ageFrac * 100)}%  (목표 <5%)`);
  console.log(`    hard ${ageHard} · decay ${ageDecay} · 첫 공격 전 ${agingBeforeAttack} · 적진 교전중 hard ${activeEnemyHard} / 노화사 ${ageDeaths}`);
}

function reportDiagnosis() {
  console.log('\n=== 습격자 열세 기여도 진단 (좌우 교대 6전, 잔존은 승자 자체 시작가치 기준) ===');
  diagnosticRow('assassin→archer 기준', 'assassin', 'archer');
  diagnosticRow('beast→archer 기준', 'beast', 'archer');
  diagnosticRow('beast→golem 기준', 'beast', 'golem');
  diagnosticRow('elite→archer 기준', 'elite', 'archer');
  diagnosticRow('assassin: 레인 정렬 버그 복원', 'assassin', 'archer', {}, () =>
    withSetting(CFG.combat, 'meleeLaneHold', false));
  diagnosticRow('beast: 레인 정렬 버그 복원', 'beast', 'archer', {}, () =>
    withSetting(CFG.combat, 'meleeLaneHold', false));
  diagnosticRow('assassin: 보루 제거', 'assassin', 'archer', { withStructures: false });
  diagnosticRow('beast: 보루 제거', 'beast', 'archer', { withStructures: false });

  diagnosticRow('assassin: 사거리 선공 제거', 'assassin', 'archer', {
    transformB: (bp) => ({ ...bp, range: CFG.cost.rangeBase }),
  });
  diagnosticRow('beast: 레인거리 제거', 'beast', 'archer', {}, () =>
    withSetting(CFG.field, 'laneSpacing', 0));
  diagnosticRow('beast: charge 제거', 'beast', 'archer', {
    transformA: (bp) => ({ ...bp, skills: bp.skills.filter((s) => s !== 'charge') }),
  });
  diagnosticRow('beast: HP로 12BP 이동', 'beast', 'archer', {
    transformA: (bp) => shiftDpsToHp(bp, 12),
  });
  diagnosticRow('assassin: HP로 12BP 이동', 'assassin', 'archer', {
    transformA: (bp) => shiftDpsToHp(bp, 12),
  });
  diagnosticRow('beast→golem: ward 제거', 'beast', 'golem', {
    transformB: (bp) => ({ ...bp, skills: bp.skills.filter((s) => s !== 'ward') }),
  });

  const oldRaider = CFG.combat.engageWindupMul.raider;
  const oldArtillery = CFG.combat.engageWindupMul.artillery;
  CFG.combat.engageWindupMul.raider = 0.5;
  CFG.combat.engageWindupMul.artillery = 1.25;
  diagnosticRow('assassin: 포격 준비 1.0s', 'assassin', 'archer');
  diagnosticRow('beast: 포격 준비 1.0s', 'beast', 'archer');
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
    `  ${label.padEnd(29)} 승점${String(Math.round(score * 100)).padStart(3)}% ` +
    `잔존${String(Math.round(median(out.map((r) => r.remainFrac)) * 100)).padStart(3)}% ` +
    `선공차${median(out.map((r) => r.firstAttackGap)).toFixed(2).padStart(5)}s ` +
    `첫타전피해${Math.round(median(out.map((r) => r.damageToABeforeFirstAttack))).toString().padStart(4)} ` +
    `도착폭${median(out.map((r) => r.aArrivalSpread)).toFixed(2).padStart(5)}s ` +
    `무공격사${String(noAttack).padStart(2)} ` +
    `오버킬 A/B ${Math.round(aOverkill * 100)}/${Math.round(bOverkill * 100)}% ` +
    `방벽흡수${Math.round(shield).toString().padStart(3)} 돌진${charges.toFixed(1)}`);
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
  console.log('=== 단일 경기 상세 (루시퍼 vs 대장장이) ===');
  const r = fullMatch('lucifer', 'smith', 4242, true);
  console.log(`\n결과: ${r.winner} 승 · ${fmt(r.t)} · ${r.waves}웨이브 · ${r.reason}`);
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
