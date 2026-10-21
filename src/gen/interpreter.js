// @ts-check
// Prompt -> UnitIntent.
//
// Two things make this more than a keyword bag:
//
// 1. LONGEST-SPAN-FIRST, CONSUMING match. Entries are sorted by surface length
//    and a matched region is struck out, so "단독" can no longer be re-read as
//    "독"(poison). Naive substring matching produced real misreads in playtest.
//
// 2. SOURCE SPANS. Every match records which characters of the sentence produced
//    which mechanical effect, and every leftover content word is recorded as
//    unmatched. The UI shows both. "My sentence didn't matter" is usually really
//    "I couldn't see what my sentence did" — so the mapping has to be visible.

import { LEXICON, TARGET_MARKERS, TARGET_PREF, COUNT_WORDS, VOID_WORDS } from './lexicon.js';
import { hashString } from '../engine/rng.js';

/** Human-readable label for each mechanical effect, used in the readout. */
const EFFECT_LABEL = {
  role: { guard: '수호자', raider: '습격자', artillery: '포격수' },
  cohort: { elite: '정예', pack: '무리', swarm: '군단' },
  shape: { sweep: '광역', precision: '정밀' },
  channel: { physical: '물리', arcane: '비술' },
  formation: { spread: '산개', compact: '밀집' },
  persistence: { relentless: '집요', flexible: '유연', steady: '보통' },
  wardAgainst: { physical: '물리 저항', arcane: '비술 저항' },
  pr: { hp: 'HP', damage: '피해', range: '사거리', speed: '속도', defense: '방어' },
};

/**
 * Split into "what I am building" vs "what I am hunting".
 * Without this, "적 원거리를 잡는 근접 암살자" builds an archer.
 */
export function splitClauses(text) {
  const tokens = text.split(/\s+/).filter(Boolean);
  const selfParts = [];
  const targetParts = [];
  let run = 0;
  for (const tok of tokens) {
    if (TARGET_MARKERS.some((m) => tok.startsWith(m))) { run = 2; targetParts.push(tok); continue; }
    if (run > 0) {
      // A verb/adnominal ending describes what WE do to them, not what they are.
      if (/(하는|되는|드는|치는|주는|뚫는|잡는|죽이는|노리는|미는|는|한|던)$/.test(tok)) {
        run = 0; selfParts.push(tok); continue;
      }
      targetParts.push(tok);
      run--;
      if (/(을|를|의|과|와)$/.test(tok)) run = 0;
      continue;
    }
    selfParts.push(tok);
  }
  return { self: selfParts.join(' '), target: targetParts.join(' ') };
}

// Pre-flatten the lexicon into (form, entry) pairs sorted longest-first.
const FORMS = LEXICON.flatMap((e) => e.w.map((w) => ({ w: w.replace(/\s+/g, ''), e })))
  .sort((a, b) => b.w.length - a.w.length);

/**
 * @param {string} prompt
 * @param {import('../domain/commanders.js').Commander} commander
 */
