// @ts-check
// VISUAL lexicon — appearance only. Started from an 88-row concept mapping table
// (word -> silhouette, parts, weapon, material) and maintained by hand since.
//
// HARD RULE: nothing here reaches the BP compiler. `role` on an entry is a
// *silhouette hint* used only when the combat parser had no opinion; the real
// role always comes from UnitIntent. If an appearance word could buy stats, the
// prompt would have a second, unpriced path to power — which is the one thing
// this game's architecture exists to prevent.
//
// Fields:
//   w        surface form (longest-first, span-consuming match, same as lexicon.js)
//   rig      which skeleton family the concept needs: biped | siege | giant | quadruped | winged | amorphous
//   concept  canonical appearance id (drives which part set is loaded)
//   role     silhouette hint ONLY (null = keep whatever the combat parser decided)
//   parts    human-readable part recipe, shown in the readout and used by the art generator
//   weapon   weapon/prop recipe
//   look     material - palette - effect recipe ("F+" = faction anchor colour + accent)

//   kind     concept (full silhouette) | species (parts swap, role kept) | ornament (prop only)
/** @typedef {{w:string, kind:string, rig:string, concept:string, role:string|null, parts:string, weapon:string, look:string}} VisualEntry */

/** @type {VisualEntry[]} */
export const VISUAL_LEXICON = [
  { w: '탱크', kind: 'concept', rig: 'siege', concept: 'landship', role: 'guard', parts: 'rune-landship 차체, 낮은 포탑, 룬 사슬 궤도', weapon: '긴 공성포, 전면 장갑', look: '검은 철·리벳, F+용광로 주황' },
  { w: '전차', kind: 'concept', rig: 'siege', concept: 'landship', role: 'guard', parts: '장갑 전투마차, 큰 철테 바퀴 2쌍', weapon: '전면 장창, 짧은 쇠뇌', look: '검은 참나무·철, F+낡은 금' },
  { w: '기갑', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '두꺼운 판금 상체, 폐쇄 투구, 중장 다리', weapon: '탑방패, 짧은 전투망치', look: '솔질 강철, F+철회색' },
  { w: '장갑차', kind: 'concept', rig: 'siege', concept: 'landship', role: 'guard', parts: '덮개형 철마차, 사격구, 바퀴 4개', weapon: '전면 방패판, 측면 쇠뇌', look: '철·목재, F+황동' },
  { w: '자주포', kind: 'concept', rig: 'siege', concept: 'engine', role: 'artillery', parts: '낮은 포가, 뒤로 기운 승강 포대', weapon: '대구경 룬 박격포', look: '흑철·황동, F+화약 호박색' },
  { w: '대포', kind: 'concept', rig: 'siege', concept: 'engine', role: 'artillery', parts: '큰 바퀴 2개와 긴 포가', weapon: '직사 공성포', look: '주철·검은 참나무, F+화약' },
  { w: '포격수', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '수직 방탄복, 어깨 지지대, 무거운 장화', weapon: '어깨식 핸드 봄바드', look: '철·가죽, F+호박색 심지' },
  { w: '투석기', kind: 'concept', rig: 'siege', concept: 'engine', role: 'artillery', parts: '목재 프레임, 높은 투척팔, 바퀴', weapon: '돌 투척 슬링', look: '검은 목재·철띠, F+먼지 회색' },
  { w: '공성추', kind: 'concept', rig: 'siege', concept: 'landship', role: 'guard', parts: '지붕 덮인 충차, 낮은 롤러', weapon: '뿔 달린 철제 ram', look: '목재·철, F+녹슨 적갈' },
  { w: '총병', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '브리건딘, 깃 달린 투구, 탄약띠', weapon: '룬 화승총', look: '호두나무·강철, F+화약' },
  { w: '머스킷', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '긴 세로 자세, 총받침 장화', weapon: '초장신 심지총과 fork rest', look: '목재·강철, F+심지 주황' },
  { w: '기관총', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '후방 탄창통, 넓은 양손 그립', weapon: '손잡이식 회전 연노·룬 볼트통', look: '강철·황동, F+호박색' },
  { w: '로켓', kind: 'concept', rig: 'siege', concept: 'engine', role: 'artillery', parts: '등 뒤 발사대, 지지 다리', weapon: '연금 로켓 3연장', look: '철·밀랍 종이, F+불씨' },
  { w: '화염방사기', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '전진 자세, 등 연료항아리', weapon: '용머리 모양 화염 사이펀', look: '황동·가죽, F+불꽃 오라' },
  { w: '골렘', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: '룬 코어 상체, 작은 머리, 바위 다리', weapon: '큰 주먹, 석판 방패', look: '현무암, F+룬광' },
  { w: '강철거인', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: '리벳 판금 거체, 투구형 머리', weapon: '양손 대형 철퇴', look: '흑철, F+용광로 틈빛' },
  { w: '석상', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: '금 간 조각상 몸, 각진 얼굴', weapon: '돌 방패, 기둥 곤봉', look: '화강암, F+이끼 녹색' },
  { w: '거인', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: '살집 큰 상체, 짧은 목, 맨다리', weapon: '통나무 몽둥이', look: '살·가죽, F+흙색' },
  { w: '오우거', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: '배 나온 거체, 작은 투구', weapon: '고기망치, 원형 솥뚜껑', look: '가죽·철, F+피혁 갈색' },
  { w: '트롤', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: '긴 팔, 굽은 등, 돌기 피부', weapon: '돌도끼', look: '회녹색 피부·뼈, F+이끼' },
  { w: '슬라임', kind: 'concept', rig: 'giant', concept: 'colossus', role: 'guard', parts: 'amorphous 넓은 방울 몸, 내부 코어', weapon: '무기 없음, 삼킨 방패 조각', look: '반투명 점액, F+코어광' },
  { w: '드래곤', kind: 'concept', rig: 'winged', concept: 'flyer', role: 'raider', parts: '큰 도마뱀 머리, 접힌 날개, 긴 꼬리', weapon: '발톱, 입 안 화염 코어', look: '비늘·뿔, F+불씨' },
  { w: '와이번', kind: 'concept', rig: 'winged', concept: 'flyer', role: 'raider', parts: '팔과 날개가 합쳐진 두발형, 가시꼬리', weapon: '독 꼬리침', look: '가죽날개·비늘, F+독녹' },
  { w: '비룡', kind: 'concept', rig: 'winged', concept: 'flyer', role: 'raider', parts: '작은 머리, 넓은 활공날개, 가는 꼬리', weapon: '발톱, 바람 칼날 장식', look: '얇은 비늘, F+청회색' },
  { w: '늑대', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '낮은 어깨, 긴 주둥이, 큰 앞발', weapon: '이빨·발톱', look: '털·가죽 갑주, F+은회색' },
  { w: '야수', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '뿔 달린 범용 맹수, 굵은 앞다리', weapon: '발톱·엄니', look: '거친 털·뿔, F+피혁' },
  { w: '사냥개', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '더 가는 몸, 목줄 갑주, 긴 다리', weapon: '이빨', look: '짧은 털·철 목갑, F+철회색' },
  { w: '거미', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '낮은 복부, 읽기 좋은 굵은 다리 6개', weapon: '앞니·독낭', look: '키틴, F+독보라' },
  { w: '전갈', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '넓은 집게, 위로 휜 꼬리', weapon: '집게·꼬리침', look: '키틴·철갑, F+독녹' },
  { w: '미노타우로스', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '황소 머리, 큰 어깨, 발굽 다리', weapon: '양손 대도끼', look: '털·가죽·철, F+피색' },
  { w: '켄타우로스', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '말 하체와 낮은 인간 상체', weapon: '짧은 창 또는 기마궁', look: '가죽·목재, F+황동' },
  { w: '궁수', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '가벼운 브리건딘, 열린 머리, 화살통', weapon: '단순 장궁', look: '목재·가죽, F+상아' },
  { w: '장궁병', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '더 긴 세로 자세, 팔 보호대', weapon: '신장보다 긴 장궁', look: '주목·강철 화살촉, F+상아' },
  { w: '석궁병', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '넓은 허리 크랭크, 짧은 투구', weapon: '대형 석궁', look: '목재·강철, F+황동' },
  { w: '저격수', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '좁은 후드, 한쪽 눈 렌즈, 망토', weapon: '초장신 룬총/정밀 쇠뇌', look: '흑철·유리, F+차가운 렌즈광' },
  { w: '사냥꾼', kind: 'concept', rig: 'biped', concept: 'marksman', role: 'artillery', parts: '모피 어깨, 가죽 후드, 덫띠', weapon: '짧은 활·사냥창', look: '목재·가죽, F+숲녹' },
  { w: '암살자', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '깊은 후드, 비대칭 경갑, 낮은 자세', weapon: '쌍단검', look: '검댕 강철·가죽, F+저채도' },
  { w: '자객', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '천 마스크, 긴 소매, 허리띠', weapon: '곡도·비수', look: '천·검은 철, F+먹색' },
  { w: '척후병', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '작은 후드, 가벼운 흉갑, 짧은 망토', weapon: '투창·짧은 검', look: '가죽·목재, F+먼지색' },
  { w: '광전사', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '맨팔, 큰 모피 어깨, 흐트러진 머리', weapon: '양손 도끼', look: '철·모피, F+피색' },
  { w: '돌격병', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '전방 어깨판, 무릎 갑주, 깃', weapon: '창·작은 방패', look: '강철·가죽, F+밝은 앵커' },
  { w: '검사', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '중간 경갑, 열린 얼굴', weapon: '장검', look: '강철·천, F+은색' },
  { w: '검객', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '긴 코트자락, 얇은 어깨선', weapon: '가는 곡도', look: '광택 억제 강철·천, F+먹색' },
  { w: '도끼병', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '한쪽 어깨 중갑, 굵은 장갑', weapon: '큰 전투도끼', look: '철·가죽, F+녹슨 적갈' },
  { w: '창병', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '겹친 방패 자세, 중갑 투구', weapon: '장창·중형 방패', look: '강철·목재, F+철회색' },
  { w: '기사', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '판금 흉갑, 면갑, 망토', weapon: '연모양 방패·장검', look: '솔질 강철, F+금속 금' },
  { w: '성기사', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '판금과 천 휘장, 후광형 머리 장식', weapon: '큰 방패·성전 망치', look: '상아 강철, F+신성 금' },
  { w: '방패병', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '몸 높이 탑방패, 폐쇄 투구', weapon: '탑방패·짧은 창', look: '강철·목재, F+철회색' },
  { w: '근위', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '장식 있는 중갑, 높은 투구깃', weapon: '방패·미늘창', look: '강철·금, F+왕실 금' },
  { w: '사제', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '긴 예복, 둥근 두건', weapon: '향로 지팡이·성서', look: '천·은, F+신성 금' },
  { w: '성직자', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '짧은 예복과 어깨갑, 머리띠', weapon: '홀·작은 방패 성물', look: '천·강철, F+상아' },
  { w: '주교', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '높은 관, 넓은 소매', weapon: '긴 목장', look: '금·벨벳, F+신성 금' },
  { w: '수도사', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '민소매 로브, 염주, 맨머리', weapon: '장갑 낀 주먹·봉', look: '천·목재, F+황토' },
  { w: '술사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '긴 소매, 부적띠, 열린 얼굴', weapon: '고리 지팡이', look: '목재·천, F+비술 보라' },
  { w: '주술사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '뿔 가면, 깃·뼈 장식', weapon: '토템 지팡이', look: '뼈·목재·가죽, F+독보라' },
  { w: '마법사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '뾰족 후드, 긴 로브, 큰 장갑', weapon: '수정 지팡이', look: '천·수정, F+비술 보라' },
  { w: '마녀', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '비대칭 모자, 누더기 망토', weapon: '굽은 지팡이·약병', look: '천·목재·유리, F+독녹' },
  { w: '연금술사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '고글, 앞치마, 병띠', weapon: '큰 투척 플라스크', look: '가죽·황동·유리, F+산성 녹색' },
  { w: '강령술사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '해골 가면, 찢긴 로브', weapon: '뼈 지팡이·영혼등', look: '뼈·천, F+망령 청록' },
  { w: '리치', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '왕관 쓴 해골 머리, 공중 로브 밑단', weapon: '긴 지팡이·성갑', look: '뼈·검은 금속, F+냉광' },
  { w: '해골', kind: 'species', rig: 'biped', concept: '해골', role: null, parts: '해골 머리, 갈비뼈 상체, 뼈 팔다리', weapon: '역할 무기 유지', look: '뼈·녹슨 철, F+냉광 눈' },
  { w: '좀비', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '굽은 시체 몸, 비대칭 팔, 끄는 다리', weapon: '깨진 방패·도끼', look: '썩은 천·살, F+병든 회녹' },
  { w: '구울', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '긴 팔, 낮은 머리, 갈비뼈', weapon: '발톱', look: '회색 살·뼈, F+피색 입' },
  { w: '뱀파이어', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '높은 칼라, 날씬한 판금, 창백한 얼굴', weapon: '가는 검·발톱', look: '검은 천·은, F+혈홍' },
  { w: '유령', kind: 'species', rig: 'biped', concept: '유령', role: null, parts: '반투명 머리, 끊긴 하체, 떠 있는 팔', weapon: '역할별 망령 무기', look: '반투명 천, F+망령 청록' },
  { w: '망령', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '깊은 빈 후드, 연기 하체', weapon: '낫·영혼검', look: '그림자 천, F+냉광' },
  { w: '악마', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '뿔 머리, 발굽 다리, 작은 접힌 날개', weapon: '곡도·발톱', look: '흑철·붉은 살, F+불씨' },
  { w: '서큐버스', kind: 'concept', rig: 'winged', concept: 'flyer', role: 'raider', parts: '작은 뿔, 박쥐날개, 긴 꼬리', weapon: '채찍·단검', look: '가죽·흑철, F+자주' },
  { w: '고블린', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '큰 귀·머리, 작은 몸, 빠른 다리', weapon: '짧은 칼·폭탄', look: '가죽·고철, F+황동' },
  { w: '오크', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '큰 엄니, 넓은 어깨, 판금 조각', weapon: '도끼·원형 방패', look: '철·가죽, F+녹슨 적갈' },
  { w: '임프', kind: 'concept', rig: 'winged', concept: 'flyer', role: 'raider', parts: '작은 뿔, 가는 날개, 긴 꼬리', weapon: '작은 삼지창', look: '붉은 살·가죽, F+불씨' },
  { w: '코볼트', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '도마뱀 머리, 짧은 꼬리, 작은 다리', weapon: '투창·슬링', look: '비늘·가죽, F+구리' },
  { w: '농민', kind: 'species', rig: 'biped', concept: '농민', role: null, parts: '천 두건, 헐렁한 옷, 작업화', weapon: '낫·쇠스랑', look: '거친 천·목재, F+흙색' },
  { w: '민병', kind: 'species', rig: 'biped', concept: '민병', role: null, parts: '누비 갑옷, 열린 투구', weapon: '창·원형 방패', look: '천·목재·철, F+철회색' },
  { w: '용병', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '섞인 갑주, 낡은 망토, 돈주머니', weapon: '검·작은 방패', look: '가죽·철, F+낡은 금' },
  { w: '대장장이', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '가죽 앞치마, 두꺼운 장갑, 수염 머리', weapon: '대형 망치·집게', look: '가죽·강철, F+용광로' },
  { w: '무녀', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '겹친 의복, 긴 소매, 방울 머리장식', weapon: '부적 막대·방울', look: '천·목재, F+상아/적색 보조' },
  { w: '점성술사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '별 장식 후드, 원형 어깨 망토', weapon: '천구의·지팡이', look: '청동·천, F+별빛' },
  { w: '군단', kind: 'ornament', rig: 'biped', concept: 'ornament', role: null, parts: '선택된 종족 키트 유지', weapon: '역할 무기 유지', look: '동일 앵커, 찢긴 큰 부대기·번호판' },
  { w: '무리', kind: 'ornament', rig: 'biped', concept: 'ornament', role: null, parts: '선택된 종족 키트 유지', weapon: '역할 무기 유지', look: '가벼운 개체별 털·흠집 변형' },
  { w: '정예', kind: 'species', rig: 'biped', concept: '정예', role: null, parts: '깨끗한 갑주, 큰 머리 볏', weapon: '역할 무기의 장식판', look: '고급 재질, F+금속 강조' },
  { w: '영웅', kind: 'species', rig: 'biped', concept: '영웅', role: null, parts: '고유 망토·비대칭 어깨장식', weapon: '역할 무기 유지', look: 'F+금, 작은 오라만' },
  { w: '기사단', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '통일된 판금·투구, 방패 문장', weapon: '장검·방패', look: '솔질 강철, F+상아' },
  { w: '벌레떼', kind: 'concept', rig: 'quadruped', concept: 'beast', role: 'raider', parts: '굵은 다리의 작은 키틴 몸', weapon: '턱·독침', look: '키틴, F+독녹, 슬롯별 등무늬' },
  { w: '해적', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '긴 코트, 삼각모, 한쪽 어깨갑', weapon: '커틀러스·손쇠뇌', look: '가죽·철, F+바랜 천' },
  { w: '닌자', kind: 'concept', rig: 'biped', concept: 'skirmisher', role: 'raider', parts: '얼굴 가림, 몸에 붙는 경갑, 짧은 천꼬리', weapon: '단도·표창', look: '검은 천·강철, F+저채도' },
  { w: '치유사', kind: 'concept', rig: 'biped', concept: 'caster', role: 'artillery', parts: '밝은 두건, 약초 주머니, 짧은 예복', weapon: '치유봉·약병', look: '천·목재·유리, F+회복 청록' },
  { w: '왕', kind: 'concept', rig: 'biped', concept: 'wall', role: 'guard', parts: '왕관 투구, 넓은 망토, 장식 흉갑', weapon: '왕홀·방패', look: '금·강철·벨벳, F+금' },
];

/** Rig families the renderer can assemble today. */
export const RIG_READY = new Set(['biped', 'siege', 'quadruped', 'winged', 'giant']);

// Within a non-biped family, only concepts that HAVE a generated part set can be
// drawn. Keeping this as an explicit list (rather than "the family is ready") is
// what lets the readout stay honest: 투석기 is also `siege`, but no parts exist for
// it yet, so it must still report a fallback instead of turning into a landship.
export const READY_CONCEPTS = new Set(['landship', 'beast', 'flyer', 'colossus']);

/** Fallback recipe per role when nothing matched — never a random guess. */
export const ROLE_DEFAULT_LOOK = {
  guard:     { rig: 'biped', concept: 'wall',      parts: '역할 기본 수호자 몸통', weapon: '역할 기본 근접 무기', look: 'F+진영 앵커' },
  raider:    { rig: 'biped', concept: 'skirmisher', parts: '역할 기본 습격자 몸통', weapon: '역할 기본 단검', look: 'F+진영 앵커' },
  artillery: { rig: 'biped', concept: 'marksman',  parts: '역할 기본 포격수 몸통', weapon: '역할 기본 원거리 무기', look: 'F+진영 앵커' },
};
