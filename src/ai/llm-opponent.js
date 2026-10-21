// @ts-check
// The LLM commander (browser side).
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
// The browser sends only a public battlefield snapshot; the server owns the
// prompt (src/ai/opponent-prompt.js). Failure is always survivable: no key,
// timeout, or garbage output falls back to the scripted bot, which uses the
// same sentence -> compile path.

import { CFG } from '../config.js';
import { computeSignals } from '../domain/signals.js';
import { player, other, structOf, frontline, SIDE } from '../engine/sim.js';
import { DIFFICULTY, sanitizeSentence } from './opponent-prompt.js';

export { DIFFICULTY };

/**
 * Public battlefield snapshot. Mirrors exactly what the human can see on screen:
 * revealed cohorts, structures, front line, signals. Never the human's essence
 * balance, never their unsent prompt.
 */
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
    enemyLastSentence: foe.lastSentence ?? null,
  };
}

const pctOf = (s) => (s && s.maxHp ? `${Math.round((Math.max(0, s.hp) / s.maxHp) * 100)}%` : '0%');

/** At novice, counts are blurred to 적음/보통/많음 so the AI plans on a fuzzier board. */
function fmtGroup(g, label, diff) {
  const n = diff.exact ? `×${g.count}` : (g.count <= 1 ? '(적음)' : g.count <= 3 ? '(보통)' : '(많음)');
  return `${label[g.role]}${n}${g.splash ? '(광역)' : ''}${g.channel === 'arcane' ? '(비술)' : ''}`;
}

/**
 * Ask the server's model for a sentence. Never throws: on failure it resolves to
 * `{ sentence: null, reason }` so the caller can fall back to the scripted bot and
 * say why.
 * @returns {Promise<{sentence:string|null, reason?:string, provider?:string, ms?:number, cached?:boolean}>}
 */
export async function askOpponent(B, side, diff = DIFFICULTY.duel, timeoutMs = 11000) {
  const me = player(B, side);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/opponent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commanderId: me.commander.id, difficulty: diff.id, snapshot: buildSnapshot(B, side, diff) }),
      signal: ctl.signal,
    });
    const j = await res.json().catch(() => null);
    if (!j?.ok || !j.text) return { sentence: null, reason: j?.error ?? `http_${res.status}` };
    const sentence = sanitizeSentence(j.text);
    if (!sentence) return { sentence: null, reason: 'empty' };
    return { sentence, provider: j.provider, ms: j.ms ?? 0, cached: !!j.cached };
  } catch (e) {
    return { sentence: null, reason: e?.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}
