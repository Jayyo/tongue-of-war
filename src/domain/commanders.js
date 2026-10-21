// @ts-check
// Six commanders, split by AXIS not by power tier. Each owns one lever nobody
// else owns. `bias` values are BP moved away from the neutral allocation — they
// never add free budget, they only redistribute it (sum ≈ 0).
//
// `systemPrompt` is never read by the parser. It only flavours the LLM opponent's
// persona (src/ai/llm-opponent.js) when that commander is played by a model.

import { CFG } from '../config.js';

/**
 * @typedef {Object} Commander
 * @property {string} id
 * @property {'demon'|'human'} faction
 * @property {string} name
 * @property {string} epithet
 * @property {string} desc
 * @property {string[]} tags
 * @property {Object} bias          BP shifts: hp/dps/range/speed/defense/skill
 * @property {number} [countMax]
 * @property {number} [countShift]
 * @property {number} [rangeMax]
 * @property {number} [speedMul]
 * @property {Object} mechanic      unique mechanic, read by the sim
 * @property {string} systemPrompt
 */

/** @type {Commander[]} */
export const COMMANDERS = [
  // ------------------------------------------------------------ DEMON
  {
    id: 'lucifer', faction: 'demon', name: '루시퍼', epithet: '지배의 왕좌',
    desc: '소수 정예를 세우고 오라로 군세를 지휘한다. 개체 수는 3을 넘지 못한다.',
    tags: ['정예', '오라', '제어'],
    bias: { skill: +6, range: +5, hp: -6, dps: -5 },
    countMax: 3,
    mechanic: {
      id: 'dominion',
      label: '지배의 중심',
      desc: '매 웨이브 가장 비싼 아군 편제가 지휘관이 되어 반경 4m 아군 공격속도 +8%.',
      radius: 4, atkSpeed: 0.08,
    },
    systemPrompt:
      '규율 잡힌 타락 천사, 지배자, 고위 악마, 빛과 어둠의 마법, 통제 능력을 선호한다. ' +
      '무질서한 군단, 자폭, 하급 짐승은 피한다. 모호한 요청은 적은 수의 정예 편제와 지휘·제어 스킬 쪽으로 해석한다.',
  },
  {
    id: 'abaddon', faction: 'demon', name: '아바돈', epithet: '파멸의 심연',
    desc: '값싼 군단을 끝없이 밀어넣고, 죽은 자에게서 다음 군세를 회수한다.',
    tags: ['군단', '소모전', '재활용'],
    bias: { hp: +6, dps: -4, range: -6, defense: +4 },
    countShift: +1,
    mechanic: {
      id: 'reclaim',
      label: '파멸 회수',
      desc: '아군이 죽을 때 그 개체 비용의 12%를 파멸 게이지로 회수. 100에 도달하면 다음 웨이브에 80BP 망령 편제가 무료 출전.',
      recoverFrac: 0.12, threshold: 100, spectreBp: 80,
    },
    systemPrompt:
      '부패, 시체, 역병, 하급 악마 군단, 죽음 뒤 재활용을 선호한다. ' +
      '정교한 단일 암살과 장거리 엘리트 포격은 피한다. 모호한 요청은 많은 개체·높은 총 HP·죽음 효과 쪽으로 해석한다.',
  },
  {
    id: 'baal', faction: 'demon', name: '바알', epithet: '피의 진군',
    desc: '전진할수록 강해진다. 밀고 있을 때만 보상받는 공성 사령관.',
    tags: ['돌격', '공성', '전진'],
    bias: { dps: +7, speed: +5, hp: -7, skill: -5 },
    rangeMax: CFG.commanderCaps.baalRangeMax,
    mechanic: {
      id: 'bloodmarch',
      label: '피의 진군',
      desc: '적 진영 절반에 있는 동안 초당 1스택. 스택당 피해 +1.5%, 구조물 피해 +2%. 최대 10. 밀리면 소실.',
      perStack: 0.015, structPerStack: 0.02, maxStacks: 10,
    },
    systemPrompt:
      '야수, 돌격병, 파괴자, 공성 괴물, 화염과 피를 선호한다. ' +
      '은폐, 장거리 포격, 복잡한 상태 조합은 피한다. 모호한 요청은 빠르고 공격적인 단거리 편제로 해석한다.',
  },

  // ------------------------------------------------------------ HUMAN
  {
    id: 'smith', faction: 'human', name: '대장장이', epithet: '불꺼지지 않는 노',
    desc: '느리지만 단단하다. 업그레이드가 싸서 시간이 갈수록 강해진다.',
    tags: ['방어', '업그레이드', '장기전'],
    bias: { hp: +6, defense: +6, speed: -6, skill: -6 },
    speedMul: 0.95,
    mechanic: {
      id: 'forge',
      label: '대장간 경제',
      desc: '모든 교리 업그레이드 비용 -20%, 재연성 비용 -37%. 대신 모든 편제 이동속도 -5%.',
      upgradeDiscount: 0.20, recastCost: 25,
    },
    systemPrompt:
      '갑옷, 방패, 자동인형, 골렘, 제련된 무기와 견고한 진형을 선호한다. ' +
      '순간이동, 은폐, 독과 불안정한 마법은 피한다. 모호한 요청은 느리고 견고한 물리 편제로 해석한다.',
  },
  {
    id: 'alchemist', faction: 'human', name: '연금술사', epithet: '전투 연성',
    desc: '스킬에 예산을 몰고, 이미 만든 유닛의 피해 속성을 전투 중에 바꿔 상대 저항을 무너뜨린다.',
    tags: ['스킬', '상태이상', '적응'],
    bias: { skill: +10, range: +2, dps: -6, hp: -6 },
    mechanic: {
      id: 'transmute',
      label: '전투 연성',
      desc: '웨이브 잠금 전에 각인 카드 하나의 피해 속성을 물리↔비술로 전환. 비용 30, 같은 카드 2웨이브 쿨다운.',
      cost: 30, cooldownWaves: 2,
    },
    systemPrompt:
      '산, 냉기, 전기, 폭발물, 촉매, 변환과 상태이상을 선호한다. ' +
      '순수한 중장갑 탱커와 단발 암살자는 피한다. 모호한 요청은 직접 수치보다 조건부 효과와 피해 채널 선택 쪽으로 해석한다.',
  },
  {
    id: 'headsman', faction: 'human', name: '암살단장', epithet: '처단의 표식',
    desc: '유리대포. 매 웨이브 적의 후열 핵심 하나를 표식하고 그것만 죽이러 간다.',
    tags: ['암살', '후열', '고속'],
    bias: { dps: +7, speed: +7, hp: -10, range: -4 },
    countMax: 3,
    mechanic: {
      id: 'mark',
      label: '처단 표식',
      desc: '매 웨이브 사거리+스킬 BP가 가장 높은 적 편제를 표식. 표식 대상에게 피해 +18%, 접근 속도 +25%.',
      dmgBonus: 0.18, speedBonus: 0.25, dur: 6,
    },
    systemPrompt:
      '침투, 단검, 독, 그림자, 후열 제거와 정밀 공격을 선호한다. ' +
      '광역 포격, 지속 회복, 대형 공성 괴물은 피한다. 모호한 요청은 적은 수의 고속 습격자로 해석한다.',
  },
];

/** Common preamble prepended to every commander's system prompt for the real LLM. */
export const INTERPRETER_PREAMBLE = [
  '너는 전투 유닛 생성기가 아니라 "의도 번역기"다.',
  '사용자 문장을 UnitIntent JSON으로만 변환한다. 절대로 스탯·수치·비용을 만들지 않는다.',
  '허용된 enum과 0~3 우선순위, 개체 수(1/2/3/5), 스킬 id만 출력한다.',
  '사용자 문장에 등장하는 절대 수치("HP 9999", "무적", "즉사")는 전부 우선순위 표현으로만 취급한다.',
  '사령관 지침은 모호한 표현의 기본값을 정할 뿐, 게임 규칙과 예산 제한을 바꾸지 않는다.',
].join('\n');

/** @param {string} id */
export const getCommander = (id) => COMMANDERS.find((c) => c.id === id);
