// @ts-check
// Korean lexicon for the LOCAL interpreter.
//
// Matching rule (important): entries are matched LONGEST-FIRST against the
// sentence, and a matched span is consumed so shorter words cannot re-match
// inside it. Without this, "단독"(solo) matched "독"(poison) and turned a plain
// physical elite into an arcane unit — a real bug found in playtesting.
//
// Every entry carries `w` (surface forms) and the meaning it contributes.
// A form that is a substring of a longer, more specific form must be listed in
// the longer form's entry too, or it will never win.

/**
 * @typedef {Object} Entry
 * @property {string[]} w        surface forms
 * @property {string} [role]
 * @property {string} [cohort]
 * @property {string} [shape]
 * @property {string} [channel]
 * @property {string} [formation]
 * @property {string} [persistence]
 * @property {string} [wardAgainst]
 * @property {Object} [pr]       priority deltas
 * @property {string} [skill]
 * @property {number} [count]
 */

/** @type {Entry[]} */
export const LEXICON = [
  // ---------------------------------------------------------------- roles: guard
  { w: ['방패병', '방패', '수문장', '수호병', '수호자', '파수꾼', '문지기', '보초'], role: 'guard', pr: { hp: 1, defense: 1 } },
  { w: ['중장보병', '중갑병', '중장', '판금', '전열', '창벽', '방어선'], role: 'guard', pr: { hp: 1, defense: 1 } },
  { w: ['골렘', '자동인형', '석상', '거상', '괴물석', '강철거인', '거인'], role: 'guard', pr: { hp: 2, defense: 1 } },
  { w: ['성기사', '기사단', '기사', '근위'], role: 'guard', pr: { hp: 1, damage: 1 } },
  { w: ['막아서는', '막아선다', '길을막', '버텨서는', '앞을막', '가로막는'], role: 'guard', pr: { hp: 1 } },

  // ---------------------------------------------------------------- roles: raider
  { w: ['암살자', '암살단', '암살', '자객', '척후병', '척후', '그림자단', '밀정'], role: 'raider', pr: { speed: 1, damage: 1 } },
  { w: ['광전사', '광란병', '돌격병', '돌격대', '돌격', '습격대', '습격', '기습대', '기습'], role: 'raider', pr: { damage: 2, speed: 1 } },
  { w: ['늑대', '들개', '사냥개', '맹수', '야수', '짐승'], role: 'raider', pr: { speed: 2, damage: 1 } },
  { w: ['파괴자', '학살자', '도살자', '살육병'], role: 'raider', pr: { damage: 2 } },
  // longest-first matching consumes the span, so a compound that implies a skill
  // must declare that skill itself or it silently loses it
  { w: ['처형인', '처형자'], role: 'raider', skill: 'execute', pr: { damage: 2 } },
  { w: ['파고드는', '파고들어', '뚫고드는', '밀어붙이', '들이치는', '치고빠지', '침투'], role: 'raider', pr: { speed: 1 } },
  { w: ['경보병', '경장', '유격'], role: 'raider', pr: { speed: 2 } },

  // ---------------------------------------------------------------- roles: artillery
  { w: ['장궁대', '장궁병', '장궁', '궁수대', '궁수', '사수', '석궁', '노병'], role: 'artillery', pr: { range: 2 } },
  { w: ['포격대', '포격수', '포격', '포대', '대포', '박격', '투석기', '투석', '공성포'], role: 'artillery', pr: { range: 2 } },
  { w: ['저격수', '저격'], role: 'artillery', pr: { range: 3, damage: 1 } },
  { w: ['주술사', '마법사', '술사', '사제', '무녀', '마녀', '현자', '점성술사'], role: 'artillery', pr: { range: 1 } },
  { w: ['화살비', '탄막', '일제사격', '사격'], role: 'artillery', pr: { range: 2 } },

  // ---------------------------------------------------------------- cohort / count
  { w: ['단독', '홀로', '혼자', '유일한', '오직하나'], cohort: 'elite', count: 1 },
  { w: ['정예', '엘리트', '챔피언', '영웅', '군주', '대장'], cohort: 'elite', count: 1, pr: { damage: 1 } },
  { w: ['거대한', '거대', '초대형', '대형', '태산같'], cohort: 'elite', count: 1, pr: { hp: 1 } },
  { w: ['한마리', '하나', '한기', '일체'], cohort: 'elite', count: 1 },
  { w: ['두마리', '한쌍', '둘', '두기'], cohort: 'pack', count: 2 },
  { w: ['세마리', '셋', '세기', '삼인', '트리오', '소대', '분대'], cohort: 'pack', count: 3 },
  { w: ['다섯', '다섯마리', '오인'], cohort: 'swarm', count: 5 },
  { w: ['군단', '떼거리', '무리떼', '벌레떼', '쥐떼', '개미떼', '수많은', '무수한', '떼'], cohort: 'swarm', count: 5 },

  // ---------------------------------------------------------------- attack shape
  { w: ['광역', '휩쓸어', '휩쓰는', '휩쓸', '쓸어버', '쓸어', '범위공격', '연쇄'], shape: 'sweep', skill: 'sweep' },
  { w: ['폭발하는', '폭발', '터지는', '자폭'], shape: 'sweep', skill: 'sweep', channel: 'arcane' },
  { w: ['정밀한', '정밀', '한명씩', '집중공격', '꿰뚫는', '꿰뚫', '관통'], shape: 'precision' },

  // ---------------------------------------------------------------- channel
  { w: ['화염', '불꽃', '불길', '불타는', '작열'], channel: 'arcane', pr: { damage: 1 } },
  { w: ['냉기', '서리', '얼음', '동빙'], channel: 'arcane', skill: 'chill' },
  { w: ['전격', '번개', '뇌전', '감전'], channel: 'arcane', pr: { damage: 1 } },
  { w: ['독칼', '독액', '맹독', '산성', '부식', '역병', '전염'], channel: 'arcane' },
  { w: ['저주', '흑마법', '주문', '비술', '마법', '영혼', '심연', '악몽', '정신'], channel: 'arcane' },
  { w: ['연금', '촉매', '약물', '시약'], channel: 'arcane' },
  { w: ['강철', '철갑', '무쇠', '쇠'], channel: 'physical', pr: { hp: 1 } },
  { w: ['대검', '장검', '검', '칼날', '칼', '도검'], channel: 'physical', pr: { damage: 1 } },
  { w: ['창', '장창', '도끼', '망치', '둔기', '철퇴'], channel: 'physical', pr: { damage: 1 } },
  { w: ['이빨', '발톱', '주먹', '맨손'], channel: 'physical' },

  // ---------------------------------------------------------------- stat priorities
  { w: ['단단한', '단단', '튼튼한', '튼튼', '두꺼운', '질긴', '불굴', '죽지않'], pr: { hp: 2 } },
  { w: ['체력', '생명력', '맷집'], pr: { hp: 2 } },
  { w: ['강력한', '강력', '흉포한', '흉포', '잔혹', '무자비', '치명적', '살상'], pr: { damage: 2 } },
  { w: ['공격력', '화력', '파괴력'], pr: { damage: 2 } },
  { w: ['멀리서', '멀리', '원거리', '장거리', '먼곳', '후방에서'], pr: { range: 2 } },
  { w: ['재빠른', '재빠르게', '빠른', '빠르게', '신속', '날렵한', '날렵', '기민', '쾌속', '민첩', '질주'], pr: { speed: 2 } },
  { w: ['느린', '느리지만', '둔중', '묵직'], pr: { speed: -2, hp: 1 } },
  { w: ['견고한', '견고', '단련된', '방어적'], pr: { defense: 2 } },
  { w: ['값싼', '싸구려', '하급', '허약', '약한', '오합지졸'], pr: { hp: -1, damage: -1 } },

  // ---------------------------------------------------------------- resistance direction
  { w: ['마법을막', '마법저항', '주문을막', '마법에강', '비술을막', '결계'], wardAgainst: 'arcane', pr: { defense: 2 } },
  { w: ['화살을막', '칼날을막', '물리에강', '물리저항', '갑옷으로', '중갑으로'], wardAgainst: 'physical', pr: { defense: 2 } },

  // ---------------------------------------------------------------- formation
  { w: ['흩어져', '흩어지는', '산개', '벌려서', '거리를두', '분산'], formation: 'spread', skill: 'spread' },
  { w: ['밀집', '뭉쳐', '어깨를맞', '빽빽'], formation: 'compact' },

  // ---------------------------------------------------------------- persistence
  { w: ['끝까지', '집요한', '집요', '물고늘어', '끈질긴', '포기하지않'], persistence: 'relentless' },
  { w: ['닥치는대로', '아무나', '눈앞의', '가까운적'], persistence: 'flexible' },

  // ---------------------------------------------------------------- target preference
  { w: ['탱커를', '방패를', '거대한적', '가장단단'], /* self-clause form */ pr: { damage: 1 } },

  // ---------------------------------------------------------------- skills
  { w: ['들이받', '충각', '돌진하는', '돌진'], skill: 'charge' },
  { w: ['뛰어넘', '건너뛰', '도약하는', '도약', '배후로'], skill: 'leap' },
  { w: ['몸으로막', '유인하는', '어그로', '가로막기'], skill: 'bulwark' },
  { w: ['보호막', '방벽', '실드', '장막', '수호결계'], skill: 'ward' },
  { w: ['둔화', '얼려붙이', '얼려', '느리게하', '발을묶', '속박'], skill: 'chill' },
  { w: ['처형하는', '처형', '숨통을', '끝장내', '마무리'], skill: 'execute' },
  { w: ['은폐', '은신', '잠복', '숨어드', '숨어', '투명'], skill: 'veil' },
  { w: ['공성괴물', '공성', '성벽을부수', '요새파괴'], pr: { hp: 2, damage: 1 } },
  { w: ['날개달린', '날개', '비행', '하늘을'], pr: { speed: 2 } },
  { w: ['땅을뒤흔드', '뒤흔드는', '지진'], shape: 'sweep', skill: 'sweep', pr: { damage: 1 } },
  { w: ['아군을지키', '아군을보호', '치유', '회복'], skill: 'ward' },
  { w: ['신성한', '성스러운', '축복'], channel: 'arcane', pr: { defense: 1 } },
  { w: ['한꺼번에', '뭉친적', '몰린적', '베어넘기'], skill: 'cleave' },

  // ================================================================ vocabulary expansion
  // Sentences like "탱크 셋", "전차 부대", "드래곤 하나" or "해골 군단" used to match
  // nothing and all compiled to the same default guard (HP1670/DPS58/R1.3). The
  // "every sentence gives me the same unit" complaint was a gap in this dictionary,
  // not in the art. The entries below fill in the nouns, unit sizes and adjectives
  // people actually type.

  // ---- machines and modern weapons (read as iron siege engines in this setting)
  { w: ['탱크', '전차대', '전차', '기갑병', '기갑', '장갑차', '장갑', '철갑차'],
    role: 'guard', channel: 'physical', pr: { hp: 2, defense: 2, speed: -1 } },
  { w: ['자주포', '야포', '곡사포', '유탄', '박격포', '화포', '함포'],
    role: 'artillery', channel: 'physical', pr: { range: 3, damage: 1 } },
  { w: ['미사일', '로켓', '폭격', '공습'], role: 'artillery', shape: 'sweep', skill: 'sweep', pr: { range: 2, damage: 2 } },
  { w: ['기관총', '소총', '머스킷', '화승총', '총병', '총'], role: 'artillery', channel: 'physical', pr: { range: 2, damage: 1 } },
  { w: ['화염방사', '화염방사기'], role: 'raider', channel: 'arcane', shape: 'sweep', skill: 'sweep', pr: { damage: 2 } },
  { w: ['공성추', '파성추', '충차'], role: 'guard', skill: 'charge', pr: { hp: 2, damage: 1, speed: -1 } },

  // ---- fantasy races and monsters
  { w: ['드래곤', '용가리', '비룡', '와이번', '용'],
    role: 'raider', cohort: 'elite', count: 1, channel: 'arcane', pr: { hp: 2, damage: 2, speed: 1 } },
  { w: ['리치', '강령술사', '사령술사', '네크로맨서'], role: 'artillery', channel: 'arcane', pr: { range: 2, damage: 1 } },
  { w: ['뱀파이어', '흡혈귀', '흡혈'], role: 'raider', channel: 'arcane', pr: { speed: 1, damage: 2 } },
  { w: ['해골병', '해골', '스켈레톤', '뼈다귀'], role: 'raider', cohort: 'swarm', count: 5, pr: { hp: -1, speed: 1 } },
  { w: ['좀비', '구울', '시체', '망자', '언데드'], role: 'guard', cohort: 'swarm', count: 5, pr: { hp: 1, speed: -1 } },
  { w: ['고블린', '임프', '코볼트', '땅꾼'], role: 'raider', cohort: 'swarm', count: 5, pr: { speed: 2, hp: -1 } },
  { w: ['오크', '오우거', '오거', '트롤'], role: 'guard', pr: { hp: 2, damage: 1 } },
  { w: ['미노타우로스', '우두인', '켄타우로스', '마인'], role: 'raider', skill: 'charge', pr: { damage: 2, speed: 1 } },
  { w: ['서큐버스', '악마', '데몬', '마귀'], role: 'raider', channel: 'arcane', pr: { damage: 1, speed: 1 } },
  { w: ['슬라임', '점액', '젤리'], role: 'guard', channel: 'arcane', pr: { hp: 2, speed: -2 } },
  { w: ['거미', '전갈', '벌레', '곤충'], role: 'raider', cohort: 'swarm', count: 5, channel: 'arcane', pr: { speed: 1 } },
  { w: ['괴수', '거대괴물', '괴물'], cohort: 'elite', count: 1, pr: { hp: 2, damage: 2 } },

  // ---- human-realm classes and troop types
  { w: ['소드마스터', '검객', '검사', '검성'], role: 'raider', channel: 'physical', pr: { damage: 2, speed: 1 } },
  { w: ['장창병', '창병', '창기병'], role: 'guard', channel: 'physical', pr: { hp: 1, damage: 1 } },
  { w: ['도끼병', '부월수', '벌목꾼'], role: 'raider', channel: 'physical', pr: { damage: 2 } },
  { w: ['사냥꾼', '수렵꾼', '엽사', '추적자'], role: 'artillery', pr: { range: 1, speed: 1 } },
  { w: ['수도사', '성직자', '주교', '신관', '사도'], role: 'artillery', channel: 'arcane', skill: 'ward', pr: { defense: 1 } },
  { w: ['연금술사', '조제사', '약제사'], role: 'artillery', channel: 'arcane', shape: 'sweep', skill: 'sweep' },
  { w: ['대장장이', '단련장', '제철'], role: 'guard', channel: 'physical', pr: { hp: 1, defense: 2 } },
  { w: ['용병', '고용병', '떠돌이'], role: 'raider', pr: { damage: 1 } },
  { w: ['민병', '농민', '시민', '평민', '징집병', '농노'], cohort: 'swarm', count: 5, pr: { hp: -1, damage: -1 } },
  { w: ['기마병', '기병대', '기병', '경기병'], role: 'raider', skill: 'charge', pr: { speed: 2, damage: 1 } },
  { w: ['방패술사', '중장방패'], role: 'guard', skill: 'bulwark', pr: { hp: 2, defense: 1 } },

  // ---- formation sizes (words for scale rather than an exact count)
  { w: ['사단', '연대', '대대', '중대'], cohort: 'swarm', count: 5 },
  { w: ['부대', '편대', '전대', '병력', '군세', '병단'], cohort: 'pack', count: 3 },
  { w: ['일당', '패거리', '작당'], cohort: 'pack', count: 3 },

  // ---- more adjectives
  { w: ['맹렬한', '맹렬', '거센', '사나운', '흉악', '광포'], pr: { damage: 2 } },
  { w: ['압도적', '절대적', '지배적'], pr: { damage: 1, hp: 1 } },
  { w: ['완강한', '억센', '굳센', '강인한', '강인'], pr: { hp: 2, defense: 1 } },
  { w: ['교활한', '영악한', '비열한', '음흉'], pr: { speed: 1, damage: 1 } },
  { w: ['냉혹한', '무정한', '차가운'], pr: { damage: 1 } },
  { w: ['거대한몸', '비대한', '우람한'], pr: { hp: 2, speed: -1 } },
  { w: ['조용한', '고요한', '소리없'], skill: 'veil', pr: { speed: 1 } },
  { w: ['낡은', '녹슨', '해진', '초라한'], pr: { hp: -1, damage: -1 } },

  // ---- more weapons
  { w: ['단검', '비수', '암기'], channel: 'physical', pr: { speed: 1, damage: 1 } },
  { w: ['쌍검', '이도류'], channel: 'physical', pr: { damage: 2, speed: 1 } },
  { w: ['언월도', '대부', '전투도끼'], channel: 'physical', pr: { damage: 2 } },
  { w: ['낫', '사슬', '갈고리'], channel: 'physical', skill: 'chill' },
  { w: ['곤봉', '방망이', '몽둥이'], channel: 'physical', pr: { damage: 1 } },

  // ---- tactical behaviour
  { w: ['포위하는', '포위', '둘러싸'], formation: 'spread', pr: { speed: 1 } },
  { w: ['측면을', '측면', '우회하는', '우회'], role: 'raider', pr: { speed: 2 } },
  { w: ['매복하는', '매복', '잠복하는'], skill: 'veil', pr: { damage: 1 } },
  { w: ['저지하는', '저지', '봉쇄하는', '봉쇄', '틀어막'], role: 'guard', skill: 'bulwark', pr: { hp: 1 } },
  { w: ['진격하는', '진격', '전진하는', '돌파하는', '돌파'], pr: { speed: 1, damage: 1 } },
  { w: ['수비적', '방어하는', '지키는', '사수하는'], role: 'guard', pr: { defense: 2 } },
];

