// @ts-check
// The LLM commander.
//
// DESIGN DECISION: the AI writes a KOREAN SENTENCE, exactly like the player, and
// that sentence goes through the same interpreter and the same BP compiler.
// It never emits stats, never emits intent JSON, and gets no privileged path
// into the engine. Two reasons:
//   1. fairness — if the AI could hand us structured intent while the human's
//      words must survive a parser, the human is playing a harder game.
//   2. it is the content — reading what the opponent wrote, and watching it
//      become a unit, is the thing this game has that a dropdown does not.
//
// Failure is always survivable: no key, timeout, or garbage output falls back to
// the scripted bot, which uses the same prompt->compile path.

import { CFG } from '../config.js';
import { computeSignals } from '../domain/signals.js';
import { player, other, structOf, frontline, SIDE } from '../engine/sim.js';

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

/**
 * Public battlefield snapshot. Mirrors exactly what the human can see on screen:
 * revealed enemy cohorts, structures, front line, signals. Never the human's
 * essence balance, never their unsent prompt.
 */
/**
 * Difficulty is tuned by INFORMATION RESOLUTION, not by model tier.
 * Swapping models would change language quality, parser hit-rate, latency and
 * tactical judgement all at once — you'd never know which knob moved the result.
 */
export const DIFFICULTY = {
  novice: { id: 'novice', label: '견습', signals: 1, exact: false, lagWaves: 2 },
  duel:   { id: 'duel',   label: '결투', signals: 2, exact: true,  lagWaves: 0 },
  abyss:  { id: 'abyss',  label: '심연', signals: 3, exact: true,  lagWaves: 0, patterns: true },
};

export function buildSnapshot(B, side, diff = DIFFICULTY.duel) {
  const me = player(B, side);
  const foe = player(B, other(side));
  const sum = (units) => {
    const by = {};
    for (const u of units) {
      const k = `${u.role}|${u.bp.count}|${u.channel}`;
      by[k] = by[k] ?? { role: u.role, count: 0, channel: u.channel, splash: u.splash > 0, range: u.range };
      by[k].count++;
    }
    return Object.values(by);
  };
  const label = { guard: '수호자', raider: '습격자', artillery: '포격수' };
  const myUnits = B.units.filter((u) => u.side === side && u.hp > 0);
  const foeUnits = B.units.filter((u) => u.side !== side && u.hp > 0);
  const front = frontline(B) / CFG.field.length;

  return {
    wave: B.wave + 1,
    time: `${Math.floor(B.t / 60)}:${String(Math.floor(B.t % 60)).padStart(2, '0')}`,
    essence: Math.floor(me.essence),
    frontline: side === SIDE.L
      ? (front > 0.55 ? '내가 밀고 있다' : front < 0.45 ? '내가 밀리고 있다' : '중앙 교착')
      : (front < 0.45 ? '내가 밀고 있다' : front > 0.55 ? '내가 밀리고 있다' : '중앙 교착'),
    myCore: pctOf(structOf(B, side, 'core')),
    myBastion: pctOf(structOf(B, side, 'bastion')),
    enemyCore: pctOf(structOf(B, other(side), 'core')),
    enemyBastion: pctOf(structOf(B, other(side), 'bastion')),
    myField: sum(myUnits).map((g) => fmtGroup(g, label, diff)),
    enemyField: sum(foeUnits).map((g) => fmtGroup(g, label, diff)),
    signals: computeSignals(B, side).slice(0, diff.signals).map((s) => (diff.exact ? `${s.label} ${Math.round(s.ratio * 100)}%` : s.label)),
    difficulty: diff.id,
    enemyLastSentence: foe.lastSentence ?? null,
  };
}

const pctOf = (s) => (s && s.maxHp ? `${Math.round((s.hp / s.maxHp) * 100)}%` : '0%');

/** At novice, counts are blurred to 적음/보통/많음 so the AI plans on a fuzzier board. */
function fmtGroup(g, label, diff) {
  const n = diff.exact ? `×${g.count}` : (g.count <= 1 ? '(적음)' : g.count <= 3 ? '(보통)' : '(많음)');
  return `${label[g.role]}${n}${g.splash ? '(광역)' : ''}${g.channel === 'arcane' ? '(비술)' : ''}`;
}

/**
 * Quantised cache key: same tactical situation reuses the same sentence.
 * Without this a 6-minute match is ~30 live calls; with it, a handful.
 */
export function cacheKeyOf(cmd, snap) {
  const bucket = (v) => Math.round(parseInt(v, 10) / 25) * 25;
  return [
    cmd.id, Math.min(9, Math.floor(snap.wave / 4)),
    snap.frontline,
    bucket(snap.myCore), bucket(snap.enemyCore),
    (snap.enemyField.join(',') || 'none'),
    (snap.signals.join(',') || 'none'),
  ].join('|');
}

/**
 * Ask the LLM for a sentence. Resolves to null on any failure so the caller can
 * fall back to the scripted bot without special-casing.
 * @returns {Promise<{sentence:string, provider:string, ms:number, cached:boolean}|null>}
 */
export async function askOpponent(B, side, diff = DIFFICULTY.duel, timeoutMs = 9500) {
  const me = player(B, side);
  const cmd = me.commander;
  const snap = buildSnapshot(B, side, diff);
  const system = buildSystemPrompt(cmd);
  const user = [
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

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/opponent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ system, user, cacheKey: cacheKeyOf(cmd, snap) + '|' + diff.id }),
      signal: ctl.signal,
    });
    const j = await res.json();
    if (!j?.ok || !j.text) return null;
    const sentence = sanitize(j.text);
    if (!sentence) return null;
    return { sentence, provider: j.provider, ms: j.ms ?? 0, cached: !!j.cached };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Strip quotes/preambles and hard-cap length — models like to editorialise. */
function sanitize(text) {
  let s = String(text).split('\n').map((l) => l.trim()).filter(Boolean)[0] ?? '';
  s = s.replace(/^["'“”「『]+|["'“”」』]+$/g, '');
  s = s.replace(/^(부대|소환|주문|답|출력)\s*[:：]\s*/, '');
  s = s.replace(/[.!?]+$/, '');
  if (s.length > 60) s = s.slice(0, 60);
  return s.length >= 4 ? s : '';
}
