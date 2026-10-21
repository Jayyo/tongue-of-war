// @ts-check
// Bootstrap, game loop, DOM wiring. All strategy lives in src/domain + src/engine;
// this file only translates between them and the screen.

import { COMMANDERS, getCommander } from './domain/commanders.js';
import { compile } from './domain/budget.js';
import { SKILLS } from './domain/skills.js';
import { stubInterpret } from './gen/interpreter.js';
import { interpretVisual, visualSummary } from './gen/visual.js';
import { computeSignals, extractClaim, verifyClaim, echoMultiplier, suggestPrompts } from './domain/signals.js';
import {
  createBattle, step, queueContract, player, structOf,
  SIDE, other, frontline, roleLabel, sideKind, logMsg,
} from './engine/sim.js';
import { makeRenderer } from './ui/renderer-three.js';
import { askOpponent, DIFFICULTY } from './ai/llm-opponent.js';
import { CFG } from './config.js';

const $ = (id) => document.getElementById(id);

// Player sentences and model output end up in innerHTML templates (log, receipt,
// cards, recap). Everything that did not come from our own constant tables goes
// through this first.
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

const state = {
  chosen: null, battle: null, render: null, mySide: SIDE.L,
  tier: 'standard', castCost: null,
  lastBlueprint: null, lastPrompt: '', lastIntent: null, lastTier: 'standard',
  cards: [], scrollHistory: [], castLog: [],
  raf: 0, acc: 0, lastNow: 0,
  aiWave: 0, aiBusy: false, aiMode: 'unknown', diff: 'duel', transmuting: false,
};

// ==================================================================== select
function buildSelect() {
  const grid = $('commander-grid');
  grid.innerHTML = '';
  for (const faction of ['demon', 'human']) {
    const head = document.createElement('div');
    head.className = `faction-head ${faction}`;
    head.textContent = faction === 'demon' ? '마 계' : '인 간 계';
    grid.appendChild(head);
    for (const c of COMMANDERS.filter((x) => x.faction === faction)) {
      const card = document.createElement('button');
      card.className = 'cmd-card';
      card.dataset.id = c.id;
      card.dataset.faction = faction;
      // Portrait leads; the mechanic text is NOT on the card face — six cards of
      // dense paragraphs read as a spec sheet, not a roster. Detail moves to a
      // single briefing pane that only shows the selected commander.
      card.innerHTML = `
        <div class="cmd-art"><img src="./assets/portraits/${c.id}.webp" alt="" loading="eager" /></div>
        <div class="cmd-plate">
          <div class="cmd-epithet">${c.epithet}</div>
          <div class="cmd-name">${c.name}</div>
          <div class="cmd-tags">${c.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div>
        </div>`;
      card.onclick = () => {
        state.chosen = c.id;
        [...grid.querySelectorAll('.cmd-card')].forEach((el) => el.classList.remove('sel'));
        card.classList.add('sel');
        $('btn-start').disabled = false;
        showBriefing(c);
      };
      grid.appendChild(card);
    }
  }
}

/** Detail pane for the selected commander only — keeps the grid visual. */
function showBriefing(c) {
  const foe = pickFoe(c);
  const box = $('briefing');
  box.hidden = false;
  box.dataset.faction = c.faction;
  box.innerHTML = `
    <div class="bf-main">
      <div class="bf-head">
        <span class="bf-name">${c.name}</span>
        <span class="bf-epithet">${c.epithet}</span>
      </div>
      <p class="bf-desc">${c.desc}</p>
      <div class="bf-mech">
        <span class="bf-mech-label">${c.mechanic.label}</span>
        <span class="bf-mech-desc">${c.mechanic.desc}</span>
      </div>
    </div>
    <div class="bf-vs">
      <span class="bf-vs-label">상대</span>
      <img class="bf-foe-art" src="./assets/portraits/${foe.id}.webp" alt="" />
      <span class="bf-foe-name">${foe.name}</span>
      <span class="bf-foe-ep">${foe.epithet}</span>
    </div>`;
}

const DIFF_NOTE = {
  novice: '적 구성이 흐릿하게만 보인다',
  duel:   '양쪽이 같은 정보를 본다',
  abyss:  '위협 수치까지 정확히 읽는다',
};

function buildDiffPick() {
  const box = $('diff-pick');
  box.innerHTML = '';
  for (const d of Object.values(DIFFICULTY)) {
    const b = document.createElement('button');
    b.className = 'diff-btn' + (d.id === state.diff ? ' on' : '');
    b.innerHTML = `<b>${d.label}</b><em>${DIFF_NOTE[d.id]}</em>`;
    b.onclick = () => { state.diff = d.id; buildDiffPick(); };
    box.appendChild(b);
  }
}

