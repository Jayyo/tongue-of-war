// @ts-check
// Scripted opponent, used when no model is configured and by the balance harness.
// It goes through the same sentence path as the player: it picks sentences from a
// fixed book, runs them through the same parser and BP compiler (at list price: no
// context discount, no repeat surcharge), and only reacts to units that have
// actually taken the field.

import { parseIntent } from '../gen/interpreter.js';
import { compile } from '../domain/budget.js';
import { CFG } from '../config.js';
import { queueContract, player, other } from '../engine/sim.js';
import { interpretVisual } from '../gen/visual.js';

// Bot's prompt book. Written as real sentences on purpose — the bot is a
// demonstration of the intended input style, not a hidden button-presser.
const BOOK = [
  { text: '두꺼운 갑옷을 두른 방패 수문장 셋, 앞을 막아선다', answers: 'raider' },
  { text: '적 후열 포격수를 파고드는 날렵한 그림자 자객 셋', answers: 'artillery' },
  { text: '멀리서 쏘아붙이는 장거리 주술 포격대', answers: 'guard' },
  { text: '광역으로 휩쓰는 화염 폭발 술사', answers: 'swarm' },
  { text: '값싼 하급 군단 다섯, 수로 밀어붙인다', answers: 'artillery' },
  { text: '강력한 단독 거대 파괴자 하나', answers: 'swarm' },
  { text: '얼음으로 적을 둔화시키는 냉기 술사 셋', answers: 'raider' },
  { text: '보호막을 두른 견고한 강철 골렘 둘', answers: 'artillery' },
  { text: '적 탱커를 처형하는 무자비한 도끼병 셋', answers: 'guard' },
  { text: '은폐한 채 접근하는 독칼 암살자 셋', answers: 'artillery' },
  { text: '돌진하는 흉포한 야수 무리 다섯', answers: 'guard' },
  { text: '정밀하게 꿰뚫는 강철 장궁대', answers: 'swarm' },
];

/**
 * @param {any} B battle
 * @param {number} side
 * @param {{botJitter?:number, tiers?:string[]|null}} [level] difficulty from
 *   src/ai/opponent-prompt.js. Novice scores its options with heavy noise and
 *   keeps to the smaller rituals; the default is the duel setting.
 */
export function botThink(B, side, level = {}) {
  const jitter = level.botJitter ?? 0.06;
  const p = player(B, side);
  const foe = player(B, other(side));

  // 1. upgrades first when rich or when the doctrine clearly pays off
  const tierIdx = p.upgrades.length;
  const tier = CFG.upgrades.tiers[tierIdx];
  if (tier && B.t >= tier.unlockAt) {
    const cost = tier.cost * (p.commander.mechanic.id === 'forge' ? 1 - p.commander.mechanic.upgradeDiscount : 1);
    if (p.essence >= cost + CFG.ritual.tiers.standard.cost) {
      p.essence -= cost;
      p.upgrades.push(pickDoctrine(p));
      return { kind: 'upgrade', doctrine: p.upgrades[p.upgrades.length - 1] };
    }
  }

  // 2. pick a tier it can afford, biggest first
  const tiers = Object.entries(CFG.ritual.tiers)
    .filter(([k]) => !level.tiers || level.tiers.includes(k))
    .sort((a, b) => b[1].bp - a[1].bp);
  const affordable = tiers.find(([, t]) => p.essence >= t.cost);
  if (!affordable) return null;
  const [, tierCfg] = affordable;

  // 3. score the prompt book against what the enemy has REVEALED
  const threat = summarizeThreat(B, other(side));
  let best = null;
  for (const entry of BOOK) {
    const intent = parseIntent(entry.text, p.commander);
    const bp = compile(intent, tierCfg.bp, p.commander);
    const score =
      counterScore(bp, threat) * 0.55 +
      compositionNeed(bp, p) * 0.25 +
      pressureScore(bp, B, side) * 0.20 +
      B.rng() * jitter;                     // jitter so it isn't robotic
    if (!best || score > best.score) best = { score, bp, text: entry.text };
  }
  if (!best) return null;

  // same appearance path as the player and the LLM opponent — the scripted bot must
  // not be the one unit family that renders differently
  best.bp.visual = interpretVisual(best.text, best.bp, p.commander);
  if (!queueContract(B, side, best.bp, tierCfg.cost)) return null;
  return { kind: 'summon', blueprint: best.bp, prompt: best.text };
}

/** What roles the enemy actually fielded — the bot sees only revealed units. */
function summarizeThreat(B, foeSide) {
  const counts = { guard: 0, raider: 0, artillery: 0 };
  let arcane = 0, physical = 0;
  for (const u of B.units) {
    if (u.side !== foeSide || u.hp <= 0) continue;
    const v = u.hp + u.dps * 5;
    counts[u.role] += v;
    if (u.channel === 'arcane') arcane += v; else physical += v;
  }
  const total = counts.guard + counts.raider + counts.artillery || 1;
  return {
    guard: counts.guard / total, raider: counts.raider / total, artillery: counts.artillery / total,
    arcaneShare: arcane / (arcane + physical || 1),
  };
}

/** Prefer the role that beats whatever the enemy has most of. */
function counterScore(bp, threat) {
  const beats = { guard: 'raider', raider: 'artillery', artillery: 'guard' };
  return threat[beats[bp.role]] ?? 0;
}

/** Fill holes in own composition — a bot with three artilleries dies to raiders. */
function compositionNeed(bp, p) {
  const owned = p.roster.reduce((acc, b) => { acc[b.role] = (acc[b.role] ?? 0) + 1; return acc; }, {});
  const n = owned[bp.role] ?? 0;
  return 1 / (1 + n);
}

/** If the line is deep in our half, buy something that holds ground. */
function pressureScore(bp, B, side) {
  const mid = CFG.field.length / 2;
  const front = B.stats.waves.length ? B.stats.waves[B.stats.waves.length - 1].front : mid;
  const losing = side === 0 ? front < mid : front > mid;
  if (!losing) return bp.role === 'raider' ? 0.6 : 0.3;
  return bp.role === 'guard' ? 1 : 0.2;
}

function pickDoctrine(p) {
  const pref = {
    lucifer: ['arcane', 'ruin', 'ward'], abaddon: ['ward', 'ruin', 'swift'],
    baal: ['ruin', 'swift', 'ward'], smith: ['ward', 'ruin', 'arcane'],
    alchemist: ['arcane', 'ruin', 'ward'], headsman: ['swift', 'ruin', 'arcane'],
  }[p.commander.id] ?? ['ruin', 'ward', 'swift'];
  return pref[p.upgrades.length % pref.length];
}
