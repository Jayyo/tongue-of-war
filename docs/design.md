# Design notes

These notes record why things are the way they are. The numbers live in
`src/config.js`; values quoted here are there to show the reasoning and may drift.

## Genre

A lane tug-of-war in the line of the StarCraft custom maps (Nexus Wars, later SC2's
Direct Strike): you never control units. You choose what to field and the battle plays
itself. That premise is what makes sentence input viable. In a game where you micro
units, typing speed becomes combat power; here, writing the next sentence happens while
the current army fights.

## 1. A sentence cannot buy a number

```
sentence -> parser -> UnitIntent -> BP compiler -> unit stats
```

`UnitIntent` (`src/domain/budget.js`) has no HP, damage, range or cost fields. It holds
enums (role, cohort size, attack shape, damage channel, formation, persistence, ward
direction, target preference), five priorities in -3..3, a count from {1, 2, 3, 5} and up
to two skill ids from a fixed pool. No field takes a raw number. The budget is the ritual
size (80 / 120 / 180 BP), picked with a button, and it is also the price.

So "HP 999999", "invincible" or "ignore the rules" are not filtered out; they have
nowhere to go. `HP 999999 무적 최강 드래곤` compiles to the same unit as `드래곤 하나`.
The worst a clever sentence can do is produce an odd but legal unit. This is a statement
about the stats only: it does not make the model behave, and it does not make the unit
good.

`compile()` normalizes whatever it is given before pricing it, and a fuzz test
(`test/compiler.test.mjs`) feeds it thousands of random sentences and malformed intents,
checking every result against bounds taken from the config: total cost within budget,
range and speed inside the role's band, HP and DPS inside their budget shares, resists at
most 25%, finite numbers, legal skills.

### Costs are convex and coupled

Linear point-buy breaks because stats multiply in combat (range x speed x DPS, HP x
resist). Current shapes:

- range: `4.0 * (R - 1.6)^1.35` above the melee floor
- speed: `3 * ((V / 3)^2 - 1)`, clamped to [-4, 18] BP, so very slow units cannot refund much
- synergy surcharge: `0.01 * C_dps * (C_range + C_speed) + 0.02 * C_range * C_speed`;
  asking for long range, high speed and high damage at once costs more than the sum
- resist is priced against every repeatable survival pool, shields included:
  `C_def = (C_hp + C_ward) * (1 / (1 - r) - 1)`, capped at 25% per channel. Pricing it
  against HP alone let a regenerating shield get its resist for free.

Attack speed is not for sale. Cohort size decides the delivery (five bodies flurry every
0.2 s, three are balanced at 0.4 s, an elite crushes every 0.8 s), otherwise DPS would be
paid for twice.

If the fixed costs of a design (the artillery range floor, two skills, a spread
formation) leave nothing to shrink on the smallest ritual, the compiler drops the last
skill, then the spread, rather than ship an over-budget unit.

### Appearance is a separate path

```
sentence -> appearance parser -> VisualIntent -> renderer
```

`src/gen/visual.js` reads the same sentence for looks (concept, part set, weapon,
material, palette) and nothing it produces reaches the compiler. If one object carried
both, an appearance word would eventually start buying stats ("heavy armour" quietly
adding HP). `test/visual.test.mjs` checks that appearance-only words leave every stat
unchanged.

## 2. Counters

Two layers are enough to stay readable:

1. a role triangle, guard > raider > artillery > guard, at x1.1;
2. composition: splash beats swarms, swarms waste a crushing elite's overkill, a precise
   elite punishes a splash design's spent budget.

The role, resist, execute, mark and home-defence multipliers are multiplied together and
the product is capped at x1.4. Without the cap, range advantage, target selection, skills
and counters compound past x2 and one counter erases every earlier investment. Siege
pressure stacks sit outside the cap on purpose: they exist to break stalemates, not to
counter anything.

## 3. The keyword problem

The risk that decides whether the game works: players find one optimal sentence and paste
it forever, and natural language becomes a slow dropdown. A finite `UnitIntent` cannot
prevent that completely. The goal is to make the best sentence depend on the battlefield.

**Signals** (`src/domain/signals.js`). The HUD publishes measured facts about what the
enemy is doing: enemy swarm, splash pressure, back-line battery, back-line dive, heavy
wall, core pressure. A sentence that names a live signal and asks for a mechanism that
answers it gets -20% on the summon cost and actually gets that behaviour (spread out,
cleave, leap...). Naming a signal that is not live gets nothing; naming several gets
nothing. The discount applies to cost, never to stats.

**Echo surcharge.** Recent casts are compared by tactical meaning (role, cohort, shape,
channel, targeting, skills, priority vector), not by wording. Above 0.82 similarity the
summon costs +12%, then +24%. Rewording does not dodge it; changing the tactic does.
Engraved cards are exempt: paying for one of three slots is the intended way to repeat.

Rejected: rewarding vivid language with power (long sentences win, non-native speakers
lose, and a "three adjectives and a metaphor" template appears within days). Deferred:
recipe discovery in the style of Infinite Craft; recipes end up on a wiki and become the
new keyword list.

## 4. Tempo

- Summons are immediate: the cohort appears 0.6 s after the cast, then a 4 s command
  lock. An earlier version queued summons for the next 12 s wave edge and read as "my
  summon did nothing". The cheapest ritual costs 80 and income starts at about 8.3/s, so
  typing speed is not production speed anyway.
- The 12 s wave survives as a phase counter: income steps, opponent turns, the doctrine
  unlock at 3:00.