function pickFoe(c) {
  const mine = COMMANDERS.filter((x) => x.faction === c.faction);
  const theirs = COMMANDERS.filter((x) => x.faction !== c.faction);
  return theirs[mine.indexOf(c) % theirs.length];
}

// ==================================================================== battle
async function startBattle() {
  const me = getCommander(state.chosen);
  const foe = pickFoe(me);
  const myside = me.faction === 'demon' ? SIDE.L : SIDE.R;

  state.battle = createBattle({
    seed: (Date.now() % 100000) | 0,
    players: [
      { side: myside, commander: me },
      { side: other(myside), commander: foe, isBot: true },
    ],
  });
  state.mySide = myside;
  Object.assign(state, {
    cards: [], scrollHistory: [], castLog: [], lastBlueprint: null, lastIntent: null, transmuting: false,
    lastTier: state.tier, aiWave: 0, aiBusy: false,
  });

  $('label-p1').innerHTML = labelFor(SIDE.L);
  $('label-p2').innerHTML = labelFor(SIDE.R);
  $('face-p1').src = `./assets/portraits/${player(state.battle, SIDE.L).commander.id}.webp`;
  $('face-p2').src = `./assets/portraits/${player(state.battle, SIDE.R).commander.id}.webp`;
  $('foe-quote').hidden = true;

  buildTierPick(); buildUpgrades(); renderCards();
  logMsg(state.battle, 'hot', `${me.name} vs ${foe.name} — 전투 개시`);

  show('screen-battle');
  if (!state.render) state.render = makeRenderer(/** @type {HTMLCanvasElement} */ ($('field')));
  state.lastNow = performance.now();
  state.acc = 0;
  cancelAnimationFrame(state.raf);
  loop();
  $('prompt-input').focus();
  preview();
  probeAi();
}

/** One health check tells the player whether they're facing a model or the bot. */
async function probeAi() {
  const B = state.battle;
  try {
    const r = await fetch('/api/health').then((x) => x.json());
    state.aiMode = r?.provider ? 'llm' : 'stub';
    logMsg(B, 'sys', r?.provider
      ? `상대 사령관: ${r.provider} / ${r.model} 이 직접 주문을 쓴다`
      : '상대 사령관: LLM 키가 없어 내장 봇이 대신 둔다');
  } catch {
    state.aiMode = 'stub';
    logMsg(B, 'sys', '상대 사령관: 정적 서버로 실행 중 — 내장 봇이 대신 둔다');
  }
}

const labelFor = (side) => {
  const p = player(state.battle, side);
  return `${p.commander.name}<em>${p.commander.faction === 'demon' ? '마계' : '인간계'}${p.isBot ? ' · AI' : ''}</em>`;
};

function buildTierPick() {
  const box = $('tier-pick');
  box.innerHTML = '';
  for (const [k, t] of Object.entries(CFG.ritual.tiers)) {
    const b = document.createElement('button');
    b.className = 'tier-btn' + (k === state.tier ? ' on' : '');
    b.innerHTML = `<span>${t.label}</span><i>${t.cost}</i>`;
    b.onclick = () => { state.tier = k; buildTierPick(); preview(); };
    box.appendChild(b);
  }
}

function buildUpgrades() {
  const row = $('upgrade-row');
  row.innerHTML = '';
  for (const [id, d] of Object.entries(CFG.upgrades.doctrines)) {
    const b = document.createElement('button');
    b.className = 'upg-btn';
    b.dataset.id = id;
    b.innerHTML = `<b>${d.label.replace(' 교리', '')}</b><span></span>`;
    b.onclick = () => buyUpgrade(id);
    row.appendChild(b);
  }
}

function buyUpgrade(id) {
  const B = state.battle;
  const p = player(B, state.mySide);
  const tier = CFG.upgrades.tiers[p.upgrades.length];
  if (!tier) return fail('이미 교리를 익혔다');
  if (B.t < tier.unlockAt) return fail(`교리는 ${Math.ceil(tier.unlockAt - B.t)}초 뒤 해금된다`);
  const cost = Math.round(tier.cost * (p.commander.mechanic.id === 'forge' ? 1 - p.commander.mechanic.upgradeDiscount : 1));
  if (p.essence < cost) return fail(`영기 ${Math.ceil(cost - p.essence)} 부족 — 교리에 ${cost} 필요`);
  p.essence -= cost;
  p.upgrades.push(id);
  logMsg(B, sideKind(state.mySide), `교리 습득: ${CFG.upgrades.doctrines[id].label} (-${cost})`);
}

