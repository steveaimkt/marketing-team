#!/usr/bin/env node
/**
 * validate-skills.mjs · 방법론 100 계약 정합성 전수 검사 (LLM 비용 0)
 *
 * 왜: skills/_evals/README.md — "작동한다를 말이 아니라 테스트로 증명한다".
 *     라우팅(eval-routing.mjs)이 '올바른 스킬을 고르는가'라면, 이건 '그 스킬이 계약대로 생겼는가'.
 * 사용: node scripts/validate-skills.mjs   ·  종료 0=통과 1=위반
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = path.join(ROOT, '100-skills');
const fmOf = t => (t.match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
const fld = (f, k) => ((f.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1] || '').trim().replace(/^"|"$/g, '');
// ⚠️ 괄호 안의 쉼표로 쪼개지 마라 · 2026-08-04
//   `본문 약 800자(HTML), 제목 5종` 을 그냥 `,` 로 나누면 `본문 약 800자(HTML`·`000자)` 로 깨져
//   022 가 "산출물 미반영" 오탐으로 잡혔다. 괄호 깊이를 세면서 자른다.
const list = s => {
  const out = []; let cur = '', depth = 0;
  for (const ch of s.replace(/^\s*\[|\]\s*$/g, '').replace(/"/g, '')) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth <= 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
};

const skills = [];
for (const cat of fs.readdirSync(M).filter(d => /^\d\d-/.test(d)).sort())
  for (const dir of fs.readdirSync(path.join(M, cat, 'skills')).sort()) {
    const p = path.join(M, cat, 'skills', dir, 'SKILL.md');
    if (fs.existsSync(p)) skills.push({ p, dir, cat, raw: fs.readFileSync(p, 'utf8') });
  }
const ids = new Set(skills.map(s => fld(fmOf(s.raw), 'id')));
const issues = [];
const add = (id, sev, msg) => issues.push({ id, sev, msg });
const REQUIRED_HEADER = [
  'id', 'name', 'description', 'slug', 'category', 'tier', 'triggers', 'inputs', 'outputs',
  'requires', 'chains_to', 'gate', 'mutating', 'writes_to', 'builder', 'version', 'persona',
  'when_to_use', 'success_metrics',
];

if (skills.length !== 100) add('COUNT', 'ERR', `스킬 수가 100개가 아니다: ${skills.length}`);
for (let n = 1; n <= 100; n++) {
  const id = String(n).padStart(3, '0');
  if (!ids.has(id)) add(id, 'ERR', '공식 ID 001–100 중 누락');
}

for (const s of skills) {
  const f = fmOf(s.raw), body = s.raw.slice(f.length + 10);
  // 코드펜스 안의 '## ' 는 섹션 경계가 아니다 (오탐 방지)
  const flat = body.replace(/```[\s\S]*?```/g, m => m.replace(/^## /gm, '@@ '));
  const id = fld(f, 'id'), slug = fld(f, 'slug');
  for (const key of REQUIRED_HEADER)
    if (!new RegExp(`^${key}:`, 'm').test(f)) add(id || s.dir, 'ERR', `필수 헤더 없음: ${key}`);
  // 1 폴더명 정합
  if (!s.dir.startsWith(id + '-')) add(id, 'ERR', `폴더명 불일치: ${s.dir}`);
  if (slug && !s.dir.endsWith(slug)) add(id, 'WARN', `slug 불일치: ${slug} vs ${s.dir}`);
  if (fld(f, 'category') !== s.cat) add(id, 'ERR', `category 불일치: ${fld(f, 'category')}`);
  // 2 체인 무결성
  for (const c of list(fld(f, 'chains_to'))) if (c !== 'ALL' && !ids.has(c)) add(id, 'ERR', `끊긴 체인 → ${c}`);
  // 3 requires 실재
  for (const r of list(fld(f, 'requires'))) {
    // 작업 폴더 자산(brand·outputs·logs·inputs)은 실행 중에 생긴다. 패키지에 있으면 오히려 틀린다
    //   ⚠️ 2026-08-22 · 패키지 안 brand/ 가 독자 프로필보다 먼저 잡혀 조용히 틀리던 것을 없앴다.
    if (/^(brand|outputs|logs|inputs)\//.test(r)) continue;
    const cand = [path.join(ROOT, r), path.join(M, r), path.join(M, path.basename(r))];
    if (!cand.some(x => fs.existsSync(x))) add(id, 'ERR', `없는 requires: ${r}`);
  }
  // 4 선언 산출물이 Output Format 에 나타나는가
  // flat 은 §31 에서 코드블록 안의 `## ` 를 `@@ ` 로 눕혀 둔 사본이다.
  //   그래서 아래 `\n## ` 컷은 **절 제목에만** 걸린다 (코드블록 안 제목엔 안 걸린다).
  //   ⚠️ 2026-08-04 · 이걸 모르고 "코드펜스 인식"을 새로 넣었다가 오히려 망가뜨렸다. 되돌렸다.
  const of = (flat.match(/## Output Format([\s\S]*?)(?=\n## |$)/) || [, ''])[1];
  if (!of.trim()) add(id, 'ERR', 'Output Format 비어 있음');
  const key = w => w.replace(/\(.*?\)/g, '').replace(/[^가-힣A-Za-z0-9]/g, '').slice(0, 4);
  // ⚠️ 2026-08-04 · 여기서 오탐 6건이 났다 (003·023·033·043·045·068). 원인 둘을 기록해 둔다.
  //   ① 대소문자를 구분해 `preheader`(선언)와 `Preheader`(본문)를 다른 말로 봤다.
  //   ② 숫자를 토큰에서 빼서 `6축 점수표` 가 본문의 `6축 평균` 열과 안 맞았다.
  //   선언과 본문은 말투가 다를 수밖에 없다. **소문자로 눕히고 숫자도 토큰에 넣는다.**
  for (const o of list(fld(f, 'outputs'))) {
    const flatOf = of.toLowerCase().replace(/[^가-힣a-z0-9]/g, '');
    const toks = (o.match(/[가-힣]{2,}|[A-Za-z]{3,}|[0-9]+[가-힣A-Za-z]+/g) || [])
      .map(x => x.toLowerCase());
    if (toks.length && !toks.some(x => flatOf.includes(x)))
      add(id, 'WARN', `산출물 미반영: "${o.slice(0, 22)}"`);
  }
  // 4-b 파일·데이터를 요구하면서 샘플 폴백이 없으면 사용자가 막힌다 (2026-08-22)
  const inp = fld(f, 'inputs');
  if (/이력 데이터|구매 데이터|주문일|고객ID|VoC\(|CSV 업로드/.test(inp) && !/^sample_fallback:/m.test(f))
    add(id, 'WARN', `파일이 필요한데 sample_fallback 없음 — 데이터 없는 사용자가 막힌다`);

  // 5 게이트 스킬은 판정 블록 필수
  if (fld(f, 'gate') === 'true' && !/컴플라이언스 게이트|게이트 판정|🛡/.test(body)) add(id, 'ERR', 'gate:true 인데 판정 블록 없음');
  // 5-b writes_to 는 착지 경로의 정본이다 — CMO 가 이걸 그대로 쓴다
  //     2026-08-22 실측: CMO 가 경로를 조합하다 output/ · LEDGER.md 같은 없는 곳에 냈다.
  //     정본이 틀리면 조합이 아니라 원본이 틀린 것이 된다.
  {
    const w = list(fld(f, 'writes_to'));
    if (!w.length) add(id, 'ERR', 'writes_to 없음 — 착지 경로의 정본이 없다');
    let fileTargets = 0;
    for (const p of w) {
      if (!p.includes('/')) continue;            // notion · figma · email — 외부 대상이지 경로가 아니다
      fileTargets++;
      if (!/^outputs\/\{날짜\}\//.test(p))
        add(id, 'ERR', `writes_to 가 outputs/{날짜}/ 로 시작하지 않는다: ${p}`);
      else if (!new RegExp(`^outputs/\\{날짜\\}/${id}-`).test(p))
        add(id, 'ERR', `writes_to 폴더가 {번호}-{슬러그} 가 아니다: ${p}`);
    }
    if (w.length && !fileTargets) add(id, 'WARN', `writes_to 에 파일 경로가 없다 (외부 대상만): ${w.join(' · ')}`);
  }
  // 5-c 외부 데이터를 요구하면 sample_fallback 이 있어야 완주한다
  //     2026-08-22 전수 검수: 5개가 없어 데이터 없는 사용자에겐 멈췄다
  {
    const inp = fld(f, 'inputs');
    // 「(선택)」이 붙은 항목과 말로 답하는 항목(목록·현황·정의)은 파일 입력이 아니다
    const fileish = inp.split(',').filter(x => !/\(선택\)/.test(x))
      .some(x => /CSV|csv|엑셀|\.xlsx|성과 데이터|구매 분포|근거 데이터|원본 콘텐츠|센터 통계|판매분석/.test(x));
    const needsData = fileish;
    if (needsData && !fld(f, 'sample_fallback'))
      add(id, 'WARN', `외부 데이터를 요구하는데 sample_fallback 없음 — 데이터 없으면 멈춘다`);
  }
  // 5-d 크롤링 전제 · 로그인 뒤 데이터를 URL 로 받겠다고 적으면 실행 시 막힌다
  {
    const inp = fld(f, 'inputs');
    if (/URL/.test(inp) && !/크롤링 불가|공개|캡처|열릴 때만|스크린샷|랜딩 URL|CTA/.test(inp))
      add(id, 'WARN', `inputs 에 URL 인데 크롤링 가능 여부가 안 적혀 있다 — docs/데이터-가져오기.md §0`);
  }
  // 5-e 비-md 산출물은 파일 직렬화 계약이 있어야 한다
  //     2026-08-22 외부 검토 — writes_to 가 .csv 인데 Output Format 은 마크다운 표였다.
  //     실행자가 마크다운을 .csv 로 저장하고 규칙을 지켰다고 오해한다.
  {
    const w = list(fld(f, 'writes_to'));
    const ext = (w.find(x => x.includes('/')) || '').split('.').pop();
    if (['csv', 'html', 'pptx', 'xlsx'].includes(ext) && !/\*\*형식\*\* ·/.test(body))
      add(id, 'ERR', `writes_to 가 .${ext} 인데 착지 블록에 「형식」 줄이 없다 (docs/공통규약.md §H)`);
  }
  // 6 mutating 은 승인 문구 필수
  if (fld(f, 'mutating') === 'true' && !/승인|⏸|확인 ?후/.test(body)) add(id, 'ERR', 'mutating:true 인데 승인 게이트 없음');
  // 7 절차 최소 3단
  const ph = (flat.match(/## Phases([\s\S]*?)(?=\n## |$)/) || [, ''])[1];
  if ((ph.match(/^\s*\d+\.\s/gm) || []).length < 3) add(id, 'ERR', 'Phases 3단 미만');
  // 8 트리거 최소 3개
  if ((f.match(/^\s*-\s+"/gm) || []).length < 3) add(id, 'WARN', '트리거 3개 미만');
}
// 9 체인 15종 무결성 · 2026-08-04
//   왜: 체인은 스킬 ID 를 본문 문자열로 들고 있어, 스킬 번호가 바뀌면 **조용히** 깨진다.
//       ROUTING.md 는 생성물이라 검사 대상이 아니고, 정본은 아래 둘이다.
//         카테고리 체인 10 = 100-skills/{팀}/PLUGIN.md 의 chain·chain_steps·chain_desc
//         교차 체인      5 = 100-skills/CHAINS.md
const chains = [];
for (const cat of fs.readdirSync(M).filter(d => /^\d\d-/.test(d)).sort()) {
  const p = path.join(M, cat, 'PLUGIN.md');
  if (!fs.existsSync(p)) { add(cat, 'ERR', `PLUGIN.md 없음`); continue; }
  const f = fmOf(fs.readFileSync(p, 'utf8'));
  const name = fld(f, 'chain');
  if (!name) { add(cat, 'ERR', `PLUGIN.md 에 chain 없음`); continue; }
  const steps = fld(f, 'chain_steps'), desc = fld(f, 'chain_desc');
  if (!steps) add(cat, 'ERR', `체인 순서 없음: ${name}`);
  if (!desc) add(cat, 'WARN', `체인 설명 없음: ${name}`);
  chains.push({ src: cat, name, steps, desc });
}
const xPath = path.join(M, 'CHAINS.md');
if (!fs.existsSync(xPath)) add('CHAINS', 'ERR', 'CHAINS.md 없음 (교차 체인 정본)');
else for (const m of fs.readFileSync(xPath, 'utf8')
  .matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|\s*`(.+?)`\s*\|(.+?)\|\s*$/gm))
  chains.push({ src: 'CHAINS.md', name: m[1].trim(), steps: m[2].trim(), desc: m[3].trim() });

const seen = new Map();
for (const c of chains) {
  // 9-1 순서에 적힌 스킬 ID 가 실재하는가
  const refs = [...new Set(c.steps.match(/\d{3}/g) || [])];
  if (!refs.length) add(c.src, 'ERR', `체인 순서에 스킬 ID 없음: ${c.name}`);
  for (const r of refs) if (!ids.has(r)) add(c.src, 'ERR', `끊긴 체인 → ${c.name} 의 ${r}`);
  // 9-2 이름 중복 (중복되면 오케스트레이터 라우팅이 갈린다)
  if (seen.has(c.name)) add(c.src, 'ERR', `체인 이름 중복: ${c.name} (${seen.get(c.name)})`);
  seen.set(c.name, c.src);
  // 9-3 단계 수와 설명 항목 수가 맞는가 (설명이 한 칸 밀리면 독자가 다른 스킬을 기대한다)
  //   단계 수는 → 로 센다. `(022|024)`·`041(042)` 처럼 한 칸에 대안이 둘이어도 한 단계다.
  const sn = c.steps.split('→').length;
  const dn = c.desc ? c.desc.split('→').length : 0;
  if (dn && dn !== sn) add(c.src, 'WARN', `체인 단계/설명 수 불일치: ${c.name} (${sn}단계 vs 설명 ${dn}칸)`);
}
if (chains.length !== 15) add('CHAIN', 'WARN', `체인 ${chains.length}종 (문서 기준 15종)`);

// 10 배포판 CMO가 팀장 10명을 전부 알고 있는가 · 2026-08-04
//   왜: 배포판 orchestrator.md 에 저자 개인 인스턴스가 실려 나간 적이 있다.
//       팀장 셋(social·ads·commerce)을 아예 부르지 않는 문서였는데 게이트를 통과했다.
//       감사는 개인정보 '문자열'만 봤지 '내용이 배포용인지'는 안 봤다.
//   ⚠️ 배포판에서만 검사한다. 정본 orchestrator 는 저자 인스턴스인 것이 정상이라
//      정본에서 돌리면 전부 오탐이 된다. `.dist-only` 는 배포판에만 있는 표식이다.
const IS_DIST = fs.existsSync(path.join(ROOT, '.dist-only'));
const orch = path.join(ROOT, 'agents', 'orchestrator.md');
if (IS_DIST && fs.existsSync(orch)) {
  const t = fs.readFileSync(orch, 'utf8');
  // agents/leads/ 는 v0.6.0 에서 사라졌다 (팀장 10명 → 판정 전담 2명). 검사도 함께 지운다.
  for (const a of ['staff-gate-auditor', 'staff-reviewer'])
    if (!t.includes(a)) add('orchestrator', 'ERR', `CMO가 모르는 담당: ${a}`);
  for (const w of ['기억 저장소', '트루먼']) {
    if (t.includes(w)) add('orchestrator', 'WARN', `배포판에 개인 인스턴스 흔적: ${w}`);
  }
}

const err = issues.filter(i => i.sev === 'ERR'), warn = issues.filter(i => i.sev === 'WARN');
console.log(`검사 ${skills.length}개 스킬 · 🔴 ERR ${err.length} · 🟡 WARN ${warn.length}\n`);
const by = {};
for (const i of issues) (by[i.msg.split(':')[0].split('→')[0].trim()] ||= []).push(i);
for (const [k, v] of Object.entries(by).sort((a, b) => b[1].length - a[1].length))
  console.log(`  ${v[0].sev === 'ERR' ? '🔴' : '🟡'} ${k} · ${v.length}건  [${[...new Set(v.map(x => x.id))].slice(0, 12).join(' ')}]`);
if (err.length) { console.log('\n--- ERR 상세 ---'); for (const e of err.slice(0, 30)) console.log(`  ${e.id}  ${e.msg}`); }
process.exit(err.length ? 1 : 0);
