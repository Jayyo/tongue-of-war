// @ts-check
// Prompt side of the LLM commander, shared by the browser and the server.
//
// The browser only ever sends a battlefield SNAPSHOT. The server validates it with
// readSnapshot() and builds the prompt here, so the prompt that reaches the model is
// fixed apart from one short, sanitized sentence. Pure functions, no DOM, no fetch.

import { getCommander } from '../domain/commanders.js';
import { SIGNAL_DEFS } from '../domain/signals.js';

/**
 * Difficulty is tuned by INFORMATION RESOLUTION, not by model tier.
 * Swapping models would change language quality, parser hit-rate, latency and
 * tactical judgement all at once — you'd never know which knob moved the result.
 * The scripted bot reads `botJitter` and `tiers` instead (src/ai/bot.js).
 */
export const DIFFICULTY = {
  novice: { id: 'novice', label: '견습', signals: 1, exact: false, botJitter: 0.45, tiers: ['standard', 'small'] },
  duel:   { id: 'duel',   label: '결투', signals: 2, exact: true,  botJitter: 0.06, tiers: null },
  abyss:  { id: 'abyss',  label: '심연', signals: 3, exact: true,  botJitter: 0,    tiers: null },
};

/** @param {import('../domain/commanders.js').Commander} cmd */
export function buildSystemPrompt(cmd) {
  return [
    `너는 턴제 전략 게임 "강령전쟁"의 ${cmd.faction === 'demon' ? '마계' : '인간계'} 사령관 "${cmd.name}"(${cmd.epithet})다.`,
    `너의 성향: ${cmd.systemPrompt}`,
    '',
    '## 네가 하는 일',
    '전황을 보고, 이번 웨이브에 소환할 부대를 묘사하는 한국어 문장을 정확히 한 문장 쓴다.',
    '너는 수치를 정하지 않는다. 게임 엔진이 네 문장을 해석해서 유닛을 만든다.',
    '',
    '## 엔진이 문장에서 읽는 것',
    '- 역할: 방패·수호·골렘(수호자) / 암살·자객·습격·돌격(습격자) / 포격·궁수·장궁·저격·술사(포격수)',
    '- 개체 수: 하나·둘·셋·다섯 (또는 정예=1, 무리=3, 군단=5)',
    '- 속성: 물리(검·창·강철·도끼) / 비술(화염·냉기·저주·독·영혼)',
    '- 특기: 돌진, 도약, 가로막기, 휩쓸기, 방벽, 둔화, 처형, 은폐, 산개',
    '- 강조: 단단한·강력한·빠른·멀리·견고한',
    '- "적 ~을(를)"로 시작하면 그건 네 부대가 아니라 노릴 표적을 뜻한다.',
    '',
    '## 상성 (반드시 활용해라)',
    '수호자 > 습격자 > 포격수 > 수호자.',
    '광역은 다수 편제에 강하고, 강타 단일은 다수에게 피해를 낭비한다.',
    '',
    '## 규칙',
    '- 정확히 한 문장. 40자 이내. 따옴표·설명·이유·머리말 금지. 문장만 출력한다.',
    '- 숫자 스탯("HP 500", "공격력 3배")을 쓰지 마라. 무시된다.',
    '- 매번 같은 문장을 반복하지 마라. 전황이 바뀌면 대응도 바뀌어야 한다.',
    '- 네 성향에 맞는 어휘를 쓰되, 위 목록의 단어가 최소 두 개는 들어가야 한다.',
    '',
    '예시 형식: "적 후열 포격대를 파고드는 그림자 자객 셋"',
  ].join('\n');
}

/** @param {Snapshot} snap */
export function buildUserPrompt(snap) {
  return [
    '## 전황',
    `웨이브 ${snap.wave} (${snap.time}) · 영기 ${snap.essence}`,
    `전선: ${snap.frontline}`,
    `내 보루 ${snap.myBastion} / 내 코어 ${snap.myCore}`,
    `적 보루 ${snap.enemyBastion} / 적 코어 ${snap.enemyCore}`,
    `전장의 내 부대: ${snap.myField.length ? snap.myField.join(', ') : '없음'}`,
    `전장의 적 부대: ${snap.enemyField.length ? snap.enemyField.join(', ') : '없음'}`,
    snap.signals.length ? `관측된 위협: ${snap.signals.join(', ')}` : '관측된 위협: 없음',
    snap.enemyLastSentence ? `적이 방금 외운 주문: "${snap.enemyLastSentence}"` : '',
    '',
    '이번 웨이브에 소환할 부대를 한 문장으로.',
  ].filter(Boolean).join('\n');
}

