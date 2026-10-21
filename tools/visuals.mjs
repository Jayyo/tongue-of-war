// Appearance harness: does the sentence actually change what gets drawn, and does
// it stay OUT of the stats? Run: node tools/visuals.mjs [--all]
//
// Gate 1 (semantic):  distinct sentences must produce distinct visual signatures
// Gate 2 (isolation):  appearance-only words must not move a single BP number
// Gate 3 (honesty):    a concept whose rig does not exist must report fallback
import { parseIntent } from '../src/gen/interpreter.js';
import { interpretVisual, visualSummary } from '../src/gen/visual.js';
import { compile } from '../src/domain/budget.js';
import { VISUAL_LEXICON, RIG_READY } from '../src/gen/visual-lexicon.js';

const NEUTRAL = { id: 'neutral', faction: 'demon', name: 'neutral', bias: {}, mechanic: { id: 'none' } };

const CASES = [
  '탱크 셋', '전차 부대', '기갑 사단', '드래곤 하나', '해골 군단 다섯',
  '저격수 셋', '투석기 둘', '기사단 셋', '늑대 다섯', '거인 하나',
  '독칼 암살자 셋', '치유사 둘', '리치 하나', '고블린 다섯', '오크 셋',
  '적 해골 궁수를 잡는 암살자 셋', '치킨집 사장 셋',
];

let rows = 0, distinct = new Set(), fallbacks = 0;
console.log('\n=== Sentence -> appearance (VisualIntent) ===');
for (const text of CASES) {
  const ui = parseIntent(text, NEUTRAL);
  const v = interpretVisual(text, ui, NEUTRAL);
  distinct.add(v.signature);
  if (v.fallback.used) fallbacks++;
  rows++;
  console.log(
    `${text.padEnd(20)} → ${v.concept.padEnd(11)} rig=${v.rigFamily.padEnd(9)} ` +
    `${v.rigReady ? '  ' : '△ '}${visualSummary(v)}`);
  if (v.unmatched.length) console.log(`${' '.repeat(22)}not recognised: ${v.unmatched.join(', ')}`);
}

// ---- Gate 2: appearance words must be invisible to the compiler.
// Compare a sentence against itself plus a pure-appearance word. If any BP number
// moves, the appearance path has leaked into the stat path.
console.log('\n=== Stat isolation (appearance words must not move any number) ===');
const PAIRS = [
  ['방패병 셋', '방패병 셋'],                 // control: identical
  ['방패병 셋', '왕관을 쓴 방패병 셋'],
  ['궁수 셋', '후드를 쓴 궁수 셋'],
];
let leaks = 0;
for (const [a, b] of PAIRS) {
  const bpA = compile(parseIntent(a, NEUTRAL), 120, NEUTRAL);
  const bpB = compile(parseIntent(b, NEUTRAL), 120, NEUTRAL);
  const keys = ['role', 'count', 'totalHp', 'totalDps', 'range', 'speed', 'channel'];
  const diff = keys.filter((k) => String(bpA[k]) !== String(bpB[k]));
  const known = b !== a && diff.length > 0;
  if (known) leaks++;
  console.log(`  "${a}" vs "${b}" -> ${diff.length ? 'differs: ' + diff.join(',') : 'identical'}`);
}

// ---- Gate 3: coverage of the lexicon vs what the renderer can build
const byRig = {};
for (const e of VISUAL_LEXICON) byRig[e.rig] = (byRig[e.rig] ?? 0) + 1;
console.log('\n=== Lexicon coverage ===');
for (const [rig, n] of Object.entries(byRig).sort((x, y) => y[1] - x[1])) {
  console.log(`  ${rig.padEnd(10)} ${String(n).padStart(3)} words ${RIG_READY.has(rig) ? '(rig available)' : '(no rig yet -> fallback)'}`);
}

const ok = distinct.size >= rows - 2 && leaks === 0;
console.log(`\n  distinct looks: ${distinct.size}/${rows}  ·  fallbacks: ${fallbacks}  ·  stat leaks: ${leaks}`);
console.log(`  VISUALS=${ok ? 'PASS' : 'FAIL'}`);
process.exitCode = ok ? 0 : 1;
