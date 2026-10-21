// "Feel" metrics — the numbers behind the three values that look wrong.
// Everything here is measurable; none of it needed a human to play first.
//
//   node tools/feel.mjs
import { createBattle, step, queueContract, player, structOf, spawnCohort, SIDE, other } from '../src/engine/sim.js';
import { compile } from '../src/domain/budget.js';
import { stubInterpret } from '../src/gen/interpreter.js';
import { getCommander } from '../src/domain/commanders.js';
import { botThink } from '../src/ai/bot.js';
import { CFG } from '../src/config.js';

const DT = 0.05;
const N = { id: 'neutral', faction: 'demon', name: '중립', bias: {}, mechanic: { id: 'none' } };
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- 1. siege speed
// How long does a cohort standing on an undefended structure take to break it?
function siegeTime(text, target) {
  const B = createBattle({ seed: 7, players: [{ side: SIDE.L, commander: N }, { side: SIDE.R, commander: N }] });
  const bp = compile(stubInterpret(text, N), 120, N);
  B.players[0].essence = 9999;
  spawnCohort(B, B.players[0], bp, 0);
  // remove the enemy bastion when we are timing the core, so we time one structure
  if (target === 'core') {
    const bast = structOf(B, SIDE.R, 'bastion');
    bast.hp = 0;
  }
  const s = structOf(B, SIDE.R, target);
  const hp0 = s.hp;
  let contact = null;
  for (let i = 0; i < 60 * 20 * 12 && s.hp > 0; i++) {
    step(B, DT);
    if (contact == null && s.hp < hp0) contact = B.t;
  }
  return { contact, broke: s.hp <= 0 ? B.t : null, dur: s.hp <= 0 && contact != null ? B.t - contact : null, hp0 };
}

console.log('\n=== 1. 구조물 파괴 속도 (무방비 상태, 표준 120BP 한 편제) ===');
console.log('   coreDamageMul =', CFG.combat.coreDamageMul, ' 보루 HP', CFG.structures.bastionHp, '· 코어 HP', CFG.structures.coreHp);
for (const [label, text] of [['방패병 셋', '앞을 막아서는 두꺼운 방패병 셋'], ['자객 셋', '적 후열을 파고드는 날렵한 그림자 자객 셋'], ['장궁대 셋', '멀리서 꿰뚫는 강철 장궁대']]) {
  for (const target of ['bastion', 'core']) {
    const r = siegeTime(text, target);
    const name = target === 'bastion' ? '보루' : '코어';
    console.log(`   ${label.padEnd(9)} → ${name}: 접촉 ${r.contact == null ? '못함' : fmt(r.contact)}` +
      (r.dur == null ? ' · 시간 내 파괴 실패' : ` · 파괴까지 ${r.dur.toFixed(1)}초`));
  }
}

// ---------------------------------------------------------------- 2. real matches
console.log('\n=== 2. 실제 경기에서 코어가 녹는 속도 (봇 대 봇 24판) ===');
const rows = [];
for (const [a, b] of [['lucifer', 'smith'], ['abaddon', 'alchemist'], ['baal', 'headsman']]) {
  for (let s = 0; s < 8; s++) {
    const ca = getCommander(a), cb = getCommander(b);
    const B = createBattle({ seed: 100 + s * 37, players: [
      { side: SIDE.L, commander: ca, isBot: true }, { side: SIDE.R, commander: cb, isBot: true }] });
    let next = 1, guard = 0;
    const track = [];
    while (!B.over && guard++ < 60 * 20 * 12) {
      step(B, DT);
      if (B.wave >= next) { next = B.wave + 1; for (const p of B.players) botThink(B, p.side); }
      if (guard % 20 === 0) {
        const l = structOf(B, SIDE.L, 'core'), r = structOf(B, SIDE.R, 'core');
        track.push({ t: B.t, lo: Math.min(l.hp / l.maxHp, r.hp / r.maxHp) });
      }
    }
    const firstHit = B.stats.firstCoreHit;
    // time from "core first scratched" to "core dead"
    const span = firstHit == null ? null : B.t - firstHit;
    // how long the losing core spent between 100%->50% and 50%->0%
    const half = track.find((x) => x.lo <= 0.5)?.t ?? null;
    rows.push({ t: B.t, firstHit, span, half, bast: B.stats.firstBastionHit });
  }
}
const num = (xs) => xs.filter((x) => x != null).sort((x, y) => x - y);
const p = (xs, q) => (xs.length ? xs[Math.floor(xs.length * q)] : NaN);
const spans = num(rows.map((r) => r.span));
const firsts = num(rows.map((r) => r.firstHit));
const halves = num(rows.map((r) => r.half));
const lens = num(rows.map((r) => r.t));
console.log(`   경기 길이            중앙 ${fmt(p(lens, .5))}  (p10 ${fmt(p(lens, .1))} / p90 ${fmt(p(lens, .9))})`);
console.log(`   첫 보루 타격         중앙 ${fmt(p(num(rows.map((r) => r.bast)), .5))}`);
console.log(`   첫 코어 타격         중앙 ${fmt(p(firsts, .5))}`);
console.log(`   코어 첫 타격→파괴     중앙 ${p(spans, .5)?.toFixed(1)}초  (p10 ${p(spans, .1)?.toFixed(1)} / p90 ${p(spans, .9)?.toFixed(1)})`);
console.log(`   패자 코어 50% 도달   중앙 ${fmt(p(halves, .5))}  → 경기의 ${Math.round(p(halves, .5) / p(lens, .5) * 100)}% 지점`);

// ---------------------------------------------------------------- 3. attrition curves
console.log('\n=== 3. 소모전 곡선이 실제로 어떻게 휘는가 ===');
console.log(`   cohortDpsRetention = ${CFG.combat.cohortDpsRetention}  ·  woundedDpsBonus = ${CFG.combat.woundedDpsBonus}`);
{
  const bp = compile(stubInterpret('값싼 하급 군단 다섯, 수로 밀어붙인다', N), 120, N);
  const per = bp.dps, n = bp.count;
  const ret = CFG.combat.cohortDpsRetention ?? 0;
  console.log(`   5기 편제(기당 DPS ${per.toFixed(0)}, 총 ${(per * n).toFixed(0)}):`);
  for (const dead of [0, 1, 2, 3, 4]) {
    const alive = n - dead;
    const share = alive > 0 ? per * (1 + (ret * dead) / alive) : 0;
    console.log(`     ${dead}기 전사 → 생존 ${alive}기 · 기당 ${share.toFixed(0)} · 편제 총 ${(share * alive).toFixed(0)} ` +
      `(원래의 ${Math.round((share * alive) / (per * n) * 100)}%)`);
  }
  const w = CFG.combat.woundedDpsBonus ?? 0;
  console.log(`   부상 보너스: HP 100%→${(1).toFixed(2)}배 · 50%→${(1 + w * 0.5).toFixed(2)}배 · 10%→${(1 + w * 0.9).toFixed(2)}배`);
}
