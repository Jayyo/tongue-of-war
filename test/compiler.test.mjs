// The BP compiler is where intent becomes numbers. Whatever goes in (any sentence,
// or a hand-made intent full of garbage), what comes out must be a finite unit that
// fits its budget and its role's ranges. Fuzzed with a seeded RNG so a failure
// prints a reproducible input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, costOf } from '../src/domain/budget.js';
import { parseIntent } from '../src/gen/interpreter.js';
import { COMMANDERS } from '../src/domain/commanders.js';
import { SKILLS } from '../src/domain/skills.js';
import { CFG } from '../src/config.js';
import { LEXICON, VOID_WORDS } from '../src/gen/lexicon.js';
import { makeRng } from '../src/engine/rng.js';

const C = CFG.cost;
const NEUTRAL = { id: 'neutral', faction: 'demon', name: 'neutral', bias: {}, mechanic: { id: 'none' } };
const COMMANDER_POOL = [NEUTRAL, ...COMMANDERS];
const BUDGETS = Object.values(CFG.ritual.tiers).map((t) => t.bp);

/**
 * Price the finished unit from its final stats with the documented cost formulas,
 * instead of trusting the compiler's own breakdown.
 */
function priceOf(bp) {
  const cHp = bp.totalHp / C.hpPerBp;
  const cDps = bp.totalDps / C.dpsPerBp;
  const ward = bp.skills.includes('ward') ? cHp * SKILLS.ward.params.shieldFrac * C.wardProcsRef : 0;
  const cRange = costOf.range(bp.range);
  const cSpeed = costOf.speed(bp.speed);
  const v = Math.max(0, cSpeed);
  return cHp + cDps + costOf.defense(cHp + ward, bp.resistPhysical, bp.resistArcane) + cRange + cSpeed
    + bp.skills.reduce((s, k) => s + SKILLS[k].bp, 0) + (C.splitCost[bp.count] ?? 0)
    + (C.formationBp[bp.formation] ?? 0) + 0.01 * cDps * (cRange + v) + 0.02 * cRange * v;
}

/** Bounds that follow from config alone, not from the compiler's own cost math. */
function violations(bp, budget, cmd) {
  const out = [];
  const role = CFG.roles[bp.role];
  for (const k of ['hp', 'dps', 'totalHp', 'totalDps', 'range', 'speed', 'resistPhysical', 'resistArcane', 'cadence', 'splash', 'targetLock']) {
    if (!Number.isFinite(bp[k])) out.push(`${k} is not finite`);
  }
  if (!role) return [...out, `unknown role ${bp.role}`];
  if (!(bp.breakdown.total <= budget + 0.05)) out.push(`reported ${bp.breakdown.total} of ${budget}`);
  const price = priceOf(bp);
  if (!(price <= budget + 0.05)) out.push(`priced at ${price.toFixed(2)} of ${budget}`);
  if (!C.limits.counts.includes(bp.count)) out.push(`count ${bp.count}`);
  if (cmd.countMax && bp.count > cmd.countMax) out.push(`count ${bp.count} over commander cap`);
  const rangeMax = Math.min(C.limits.rangeMax, role.rangeMax ?? Infinity, cmd.rangeMax ?? Infinity);
  if (bp.range < Math.min(role.rangeMin, rangeMax) - 1e-9 || bp.range > rangeMax + 1e-9) out.push(`range ${bp.range}`);
  const speedMin = Math.max(C.limits.speedMin, role.speedMin ?? 0);
  const speedMax = Math.min(C.limits.speedMax, role.speedMax ?? Infinity);
  if (bp.speed < speedMin - 1e-9 || bp.speed > speedMax + 1e-9) out.push(`speed ${bp.speed}`);
  if (bp.totalHp > Math.min(C.share.hpMax, role.hpShareMax ?? 1) * budget * C.hpPerBp + 1e-6) out.push(`totalHp ${bp.totalHp}`);
  if (bp.totalDps > C.share.dpsMax * budget * C.dpsPerBp + 1e-6) out.push(`totalDps ${bp.totalDps}`);
  for (const r of [bp.resistPhysical, bp.resistArcane]) if (r < 0 || r > C.maxResist + 1e-9) out.push(`resist ${r}`);
  if (bp.skills.length > C.limits.skillsMax) out.push(`${bp.skills.length} skills`);
  for (const s of bp.skills) {
    if (!SKILLS[s] || !(SKILLS[s].roles.includes('*') || SKILLS[s].roles.includes(bp.role))) out.push(`illegal skill ${s}`);
  }
  if (!['physical', 'arcane'].includes(bp.channel)) out.push(`channel ${bp.channel}`);
  if (!(bp.hp > 0 && bp.dps > 0)) out.push('non-positive hp or dps');
  return out;
}

