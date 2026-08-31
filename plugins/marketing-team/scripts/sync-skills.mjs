#!/usr/bin/env node
/**
 * sync-skills.mjs · 스킬 100개 카탈로그를 정본에서 다시 받아 온다.
 *
 * 이 패키지는 스킬을 **사본으로 들고 있다** (설치 하나로 완결되게 하려고).
 * 사본은 늙는다. 정본이 바뀌면 이 스크립트로 다시 받고, 받은 뒤 검사를 돌린다.
 *
 * 사용: node scripts/sync-skills.mjs <정본_marketing-os_경로>
 *   예: node scripts/sync-skills.mjs ../marketing-os-dist
 *
 * 🔴 **이름(`name:`)만은 이 저장소가 정본이다** (2026-09-01 · 사용자 결정).
 *    100개 이름을 「대상 + 행위」 한 꼴로 통일했고 `docs/스킬명-대조표.md` 가 그 정본이다.
 *    상류(marketing-os · marketing-os-dist)는 옛 이름을 들고 있어서, 그냥 받아 오면
 *    **100개가 조용히 되돌아간다.** 그래서 받은 뒤 대조표로 이름을 **되씌운다.**
 *    이름 말고 다른 것(절차·트리거·입출력)은 상류가 정본이다.
 */
import fs from 'node:fs';
// ⚠️ 윈도우에서 클론하면 .md 가 CRLF 로 온다 (git 기본값 core.autocrlf=true).
//    그러면 frontmatter 파서(`/^---\n…\n---\n/`)가 통째로 실패해 이 스크립트가 조용히 오작동한다.
//    .gitattributes 가 새 클론을 막지만, 이미 CRLF 가 된 파일과 윈도우 에디터가 저장한 파일도 있다.
//    정규식을 11군데 고치면 빠뜨린다. **읽는 즉시 눕힌다.** (실측 2026-08-23)
const _readFileSync = fs.readFileSync;
fs.readFileSync = (p, o) =>
  (o === 'utf8' || o?.encoding === 'utf8')
    ? String(_readFileSync(p, o)).replace(/\r\n/g, '\n')
    : _readFileSync(p, o);

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = process.argv[2];
if (!src) { console.error('정본 경로를 인자로 주세요.  예: node scripts/sync-skills.mjs ../marketing-os-dist'); process.exit(1); }
const from = path.resolve(src, '100-skills');
if (!fs.existsSync(path.join(from, 'ROUTING.md'))) { console.error(`정본이 아닌 것 같습니다: ${from}`); process.exit(1); }

const to = path.join(ROOT, '100-skills');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });

// 🔴 이름 되씌우기 · 상류가 옛 이름을 들고 있어도 이 저장소의 이름이 이긴다 (2026-09-01)
{
  const 표 = path.join(ROOT, 'docs', '스킬명-대조표.md');
  if (!fs.existsSync(표)) {
    console.error('🔴 docs/스킬명-대조표.md 가 없다. 이름 정본이 없으면 상류의 옛 이름이 그대로 들어온다.');
    process.exit(1);
  }
  const 쌍 = [...fs.readFileSync(표, 'utf8')
    .matchAll(/^\| ?(\d{3}) ?\| ?([^|]+?) ?\| ?([^|]+?) ?\|/gm)]
    .map(m => ({ from: m[2].trim().replace(/\*\*/g, '').trim(), to: m[3].trim().replace(/\*\*/g, '').trim() }))
    .filter(r => r.from && r.to && r.from !== r.to && !/^-+$/.test(r.from))
    .sort((a, b) => b.from.length - a.from.length);
  const rx = new RegExp(쌍.map(r => r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  const 사전 = Object.fromEntries(쌍.map(r => [r.from, r.to]));
  let 되씌움 = 0;
  const 훑기 = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const q = path.join(d, e.name);
    if (e.isDirectory()) return 훑기(q);
    if (!/\.(md|html|json)$/.test(e.name)) return;
    const body = fs.readFileSync(q, 'utf8');
    const 새 = body.replace(rx, m => 사전[m]);
    if (새 !== body) { fs.writeFileSync(q, 새); 되씌움++; }
  });
  훑기(to);
  console.log(`✅ 이름 되씌움 · 파일 ${되씌움}개 (대조표 ${쌍.length}쌍 · 이름은 이 저장소가 정본)`);
}

// 받아 온 사본에서 개인 인스턴스 이름을 이 패키지의 이름으로 바꾼다 (정본은 건드리지 않는다)
const SUBS = [[/트루먼이 상시로/g, '디렉터가 상시로'], [/트루먼/g, '디렉터'],
              [/# 스킬 100 · 라우팅 테이블/g, '# 스킬 100 · 라우팅 테이블']];  // 보통명사 「검증 방법론」 등은 건드리지 않는다
let n = 0;
const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  if (!/\.md$/.test(e.name)) return;
  const t = fs.readFileSync(p, 'utf8');
  let out = t;
  for (const [re, rep] of SUBS) out = out.replace(re, rep);
  if (out !== t) { fs.writeFileSync(p, out); n++; }
});
walk(to);

// 산출 경로를 스킬별 폴더로 (2026-08-22 결정 · docs/공통규약.md §H)
//   정본은 outputs/{날짜}/{카테고리}/파일 이지만, 우리는 한 실행의 결과를 한 폴더에 모은다.
//   outputs/{날짜}/{번호}-{슬러그}/파일  ← gate.md · 첨부가 같이 들어간다
{
  let c = 0;
  const w2 = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const q = path.join(d, e.name);
    if (e.isDirectory()) return w2(q);
    if (e.name !== 'SKILL.md') return;
    const slug = path.basename(path.dirname(q));
    const t = fs.readFileSync(q, 'utf8');
    const out = t.replace(/outputs\/\{날짜\}\/[a-z-]+\//g, `outputs/{날짜}/${slug}/`);
    if (out !== t) { fs.writeFileSync(q, out); c++; }
  });
  w2(to);
  console.log(`산출 경로 스킬별 폴더로 · ${c}개 파일`);
}

const count = (() => { let c = 0; const w = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name === 'SKILL.md') c++; }); w(to); return c; })();
console.log(`스킬 ${count}개 동기화 · 이름 치환 ${n}개 파일\n`);

for (const s of ['build-routing.mjs', 'build-catalog.mjs', 'validate-skills.mjs', 'verify.mjs']) {
  console.log(`--- ${s}`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', s)], { stdio: 'inherit' }); }
  catch { console.error(`  ⚠️ ${s} 가 실패했습니다. 위 내용을 고친 뒤 다시 돌리세요.`); process.exitCode = 1; }
}