export function stubInterpret(prompt, commander) {
  const text = (prompt || '').trim();
  const { self, target } = splitClauses(text);
  const selfC = self.replace(/\s+/g, '');
  const targetC = target.replace(/\s+/g, '');

  const pr = { hp: 0, damage: 0, range: 0, speed: 0, defense: 0 };
  const roleVotes = { guard: 0, raider: 0, artillery: 0 };
  const cohortVotes = { elite: 0, pack: 0, swarm: 0 };
  const channelVotes = { physical: 0, arcane: 0 };
  let shape = null, formation = null, persistence = null, wardAgainst = null, countHint = null;
  const skills = [];
  /** @type {{text:string, effects:string[]}[]} */
  const spans = [];

  // consuming scan: mask out matched regions so shorter forms can't re-match
  let mask = selfC;
  for (const { w, e } of FORMS) {
    const at = mask.indexOf(w);
    if (at < 0) continue;
    mask = mask.slice(0, at) + '\0'.repeat(w.length) + mask.slice(at + w.length);

    const effects = [];
    if (e.role) { roleVotes[e.role] += 1; effects.push(EFFECT_LABEL.role[e.role]); }
    if (e.cohort) { cohortVotes[e.cohort] += 1; effects.push(EFFECT_LABEL.cohort[e.cohort]); }
    if (e.channel) { channelVotes[e.channel] += 1; effects.push(EFFECT_LABEL.channel[e.channel]); }
    if (e.shape && !shape) { shape = e.shape; effects.push(EFFECT_LABEL.shape[e.shape]); }
    if (e.formation && !formation) { formation = e.formation; effects.push(EFFECT_LABEL.formation[e.formation]); }
    if (e.persistence && !persistence) { persistence = e.persistence; effects.push(EFFECT_LABEL.persistence[e.persistence]); }
    if (e.wardAgainst && !wardAgainst) { wardAgainst = e.wardAgainst; effects.push(EFFECT_LABEL.wardAgainst[e.wardAgainst]); }
    if (e.skill && !skills.includes(e.skill)) { skills.push(e.skill); effects.push(`스킬:${e.skill}`); }
    if (e.count && countHint == null) { countHint = e.count; effects.push(`${e.count}기`); }
    if (e.pr) {
      for (const k of Object.keys(e.pr)) {
        pr[k] += e.pr[k];
        effects.push(`${EFFECT_LABEL.pr[k]}${e.pr[k] > 0 ? '+' : ''}${e.pr[k]}`);
      }
    }
    if (effects.length) spans.push({ text: w, effects });
  }

  for (const c of COUNT_WORDS) {
    if (c.w.some((w) => selfC.includes(w))) { countHint = c.n; break; }
  }
  const digit = selfC.match(/(\d+)\s*(마리|기|명|개|체)/);
  if (digit) countHint = nearestCount(parseInt(digit[1], 10));

  // target preference comes ONLY from the target clause
  let targetPreference = 'nearest';
  let targetSpan = null;
  for (const t of TARGET_PREF) {
    const hit = t.w.find((w) => targetC.includes(w));
    if (hit) { targetPreference = t.pref; targetSpan = hit; break; }
  }

  let role = argmax(roleVotes);
  if (!role) {
    if (pr.range >= 2) role = 'artillery';
    else if (pr.speed >= 2) role = 'raider';
    else if (pr.damage >= 2 && pr.hp < 2) role = 'raider';
    else role = 'guard';
  }
  if (targetPreference === 'backline' && roleVotes.artillery === 0) role = 'raider';

  const cohort = argmax(cohortVotes) || (countHint === 1 ? 'elite' : countHint >= 5 ? 'swarm' : 'pack');
  const count = /** @type {1|2|3|5} */ (countHint ?? { elite: 1, pack: 3, swarm: 5 }[cohort] ?? 1);
  const channel = argmax(channelVotes) || 'physical';

  // ---- leftover content words: the player wrote them and got nothing for it.
  // Surfacing these is how the game admits its own limits instead of pretending.
  const consumedForms = new Set(spans.map((s) => s.text));
  const unmatched = leftoverWords(self, consumedForms);
  const voided = VOID_WORDS.filter((v) => text.toLowerCase().includes(v.toLowerCase()));

  // confidence = share of content words that actually did something
  const contentCount = unmatched.length + spans.length || 1;
  const confidence = clamp01(0.30 + 0.7 * (spans.length / contentCount) - 0.05 * voided.length);

  return {
    role: /** @type {any} */ (role),
    cohort: /** @type {any} */ (cohort),
    attackShape: /** @type {any} */ (shape ?? 'precision'),
    damageChannel: /** @type {any} */ (channel),
    formation: /** @type {any} */ (formation ?? 'compact'),
    persistence: /** @type {any} */ (persistence ?? 'steady'),
    wardAgainst,
    priorities: {
      // Negative priorities are REAL. "느린 자객" (slow assassins) asks to take budget
      // OUT of speed and spend it elsewhere; clamping at 0 made the word vanish.
      // (Guards and artillery already sit at their role's speed cap of 3.0, so for
      // them "느린" only shifts the HP/damage split.)
      hp: clamp(pr.hp, -3, 3), damage: clamp(pr.damage, -3, 3), range: clamp(pr.range, -3, 3),
      speed: clamp(pr.speed, -3, 3), defense: clamp(pr.defense, -3, 3),
    },
    requestedCount: count,
    skills: skills.slice(0, 2),
    targetPreference: /** @type {any} */ (targetPreference),
    flavorName: coinName(text, commander),
    confidence,
    trace: { self, target, spans, unmatched, voided, targetSpan, roleVotes, cohortVotes, channelVotes },
  };
}

/**
 * Content words that produced nothing. Particles and filler are dropped so the
 * "ignored" list stays honest rather than noisy.
 */
const FILLER = /^(그|이|저|더|좀|아주|매우|정말|무슨|어떤|것|수|등|및|하고|그리고|또는|으로|에게|에서|에|의|을|를|은|는|이|가|과|와|도|만|처럼|같은|같이|하는|한|하며|되는|주는)$/;
function leftoverWords(self, consumed) {
  const out = [];
  for (const raw of self.split(/\s+/).filter(Boolean)) {
    const bare = raw.replace(/[,.!?"'()]/g, '');
    if (!bare || bare.length < 2 || FILLER.test(bare)) continue;
    const flat = bare.replace(/\s+/g, '');
    // a word counts as used if any consumed form appears inside it
    if ([...consumed].some((c) => flat.includes(c))) continue;
    out.push(bare);
  }
  return out;
}

/**
 * Placeholder for the real model adapter. Kept so the call site never changes.
 * When wired, it must return the SAME closed UnitIntent shape plus sourceSpans —
 * it may widen synonym coverage but must never invent a new mechanical axis.
 */
export async function llmInterpret(prompt, commander) {
  return stubInterpret(prompt, commander);
}

// ---------------------------------------------------------------- naming
const DEMON_PREFIX = ['심연의', '재의', '피의', '검은', '일곱번째', '녹슨', '굶주린'];
const HUMAN_PREFIX = ['강철의', '서약한', '백색', '제3', '망명', '등불', '봉인된'];

function coinName(text, commander) {
  const h = hashString(text + (commander?.id ?? ''));
  return (commander?.faction === 'demon' ? DEMON_PREFIX : HUMAN_PREFIX)[h % 7];
}

// ---------------------------------------------------------------- utils
function argmax(obj) {
  let best = null, bv = 0;
  for (const k of Object.keys(obj)) if (obj[k] > bv) { bv = obj[k]; best = k; }
  return best;
}
function nearestCount(n) {
  return [1, 2, 3, 5].reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clamp01 = (v) => Math.max(0, Math.min(1, v));
