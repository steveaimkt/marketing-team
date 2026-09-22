# 저장소를 고치는 사람에게

> 플러그인을 **쓰기만** 한다면 이 문서는 필요 없다. [README](README.md) 로 충분하다.
> 여기는 스킬을 고치거나 검사를 돌리는 사람을 위한 문서다. 저장소에서 일하는 규칙은 [CLAUDE.md](CLAUDE.md) 에 있다.

## 폴더를 열어서 쓰기 (클로드 코드 전용, 고급)

⛔ **클론만으로는 스킬이 나타나지 않는다.** `.claude/` 는 저장소에 안 들어간다(개인 설정이라 `.gitignore` 대상).
**한 번 실행해서 연결 고리를 만들어야 한다.**

```bash
git clone https://github.com/steveaimkt/marketing-team.git
cd marketing-team
node plugins/marketing-team/scripts/bootstrap.mjs
```

```
✅ 스킬 3개 · 담당 3명 · 연결 2
   마케팅 팀 구축하자
```

그다음 클로드 코드를 **이 폴더에서 새로 열고** 「마케팅 팀 구축하자」.

- 심링크가 막힌 환경(주로 윈도우)에서는 **자동으로 복사로 바뀐다.** 그때는 `git pull` 뒤 다시 돌린다
- 이미 `.claude/` 를 쓰고 있으면 **덮어쓰지 않고 알려만 준다.** 바꾸려면 `--force`

스킬 파일과 산출물이 **한 폴더에 다 보이는** 것이 장점이지만, **기본 경로는 ①과 ②(플러그인 설치)** 다.

다만 **코워크에서는 클론 방식을 못 쓴다.** 터미널이 없어서 `git clone` 과 `bootstrap.mjs` 를 돌릴 수 없다.
**폴더를 여는 것 자체는 코워크도 된다.** 입력창의 「Work in a project or folder」로 작업 폴더를 고르면
그 안의 `brand/` · `inputs/` · `outputs/` · `logs/` 를 그대로 읽고 쓴다. 다만 플러그인은 마켓플레이스로 설치해야 한다.
그리고 오래 쓰면 `git pull` 이 내가 채운 `brand/profile.md` 와 부딪힌다.

> ⚠️ **윈도우에서 클론했다면 점검이 특히 중요하다.** 깃이 연결 고리를 텍스트 파일로 받아 오는 일이 있고,
> 그러면 담당이 하나도 안 걸린다. `marketing-team-setup`이 그것을 찾아 그 자리에서 고친다.

| | 코워크 | 클로드 코드 | 윈도우 |
|---|---|---|---|
| 플러그인 설치 **(기본)** | ✅ | ✅ | ✅ |
| 클론 + bootstrap (고급) | ❌ 터미널이 없다 | ✅ | ⚠️ 심링크 대신 복사 |
| 작업 폴더 열기 | ✅ Work in a project or folder | ✅ 폴더에서 실행 | ✅ |

**제품(팀·스킬)과 내 데이터(브랜드·산출물)가 분리돼 있어서** 플러그인이 성립한다.
경로 규칙은 [docs/공통규약.md §0](plugins/marketing-team/docs/공통규약.md).

## 스킬 100개는 일부러 등록하지 않는다

스킬은 `100-skills/` 에 파일로 있지만 Claude Code 에 스킬로 **등록되지 않는다.** 의도된 설계다.

| 방식 | 매 세션 고정 비용 |
|---|---|
| 100개를 전부 스킬로 등록 | **약 14,700 토큰** (카테고리당 ~1,475 × 10) |
| 이 패키지 (담당 3 + 스킬 3) | **약 3,700 토큰** |

명부 한 장만 상시로 보고, **본문은 매칭된 순간에만 연다.**
그 명부를 여는 자리가 `marketing-team-tasks` 스킬이다.

---

## 검사

```bash
node plugins/marketing-team/scripts/verify.mjs          # 설치해도 그대로 뜨는가
node plugins/marketing-team/scripts/validate-skills.mjs # 스킬 100개가 계약대로 생겼는가
node plugins/marketing-team/scripts/eval-routing.mjs    # 부를 말이 아직 그 스킬로 가는가
node plugins/marketing-team/scripts/daily-health-check.mjs  # 위 셋과 회귀 전부를 한 번에
```

**셋 다 push 할 때 자동으로 돈다.** 설정은 [.github/workflows/verify.yml](.github/workflows/verify.yml).
손으로 치는 것을 기억할 필요가 없다. 안 돌면 병합이 막힌다.

`verify.mjs` 가 보는 것은 **"폴더로 열면 되지만 플러그인으로 설치하면 안 되는"** 함정들이다.