// ---------------------------------------------------------------- prompting
/** interpret -> context claim -> tactic grant -> compile -> price */
function interpretNow(text, tierKey = state.tier, history = state.scrollHistory) {
  const B = state.battle;
  const p = player(B, state.mySide);
  if (!text) return null;

  const intent = stubInterpret(text, p.commander);
  const live = computeSignals(B, state.mySide);
  const claim = extractClaim(text);
  const verdict = verifyClaim(claim, live);
  if (verdict.ok && verdict.mechanism) {
    intent.claimSignal = claim.signal;
    if (!intent.skills.includes(verdict.mechanism)) {
      intent.skills = [verdict.mechanism, ...intent.skills].slice(0, 2);
    }
  }

  const tier = CFG.ritual.tiers[tierKey];
  const bp = compile(intent, tier.bp, p.commander);
  const R = CFG.ritual;
  const echo = echoMultiplier(intent, history);
  const base = verdict.ok ? tier.cost * R.contextDiscount : tier.cost;
  const cost = Math.ceil((base * echo) / 5) * 5;
  // Appearance is parsed on a SEPARATE path and never touches `bp`.
  const visual = interpretVisual(text, intent, p.commander);
  return { intent, bp, text, live, claim, verdict, cost, echo, tierCost: tier.cost, visual };
}

function preview() {
  const B = state.battle;
  if (!B) return;
  paintSignals(B);
  const text = /** @type {HTMLTextAreaElement} */ ($('prompt-input')).value.trim();
  const r = interpretNow(text);
  if (!r) {
    $('receipt').innerHTML = '<span class="more">문장을 적으면 어떤 단어가 무엇이 되는지 여기에 나온다</span>';
    $('detail').innerHTML = '';
    $('cast-cost').textContent = `◆${CFG.ritual.tiers[state.tier].cost}`;
    state.castCost = null;
    $('btn-summon').classList.remove('poor');
    return;
  }
  $('receipt').innerHTML = receiptHtml(r);
  $('detail').innerHTML = detailHtml(r);
  // the cast button carries the live price and turns red when unaffordable,
  // so "why didn't it summon" is answered before the click
  const me = player(B, state.mySide);
  $('cast-cost').textContent = `◆${r.cost}`;
  state.castCost = r.cost;                  // paintHud re-checks this every frame
  $('btn-summon').classList.toggle('poor', me.essence < r.cost);
}

function paintSignals(B) {
  const live = computeSignals(B, state.mySide);
  // Percentages were noise: `core_pressure` is binary and composition ratios hit
  // 100% whenever the enemy fields one cohort, so the row read "100% 100% 100%".
  // Three bars of intensity carry the same decision with none of the false
  // precision, and TWO signals is what the HUD design actually called for.
  const dots = (r) => (r >= 0.85 ? '●●●' : r >= 0.6 ? '●●○' : '●○○');
  $('signal-row').innerHTML = live.length
    ? live.slice(0, 2).map((s) =>
        `<span class="sig" title="${s.desc} — 대응: ${(s.answers ?? []).join(', ') || '없음'}">` +
        `${s.label}<i>${dots(s.ratio)}</i></span>`).join('')
    : '<span class="sig off">관측된 위협 없음</span>';
}

/** Suggested openings. Clicking one FILLS the box — it never summons for you. */
let suggestKey = '';
function paintSuggestions(B) {
  const me = player(B, state.mySide);
  const list = suggestPrompts(B, state.mySide, me.commander.faction);
  const key = list.map((s) => s.text).join('|');
  if (key === suggestKey) return;
  suggestKey = key;
  // Two suggestions, not three: the row competes with the input box for attention
  // and a third option has never changed a decision in playtest.
  $('suggest-row').innerHTML = list.slice(0, 2).map((s) =>
    `<button class="sg" data-text="${esc(s.text)}"><em>${esc(s.label)}</em>${esc(s.text)}</button>`).join('');
  for (const b of $('suggest-row').children) {
    b.onclick = () => {
      const ta = $('prompt-input');
      ta.value = b.dataset.text;
      ta.focus();
      // put the caret at the end so the player naturally edits the tail
      ta.setSelectionRange(ta.value.length, ta.value.length);
      preview();
    };
  }
}

/**
 * The receipt: at most four `조각 -> 효과` chips, always visible.
 * This is the minimum honest answer to "did my sentence do anything?".
 */
