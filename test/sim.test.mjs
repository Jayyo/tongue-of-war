// The simulation must be a pure function of (seed, commands): the balance harness,
// the mirror gate and any future replay all depend on that.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, step, queueContract, SIDE, structOf } from '../src/engine/sim.js';
import { compile } from '../src/domain/budget.js';
import { stubInterpret } from '../src/gen/interpreter.js';
import { getCommander } from '../src/domain/commanders.js';
import { botThink } from '../src/ai/bot.js';

const DT = 0.05;
const NEUTRAL = { id: 'neutral', faction: 'demon', name: 'neutral', bias: {}, mechanic: { id: 'none' } };

function botMatch(a, b, seed) {
  const B = createBattle({ seed, players: [
    { side: SIDE.L, commander: getCommander(a), isBot: true },
    { side: SIDE.R, commander: getCommander(b), isBot: true },
  ] });
  const samples = [];
  let nextWave = 1;
  while (!B.over && B.tick < 20 * 600) {
    step(B, DT);
    if (B.wave >= nextWave) { nextWave = B.wave + 1; for (const p of B.players) botThink(B, p.side); }
    if (B.tick % 100 === 0) samples.push(B.units.filter((u) => u.hp > 0).map((u) => `${u.side}${u.x.toFixed(5)}/${u.hp.toFixed(4)}`).sort().join());
  }
  return { winner: B.winner, t: B.t, cores: B.structures.map((s) => s.hp), samples };
}

test('same seed, same match', () => {
  const first = botMatch('baal', 'alchemist', 31);
  const again = botMatch('baal', 'alchemist', 31);
  assert.deepEqual(again, first);
  assert.ok(first.samples.length > 20);
});

/** One identical cohort per side, no structures in the way, run until a side is gone. */
function mirror(text, seed) {
  const B = createBattle({ seed, players: [{ side: SIDE.L, commander: NEUTRAL }, { side: SIDE.R, commander: NEUTRAL }] });
  for (const s of B.structures) {
    if (s.kind === 'bastion') s.hp = 0;
    else s.hp = s.maxHp = Number.POSITIVE_INFINITY;
  }
  for (const side of [SIDE.L, SIDE.R]) {
    B.players[side].essence = 9999;
    queueContract(B, side, compile(stubInterpret(text, NEUTRAL), 120, NEUTRAL), 0);
  }
  const value = (side) => B.units.filter((u) => u.side === side && u.hp > 0).reduce((s, u) => s + u.hp, 0);
  for (let i = 0; i < 20 * 60; i++) {
    step(B, DT);
    if (B.wave >= 1 && (!value(SIDE.L) || !value(SIDE.R))) break;
  }
  return [value(SIDE.L), value(SIDE.R)];
}

test('mirror matches end exactly even (no processing-order bias)', () => {
  // The first engine updated units in array order and the left side won 12/12
  // mirror matches. Planning against frozen state and applying damage together
  // fixed it; this keeps it fixed.
  for (const text of ['두꺼운 갑옷을 두른 방패 수문장 셋', '은폐한 채 접근하는 독칼 암살자 셋', '광역으로 휩쓰는 화염 폭발 술사', '돌진하는 흉포한 야수 무리 다섯']) {
    for (const seed of [2000, 2613, 3226]) {
      const [l, r] = mirror(text, seed);
      assert.equal(l, r, `${text} seed ${seed}: left ${l} vs right ${r}`);
    }
  }
});

test('a match always ends by the hard time limit', () => {
  const r = botMatch('smith', 'smith', 5);
  assert.ok(r.winner === SIDE.L || r.winner === SIDE.R);
  assert.ok(r.t <= 540 + DT);
});
