// @ts-check
// Fixed skill pool. Skills are NEVER free-form: a prompt selects from this
// enum, it cannot invent an effect. Costs are expressed in BP and were derived
// from expected damage / expected EHP over a 20s reference fight.

import { CFG } from '../config.js';

/**
 * @typedef {Object} Skill
 * @property {string} id
 * @property {string} label
 * @property {number} bp        base BP cost
 * @property {string} kind      'mobility' | 'control' | 'damage' | 'sustain' | 'stealth'
 * @property {string} desc
 * @property {string[]} roles   roles that may take it ('*' = any)
 * @property {Object} params
 */

// Prices were re-derived from counterfactual runs (same matchups with the skill
// removed): charge 7->2, veil 14->6 (duration 4->9 s), chill 8->0, ward 14->18,
// execute 6->9. Charge was worth less than nothing as implemented (removing it
// raised the win rate), chill only slows movement so it is nearly worthless
// against a target that is already in melee, and ward absorbed ~166 damage per
// match, which the old price undercharged.
/** @type {Record<string, Skill>} */
export const SKILLS = {
  charge: {
    id: 'charge', label: '돌진', bp: 2, kind: 'mobility',
    desc: '8초마다 4m 전진. 무적 없음.',
    roles: ['guard', 'raider'],
    params: { dash: 4, cd: 8 },
  },
  leap: {
    id: 'leap', label: '후열 도약', bp: 14, kind: 'mobility',
    desc: '전투당 1회, 가장 먼 적 뒤 1m로 도약.',
    roles: ['raider'],
    params: { once: true, behind: 1 },
  },
  bulwark: {
    id: 'bulwark', label: '가로막기', bp: 10, kind: 'control',
    desc: '3m 내 습격자의 표적을 2초간 자신에게 돌림. 쿨 10초.',
    roles: ['guard'],
    params: { radius: 3, dur: 2, cd: 10 },
  },
  sweep: {
    id: 'sweep', label: '휩쓸기', bp: 14, kind: 'damage',
    desc: '주 대상 100%, 주변 최대 3명에게 각 30%.',
    roles: ['*'],
    params: { secondary: 0.30, maxTargets: 3 },
  },
  ward: {
    id: 'ward', label: '방벽', bp: 18, kind: 'sustain',
    // Cooldown starts when the shield BREAKS, not on spawn. The old version let
    // the timer run during the march, so the first shield could re-appear the
    // instant it popped — measured at ~2.2 procs/unit, i.e. half price.
    desc: '총 HP의 12% 보호막. 깨진 뒤 10초 후 재생성.',
    roles: ['*'],
    params: { shieldFrac: 0.12, cd: 10 },
  },
  chill: {
    id: 'chill', label: '둔화', bp: 0, kind: 'control',
    desc: '적 이동속도 -20%, 2초. 발동 쿨 5초.',
    roles: ['*'],
    params: { slow: 0.20, dur: 2, cd: 5 },
  },
  execute: {
    id: 'execute', label: '처형', bp: CFG.skillTuning.executeBp, kind: 'damage',
    desc: 'HP 25% 이하 대상에게 피해 +35%.',
    roles: ['*'],
    params: { threshold: 0.25, bonus: 0.35 },
  },
  veil: {
    id: 'veil', label: '은폐', bp: 6, kind: 'stealth',
    desc: '첫 공격 또는 4초 후 해제. 은폐 중 표적 지정 불가.',
    roles: ['raider'],
    params: { dur: 9 },   // 4 s ran out before most raiders reached their target
  },

  // ---- conditional tactics: only reachable through a verified context claim.
  // They are priced like any other skill; the context discount is on the summon
  // cost, not on the BP, so a context answer is never free power.
  spread: {
    id: 'spread', label: '산개', bp: 8, kind: 'control',
    desc: '개체 간격을 벌려 광역 2차 피해를 60% 덜 받는다.',
    roles: ['*'],
    params: { splashReduction: 0.6, gap: 2.2 },
  },
  cleave: {
    id: 'cleave', label: '난도', bp: 10, kind: 'damage',
    desc: '적 3개체가 2.5m 안에 뭉치면 다음 공격이 광역이 된다.',
    roles: ['*'],
    params: { need: 3, radius: 2.5, secondary: 0.30 },
  },
};

/** @param {string[]} ids @param {string} role */
export function legalSkills(ids, role) {
  return ids
    .filter((id) => SKILLS[id])
    .filter((id) => SKILLS[id].roles.includes('*') || SKILLS[id].roles.includes(role))
    .slice(0, 2);
}

/** @param {string[]} ids */
export function skillCost(ids) {
  return ids.reduce((s, id) => s + (SKILLS[id]?.bp ?? 0), 0);
}