function receiptHtml(r) {
  const { intent, bp } = r;
  const tr = intent.trace ?? {};
  const chips = [];
  if (tr.targetSpan) {
    chips.push(`<span class="sp tgt"><b>적 ${tr.targetSpan}</b><i>${TARGET_LABEL[bp.targetPreference] ?? ''}</i></span>`);
  }
  for (const sp of (tr.spans ?? []).slice(0, 4 - chips.length)) {
    chips.push(`<span class="sp"><b>${sp.text}</b><i>${sp.effects.slice(0, 2).join('·')}</i></span>`);
  }
  // The appearance chip answers "did the game understand what I asked to SEE?".
  // It is deliberately the last chip: stats first, looks second.
  if (r.visual) {
    const v = r.visual;
    const label = v.rigReady ? '외형' : '외형(대체)';
    chips.push(`<span class="sp vis" title="${visualSummary(v)}${v.fallback.used ? ' — ' + v.fallback.reason : ''}">` +
      `<b>${label}</b><i>${v.concept}${v.rigReady ? '' : ' △'}</i></span>`);
  }
  const dead = (tr.unmatched ?? []).length;
  const voided = (tr.voided ?? []).length;
  const extra = Math.max(0, (tr.spans ?? []).length - (4 - (tr.targetSpan ? 1 : 0)));
  if (voided) chips.push(`<span class="sp void"><b>${esc(tr.voided[0])}</b><i>규칙상 불가</i></span>`);
  else if (dead) chips.push(`<span class="sp dead"><b>${esc(tr.unmatched[0])}</b><i>외형 전용</i></span>`);
  if (extra > 0 || dead > 1) chips.push(`<span class="more">+${extra + Math.max(0, dead - 1)} · 해석 보기</span>`);
  return chips.join('');
}

/** Everything precise lives in the drawer, one keypress away. */
function detailHtml(r) {
  const { intent, bp, verdict, cost, echo, tierCost } = r;
  const b = bp.breakdown;
  const tr = intent.trace ?? {};
  const conf = Math.round((intent.confidence ?? 1) * 100);
  return `
    <div><b>${Math.round(bp.totalHp)}</b> HP · <b>${Math.round(bp.totalDps)}</b> DPS ·
      사거리 <b>${bp.range.toFixed(1)}m</b> · 속도 <b>${bp.speed.toFixed(1)}</b>
      ${bp.resistPhysical > 0.01 ? `· 저항 ${Math.round(bp.resistPhysical * 100)}/${Math.round(bp.resistArcane * 100)}%` : ''}
      ${roleCapNote(bp)}</div>
    <div>${b.budget}BP → HP ${b.hp} / 피해 ${b.dps} / 방어 ${b.defense} / 사거리 ${b.range} / 속도 ${b.speed} / 스킬 ${b.skill} / 진형 ${b.formation ?? 0} / 분할 ${b.split} / 시너지 ${b.synergy}</div>
    <div>비용 <b>◆${cost}</b>
      ${verdict?.ok ? '<span class="good">문맥 대응 −20%</span>' : ''}
      ${echo > 1 ? `<span class="warn">동어반복 +${Math.round((echo - 1) * 100)}%</span>` : ''}
      ${cost !== tierCost ? `<span class="dim">(기본 ${tierCost})</span>` : ''}</div>
    ${verdict?.reason ? `<div class="${verdict.ok ? 'good' : 'warn'}">${verdict.ok ? '✔' : '✖'} ${esc(verdict.reason)}</div>` : ''}
    ${bp.skills.length ? `<div>스킬: ${bp.skills.map((k) => `<b>${SKILLS[k].label}</b> — ${SKILLS[k].desc}`).join('<br>')}</div>` : ''}
    ${(tr.unmatched ?? []).length ? `<div class="dim">외형 전용(0BP): ${esc(tr.unmatched.join(', '))}</div>` : ''}
    ${(tr.voided ?? []).length ? `<div class="warn">규칙상 불가: ${esc(tr.voided.join(', '))}</div>` : ''}
    <div class="dim">해석 신뢰도 ${conf}%</div>`;
}

const TARGET_LABEL = { backline: '후열 우선', highestHp: '단단한 적 우선', lowestHp: '약한 적 우선', nearest: '가까운 적' };

function roleCapNote(bp) {
  const rc = CFG.roles[bp.role];
  const notes = [];
  if (rc.speedMax && bp.speed >= rc.speedMax - 0.02) notes.push(`${roleLabel(bp.role)} 속도 상한`);
  if (rc.rangeMin && bp.range <= rc.rangeMin + 0.02) notes.push('사거리 하한');
  return notes.length ? `<span class="capnote">· ${notes.join(' · ')} 도달</span>` : '';
}

