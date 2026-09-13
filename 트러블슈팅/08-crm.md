# 08-crm 검수 결과 (2026-09-14)

| 스킬 | 판정 | 핵심 문제 |
|---|---|---|
| 071-cs-chatbot-rag | 문제 없음 | sample_fallback 없음(타당) |
| 072-cs-manual | 문제 발견 | sample_fallback(`A브랜드-고객문의-60건.csv`)을 안 쓰고 리뷰-200건.csv 사용, 그마저도 실제 `분류후보` 분포와 example 카테고리 체계(제품71·배송42 등)가 전혀 다름 |
| 073-customer-journey-map | **심각·원인 규명됨** | sample_fallback이 가리키는 파일에 "가입" 열이 없는데, **카탈로그 문서 3개(`sample-data/README.md`, `장별-실습자료.md`, `장별/07장-데이터-CRM/README.md`)가 073이 써야 할 파일을 서로 다르게 지목**(원고소스 11장 실측 감사에서 발견된 원고-산출물 불일치의 근본 원인). example 수치(이탈위험 287명·휴면 986명)도 실제 체인 실행 결과(이탈위험 64명·휴면 11명)와 무관한 가공값 |
| 074-email-sequence | 정책 위반 | `SKILL.md.전_20260910_체인방향` git 미추적(CLAUDE.md §6 위반). 데이터 문제는 없음 |
| 075-kakao-alimtalk | 정책 위반 | 074와 동일한 미추적 백업 존재. 데이터 문제는 없음 |
| 076-membership-program | **심각** | example 인원(159+477+2,544=3,180명)이 실제 sample_fallback 고유 고객(880명)과 무관. 실제 체인 실행 검증본은 44/132/704명(합 880)으로 정확히 나옴 — example만 가공값 |
| 077-winback-campaign | 문제 발견 | example 세그먼트 합계(1,273명)가 전체 고객 수(320명)보다 4배 큼. 실측 실행본은 휴면 11명으로 정확 |
| 078-voc-pipeline | 경미~중간 | "리뷰 200건(실측)"이라 표기했지만 카테고리 명칭·수치가 실제 `분류후보` 분포와 대응 안 됨 |
| 079-review-request-automation | SKILL.md 자기모순 | sample_fallback 주석("묻지 않고 완주")과 게이트표("데이터 없으면 설계만")가 정반대 — example은 후자를 따름(fallback 규칙이 죽은 문구) |
| 080-customer-interview | 문제 없음 | sample_fallback 없음(타당) |

## 부수 발견 — 073 문제의 근본 원인
`plugins/marketing-team/100-skills/08-crm/skills/073-customer-journey-map/SKILL.md`가 가리키는 파일(`A브랜드-퍼널단계.csv`, 240행, "가입" 열 없음)과, 카탈로그 문서들이 안내하는 파일(`A브랜드-퍼널-가입구매-90일.csv`, 900행, "가입" 열 있음, 결제완료 합계 1,526건까지 README 서술과 일치)이 다르다. 이 불일치가 원고 검증(11장)에서 발견된 "073이 원고 서술과 다른 파일을 읽는다"는 문제의 실제 원인이다. **수정 시 어느 파일이 정본인지 먼저 정해야 한다** — SKILL.md를 카탈로그 문서에 맞출지, 카탈로그를 SKILL.md에 맞출지.

## 그 외
- routing-eval.jsonl: 10개 스킬 전부 트리거 리터럴 중복 없음(정상).
