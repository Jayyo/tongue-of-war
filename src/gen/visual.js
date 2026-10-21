// @ts-check
// Sentence -> VisualIntent. APPEARANCE ONLY.
//
// Why this is a separate file from interpreter.js: the combat parser and the
// appearance parser must not share an output. If one object fed both the BP
// compiler and the renderer, an appearance word would eventually become a stat
// word ("heavy armour" quietly buying HP), and the whole "the model cannot make
// numbers" guarantee would leak. So:
//
//   sentence ─┬─> UnitIntent   (interpreter.js) -> budget.js -> stats
//             └─> VisualIntent (this file)      -> renderer  -> pixels
//
// `roleSilhouette` is COPIED from the already-decided UnitIntent.role. The visual
// lexicon's own `role` hint is used only to pick a concept when the sentence gave
// the combat parser nothing to work with.

import { VISUAL_LEXICON, RIG_READY, READY_CONCEPTS, ROLE_DEFAULT_LOOK } from './visual-lexicon.js';
import { TARGET_MARKERS } from './lexicon.js';
import { hashString } from '../engine/rng.js';

// longest surface form first, so 강철거인 is never re-read as 강철 + 거인
const SORTED = [...VISUAL_LEXICON].sort((a, b) => b.w.length - a.w.length);

/**
 * Split the sentence into "about me" and "about the enemy". A sentence like
 * `적 해골 궁수를 잡는 암살자` must render an assassin, not a skeleton archer.
 * @param {string} text
 */
function selfClause(text) {
  const parts = [];
  let cursor = 0;
  const marks = [];
  for (const m of TARGET_MARKERS) {
    let i = text.indexOf(m);
    while (i !== -1) { marks.push(i); i = text.indexOf(m, i + 1); }
  }
  marks.sort((a, b) => a - b);
  for (const at of marks) {
    // the enemy clause runs to the next particle that hands the sentence back
    const rest = text.slice(at);
    const end = rest.search(/(을|를|이|가|은|는)\s|\s/);
    parts.push(text.slice(cursor, at));
    cursor = at + (end === -1 ? rest.length : end + 1);
  }
  parts.push(text.slice(cursor));
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * @param {string} text raw sentence
 * @param {{role:string}} unitIntent the ALREADY decided combat intent
 * @param {{faction?:string}} [commander]
 */
export function interpretVisual(text, unitIntent, commander = {}) {
  const self = selfClause(String(text ?? ''));
  const flat = self.replace(/\s+/g, '');
  const struck = Array(flat.length).fill(false);

  /** @type {{text:string, concept:string, axes:string[]}[]} */
  const spans = [];
  const picked = [];
  for (const e of SORTED) {
    const key = e.w.replace(/\s+/g, '');
    let from = 0;
    for (;;) {
      const at = flat.indexOf(key, from);
      if (at === -1) break;
      const free = struck.slice(at, at + key.length).every((x) => !x);
      if (free) {
        for (let i = at; i < at + key.length; i++) struck[i] = true;
        picked.push({ e, at });
        spans.push({ text: e.w, concept: e.concept, axes: ['실루엣', '파츠', '무기', '재질'] });
        break;                       // one hit per entry is enough to set a concept
      }
      from = at + 1;
    }
  }

  const role = unitIntent?.role ?? 'guard';
  // Conflict rule from the design: entry priority -> longer surface -> further right.
  // Korean puts the head noun late, so "강철 해골 궁수" should read as an archer.
  picked.sort((a, b) => (b.e.w.length - a.e.w.length) || (b.at - a.at));
  // Ornament-class entries (the table's "역할 유지" rows: 군단, 깃발, 후드…) describe
  // decoration, not identity. Letting one win the head slot turned "해골 군단 다섯"
  // into a generic role default and threw the skeleton away.
  const identity = picked.filter((p) => p.e.kind !== 'ornament');
  const pool = identity.length ? identity : picked;
  const head = pool.length
    ? pool.slice().sort((a, b) => (b.at - a.at) || (b.e.w.length - a.e.w.length))[0].e
    : null;

  const base = ROLE_DEFAULT_LOOK[role] ?? ROLE_DEFAULT_LOOK.guard;
  const chosen = head
    ? { ...head, rig: head.kind === 'species' ? base.rig : head.rig }
    : { rig: base.rig, concept: base.concept, parts: base.parts, weapon: base.weapon, look: base.look };
  // a species keeps the role's weapon unless it brought its own
  if (head && head.kind === 'species' && /유지/.test(head.weapon)) chosen.weapon = base.weapon;

  // Secondary entries still contribute material/ornament flavour even when they
  // did not win the head slot — that is how "강철 해골" gets an iron-clad skeleton.
  const accents = picked.filter((p) => p.e !== head).slice(0, 2).map((p) => p.e.look.split(',')[0].trim());
  // Ornaments still get to add their prop even when they lost the head slot.
  const props = picked.filter((p) => p.e.kind === 'ornament' && p.e !== head)
    .map((p) => p.e.parts).slice(0, 2);

  const rigReady = chosen.rig === 'biped'
    ? RIG_READY.has(chosen.rig)
    : RIG_READY.has(chosen.rig) && READY_CONCEPTS.has(chosen.concept);
  const intent = {
    schemaVersion: 1,
    roleSilhouette: role,
    rigFamily: chosen.rig,
    concept: chosen.concept,
    parts: chosen.parts,
    weapon: chosen.weapon,
    look: chosen.look,
    accents,
    props,
    faction: commander.faction ?? 'demon',
    // A concept whose skeleton does not exist yet must SAY so rather than
    // silently drawing a human and pretending the word landed.
    rigReady,
    fallback: rigReady
      ? { used: false, reason: null }
      : { used: true, reason: `${chosen.rig} 골격 미구현 — 역할 기본 실루엣으로 대체`, concept: base.concept },
    spans,
    unmatched: leftovers(self, picked.map((p) => p.e.w)),
    signature: '',
  };
  intent.signature = signatureOf(intent);
  return intent;
}

/** Content words that produced no appearance. Honest, not noisy. */
function leftovers(self, used) {
  const stop = /^(적|상대|의|을|를|이|가|은|는|에|와|과|로|으로|하는|한|셋|둘|하나|다섯|마리|기)$/;
  return self.split(/\s+/)
    .filter((w) => w && !stop.test(w) && !used.some((u) => w.includes(u)))
    .slice(0, 6);
}

/** Canonical identity: same recipe -> same signature, so caches and art reuse hit. */
function signatureOf(v) {
  // The recipe, not just the concept: 탱크 and 전차 are both `landship` but differ in
  // hull, weapon and palette, and the art cache must treat them as different units.
  const key = [v.faction, v.roleSilhouette, v.rigFamily, v.concept,
               v.parts, v.weapon, v.look, ...v.accents, ...(v.props ?? [])].join('|');
  return `${v.concept}-${(hashString(key) % 0xffff).toString(16).padStart(4, '0')}`;
}

/** One-line readout for the receipt / drawer. */
export function visualSummary(v) {
  const bits = [v.parts.split(',')[0], v.weapon.split(',')[0], v.look.split(',').slice(-1)[0]];
  return bits.map((s) => s.trim()).filter(Boolean).join(' · ');
}