function summon() {
  const B = state.battle;
  const text = /** @type {HTMLTextAreaElement} */ ($('prompt-input')).value.trim();
  const r = interpretNow(text);
  if (!r) return fail('주문을 먼저 적어라');
  // A summon that silently does nothing is the worst possible feedback. Say the
  // exact shortfall and how long until it is affordable.
  const me = player(B, state.mySide);
  // The lock is the pacing rule now that summons are immediate — say it plainly.
  if (B.t < (me.lockUntil ?? 0)) {
    return fail(`명령 잠금 — ${(me.lockUntil - B.t).toFixed(1)}초 뒤 다음 주문`);
  }
  if (me.essence < r.cost) {
    const short = Math.ceil(r.cost - me.essence);
    const secs = Math.ceil(short / Math.max(0.1, CFG.economy.income(B.t)));
    return fail(`영기 ${short} 부족 — 약 ${secs}초 뒤 가능 (보유 ${Math.floor(me.essence)} / 필요 ${r.cost})`);
  }
  // The renderer needs the appearance recipe, and the only thing that survives from
  // here to the field is the blueprint — so it rides along on it. It is read ONLY by
  // the renderer; budget.js has already finished with this object.
  r.bp.visual = r.visual;
  if (!queueContract(B, state.mySide, r.bp, r.cost)) return fail('소환 실패');
  state.lastBlueprint = r.bp;
  state.lastPrompt = r.text;
  state.lastIntent = r.intent;
  state.lastTier = state.tier;
  state.scrollHistory.push(r.intent);
  // The post-match recap is the only place a prompt game can show the player what
  // their own words built — keep the sentence, not just the parsed intent.
  state.castLog.push({
    text: r.text, cost: r.cost, role: r.bp.role, count: r.bp.count,
    concept: r.visual?.concept ?? '-', hp: Math.round(r.bp.totalHp), dps: Math.round(r.bp.totalDps),
  });
  player(B, state.mySide).lastSentence = r.text;
  player(B, state.mySide).lastSummonFx = B.t;
  $('btn-engrave').disabled = state.cards.length >= CFG.ritual.engraveSlots;
  castFlash(r.text);
  // Summons are immediate: the cohort is already materialising in front of the core.
  banner('ok', `현현 중 — ${CFG.ritual.manifestDelay.toFixed(1)}초 뒤 전장에 선다`);
  logMsg(B, sideKind(state.mySide), `주문 완성 (◈${r.cost}${r.verdict?.ok ? ', 문맥 대응' : ''}) — 현현 중`);
  $('receipt').innerHTML = receiptHtml(r);
  $('detail').innerHTML = detailHtml(r);
}

/** The moment the sentence becomes an army — burn it across the screen. */
function castFlash(text) {
  const el = $('cast-flash');
  $('cast-flash-text').textContent = text;
  el.classList.remove('go');
  void el.offsetWidth;
  el.classList.add('go');
}

function engrave() {
  const B = state.battle;
  const p = player(B, state.mySide);
  if (!state.lastBlueprint) return fail('먼저 소환해서 실전에 써본 설계만 각인할 수 있다');
  if (state.cards.length >= CFG.ritual.engraveSlots) return fail(`각인 슬롯이 가득 찼다 (${CFG.ritual.engraveSlots}칸)`);
  const tierCost = CFG.ritual.tiers[state.lastTier].cost;
  const cost = Math.round(tierCost * CFG.ritual.engraveCostMul);
  if (p.essence < cost) return fail(`영기 ${Math.ceil(cost - p.essence)} 부족 — 각인에 ${cost} 필요`);
  p.essence -= cost;
  state.cards.push({ bp: state.lastBlueprint, prompt: state.lastPrompt, tier: state.lastTier });
  logMsg(B, sideKind(state.mySide), `각인 (-${cost}) — 이후 ◈${Math.round(tierCost * CFG.ritual.engravedCastMul)}에 재소환`);
  renderCards();
}

function renderCards() {
  const box = $('card-slots');
  box.innerHTML = '';
  for (let i = 0; i < CFG.ritual.engraveSlots; i++) {
    const c = state.cards[i];
    const el = document.createElement('button');
    el.className = 'card' + (c ? '' : ' empty');
    if (!c) { el.textContent = '빈 슬롯'; el.disabled = true; }
    else {
      const cost = Math.round(CFG.ritual.tiers[c.tier].cost * CFG.ritual.engravedCastMul);
      const arcane = c.bp.channel === 'arcane';
      el.innerHTML = `<span class="chip role-${c.bp.role}">${roleLabel(c.bp.role)}</span>
        <i class="card-ch${arcane ? ' arcane' : ''}"></i>
        <span class="card-name">${esc(c.prompt)}</span><span class="card-cost">◈${cost}</span>`;
      el.title = `${c.prompt} (${arcane ? '비술' : '물리'})`;
      el.onclick = () => {
        if (state.transmuting) return transmute(c);
        const B = state.battle;
        const me = player(B, state.mySide);
        if (B.t < (me.lockUntil ?? 0)) return fail(`명령 잠금 — ${(me.lockUntil - B.t).toFixed(1)}초 뒤 다음 주문`);
        if (!queueContract(B, state.mySide, c.bp, cost)) return fail(`영기 ${Math.ceil(cost - me.essence)} 부족 — 재소환에 ${cost} 필요`);
        me.lastSummonFx = B.t;
        logMsg(B, sideKind(state.mySide), `재소환: ${c.prompt} (-${cost})`);
      };
    }
    box.appendChild(el);
  }
  // The engrave cost now rides on the button itself instead of a separate label.
  const engCost = Math.round(CFG.ritual.tiers[state.lastTier ?? state.tier].cost * CFG.ritual.engraveCostMul);
  $('btn-engrave').textContent = `각인 ◆${engCost} (${state.cards.length}/${CFG.ritual.engraveSlots})`;
  const mech = player(state.battle, state.mySide).commander.mechanic;
  const tx = $('btn-transmute');
  tx.hidden = mech.id !== 'transmute';
  tx.disabled = !state.cards.length;
  tx.classList.toggle('on', state.transmuting);
  if (!tx.hidden) tx.textContent = state.transmuting ? '연성할 카드 선택' : `연성 ◆${mech.cost}`;
}

