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
  const alive = (side) => B.units.some((u) => u.side === side && u.hp > 0);
  for (let i = 0; i < 20 * 60; i++) {
    step(B, DT);
    if (B.wave >= 1 && (!alive(SIDE.L) || !alive(SIDE.R))) break;
  }
  return { left: alive(SIDE.L), right: alive(SIDE.R), t: B.t };
}

test('identical cohorts wipe each other out on the same tick', () => {
  // The first engine updated units in array order and the left side won 12/12
  // mirror matches. Planning against frozen state and applying damage together
  // fixed it; this keeps it fixed. These designs always meet and fight it out
  // inside a minute (tanky or veiled ones can time out instead).
  for (const text of ['적 후열 포격수를 파고드는 날렵한 그림자 자객 셋', '광역으로 휩쓰는 화염 폭발 술사', '돌진하는 흉포한 야수 무리 다섯', '정밀하게 꿰뚫는 강철 장궁대']) {
    for (const seed of [2000, 2613, 3226]) {
      const r = mirror(text, seed);
      assert.ok(!r.left && !r.right && r.t < 60, `${text} seed ${seed}: left ${r.left} right ${r.right} at ${r.t.toFixed(2)}s`);
    }
  }
});

test('a match always ends by the hard time limit', () => {
  const r = botMatch('smith', 'smith', 5);
  assert.ok(r.winner === SIDE.L || r.winner === SIDE.R);
  assert.ok(r.t <= 540 + DT);
});
