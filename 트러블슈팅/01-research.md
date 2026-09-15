# 01-research 검수 결과 (2026-09-14)

| 스킬 | 판정 | 핵심 문제 |
|---|---|---|
| 001-keyword-research | 경미 | sample_fallback CSV(`A브랜드-키워드-10개.csv`) 스키마가 SKILL.md Output Format 스키마와 다르고, example도 이 파일을 안 씀(고아 필드) |
| 002-competitor-analysis | 문제 없음 | example이 `경쟁사-3곳.md`와 완전히 일치(단가 계산 검산됨). SKILL.md 템플릿의 경쟁사 수(2개)만 실제(3개)와 다름(사소) |
| 003-competitor-monitoring | **심각** | SKILL.md 자체 주석이 "sample_fallback을 스냅샷 폴더로 고쳤다"고 기록했는데, "실습해 보기"·example은 여전히 옛 파일(`경쟁사-3곳.md`)과 옛 수치를 씀. 실제 스냅샷 diff(C사 22,000→19,900·할인 9.5%)와도 다름(예시는 22,000→13,200·할인 40%). "고쳤다고 적어놓고 실제로는 안 고친" 사례 |
| 004-market-sizing | 문제 없음 | 데이터 파일 의존 없음, TAM/SAM/SOM 계산 전부 검산 일치 |
| 005-trend-scanning | 경미 | sample_fallback(`A브랜드-유튜브검색-61편.csv`)을 SKILL.md Phases가 아예 안 씀, example도 미사용 (001과 동일 패턴) |
| 006-review-mining | **이미 수정됨** | 이번 세션에서 example/input.md·output.md를 실제 샘플과 일치하도록 수정 완료 |
| 007-survey-design | 잠재적 | sample_fallback(리뷰 200건 CSV)에 인구통계/응답 열이 없어 Contract가 요구하는 "인구통계×응답 교차표"를 만들 수 없는 구조(example은 1차에서 멈춰 문제가 안 드러남) |
| 008-persona-builder | **가장 심각** | 페르소나 근거("성분", "전성분", "비싸다")가 실제 리뷰 데이터에 **0건** 등장. 순수 창작. "살짝 따가웠다" 실제 11건→예시 24건, "끈적임" 실제 14건→예시 38건 |
| 009-price-positioning-map | **Contract 위반** | 원본에 없는 평점·리뷰수(자사 3.25/200건, B사 4.10/1,800건 등)를 `[추정]` 태그 없이 하드코딩. 자사 평점도 006 실제 계산값(3.41)과 다름(3.25) |
| 010-market-entry-priority | 경미 | Impact/Effort 계산은 정확하나, 예시가 SKILL.md 고정 4분면 이름("★지금 진입/다음 라운드/자투리/보류") 대신 다른 용어를 씀 |

## 부수 발견
- `003-competitor-monitoring/SKILL.md.전_20260905`가 git 미추적 상태로 `plugins/` 안에 있음(CLAUDE.md §6 위반). diff 결과 문체 교정 차이만 있고 본 결함과는 무관.
- `005-trend-scanning`에도 동일한 미추적 백업 존재.
- routing-eval.jsonl: 006의 5번째 줄이 트리거와 "들" 한 글자 차이로 거의 동일(완전 일치는 아님, 참고만).