/**
 * The alchemist's lever: flip an engraved card between physical and arcane, so a
 * design the enemy has started resisting comes back through the other channel.
 * Arm the button, then click a card. Only future recasts change; units already on
 * the field keep the channel they were summoned with.
 */
function toggleTransmute() {
  state.transmuting = !state.transmuting && state.cards.length > 0;
  renderCards();
}

function transmute(card) {
  const B = state.battle;
  const p = player(B, state.mySide);
  const m = p.commander.mechanic;
  state.transmuting = false;
  renderCards();
  const readyAt = (card.transmutedAt ?? -Infinity) + m.cooldownWaves;
  if (B.wave < readyAt) return fail(`이 카드는 ${readyAt - B.wave}국면 뒤에 다시 연성할 수 있다`);
  if (p.essence < m.cost) return fail(`영기 ${Math.ceil(m.cost - p.essence)} 부족 — 연성에 ${m.cost} 필요`);
  p.essence -= m.cost;
  const channel = card.bp.channel === 'arcane' ? 'physical' : 'arcane';
  card.bp = { ...card.bp, channel };
  card.transmutedAt = B.wave;
  logMsg(B, sideKind(state.mySide), `전투 연성: ${card.prompt} → ${channel === 'arcane' ? '비술' : '물리'} (-${m.cost})`);
  renderCards();
}

// ---------------------------------------------------------------- loop
const DT = 0.05;

function loop() {
  state.raf = requestAnimationFrame(loop);
  const B = state.battle;
  if (!B) return;
  const now = performance.now();
  let elapsed = (now - state.lastNow) / 1000;
  state.lastNow = now;
  if (elapsed > 0.5) elapsed = 0.5;
  state.acc += elapsed;

  while (state.acc >= DT) {
    const waveBefore = B.wave;
    step(B, DT);
    state.acc -= DT;
    // FAIRNESS: the opponent is asked at the wave boundary, on the state that
    // exists BEFORE this wave's play. If we called it after the player summoned,
    // the AI would be reacting to an order the player can no longer take back —
    // it would be reading the human's hand.
    if (B.wave > waveBefore && B.wave > state.aiWave) { state.aiWave = B.wave; runOpponent(B); }
    if (B.over) break;
  }
  state.render(B);
  paintHud(B);
  if (B.over) endBattle(B);
}

// ---------------------------------------------------------------- opponent
let botModule = null;

const FALLBACK_TAG = {
  no_provider: '내장 봇', timeout: '내장 봇 · 응답 시간 초과',
  rate_limited: '내장 봇 · 호출 제한', empty: '내장 봇 · 빈 응답', unaffordable: '내장 봇',
};

/**
 * Ask the model for a sentence; run it through the SAME pipeline the player uses.
 * Anything that goes wrong falls through to the scripted bot, and the quote box
 * says which of the two actually wrote the line.
 */