| 검사 | 왜 |
|---|---|
| `plugin.json` 의 `repository` 가 문자열인가 | 객체면 플러그인 전체가 로드되지 않는다 |
| `agents/` 에 하위 폴더가 없는가 | 하위 폴더의 담당은 플러그인에서 통째로 사라진다 |
| `agents/` 의 모든 `.md` 에 frontmatter 가 있는가 | 없으면 그 문서가 유령 담당으로 등록된다 |
| `skills/` 가 한 단계인가 | 2단계 아래는 스캔되지 않는다 |
| 담당·스킬이 가리키는 문서가 실재하는가 | 없는 파일을 가리켜도 아무 에러가 안 난다 |
| 두 곳의 버전이 같은가 | 한쪽만 올리면 코워크가 「새것 없음」으로 본다 |

**검사는 윈도우·맥 양쪽에서 돈다.** 외부 명령을 부르지 않고 노드로만 돌며,
`.md` 가 CRLF 여도 읽는 즉시 눕혀서 견딘다.

> ⚠️ **`.gitattributes` 를 지워선 안 된다.** 윈도우 git 의 기본값(`core.autocrlf=true`)으로 클론하면
> `.md` 가 전부 CRLF 가 되고, 그러면 frontmatter 파서가 통째로 실패한다.
> **2026-08-23 실측에서 `verify.mjs` 가 🔴 128건**을 뱉었다. `* text=auto eol=lf` 한 줄이 이걸 막는다.
> `verify.mjs` 가 이 파일의 존재와 작업본의 줄바꿈을 매번 검사한다.

`eval-routing.mjs` 가 보는 것은 **「부를 말 482개가 아직 제 스킬로 가는가」**다.
진입로가 자연어 하나뿐이라, 트리거 한 줄을 고치면 엉뚱한 스킬이 열려도 아무 에러가 안 난다.

**실측 결과는 600건 전수에서 정확 584 (97.3%), 헷갈릴 만한 것 13, 틀림 3이다** (2026-09-22, `--live-cc`).
「헷갈릴 만한 것」은 `ambiguous_with` 에 미리 적어 둔, 사람도 헷갈리는 쌍이다.

⚠️ **어휘층(모델을 안 부르는 빠른 검사)과 B층(실모델)은 다른 것을 확인한다.**
어휘층은 낱말 겹침만 보는 대략치라 부채가 절반쯤 남아 있다. **실사용 라우팅은 B층으로 확인한다.**
어휘 점수가 떨어졌을 때 기준선을 낮추기 전에 **B층으로 확인한다.**

### 매일 스스로 검사한다

`daily-health-check.mjs` 가 **결정론 검사 13종**(구조 1, 회귀 11, 안전 1)을 끝까지 돌고
`maintenance/reports/` 에 요약을 남긴다. 한 검사가 실패·정지해도 나머지를 계속 돌고 마지막에 결과를 합친다.

- **🟡 은 실패가 아니다.** 「작업 중 드리프트」로 따로 표시한다 (개발 중 오탐 방지)
- **같은 검사가 연속 실패하면** 보고서에 `circuit_break` 로 표시한다
- **검사기 자신과 정책 파일**은 자동 수정 금지 목록에 들어 있다 (검사자가 자기 기준을 못 바꾸게)

`maintenance/` 는 저장소 유지보수 자산이라 **플러그인 패키지에 들어가지 않는다.**

| 층 | 무엇을 | 돈 | 언제 |
|---|---|---|---|
| **A** (기본) | 케이스 600건의 구조·모순·트리거 충돌 + 어휘 기준선 회귀 | 0 | push 마다 |
| **B** | 실제 모델에게 `ROUTING.md` 를 주고 600건을 라우팅시킨다 | 아래 참조 | 손으로 |

```bash
node plugins/marketing-team/scripts/eval-routing.mjs --report          # 틀리는 케이스 전부
node plugins/marketing-team/scripts/eval-routing.mjs --update-baseline # 의도한 변경일 때만
```

**B층은 방법이 둘이다. 확인하는 것은 같고 비용을 내는 곳이 다르다.**

| | 무엇으로 | 계산서 | CI |
|---|---|---|---|
| `--live-cc` | 이미 깔린 `claude` 를 헤드리스(`-p`)로 부른다 | **구독 사용량 · 추가 결제 없음** | ❌ 사람이 로컬에서 |
| `--live` | 공식 SDK 로 API 를 부른다 | 토큰 과금 (별도 결제) | ✅ 키를 시크릿에 넣으면 |