- Scrolls are one-shot. Engraving a design costs 0.6x its ritual and re-casting it 0.8x,
  so a card breaks even after three re-casts, and there are three slots. Situational
  units stay scrolls; only a real staple earns a slot.
- Target length is about six and a half minutes. Overtime starts at 8:40 and drains both
  cores; 9:00 is a hard limit decided on remaining core HP.

## 5. Engine rules

`src/engine/sim.js` has no DOM, no `Math.random()` and no wall clock. It runs the same in
the browser and in Node, which is what makes the headless harness and the tests possible.

- **Plan, then apply.** The first engine walked the unit array and applied movement and
  damage immediately; identical cohorts on both sides produced a 12/12 left-side win.
  A tick is now: advance all timers, plan every unit against the frozen state, move
  everyone, sum damage, apply it at once, resolve deaths. A unit killed this tick still
  lands the blow it already threw. Rule: the planning pass never writes a value another
  unit reads (veil expiry and chill used to break this).
- **Nothing depends on which side spawned first.** Lanes come from a per-role priority
  list by slot, and target tie-breaks hash (seed, sorted slot pair) using integers only.
  Hashing unit ids gave the side that spawned first a different distribution, and float
  lane positions that drifted by 1e-15 between mirrored sides flipped hashed tie-breaks.
  `test/sim.test.mjs` checks that identical cohorts wipe each other out on the same tick.
- **2D distance** (x plus lane offset). Melee units reaching across five lanes to
  focus one target made split cohorts much weaker than the cost model assumed.
- **No hit RNG.** The seed decides starting conditions only; combat resolution is
  deterministic, so a lost fight can be read.
- **Aging** stops back lines from stacking forever, but units still fighting in enemy
  territory are exempt; otherwise aging dissolved winning pushes and recreated the
  stalemate it was meant to prevent.

## 6. The LLM opponent

The model writes one Korean sentence per wave and that sentence goes through the same
parser and compiler as the player's. If the AI could emit intent JSON directly, the human
would be playing a language game against an opponent playing a tactics game, and the part
worth watching (reading what the opponent wrote and seeing what it became) would be gone.
The prompt describes the meaning space (roles, sizes, channels, skills) rather than the
parser's dictionary, so the model writes sentences instead of keyword lists.

The browser sends only a public snapshot: wave, time, the AI's own essence, front line,
structure HP, revealed cohorts, live signals and the human's last summoned sentence. Never
the human's essence or unsent text. The server validates the snapshot field by field and
builds the prompt itself (`src/ai/opponent-prompt.js`); the only free text that reaches
the model is that last sentence, cut to 80 characters of Korean. The API also refuses
other origins and non-JSON requests and the page refuses to be framed, so another web page
cannot quietly spend the key through the player's browser. Answers are cached per quantized situation, so a repeated situation
reuses its sentence instead of calling the model again. Any failure (no key, timeout,
empty answer, rate limit) falls back to the scripted bot, and the quote box says which
one wrote the line.

The model's sentence is priced exactly like the player's: context discount when it answers
a live signal, repeat surcharge against its own history. The keyless bot is simpler: it
picks from a fixed book of sentences and pays list price.

Difficulty changes the information the opponent gets, not the model: novice sees one
signal and fuzzy counts, duel two signals with exact counts, abyss three. Swapping models
would change language quality, parser hit rate, latency and judgement all at once. The
scripted bot reads the same setting as scoring noise.

Defaults are fast models with reasoning turned down. Measured with the game's real
prompt: gpt-6-luna at effort "none" answers in 1.3-2.3 s, gemini-3.5-flash at "minimal"
in about 1.6 s, deepseek-chat in about 1 s. Reasoning models with default effort took
5-7 s and sometimes spent the whole output budget on reasoning, returning nothing.

## 7. Visual grammar

Generated art must not overwrite the combat grammar. A counter game needs the role,
single/splash and physical/arcane of an enemy unit readable in two or three seconds.

- the ground sigil is the role (square guard, arrowhead raider, diamond artillery)
- colour is the faction
- a ring under a unit means splash; units fade while veiled

Units are cut-out rigs assembled from generated part sheets: an 11-part biped (also used
at a heavier scale for golems and giants), a siege rig (hull, track, turret, barrel,
plate) and creature rigs for quadrupeds and winged units. A concept with no parts yet
(catapult, cannon...) falls back to the role's silhouette and the receipt marks it with
△ instead of pretending the word landed. Concept palettes tint the shared biped parts at
half strength so a skeleton and a knight differ without new art, while the faction colour
stays.

## Open problems

1. **Free language vs strategic honesty.** A strong balancer turns "a cursed twilight
   swordsman with wings" and "fast melee dealer" into the same unit, and players feel
   ignored. The receipt shows which words did what and which did nothing; hiding that
   makes it worse.
2. **Keyword play can be delayed, not removed.** The useful test is whether editing a
   sentence leads players to an unexpected but understandable tactic. If three intent
   fingerprints account for most of the essence spent, the fix is a richer intent and
   conditional-behaviour grammar, not bigger penalties.
3. **Current balance gaps** (from `npm run balance`): the winner keeps a median 36% of its
   value in cohort duels against a 15-30% target; bot-vs-bot commander pairings are
   lopsided (the demon side wins 50-100% in 7 of 9); in cohort duels with structures off,
   veiled raiders slip past the other cohort and both end up on an invulnerable core, so
   that row of the matrix is all draws; guards and artillery sit at their speed cap, so
   "느린" (slow) only reallocates budget for raiders.
4. **LLM dependence.** A model opponent costs money per match and its skill changes when
   the model does. The cache and the bot fallback soften this; they do not remove it.