async function runOpponent(B) {
  const side = other(state.mySide);
  if (state.aiBusy) return;
  const diff = DIFFICULTY[state.diff] ?? DIFFICULTY.duel;
  let reason = 'no_provider';
  if (state.aiMode === 'llm') {
    state.aiBusy = true;
    try {
      const got = await askOpponent(B, side, diff);
      // A slow answer can land after the match ended or a new one started.
      if (B !== state.battle || B.over) return;
      if (got.sentence) {
        const p = player(B, side);
        const intent = stubInterpret(got.sentence, p.commander);
        const tierKey = p.essence >= CFG.ritual.tiers.greater.cost ? 'greater'
          : p.essence >= CFG.ritual.tiers.standard.cost ? 'standard' : 'small';
        const tier = CFG.ritual.tiers[tierKey];
        const bp = compile(intent, tier.bp, p.commander);
        // the AI's sentence goes through the SAME appearance path as the player's
        bp.visual = interpretVisual(got.sentence, intent, p.commander);
        if (queueContract(B, side, bp, tier.cost)) {
          p.lastSentence = got.sentence;
          p.lastSummonFx = B.t;
          showFoeQuote(p, got.sentence, got.cached ? `${got.provider} · 캐시` : `${got.provider} · ${got.ms}ms`, bp);
          logMsg(B, sideKind(side), `상대 주문: "${got.sentence}"`);
          return;
        }
        reason = 'unaffordable';
      } else {
        reason = got.reason ?? 'error';
      }
    } finally { state.aiBusy = false; }
  }

  if (!botModule) botModule = await import('./ai/bot.js');
  if (B !== state.battle || B.over) return;
  const act = botModule.botThink(B, side, diff);
  if (act?.kind === 'summon') {
    const p = player(B, side);
    p.lastSentence = act.prompt;
    p.lastSummonFx = B.t;
    showFoeQuote(p, act.prompt, FALLBACK_TAG[reason] ?? '내장 봇 · 응답 실패', act.blueprint);
    logMsg(B, sideKind(side), `상대 주문: "${act.prompt}"`);
  } else if (act?.kind === 'upgrade') {
    logMsg(B, sideKind(side), `상대 교리: ${CFG.upgrades.doctrines[act.doctrine].label}`);
  }
}

function showFoeQuote(p, sentence, tag, bp) {
  $('foe-quote').hidden = false;
  $('fq-who').textContent = p.commander.name;
  $('fq-tag').textContent = tag;
  $('fq-text').textContent = sentence;
  $('fq-stat').innerHTML = bp
    ? `<span class="chip role-${bp.role}">${roleLabel(bp.role)}</span> ${bp.count}기 · HP ${Math.round(bp.totalHp)} · DPS ${Math.round(bp.totalDps)} · ${bp.channel === 'arcane' ? '비술' : '물리'}`
    : '';
  const el = $('foe-quote');
  el.style.animation = 'none'; void el.offsetWidth; el.style.animation = '';
}

// ---------------------------------------------------------------- hud
let lastLogLen = 0, dexKey = '';
function paintHud(B) {
  const mm = Math.floor(B.t / 60), ss = Math.floor(B.t % 60);
  $('clock').textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  $('wave-fill').style.width = `${Math.max(0, Math.min(1, 1 - (B.nextWaveAt - B.t) / CFG.pacing.wave)) * 100}%`;
  const ot = B.t >= CFG.pacing.overtimeAt;
  $('phase-label').textContent = ot ? '균열 붕괴' : `제${B.wave + 1}국면`;
  $('phase-label').classList.toggle('hot', ot);

  for (const side of [SIDE.L, SIDE.R]) {
    const n = side === SIDE.L ? 1 : 2;
    const core = structOf(B, side, 'core');
    const bast = structOf(B, side, 'bastion');
    $(`core-p${n}`).style.width = `${Math.max(0, core.hp / core.maxHp) * 100}%`;
    $(`bast-p${n}`).style.width = `${Math.max(0, bast.hp / bast.maxHp) * 100}%`;
    const p = player(B, side);
    $(`res-p${n}`).textContent = String(Math.floor(p.essence));
    $(`mech-p${n}`).textContent = mechText(p);
  }

  const me = player(B, state.mySide);
  // Affordability is re-checked EVERY frame, not only when the text changes.
  // Checking it in preview() alone left the button red after the essence had
  // already grown past the price, which reads as "the game is broken".
  const locked = B.t < (me.lockUntil ?? 0);
  const btn = $('btn-summon');
  btn.classList.toggle('locked', locked);
  if (state.castCost != null) {
    btn.classList.toggle('poor', !locked && me.essence < state.castCost);
  }
  // The button itself counts the lock down, so the wait is never a mystery.
  $('cast-cost').textContent = locked
    ? `${(me.lockUntil - B.t).toFixed(1)}s`
    : `◆${state.castCost ?? CFG.ritual.tiers[state.tier].cost}`;
  const tier = CFG.upgrades.tiers[me.upgrades.length];
  for (const b of $('upgrade-row').children) {
    const owned = me.upgrades.includes(b.dataset.id);
    b.classList.toggle('owned', owned);
    const cost = tier ? Math.round(tier.cost * (me.commander.mechanic.id === 'forge' ? 1 - me.commander.mechanic.upgradeDiscount : 1)) : 0;
    b.disabled = !tier || B.t < tier.unlockAt || me.essence < cost;
    const span = b.querySelector('span');
    span.textContent = !tier ? '' : B.t < tier.unlockAt ? `${Math.ceil(tier.unlockAt - B.t)}s` : `◈${cost}`;
  }

  paintSuggestions(B);

  if (B.log.length !== lastLogLen) {
    lastLogLen = B.log.length;
    $('log').innerHTML = B.log.slice(-7).reverse()
      .map((l) => `<div class="l-${l.kind}">${esc(l.text)}</div>`).join('');
  }

  const foe = player(B, other(state.mySide));
  const key = foe.roster.map((b) => b.name + b.role + b.count).join('|');
  if (key !== dexKey) {
    dexKey = key;
    $('dex-panel').innerHTML = foe.roster.length
      ? `<div class="dex-title">적 편제</div>` + foe.roster.slice(-3).map((b) => `
      <div class="dex-row">
        <span class="chip role-${b.role}">${roleLabel(b.role)}</span>
        <span>${b.count}기</span>
        <span class="dim">${Math.round(b.totalDps)}dps${b.splash ? ' · 광역' : ''}</span>
      </div>`).join('')
      : '';
  }
}