```bash
node plugins/marketing-team/scripts/eval-routing.mjs --live-cc --limit 40   # 맥스 구독 · 짧게
node plugins/marketing-team/scripts/eval-routing.mjs --live-cc              # 600건 전부
npm i --no-save @anthropic-ai/sdk && node plugins/…/eval-routing.mjs --live # API
```

`--live-cc` 는 프롬프트 캐시를 못 써서 `ROUTING.md` 를 매번 다시 보낸다. 그래서 느리고,
대신 묶음을 40건으로 크게 잡는다. `--live` 는 캐시가 먹어서 빠르지만 돈이 든다.

> A층의 어휘 기준선은 **진짜 라우팅이 아니다.** 글자 2-gram 으로 고른 1등일 뿐이라
> 절대 점수(지금 316/600)는 의미가 없다. 의미 있는 것은 **어제 맞던 것이 오늘 틀리는가** 하나다.
> 라우팅 품질 자체를 확인하려면 B층을 돌려야 한다.

### 커밋 훅 (저장소를 고치는 사람에게만)

B층은 **GitHub Actions 에서 못 돈다.** 거기엔 구독 로그인이 없다.
그래서 커밋하는 사람의 컴퓨터에서 잡는다. `.githooks/pre-commit` 이 그 자리다.

```
라우팅 파일을 안 건드렸다   → A층만 (3초)
SKILL.md·routing-eval·docs/ 를 건드렸다 → A층 + B층 60건 (약 2분 · 구독)
급할 때                    → SKIP_LIVE=1 git commit …
```

⛔ **깃 훅은 배포되지 않는다.** `.git/hooks/` 는 클론에 안 따라온다 (`.claude/` 와 같은 문제).
그래서 훅을 **추적되는 `.githooks/`** 에 두고 `core.hooksPath` 로 가리킨다.
**`bootstrap.mjs` 가 이 연결을 대신 해 준다.** 클론한 사람이 어차피 한 번 돌리는 명령이다.

| 누구 | 훅이 오나 |
|---|---|
| 코워크·클로드 코드 **플러그인 설치자** | ❌ 저장소가 없다 · 훅과 무관 |
| 저장소를 **클론한 사람** | 🟡 파일은 따라오지만 `bootstrap.mjs` 를 한 번 돌려야 켜진다 |

훅은 **제품이 아니라 개발 도구**다. 스킬 100개를 쓰는 사용자에게는 아무 영향이 없다.

정적 검사로 못 잡는 회귀도 있다. 「문서는 고쳤지만 실제로 안 도는」 경우다. 이런 것은
[scripts/실제확인.md](plugins/marketing-team/scripts/실제확인.md) 를 사람이 밟아 확인한다.

## 폴더와 저장소 구조 (고치는 사람용)

```
.claude-plugin/marketplace.json   마켓플레이스 카탈로그
plugins/marketing-team/           ← 플러그인 본체 (설치되는 것은 이 폴더다)
  agents/       검토 담당 3명 · 평탄하게 둔다 (하위 폴더 금지)
                staff-gate-auditor = AI 규제검토자 · staff-reviewer = AI 사업검토자
                staff-compliance-setup = AI 규제세팅
  skills/       marketing-team-setup · marketing-team-tasks · ai-marketer
  docs/         공통규약 · 검토-절차 · 팀-헌장 · 도메인-금기 · 자문-프레임워크 · 헷갈리는-쌍
  100-skills/   스킬 100개 카탈로그 + ROUTING.md 명부
  brand-templates/  빈 템플릿 원본 — 작업 폴더의 brand/ 와 이름이 겹치면 안 된다
  sample-data/  브랜드 정보가 없어도 완주하게 하는 샘플
  scripts/      verify · validate-skills · eval-routing · build-catalog · sync-skills · 실제확인.md
.github/workflows/verify.yml      push 마다 위 검사를 자동으로 돌린다
.githooks/pre-commit              커밋 전 · 라우팅을 건드렸으면 B층까지 (bootstrap 이 켜 준다)
.claude/                          클론해서 폴더로 열 때의 연결 고리
brand/ outputs/ logs/ inputs/     작업 폴더 (실행할 때 생긴다)
```

> **왜 한 겹 더 들어가 있나.** 마켓플레이스는 「저장소 어디에 플러그인이 있는지」를 가리켜야 한다.
> 저장소 루트 자체를 가리키면(`"source": "./"`) **코워크가 동기화에 실패한다**(2026-08-22 실측).
> 그래서 플러그인을 `plugins/marketing-team/` 에 두고 거기를 가리킨다.
> `scripts/verify.mjs` 가 이 규칙을 매번 검사한다.

