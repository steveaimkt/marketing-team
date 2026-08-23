# 마케팅 팀 · marketing-team

> **스킬 100개를 갖춘 마케팅팀 하나.** 설치하면 그 자리에서 뜬다.
> **CMO** 가 일을 받아 직접 하고, 발행물은 **CCO(규제)** 가, 중요한 판단은 **CSO(검수)** 가 본다.
> 계획을 브리핑하고, 만들고, 규제 게이트를 통과시켜 **파일로 남긴다.**

---

## 두 가지만 하시면 됩니다

| | 하는 일 | 결과 |
|---|---|---|
| **①** | 설치하고 **「마케팅팀 업무 시작하자」** | 스킬 100개를 **바로 씁니다.** 번호도 이름도 몰라도 됩니다 |
| **②** | **`마케팅팀-구축하기`** 로 우리 회사 정보 | 100개가 **우리 값으로** 돕니다. 3분 |

②를 건너뛰어도 멈추지 않습니다. 샘플(가상의 A브랜드)로 완주하고 `[샘플]` 이 붙습니다.

### 스킬 셋

| 스킬 | 언제 |
|---|---|
| `마케팅팀-구축하기` | 설치 직후 점검 · 작업 폴더 생성 · 브랜드 정보 등록 |
| `마케팅팀-업무리스트` | 무엇을 시킬 수 있는지 볼 때 |
| **`마케팅-CMO`** | **실제 업무를 받는 자리** · 매일 쓰는 입구 |

```
마케팅팀 업무 시작하자    ← 무엇을 시킬지 모를 때
리뷰 분석해줘            경쟁사 비교해줘        이번 달 광고 어땠어
상세페이지 써줘           예산 다시 짜줘         광고애널리틱스 돌려줘
```

명령어를 외우지 않는다. **부르는 말**이 뒤에서 받고, 안 걸리면 3단 폴백이 받는다.

<!-- STATS:START -->
스킬 100 · 부를 말 469 · 게이트 32 · 상태변경 7 · 체인 15
저장 형식 md 76 · csv 13 · html 8 · pptx 3 · `writes_to` 보유 100 · 샘플 폴백 48
<!-- STATS:END -->

> 위 숫자는 `node plugins/marketing-team/scripts/build-stats.mjs` 가 정본에서 계산한다. 손으로 고치지 않는다.
전체 명부는 [100-skills/ROUTING.md](plugins/marketing-team/100-skills/ROUTING.md).

---

## 설치

### ① 코워크 · Cowork

```
사이드바 Customize → Plugins → Add marketplace
→  steveaimkt/marketing-team
→  목록에 뜬 marketing-team 을 Install
```

설치하면 **Skills 탭에 3개, Agents 탭에 2명**이 뜬다.
그다음 **`마케팅팀-구축하기`** 를 누른다.

### ② 클로드 코드 · Claude Code

```
/plugin marketplace add steveaimkt/marketing-team
/plugin install marketing-team@marketing-team
```

작업할 폴더를 하나 열고 **`마케팅팀-구축하기`**. 그 폴더에 `brand/` · `outputs/` · `logs/` 를 만들어 준다.
앞으로 산출물은 전부 그 폴더에 쌓인다.

### ③ 폴더를 열어서 · 클로드 코드 전용 · **고급**

⛔ **클론만으로는 안 뜬다.** `.claude/` 는 저장소에 안 들어간다(개인 설정이라 `.gitignore` 대상).
**한 번 실행해서 연결 고리를 만들어야 한다.**

```bash
git clone https://github.com/steveaimkt/marketing-team.git
cd marketing-team
node plugins/marketing-team/scripts/bootstrap.mjs
```

```
✅ 스킬 3개 · 담당 2명 · 연결 2
   마케팅팀 구축하자
```

그다음 클로드 코드를 **이 폴더에서 새로 열고** 「마케팅팀 구축하자」.

- 심링크가 막힌 환경(주로 윈도우)에서는 **자동으로 복사로 바뀐다.** 그때는 `git pull` 뒤 다시 돌린다
- 이미 `.claude/` 를 쓰고 있으면 **덮어쓰지 않고 알려만 준다.** 바꾸려면 `--force`

스킬 파일과 산출물이 **한 폴더에 다 보이는** 것이 장점이지만, **기본 경로는 ①·②(플러그인 설치)** 다.

다만 **코워크에서는 이 방법이 없다.** 코워크에는 「내 폴더를 연다」가 없어서 플러그인이라야 한다.
그리고 오래 쓰면 `git pull` 이 내가 채운 `brand/profile.md` 와 부딪힌다.

