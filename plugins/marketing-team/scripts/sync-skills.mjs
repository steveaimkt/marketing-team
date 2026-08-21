#!/usr/bin/env node
/**
 * sync-skills.mjs · 스킬 100개 카탈로그를 정본에서 다시 받아 온다.
 *
 * 이 패키지는 스킬을 **사본으로 들고 있다** (설치 하나로 완결되게 하려고).
 * 사본은 늙는다. 정본이 바뀌면 이 스크립트로 다시 받고, 받은 뒤 검사를 돌린다.
 *
 * 사용: node scripts/sync-skills.mjs <정본_marketing-os_경로>
 *   예: node scripts/sync-skills.mjs ../marketing-os-dist
 */
import fs from 'node:fs';
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

const count = (() => { let c = 0; const w = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => { const p = path.join(d, e.name); if (e.isDirectory()) w(p); else if (e.name === 'SKILL.md') c++; }); w(to); return c; })();
console.log(`스킬 ${count}개 동기화 · 이름 치환 ${n}개 파일\n`);

for (const s of ['validate-skills.mjs', 'verify.mjs']) {
  console.log(`--- ${s}`);
  try { execFileSync(process.execPath, [path.join(ROOT, 'scripts', s)], { stdio: 'inherit' }); }
  catch { console.error(`  ⚠️ ${s} 가 실패했습니다. 위 내용을 고친 뒤 다시 돌리세요.`); process.exitCode = 1; }
}