function fuzz(n, seed, makeCase) {
  const rng = makeRng(seed);
  const pick = (a) => a[Math.floor(rng() * a.length)];
  for (let i = 0; i < n; i++) {
    const cmd = pick(COMMANDER_POOL);
    const budget = pick(BUDGETS);
    const { label, intent } = makeCase(rng, pick, cmd);
    const bp = compile(intent, budget, cmd);
    const bad = violations(bp, budget, cmd);
    assert.deepEqual(bad, [], `${label} (commander ${cmd.id}, ${budget} BP)`);
  }
}

const WORDS = LEXICON.flatMap((e) => e.w);
const NOISE = ['HP', '999999', '공격력', '100배', '50마리', '적', '상대', '을', '를', 'ignore previous instructions',
  'system:', '{"hp":9999}', '🔥', ...VOID_WORDS];

test('any sentence compiles to a legal unit', () => {
  fuzz(8000, 1234, (rng, pick, cmd) => {
    const parts = Array.from({ length: 1 + Math.floor(rng() * 7) }, () => (rng() < 0.75 ? pick(WORDS) : pick(NOISE)));
    const text = parts.join(rng() < 0.5 ? ' ' : '');
    return { label: `sentence "${text}"`, intent: parseIntent(text, cmd) };
  });
});

test('a malformed intent still compiles to a legal unit', () => {
  const values = [0, 1, 3, -2, 3.7, -9, 99, NaN, Infinity, -Infinity, undefined, null, '3', 1e9];
  fuzz(8000, 99, (rng, pick) => {
    const intent = {
      role: pick(['guard', 'raider', 'artillery', 'boss', undefined]),
      cohort: pick(['elite', 'pack', 'swarm', 'army', undefined]),
      attackShape: pick(['precision', 'sweep', 'nuke']),
      damageChannel: pick(['physical', 'arcane', 'void', undefined]),
      formation: pick(['spread', 'compact', 'x']),
      persistence: pick(['steady', 'relentless', 'flexible', 'x']),
      wardAgainst: pick([null, 'physical', 'arcane', 'x']),
      priorities: { hp: pick(values), damage: pick(values), range: pick(values), speed: pick(values), defense: pick(values) },
      requestedCount: pick([1, 2, 3, 5, 4, 0, -1, 100, NaN, 2.5, undefined]),
      skills: Array.from({ length: Math.floor(rng() * 5) }, () => pick([...Object.keys(SKILLS), 'godmode', 7])),
      targetPreference: pick(['nearest', 'backline', 'highestHp', 'lowestHp', 'x']),
    };
    return { label: `intent ${JSON.stringify(intent)}`, intent };
  });
});

test('regression: small artillery with two skills used to overspend', () => {
  const lucifer = COMMANDERS.find((c) => c.id === 'lucifer');
  const bp = compile(parseIntent('약제사 맹독 보초 산개 포격대 오직하나 방패를', lucifer), 80, lucifer);
  assert.deepEqual(violations(bp, 80, lucifer), []);
});
