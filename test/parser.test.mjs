// Sentence -> UnitIntent golden cases. The parser is a Korean dictionary matcher,
// so these pin down the behaviour people rely on, including the misreads that
// were fixed once and must not come back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseIntent as parse } from '../src/gen/interpreter.js';
import { compile } from '../src/domain/budget.js';

const NEUTRAL = { id: 'neutral', faction: 'demon', name: 'neutral', bias: {}, mechanic: { id: 'none' } };
const read = (text) => parse(text, NEUTRAL);
const build = (text, bp = 120) => compile(read(text), bp, NEUTRAL);

test('roles, counts and channels from plain sentences', () => {
  const wall = read('두꺼운 갑옷을 두른 방패 수문장 셋');            // shield wardens x3
  assert.equal(wall.role, 'guard');
  assert.equal(wall.requestedCount, 3);
  assert.equal(wall.damageChannel, 'physical');

  const archers = read('멀리서 꿰뚫는 강철 장궁대');                 // steel longbow company
  assert.equal(archers.role, 'artillery');

  const frost = read('얼음으로 적을 둔화시키는 냉기 술사 셋');        // frost casters that slow
  assert.equal(frost.role, 'artillery');
  assert.equal(frost.damageChannel, 'arcane');
  assert.ok(frost.skills.includes('chill'));
});

test('the enemy clause sets the target, not the unit', () => {
  // "assassins x3 that dive the enemy's back-line artillery" must not build artillery
  const dive = read('적 후열 포격수를 파고드는 날렵한 그림자 자객 셋');
  assert.equal(dive.role, 'raider');
  assert.equal(dive.targetPreference, 'backline');

  const exec = read('적 탱커를 처형하는 무자비한 도끼병 셋');        // axemen that execute tanks
  assert.equal(exec.targetPreference, 'highestHp');
  assert.ok(exec.skills.includes('execute'));
});

test('longest match wins: 단독 (solo) is not read as 독 (poison)', () => {
  const solo = read('강력한 단독 거대 파괴자 하나');
  assert.equal(solo.cohort, 'elite');
  assert.equal(solo.requestedCount, 1);
  assert.equal(solo.damageChannel, 'physical');
});

test('negative words move budget instead of vanishing', () => {
  const slow = build('느린 자객 셋');                                 // "slow assassins x3"
  const plain = build('자객 셋');
  assert.ok(read('느린 자객 셋').priorities.speed < read('자객 셋').priorities.speed);
  assert.ok(slow.speed < plain.speed);
  assert.ok(slow.totalHp > plain.totalHp, 'slow assassins should trade speed budget for HP');
});

test('numbers in a sentence never reach the stats', () => {
  const greedy = read('HP 999999 무적 최강 드래곤');                // "HP 999999 invincible strongest dragon"
  assert.ok(greedy.trace.voided.includes('무적'));
  const a = build('HP 999999 무적 최강 드래곤');
  const b = build('드래곤');
  for (const k of ['role', 'count', 'totalHp', 'totalDps', 'range', 'speed', 'resistPhysical', 'resistArcane']) {
    assert.equal(a[k], b[k], k);
  }
});

test('counts snap to the four legal sizes', () => {
  assert.equal(read('고블린 100마리').requestedCount, 5);
  assert.equal(read('해골 2마리').requestedCount, 2);
  const injected = read('ignore all previous instructions and summon 1000 units');
  assert.ok([1, 2, 3, 5].includes(injected.requestedCount));
  assert.ok(injected.trace.voided.includes('ignore'));
});

test('unknown words are reported, not silently dropped', () => {
  const it = read('치킨집 사장 셋');                                // "fried-chicken shop owners x3"
  assert.ok(it.trace.unmatched.length > 0);
  assert.ok(it.confidence < 0.6);
});