> ⚠️ **윈도우에서 클론했다면 점검이 특히 중요하다.** 깃이 연결 고리를 텍스트 파일로 받아 오는 일이 있고,
> 그러면 담당이 하나도 안 걸린다. `마케팅팀-구축하기` 가 그것을 찾아 그 자리에서 고친다.

| | 코워크 | 클로드 코드 | 윈도우 |
|---|---|---|---|
| 플러그인 설치 **(기본)** | ✅ | ✅ | ✅ |
| 클론 + bootstrap (고급) | ❌ 터미널이 없다 | ✅ | ⚠️ 심링크 대신 복사 |

**제품(팀·스킬)과 내 데이터(브랜드·산출물)가 분리돼 있어서** 플러그인이 성립한다.
경로 규칙은 [docs/공통규약.md §0](plugins/marketing-team/docs/공통규약.md).

---

## 구조

```
사용자 (모든 ⏸ 승인의 최종 결재권자)
   │
CMO  ← 메인 대화에서 직접 돈다 (에이전트가 아니라 스킬이다)
   │     접수 · 라우팅 · 브리핑 ⏸ · 실행 · 파일 착지 · 기록
   │     스킬 100개를 직접 굴린다. 실행자를 따로 두지 않는다
   │
   └─ 판정 담당 2  ← 내가 나를 검사할 수 없는 자리에만
       CCO(규제)   staff-gate-auditor  대외 발행물 검사 · ⛔ 유일 권한
       CSO(검수)   staff-reviewer      CEO·CFO·고객·CLO·CBO 5관점 (sonnet)
```

**서브에이전트는 「독립성이 필요한 판정」에만 씁니다.** 실행은 전부 메인에서 합니다.
한때 팀장 10명을 뒀으나 하는 일이 「스킬 읽고 따라하기」로 환원돼 지웠습니다.

### CCO 와 CSO 는 묻는 질문이 다르다

| | **CCO(규제)** | **CSO(검수)** |
|---|---|---|
| 묻는 것 | **법을 어겼는가** | **사업적으로 맞는가** |
| 대상 | 대외 발행물 (`gate: true` · 32개) | 중요 판단 (런칭 플랜 · 제안서 · 예산안) |
| 언제 | 발행 직전 · 자동 · `gate:true` 32개 | **가격·예산·우선순위·포지셔닝·계약**이 나오면 (주제 기반) |
| 권한 | ⛔ 를 CMO 가 **못 뒤집는다** | 의견 · CMO 가 반영 여부 판단 |

```
CCO(규제)   「업계 1위」 실증자료 없음 → ⛔   나갈 수 없다
CSO(검수)   CFO — 할인 30%면 마진 8%        나가도 되지만 팔수록 손해다
```

CMO 가 직접 검토자 모드로 도는 **6관점 절차**는 따로 있다
([docs/검토-절차.md](plugins/marketing-team/docs/검토-절차.md)) — CSO 의 5관점과 다르다.

**멈춰 서는 자리가 32곳.** 대외로 나가는 산출물 32개는 발행 전 규제 검사를 통과해야 한다.
표시광고법이 공통이고, `brand/profile.md` 의 업종에 따라 화장품법·건강기능식품법이 자동으로 갈아 끼워진다.
⛔ 판정이면 **전달하지 않도록 지시한다.** 다만 **기술적 강제 차단은 아니다** —
현재는 절차 규약과 사람 승인에 기댄다. 실제 발송 도구가 붙을 때 서버·훅 차단으로 올린다.

---

## 스킬 100개는 일부러 등록하지 않는다

스킬은 `100-skills/` 에 파일로 있지만 Claude Code 에 스킬로 **등록되지 않는다.** 의도된 설계다.

| 방식 | 매 세션 고정 비용 |
|---|---|
| 100개를 전부 스킬로 등록 | **약 14,700 토큰** (카테고리당 ~1,475 × 10) |
| 이 패키지 (담당 2 + 스킬 3) | **약 3,700 토큰** |

명부 한 장만 상시로 보고, **본문은 매칭된 순간에만 연다.**
그 명부를 여는 자리가 `마케팅팀-업무리스트` 스킬이다.

---

## 검사

```bash
node plugins/marketing-team/scripts/verify.mjs          # 설치해도 그대로 뜨는가
node plugins/marketing-team/scripts/validate-skills.mjs # 스킬 100개가 계약대로 생겼는가
node plugins/marketing-team/scripts/eval-routing.mjs    # 부를 말이 아직 그 스킬로 가는가
```

