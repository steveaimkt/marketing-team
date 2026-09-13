# 10-ops 검수 결과 (2026-09-14)

| 스킬 | 판정 | 핵심 문제 |
|---|---|---|
| 091-work-audit | 경미 | sample_fallback(`build-log-sample.md`) 지정돼 있으나 example이 그 내용을 안 쓰고 가상 Q&A로 구성(거짓을 사실처럼 내세우진 않음) |
| 092-skill-builder-meta | 문제 발견 | SKILL.md가 "등록 심사"(이 스킬의 일)와 "공식 편입 심사"(이 스킬의 일 아님)를 용어로 구분해놨는데, example이 스스로 "이 스킬 일 아니다"라고 규정한 "편입 심사" 용어를 자기 예시에 그대로 씀. ※ 오늘 다른 조사에서 발견한 "6/7 통과" 표시 오류(실제 7/7)는 결과물 html 레벨에서 이미 정정 완료 |
| 093-meeting-task-automation | 문제 발견(2건) | ① writes_to(.docx만)와 Output Format 저장 파일 표기(.md)가 자기모순 ② example이 sample_fallback(내부회의메모, 실제로는 펌프 결함·CS 60건 논의)과 무관한 완전 창작 회의("9월 리뉴얼", 리필 파우치) |
| 094-outsourcing-brief | 문제 없음 | example이 실제 sample_fallback 수치(장바구니 전환 5.0%)를 정확히 재사용 |
| 095-budget-planner | 문제 없음 | sample_fallback 없음(타당), 예산·캐시플로 산식 전부 검산 일치 |
| 096-quote-comparison | 경미 | "C사 실질 총액"에서 이미 합산에 포함된 항목을 중복 가산한 것으로 보이는 이중계산 소지([추정] 태그로 완화됨) |
| 097-onboarding-docs | 문제 발견 | 091의 example과 이어지는 서사인데 같은 스킬(031) 업무를 서로 다른 요일(화·목·토 vs 수·금)에 배정 — 체인 서사 내부 모순 |
| 098-weekly-retro-planning | **자기모순** | sample_fallback(`A브랜드-반복업무-15건.csv`)이 지정돼 있으나, 정작 그 대체 대상 파일(`build-log-sample.md`)의 머리말이 "091·098·100은 이 파일을 읽어야 한다"고 명시 — 지정 자체가 다른 문서와 충돌. 실제 입력(주간 로그)과 CSV(정적 속성표)도 구조가 안 맞음 |
| 099-legal-basics-checker | 문제 없음 | 게이트 건수 합계 검증 일치 |
| 100-orchestration | **자기모순** | 098과 같은 sample_fallback 충돌 + SKILL.md 자체 모순("묻지 않고 완주" vs "없으면 3문답 후 091 권한다"가 바로 아래에 나란히 있음). example도 3문답 방식만 시연(CSV 미사용) |

## 부수 발견 — 098/100 문제의 근본 원인
`build-log-sample.md`가 자기 자신을 091·098·100의 정본으로 못 박고 있는데, 098·100의 SKILL.md는 별도 CSV(`A브랜드-반복업무-15건.csv`)를 sample_fallback으로 지정해 두 문서가 서로 다른 소리를 한다. **08-crm의 073과 같은 유형의 "문서 간 지정 파일 불일치"** — 수정 시 어느 쪽이 정본인지 먼저 정해야 한다.

## 그 외
- routing-eval.jsonl: 10개 스킬 전부 트리거 리터럴 중복 없음(정상).
