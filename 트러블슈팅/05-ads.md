# 05-ads 검수 결과 (2026-09-14)

| 스킬 | 판정 | 핵심 문제 |
|---|---|---|
| 041-coupang-ads-analysis | 문제 발견 | ROAS 폴백값이 Contract 안에서 퍼센트(100%·300%)와 배수(2.0·3.0) 두 가지로 따로 적힘(자기모순). example도 sample_fallback(`A브랜드-쿠팡광고-30일.csv`, 실제 광고비 합계 1,500,000원)과 무관한 지어낸 숫자(광고비 4,120,000원, 없는 키워드) 사용 |
| 042-naver-shopping-ads | 문제 발견 | ROAS 배수 표기 버그는 **이미 수정됨**. 다만 sample_fallback(쇼핑검색형 CSV, 키워드 열 없음)과 example이 쓰는 파일(`naver-ads-sample-report.csv`, 키워드형)이 다름 — 이 스킬의 핵심 시연 포인트(브랜드/일반 키워드 분리)가 지정 파일로는 재현 불가 |
| 043-meta-ad-copy | 경미 | sample_fallback 필드가 사실상 미사용(자체 주석 있음, 고아 필드 후보) |
| 044-google-ads-setup | 문제 없음 | sample_fallback 없음(데이터 불필요) |
| 045-weekly-ads-report | 문제 발견 | example이 sample_fallback(`A브랜드-광고매체통합-12주.csv`) 대신 043이 쓰는 다른 파일(`A브랜드-메타광고-30일.csv`)을 인용. 그 파일 기준으로도 example 숫자가 실제 합산과 안 맞음(지어낸 값에 실재 파일명만 붙임) |
| 046-roas-budget-rebalance | **가장 심각** | 프런트매터 sample_fallback(`A브랜드-광고매체통합-12주.csv`)이 본문 게이트표·example 전부(`A브랜드-채널성과-90일.csv`)와 다름. 그 파일엔 광고비/지출 열 자체가 없는데 example은 "뉴스레터 지출 600,000·ROAS 63.0"처럼 존재하지 않는 열의 값을 만들어 씀 |
| 047-ad-ab-verdict | 문제 발견 | sample_fallback(`A브랜드-ab테스트-3건.csv`)과 example/input.md 표기 파일이 다르고, 실제 example 내용(헤드라인 테스트, 노출 124,000 등)은 두 후보 파일 어디와도 대응 안 됨 — 완전 창작 |
| 048-landing-cro-audit | 문제 없음 | sample_fallback 실제 퍼널 수치(조회 12,400→장바구니 620(5.0%)→결제시작 210(1.7%)→결제완료 96(0.8%))가 example과 숫자 단위까지 정확히 일치. 모범 사례 |
| 049-ad-policy-checker | 문제 없음 | 048 원본·043 결과물 문구를 실제 그대로 인용. 모범 사례 |
| 050-utm-attribution | 문제 없음 | sample_fallback 없음 |

## 부수 발견
- routing-eval.jsonl: 10개 스킬 전부 트리거 리터럴 중복 없음(정상).
- 041·042·045·046·047 다섯 스킬에서 같은 계열의 결함("sample_fallback 선언 파일 ≠ example 실제 데이터")이 반복.
