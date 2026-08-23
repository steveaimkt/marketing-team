#!/usr/bin/env node
/**
 * bootstrap.mjs · 저장소를 클론해서 폴더로 열어 쓸 때 한 번 실행한다.
 *
 * 왜: `.claude/` 는 .gitignore 대상이라 새 클론에는 연결 고리가 없다.
 *     README 는 「클론하면 그대로 뜬다」고 했지만 실제로는 스킬이 하나도 안 뜬다.
 *     그러면 `마케팅팀-구축하기` 도 못 불러 스스로 복구할 수 없다 (2026-08-22 발견).
 *
 * 사용: node plugins/marketing-team/scripts/bootstrap.mjs
 *       node plugins/marketing-team/scripts/bootstrap.mjs --force   (기존 것을 바꿀 때만)
 *
 * ⛔ 기존 .claude/ 를 임의로 지우지 않는다. 무엇을 할지 먼저 보여준다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, '..');            // plugins/marketing-team
const REPO = path.resolve(PLUGIN, '..', '..');      // 저장소 루트
const FORCE = process.argv.includes('--force');
const DOT = path.join(REPO, '.claude');

const LINKS = [
  ['agents', path.relative(DOT, path.join(PLUGIN, 'agents'))],
  ['skills', path.relative(DOT, path.join(PLUGIN, 'skills'))],
];

console.log(`\n마케팅팀 · 폴더로 열어 쓰기 준비\n`);
console.log(`  저장소   ${REPO}`);
console.log(`  플러그인 ${path.relative(REPO, PLUGIN)}\n`);
console.log(`할 일 — ${path.relative(REPO, DOT)}/ 아래에 연결 고리를 만든다\n`);
for (const [name, target] of LINKS) console.log(`  ${name}  →  ${target}`);

fs.mkdirSync(DOT, { recursive: true });

let made = 0, kept = 0, copied = 0;
for (const [name, target] of LINKS) {
  const link = path.join(DOT, name);
  const abs = path.resolve(DOT, target);

  if (fs.existsSync(link) || fs.lstatSync(link, { throwIfNoEntry: false })) {
    let cur = null;
    try { cur = fs.readlinkSync(link); } catch { /* 심링크가 아니다 */ }
    if (cur === target) { console.log(`\n  ✅ ${name} · 이미 올바르게 연결돼 있다`); kept++; continue; }
    if (!FORCE) {
      console.log(`\n  ⚠️  ${name} · 이미 있다 (${cur ? `→ ${cur}` : '실제 폴더/파일'})`);
      console.log(`      바꾸려면 --force. 그 전에 안에 든 것을 확인하세요.`);
      kept++; continue;
    }
    fs.rmSync(link, { recursive: true, force: true });
  }

  try {
    fs.symlinkSync(target, link, 'dir');
    console.log(`\n  ✅ ${name} · 연결했다`);
    made++;
  } catch (e) {
    // 윈도우 등 심링크가 막힌 환경 — 복사로 폴백
    fs.cpSync(abs, link, { recursive: true });
    console.log(`\n  ✅ ${name} · 심링크가 막혀 복사했다 (${e.code})`);
    console.log(`      ⚠️  복사본이라 플러그인을 고쳐도 안 따라온다. \`git pull\` 뒤 이 명령을 다시 돌린다.`);
    copied++;
  }
}

// ── 커밋 훅 · 저장소를 고치는 사람에게만 해당한다 ──────────────────────
//   왜: 깃 훅은 .git/hooks/ 에 사는데 그 폴더는 배포되지 않는다. 클론해도 안 따라온다.
//       그래서 추적되는 .githooks/ 에 두고, 여기서 core.hooksPath 로 가리킨다.
//   무엇을 막나: 부를 말을 고치고 재보지 않은 채 커밋하는 것.
//       B층(실측)은 GitHub Actions 에서 못 돈다 — 구독 로그인이 없어서다. 여기가 유일한 자리다.
{
  const hooks = path.join(REPO, '.githooks');
  const isGit = fs.existsSync(path.join(REPO, '.git'));
  if (!isGit) {
    // 플러그인으로 설치한 사용자는 여기 안 온다. 저장소가 아니면 훅은 의미가 없다
  } else if (!fs.existsSync(hooks)) {
    console.log(`\n  ⚠️  .githooks/ 가 없다 — 커밋 훅을 못 켠다`);
  } else {
    const { spawnSync } = await import('node:child_process');
    const cur = spawnSync('git', ['config', '--get', 'core.hooksPath'],
      { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim();
    if (cur === '.githooks') {
      console.log(`\n  ✅ 커밋 훅 · 이미 켜져 있다`);
    } else if (cur) {
      console.log(`\n  ⚠️  커밋 훅 · 이미 다른 곳을 쓴다 (${cur}) — 덮어쓰지 않는다`);
      console.log(`      켜려면: git config core.hooksPath .githooks`);
    } else {
      const r = spawnSync('git', ['config', 'core.hooksPath', '.githooks'],
        { cwd: REPO, encoding: 'utf8', shell: process.platform === 'win32' });
      if (r.status === 0) {
        console.log(`\n  ✅ 커밋 훅 · 켰다 (라우팅 파일을 고치면 커밋 전에 60건을 재본다)`);
        console.log(`      끄려면: git config --unset core.hooksPath`);
      } else {
        console.log(`\n  ⚠️  커밋 훅 · 못 켰다. 손으로: git config core.hooksPath .githooks`);
      }
    }
  }
}

const okAgents = fs.existsSync(path.join(DOT, 'agents'));
const okSkills = fs.existsSync(path.join(DOT, 'skills'));
const nSkills = okSkills ? fs.readdirSync(path.join(DOT, 'skills')).length : 0;
const nAgents = okAgents ? fs.readdirSync(path.join(DOT, 'agents')).filter(f => f.endsWith('.md')).length : 0;

console.log(`\n──────────────────────────────`);
console.log(`  스킬 ${nSkills}개 · 담당 ${nAgents}명 · 연결 ${made} · 복사 ${copied} · 유지 ${kept}`);
if (nSkills === 3 && nAgents === 2) {
  console.log(`\n  ✅ 준비됐다. 클로드 코드를 이 폴더에서 새로 열고 —\n`);
  console.log(`     마케팅팀 구축하자\n`);
} else {
  console.log(`\n  ⚠️  스킬 3 · 담당 2 가 아니다. plugins/marketing-team/ 이 온전한지 확인하세요.\n`);
  process.exit(1);
}
