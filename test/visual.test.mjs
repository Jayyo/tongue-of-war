// The appearance path reads the same sentence but must never move a stat.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stubInterpret } from '../src/gen/interpreter.js';
import { interpretVisual } from '../src/gen/visual.js';
import { compile } from '../src/domain/budget.js';

const NEUTRAL = { id: 'neutral', faction: 'demon', name: 'neutral', bias: {}, mechanic: { id: 'none' } };
/** The whole blueprint except its display name and the parser's confidence score. */
const stats = (text) => {
  const { name, confidence, ...rest } = compile(stubInterpret(text, NEUTRAL), 120, NEUTRAL);
  return rest;
};

test('appearance-only words do not change a single stat', () => {
  assert.deepEqual(stats('왕관을 쓴 방패병 셋'), stats('방패병 셋'));   // "crowned shieldmen x3"
  assert.deepEqual(stats('후드를 쓴 궁수 셋'), stats('궁수 셋'));       // "hooded archers x3"
});

test('a tank is drawn as a landship, and missing art is admitted', () => {
  const tank = interpretVisual('탱크 셋', stubInterpret('탱크 셋', NEUTRAL), NEUTRAL);
  assert.equal(tank.concept, 'landship');
  assert.equal(tank.rigReady, true);
  const catapult = interpretVisual('투석기 둘', stubInterpret('투석기 둘', NEUTRAL), NEUTRAL);
  assert.equal(catapult.rigReady, false);          // no catapult parts yet
  assert.equal(catapult.fallback.used, true);
});

test('the enemy clause does not decide what we look like', () => {
  const text = '적 해골 궁수를 잡는 암살자 셋';              // "assassins x3 that hunt enemy skeleton archers"
  const v = interpretVisual(text, stubInterpret(text, NEUTRAL), NEUTRAL);
  assert.equal(v.roleSilhouette, 'raider');
  assert.notEqual(v.concept, 'marksman');
});