**셋 다 push 할 때 자동으로 돈다** — [.github/workflows/verify.yml](.github/workflows/verify.yml).
손으로 치는 것을 기억할 필요가 없다. 안 돌면 병합이 막힌다.

`verify.mjs` 가 보는 것은 **"폴더로 열면 되는데 플러그인으로 설치하면 안 되는"** 함정들이다.

| 검사 | 왜 |
|---|---|
| `plugin.json` 의 `repository` 가 문자열인가 | 객체면 플러그인 전체가 로드되지 않는다 |
| `agents/` 에 하위 폴더가 없는가 | 하위 폴더의 담당은 플러그인에서 통째로 사라진다 |
| `agents/` 의 모든 `.md` 에 frontmatter 가 있는가 | 없으면 그 문서가 유령 담당으로 등록된다 |
| `skills/` 가 한 단계인가 | 2단계 아래는 스캔되지 않는다 |
| 담당·스킬이 가리키는 문서가 실재하는가 | 없는 파일을 가리켜도 아무 에러가 안 난다 |
| 두 곳의 버전이 같은가 | 한쪽만 올리면 코워크가 「새것 없음」으로 판정한다 |

`eval-routing.mjs` 가 보는 것은 **「부를 말 469개가 아직 제 스킬로 가는가」**다.
진입로가 자연어 하나뿐이라, 트리거 한 줄을 고치면 엉뚱한 스킬이 열려도 아무 에러가 안 난다.

| 층 | 무엇을 | 돈 | 언제 |
|---|---|---|---|
| **A** (기본) | 케이스 596건의 구조·모순·트리거 충돌 + 어휘 기준선 회귀 | 0 | push 마다 |
| **B** (`--live`) | 실제 모델에게 `ROUTING.md` 를 주고 596건을 라우팅시킨다 | 유료 | 손으로 누를 때 |

```bash
node plugins/marketing-team/scripts/eval-routing.mjs --report          # 틀리는 케이스 전부
node plugins/marketing-team/scripts/eval-routing.mjs --update-baseline # 의도한 변경일 때만
npm i @anthropic-ai/sdk && node plugins/…/eval-routing.mjs --live      # B층
```

> A층의 어휘 기준선은 **진짜 라우팅이 아니다.** 글자 2-gram 으로 고른 1등일 뿐이라
> 절대 점수(지금 316/596)는 의미가 없다. 의미 있는 것은 **어제 맞던 것이 오늘 틀리는가** 하나다.
> 라우팅 품질 자체를 재려면 B층을 돌려야 한다.

정적 검사로 못 잡는 것 — 「문서는 고쳤는데 실제로 안 도는」 회귀 — 은
[scripts/smoke.md](plugins/marketing-team/scripts/smoke.md) 를 사람이 밟아 확인한다.

---

## 폴더

```
.claude-plugin/marketplace.json   마켓플레이스 카탈로그
plugins/marketing-team/           ← 플러그인 본체 (설치되는 것은 이 폴더다)
  agents/       판정 담당 2명 · 평탄하게 둔다 (하위 폴더 금지)
                staff-gate-auditor = CCO(규제) · staff-reviewer = CSO(검수)
  skills/       마케팅팀-구축하기 · 마케팅팀-업무리스트 · 마케팅-CMO
  docs/         공통규약 · 검토-절차 · 팀-헌장 · 도메인-금기 · 자문-프레임워크 · 헷갈리는-쌍
  100-skills/   스킬 100개 카탈로그 + ROUTING.md 명부
  brand-templates/  빈 템플릿 원본 — 작업 폴더의 brand/ 와 이름이 겹치면 안 된다
  sample-data/  브랜드 정보가 없어도 완주하게 하는 샘플
  scripts/      verify · validate-skills · eval-routing · build-catalog · sync-skills · smoke.md
.github/workflows/verify.yml      push 마다 위 검사를 자동으로 돌린다
.claude/                          클론해서 폴더로 열 때의 연결 고리
brand/ outputs/ logs/ inputs/     작업 폴더 (실행할 때 생긴다)
```

> **왜 한 겹 더 들어가 있나** · 마켓플레이스는 「저장소 어디에 플러그인이 있는지」를 가리켜야 한다.
> 저장소 루트 자체를 가리키면(`"source": "./"`) **코워크가 동기화에 실패한다**(2026-08-22 실측).
> 그래서 플러그인을 `plugins/marketing-team/` 에 두고 거기를 가리킨다.
> `scripts/verify.mjs` 가 이 규칙을 매번 검사한다.

MIT License.