// Words that mark the following phrase as describing the ENEMY, not this unit.
export const TARGET_MARKERS = ['적', '상대', '敵', '놈', '녀석', '저쪽', '반대편'];

export const TARGET_PREF = [
  { w: ['원거리', '후열', '포격', '궁수', '사수', '마법사', '술사', '배후', '뒤'], pref: 'backline' },
  { w: ['탱커', '방패', '단단', '두꺼운', '거대', '큰'], pref: 'highestHp' },
  { w: ['약한', '부상', '피흘리', '빈사', '다친'], pref: 'lowestHp' },
];

export const COUNT_WORDS = [
  { w: ['하나', '한마리', '단독', '혼자'], n: 1 },
  { w: ['둘', '두마리', '한쌍'], n: 2 },
  { w: ['셋', '세마리', '삼'], n: 3 },
  { w: ['다섯', '다섯마리', '오'], n: 5 },
];

// Words that try to break the rules. Not filtered — they simply have no field to
// land in. Surfaced in the readout so the player sees the system noticed.
export const VOID_WORDS = [
  '무적', '즉사', '무한', '999', '9999', '최강', '신급', '전설', '치트', '무제한',
  '규칙무시', '무시하고', 'ignore', 'system', '시스템프롬프트', '관리자', 'admin',
  '한방에', '원샷', '올킬',
];