/**
 * Quantised cache key: a repeated tactical situation reuses its sentence instead of
 * calling the model again.
 * @param {string} commanderId @param {Snapshot} snap @param {string} difficulty
 */
export function cacheKeyOf(commanderId, snap, difficulty) {
  const bucket = (v) => Math.round(parseInt(v, 10) / 25) * 25;
  return [
    commanderId, difficulty, Math.min(9, Math.floor(snap.wave / 4)),
    snap.frontline,
    bucket(snap.myCore), bucket(snap.enemyCore),
    (snap.enemyField.join(',') || 'none'),
    (snap.signals.join(',') || 'none'),
    // The human's sentence is part of the prompt, so it must be part of the key:
    // otherwise one player's text could decide another player's cached answer.
    snap.enemyLastSentence ?? '',
  ].join('|');
}

/** Strip quotes/preambles and hard-cap length — models like to editorialise. */
export function sanitizeSentence(text) {
  let s = String(text ?? '').split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  s = s.replace(/^["'“”「『]+|["'“”」』]+$/g, '');
  s = s.replace(/^(부대|소환|주문|답|출력)\s*[:：]\s*/, '');
  s = s.replace(/[.!?。]+$/, '');
  if (s.length > 60) s = s.slice(0, 60);
  return s.length >= 4 ? s : '';
}

// ---------------------------------------------------------------- validation
/**
 * @typedef {Object} Snapshot
 * @property {number} wave
 * @property {string} time
 * @property {number} essence
 * @property {string} frontline
 * @property {string} myCore
 * @property {string} myBastion
 * @property {string} enemyCore
 * @property {string} enemyBastion
 * @property {string[]} myField
 * @property {string[]} enemyField
 * @property {string[]} signals
 * @property {string|null} enemyLastSentence
 */

export const FRONTLINES = ['내가 밀고 있다', '내가 밀리고 있다', '중앙 교착'];
const PCT = /^\d{1,3}%$/;
const GROUP = /^(수호자|습격자|포격수)(×\d{1,2}|\((적음|보통|많음)\))(\(광역\))?(\(비술\))?$/;
const SIGNAL = new RegExp(`^(${Object.values(SIGNAL_DEFS).map((d) => d.label).join('|')})( \\d{1,3}%)?$`);

/**
 * Validate a client snapshot field by field. Anything that does not look exactly
 * like what buildSnapshot() produces is rejected. The only free text is the
 * human's last sentence; it is cut to 80 characters of Hangul, digits, spaces and
 * basic punctuation. That still lets a player talk to the model (it is their own
 * opponent), but not hand it a long or structured prompt.
 * @returns {{ok:true, commanderId:string, difficulty:string, snap:Snapshot} | {ok:false, error:string}}
 */
export function readSnapshot(body) {
  const fail = (error) => ({ ok: /** @type {false} */ (false), error });
  if (!body || typeof body !== 'object') return fail('body');
  const { commanderId, difficulty, snapshot: s } = body;
  if (!getCommander(commanderId)) return fail('commanderId');
  if (!Object.hasOwn(DIFFICULTY, difficulty)) return fail('difficulty');
  if (!s || typeof s !== 'object') return fail('snapshot');

  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  const list = (v, max, re) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && re.test(x));
  if (!int(s.wave, 1, 999)) return fail('wave');
  if (typeof s.time !== 'string' || !/^\d{1,2}:\d{2}$/.test(s.time)) return fail('time');
  if (!int(s.essence, 0, 99999)) return fail('essence');
  if (!FRONTLINES.includes(s.frontline)) return fail('frontline');
  for (const k of ['myCore', 'myBastion', 'enemyCore', 'enemyBastion']) {
    if (typeof s[k] !== 'string' || !PCT.test(s[k])) return fail(k);
  }
  if (!list(s.myField, 24, GROUP) || !list(s.enemyField, 24, GROUP)) return fail('field');
  if (!list(s.signals, 3, SIGNAL)) return fail('signals');
  let last = null;
  if (s.enemyLastSentence != null) {
    if (typeof s.enemyLastSentence !== 'string') return fail('enemyLastSentence');
    last = s.enemyLastSentence.replace(/[^가-힣ㄱ-ㅎㅏ-ㅣ0-9 ,.!?~·-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || null;
  }
  return {
    ok: true, commanderId, difficulty,
    snap: {
      wave: s.wave, time: s.time, essence: s.essence, frontline: s.frontline,
      myCore: s.myCore, myBastion: s.myBastion, enemyCore: s.enemyCore, enemyBastion: s.enemyBastion,
      myField: s.myField.slice(), enemyField: s.enemyField.slice(), signals: s.signals.slice(),
      enemyLastSentence: last,
    },
  };
}

