# 100개 스킬 전수 검수 · 트러블슈팅 기록 (2026-09-14)

marketing-team 플러그인의 100개 스킬 전부를 카테고리별로 나눠 검수했다. 방법은 각 스킬의
`SKILL.md` `sample_fallback:` 필드가 가리키는 실제 샘플 데이터 파일을 열어, `example/input.md`·
`example/output.md`가 그 실제 데이터와 맞는 예시를 쓰는지 대조하고, SKILL.md 본문(Contract·
Output Format·게이트 규칙)이 자기 자신과 모순되는 곳이 있는지, `routing-eval.jsonl`이 트리거를
그대로 베끼지 않았는지 확인했다. 전부 읽기 전용 조사로 시작했고, 이 문서는 그 결과를 기록한다.

## 총괄

**100개 중 67개 스킬에서 문제 발견.** 카테고리별 상세는 각 파일 참고.

| 카테고리 | 문제 스킬 | 파일 |
|---|---|---|
| 01-research | 6/10 | [01-research.md](01-research.md) |
| 02-product | 6/10 | [02-product.md](02-product.md) |
| 03-content | 7/10 | [03-content.md](03-content.md) |
| 04-social | 6/10 | [04-social.md](04-social.md) |
| 05-ads | 5/10 | [05-ads.md](05-ads.md) |
| 06-commerce | 8/10 | [06-commerce.md](06-commerce.md) |
| 07-analytics | 8/10 | [07-analytics.md](07-analytics.md) |
| 08-crm | 8/10 | [08-crm.md](08-crm.md) |
| 09-brand-sales | 7/10 | [09-brand-sales.md](09-brand-sales.md) |
| 10-ops | 6/10 | [10-ops.md](10-ops.md) |

## 반복되는 결함 유형 (교차 패턴)

1. **sample_fallback ≠ example 실제 데이터** — 가장 흔한 결함. SKILL.md가 선언한 샘플 파일과
   `example/`이 실제로 보여주는 숫자·구성이 다른 파일에서 나온 것. 006-review-mining에서 최초
   발견된 유형이 최소 30개 이상 스킬에서 재현됨.
2. **"자극 8건" 오류 전파** — `sample-data/A브랜드-리뷰-200건.csv`의 "자극" 카테고리 리뷰가
   실제로는 23건인데, "8건(그중 6건 동일 제품 교체)"이라는 틀린 숫자가 최소 8개 스킬
   (011·015·020·023·027·028·029·030)의 example에 그대로 복사돼 "실측/검증완료"로 표기됨.
3. **허위 안전사고 리뷰 창작** — 032·054가 실제 리뷰 데이터에 없는 "피부가 뒤집어져서 병원
   갔다", "소비자원에 문의했다" 같은 위기 시나리오를 완전히 지어냄.
4. **SKILL.md 자기모순** — Contract가 정한 규칙(ROAS 배수 표기, 3 STEP 검사, 금지어 등)과
   Output Format 템플릿·example이 실제로 보여주는 형태가 다른 경우. 042(이미 수정됨)가 최초
   발견 사례.
5. **계산 오류·부호 반전** — 042(수정됨)·046·057(수정됨)·062(수정됨)·067·070·087·096 등에서
   반복. 070(NPS)은 방향 자체가 반대로 나온 가장 심각한 사례.
6. **배포 폴더 안 git 미추적 백업 파일** — 025·074·075 등 여러 폴더에 `.전_날짜` 백업이
   `plugins/` 안에 방치돼 CLAUDE.md §6 위반.

## 진행 상태

- [ ] 01-research 수정
- [ ] 02-product 수정
- [ ] 03-content 수정
- [ ] 04-social 수정
- [ ] 05-ads 수정
- [ ] 06-commerce 수정
- [ ] 07-analytics 수정
- [ ] 08-crm 수정
- [ ] 09-brand-sales 수정
- [ ] 10-ops 수정
- [ ] 배포 폴더 안 미추적 백업 파일 정리
- [ ] `validate-skills.mjs`·`eval-routing.mjs`·`build-stats.mjs` 최종 재확인