function mechText(p) {
  const m = p.commander.mechanic;
  if (m.id === 'reclaim') return `파멸 ${Math.floor(p.reclaim)}/${m.threshold}`;
  if (m.id === 'bloodmarch' && p.marchStacks >= 1) return `진군 ${Math.floor(p.marchStacks)}`;
  if (p.siegeStacks) return `공성 +${p.siegeStacks * 5}%`;
  return '';
}

const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- end
function endBattle(B) {
  cancelAnimationFrame(state.raf);
  const win = B.winner === state.mySide;
  $('result-title').textContent = win ? '승 리' : '패 배';
  $('result-title').style.color = win ? 'var(--gold)' : 'var(--dim)';
  const me = player(B, state.mySide);
  const foe = player(B, other(state.mySide));
  const distinct = new Set(state.scrollHistory.map((i) => `${i.role}|${i.cohort}|${i.skills.join(',')}`)).size;
  const looks = new Set(state.castLog.map((c) => c.concept)).size;
  const rows = state.castLog.slice(-8).map((c) => `
    <tr><td class="rc-text">${esc(c.text)}</td>
        <td class="rc-mid">${roleLabel(c.role)} ${c.count}기</td>
        <td class="rc-mid">HP ${c.hp} · DPS ${c.dps}</td>
        <td class="rc-look">${c.concept}</td>
        <td class="rc-cost">◆${c.cost}</td></tr>`).join('');
  $('result-body').innerHTML = `
    <div>${B.endReason} · <b>${fmt(B.t)}</b> · 제${B.wave}국면</div>
    <div>내 코어 <b>${Math.round(structOf(B, state.mySide, 'core').hp)}</b> / 상대 코어 <b>${Math.round(structOf(B, other(state.mySide), 'core').hp)}</b></div>
    <div>주문 ${state.castLog.length}회 · 서로 다른 전술 <b>${distinct}</b>가지 · 서로 다른 외형 <b>${looks}</b>가지 · 각인 ${state.cards.length}장</div>
    <div class="dim">상대(${foe.commander.name}) 투자 ${Math.round(foe.totalSpent)} · 잃은 유닛 ${foe.unitsLost}</div>
    ${rows ? `<table class="recap"><thead><tr><th>내가 쓴 문장</th><th>편제</th><th>실제 수치</th><th>외형</th><th>비용</th></tr></thead><tbody>${rows}</tbody></table>` : ''}`;
  show('screen-result');
}

// ---------------------------------------------------------------- utils
function show(id) {
  for (const s of document.querySelectorAll('.screen')) s.classList.remove('active');
  $(id).classList.add('active');
}

let bannerTimer = 0;
/** Centre-screen feedback. Every rejected action must produce one of these. */
function banner(kind, msg) {
  const el = $('banner');
  el.textContent = msg;
  el.className = `banner show ${kind}`;
  clearTimeout(bannerTimer);
  bannerTimer = window.setTimeout(() => { el.className = 'banner'; }, kind === 'ok' ? 1500 : 2400);
}
const fail = (msg) => { banner('bad', msg); shake($('prompt-panel')); };

function shake(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}

function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = window.setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- wiring
buildSelect();
buildDiffPick();
$('btn-start').onclick = startBattle;
$('btn-summon').onclick = summon;
$('btn-engrave').onclick = engrave;
$('btn-transmute').onclick = toggleTransmute;
$('btn-again').onclick = () => { show('screen-select'); state.battle = null; };
$('drawer-tab').onclick = toggleDrawer;
function toggleDrawer() {
  const d = $('drawer');
  d.classList.toggle('open');
  $('drawer-tab').textContent = d.classList.contains('open') ? '닫기 [Tab]' : '해석 · 서고 [Tab]';
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && state.battle) { e.preventDefault(); toggleDrawer(); }
});
$('prompt-input').addEventListener('input', debounce(preview, 170));
$('prompt-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); summon(); }
});
