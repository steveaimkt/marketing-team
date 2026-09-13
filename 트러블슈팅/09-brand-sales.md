# 09-brand-sales 검수 결과 (2026-09-14)

| 스킬 | 판정 | 핵심 문제 |
|---|---|---|
| 081-brand-story | 문제 발견 | sample_fallback(내부회의메모, 실제로는 CS·ROAS 논의)이 Phase 2(창업 인터뷰)에 쓸 내용이 없음. 게이트가 항상 "묻고 멈춘다"라 사실상 미사용, example도 완전히 다른 가상 인터뷰 사용 |
| 082-brand-guidelines-doc | **심각(Contract 위반)** | sample_fallback이 "이 컬러값을 지어내면 안 된다"고 명시([미확보])했는데 example이 주컬러·보조컬러·배경색을 전부 지어내 확정. 로고 있음/없음도 실제와 반대로 적음 |
| 083-press-release | **심각** | example이 sample_fallback과 무관한 완전 창작 서사("9월 리뉴얼 출시", VoC 62건, 설문 214명 중 31명) — 어떤 실제 파일과도 대응 안 됨 |
| 084-proposal-generator | 문제 없음 | sample_fallback 없음(타당), 배점·목차 분량 전부 검산 일치 |
| 085-sales-deck | 문제 발견 | input.md("12장→8장")와 output.md(실제 11장, 축소 매수 설명도 다름) 불일치 |
| 086-meeting-followup | 문제 발견 | sample_fallback(오프라인 입점 협상 메모)과 무관한 완전 창작 서사("D2C PoC 영업 미팅, 4천만원 계약") |
| 087-partnership-pack | **심각(계산 오류)** | 손익분기 계산이 문서 안 세 곳에서 다름(계산식 자체 600만원 vs 서술 400만원 vs 190만원, 셋 다 다르고 정답은 600만원) |
| 088-sponsored-content-brief | 경미 | Contract 8단 구조와 example 표의 항목 배치가 일부 안 맞음 |
| 089-crisis-comms | 구조 혼란 | 컴플라이언스 검사 결과가 본문에 두 번 등장(순서·문맥 불분명, 버그 단정은 어려움) |
| 090-award-application | 문제 없음(단, 083/081과 허구 세계관 공유) | 자체 산술은 정확하나 083·081의 창작 서사를 재사용 |

## 부수 발견
- sample_fallback을 선언한 4개 스킬(081·082·083·086) **전부**에서 example이 실제 샘플과 무관한 서사를 씀 — 06-review-mining 패턴의 재현.
- routing-eval.jsonl: 10개 스킬 전부 트리거 리터럴 중복 없음(정상).
