# 04-social 검수 결과 (2026-09-14)

| 스킬 | 판정 | 핵심 문제 |
|---|---|---|
| 031-instagram-feed-planning | 경미 | 캡션 글자수 오기재("12자"라 했지만 실제 10/14자). "9월 3일, 다시 나옵니다" 캡션이 이미 지난 날짜를 미래형으로 예고(논리 모순). sample_fallback 미사용 |
| 032-comment-response-management | **심각** | "sample-data/A브랜드-리뷰-200건.csv에서 6건 발췌"라 했지만 그 6건 문장이 실제 CSV에 전혀 없음(grep 0건). 특히 **"이거 쓰고 피부 뒤집어졌어요. 병원 갔습니다"라는 위기 사례 자체가 완전 창작**(006과 동일 유형, 06-commerce의 054와도 같은 "허위 안전사고" 패턴) |
| 033-influencer-research | 경미 | @glow_everyday 규모 "21만"과 급증 설명 "4.2만→11만"이 서로 연결 안 됨. 스코어카드 계산은 정확 |
| 034-influencer-collab-brief | 경미 | SKILL.md Phase 6은 "3 STEP"이라는데 example 규제검사 표는 4행. 033과의 연계 수치는 정확 |
| 035-event-planning | 경미 | 034와 동일 유형("3 STEP" vs 실제 4행). Phase 3의 인스타 필수 고지 문구가 예시에 빠짐. 예산 산식은 정확 |
| 036-community-management | 문제 없음 | Contract 범위 준수, 자기모순 없음 |
| 037-ugc-collection-consent | 문제 없음 | 동의 대장 만료일 계산 정확, 표 구조 차이는 표현 방식일 뿐 |
| 038-social-listening | 문제 발견 | Contract는 "부정 비율 30% 초과 시 경보"라는데 example 결론은 "40% 초과 미달"이라며 다른 임계값을 인용(결과는 우연히 맞음). 나머지 계산은 정확 |
| 039-channel-growth-audit | 문제 발견 | SKILL.md 자기 주석이 "채널성과-90일 CSV로는 인스타 진단 못 낸다"고 명시하는데, example/input.md는 바로 그 파일로 연습하라고 안내 — 안 되는 조합을 권유하는 자기모순 |
| 040-viral-hook-library | 문제 발견 | Contract·Phase4가 "근거 없는 훅은 버리고 재생성한다"고 두 번 명시하는데, example은 근거 없는 훅("147번째")을 폐기하지 않고 각주만 붙여 TOP-10에 남김 — Contract 위반 |

## 부수 발견
- 이 카테고리(032·039·040)는 사용자가 이전 세션에서 이미 의심했던 지점과 정확히 일치함(교차 검증됨).
- routing-eval.jsonl: 10개 스킬 전부 트리거 리터럴 중복 없음(정상).
