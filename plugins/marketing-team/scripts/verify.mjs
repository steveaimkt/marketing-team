#!/usr/bin/env node
/**
 * verify.mjs · 이 패키지가 "플러그인으로 설치해도 그대로 뜨는가"를 검사한다.
 *
 * 왜: 폴더로 열면 되는데 플러그인으로 설치하면 안 되는 일이 실제로 있었다.
 *     ① plugin.json 의 repository 가 객체면 플러그인 전체가 로드되지 않는다 (문자열이어야 한다)
 *     ② agents/ 의 하위 폴더는 스캔되지 않는다 — 하위 폴더에 둔 담당은 통째로 사라진다
 *     ③ agents/ 안의 .md 는 전부 담당으로 등록된다 — 규약 문서를 거기 두면 유령 담당이 생긴다
 *     ④ skills/ 도 바로 아래 한 단계만 스캔된다
 *
 * 사용: node scripts/verify.mjs   ·  종료 0=통과 1=위반
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
import { spawnSync } from 'node:child_process';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const issues = [];
const notes = [];
const err = (m) => issues.push(['🔴', m]);
const warn = (m) => issues.push(['🟡', m]);
const ok = [];

// ① 매니페스트
const mpath = path.join(ROOT, '.claude-plugin/plugin.json');
if (!fs.existsSync(mpath)) err('.claude-plugin/plugin.json 없음');
else {
  let m;
  try { m = JSON.parse(fs.readFileSync(mpath, 'utf8')); } catch (e) { err(`plugin.json 파싱 실패: ${e.message}`); }
  if (m) {
    for (const k of ['name', 'description', 'version']) if (!m[k]) err(`plugin.json 필수 필드 없음: ${k}`);
    if (m.repository !== undefined && typeof m.repository !== 'string')
      err('plugin.json repository 가 객체다 — 문자열이어야 플러그인이 로드된다 (실측 2026-08-22)');
    if (m.author !== undefined && typeof m.author !== 'object') warn('plugin.json author 는 {name} 객체를 권한다');
    if (m.name) ok.push(`매니페스트 ${m.name} v${m.version}`);
  }
}

// ①-2 마켓플레이스 매니페스트 (배포 저장소 구조일 때만)
{
  const REPO0 = path.resolve(ROOT, '..', '..');
  const mk = path.join(REPO0, '.claude-plugin', 'marketplace.json');
  if (fs.existsSync(mk)) {
    let m; try { m = JSON.parse(fs.readFileSync(mk, 'utf8')); } catch (e) { err(`marketplace.json 파싱 실패: ${e.message}`); }
    if (m) {
      const entry = (m.plugins || [])[0];
      if (!entry) err('marketplace.json 에 plugins 항목이 없다');
      else {
        if (typeof entry.source !== 'string' || !entry.source.startsWith('./') || entry.source === './')
          err(`marketplace.json 의 source 는 "./하위폴더" 여야 한다 (지금: ${JSON.stringify(entry.source)}) — ` +
              '저장소 루트 자체를 가리키면 코워크가 동기화에 실패한다 (실측 2026-08-22)');
        else if (!fs.existsSync(path.join(REPO0, entry.source, '.claude-plugin', 'plugin.json')))
          err(`marketplace.json 의 source 가 가리키는 곳에 플러그인이 없다: ${entry.source}`);
        else ok.push(`마켓플레이스 → ${entry.source}`);
      }
    }
  }
}

// ①-3 플러그인 안에 또 다른 플러그인이 있으면 안 된다
//   왜: 배포판에서 딸려온 카테고리별 plugin.json 10개가 100-skills/ 안에 남아 있었다.
//       코워크 백엔드가 이걸 보고 failed_content 로 거부했다 (2026-08-22 실측).
{
  const found = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    if (e.name === 'node_modules') return;
    const q = path.join(d, e.name);
    if (e.isDirectory()) return walk(q);
    if (e.name === 'plugin.json' && path.basename(d) === '.claude-plugin') found.push(path.relative(ROOT, q));
  });
  walk(ROOT);
  if (found.length > 1)
    err(`플러그인 안에 plugin.json 이 ${found.length}개다 — 하나여야 한다. 중첩된 매니페스트: ` +
        found.filter(f => f !== '.claude-plugin/plugin.json').slice(0, 5).join(', '));
  else ok.push('매니페스트 1개 (중첩 없음)');
}

// ② 담당(agents) · 평탄해야 한다
const adir = path.join(ROOT, 'agents');
const agents = [];
if (!fs.existsSync(adir)) err('agents/ 없음');
else {
  for (const e of fs.readdirSync(adir, { withFileTypes: true })) {
    if (e.isDirectory()) { err(`agents/ 하위 폴더는 플러그인에서 스캔되지 않는다: agents/${e.name}/ — 최상위로 올려라`); continue; }
    if (!e.name.endsWith('.md')) continue;
    const raw = fs.readFileSync(path.join(adir, e.name), 'utf8');
    const fm = (raw.match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    const base = e.name.replace(/\.md$/, '');
    if (!fm) { err(`agents/${e.name} · frontmatter 없음 — 담당이 아니면 docs/ 로 옮겨라 (유령 담당이 된다)`); continue; }
    const name = (fm.match(/^name:\s*(.+)$/m) || [, ''])[1].trim();
    const desc = (fm.match(/^description:\s*(.+)$/m) || [, ''])[1].trim();
    if (!name) err(`agents/${e.name} · name 없음`);
    else if (name !== base) err(`agents/${e.name} · 파일명과 name 불일치 (${name})`);
    if (!desc) err(`agents/${e.name} · description 없음 — AI 마케터가 언제 부를지 모른다`);
    agents.push(base);
  }
  ok.push(`담당 ${agents.length}명 (평탄 · 전원 frontmatter 완비) · AI 마케터는 스킬`);
}

// ③ AI 마케터가 전원을 알고 있나 · 유령이 없나
// AI 마케터는 메인 컨텍스트에서 도는 스킬이다. 서브에이전트가 아니다 (2026-08-22 결정).
//   서브에이전트가 다시 위임하면 맥락이 두 겹으로 접힌다. 내려가는 단계는 언제나 한 단이다.
if (fs.existsSync(path.join(adir, 'marketing-director.md')))
  err('agents/marketing-director.md 가 있다 — AI 마케터는 skills/AI-마케터 여야 한다 (중첩 위임 방지)');
const dpath = path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md');
if (!fs.existsSync(dpath)) err('skills/AI-마케터/SKILL.md 없음 — 입구가 없다');
else {
  const d = fs.readFileSync(dpath, 'utf8');
  for (const a of agents) if (!d.includes(a)) err(`AI 마케터가 모르는 담당: ${a} — 조직도에 없으면 호출되지 않는다`);
  // 담당은 「내가 나를 검사할 수 없는 자리」에만 둔다 (2026-08-22 결정). 실행자는 두지 않는다.
  const exec = agents.filter(a => !a.startsWith('staff-'));
  if (exec.length) err(`실행 담당이 있다: ${exec.join(', ')} — 실행은 AI 마케터가 메인에서 한다. 담당은 판정 전담만`);
  for (const m of d.matchAll(/`(lead-[a-z-]+|staff-[a-z-]+)`/g))
    if (!agents.includes(m[1])) err(`AI 마케터가 없는 담당을 부른다: ${m[1]}`);
}

// ④ 스킬 · 바로 아래 한 단계
const sdir = path.join(ROOT, 'skills');
let skills = [];
if (!fs.existsSync(sdir)) warn('skills/ 없음');
else {
  for (const e of fs.readdirSync(sdir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const p = path.join(sdir, e.name, 'SKILL.md');
    if (!fs.existsSync(p)) {
      const nested = fs.readdirSync(path.join(sdir, e.name), { withFileTypes: true }).filter(x => x.isDirectory());
      if (nested.length) err(`skills/${e.name}/ 안에 다시 폴더가 있다 — 2단계는 스캔되지 않는다`);
      else err(`skills/${e.name}/SKILL.md 없음`);
      continue;
    }
    const fm = (fs.readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---/) || [, ''])[1];
    if (!/^description:/m.test(fm)) err(`skills/${e.name} · description 없음`);
    skills.push(e.name);
  }
  ok.push(`스킬 ${skills.length}개`);
}

// ⑤ 스킬 명부
const M = path.join(ROOT, '100-skills');
if (!fs.existsSync(M)) err('100-skills/ 없음 — 팀이 지휘할 스킬이 없다');
else {
  const n = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (e.name === 'SKILL.md') n.push(p);
  });
  walk(M);
  if (n.length !== 100) warn(`스킬 ${n.length}개 (기준 100)`);
  else ok.push('마케팅 스킬 100개');
  for (const f of ['ROUTING.md', 'CHAINS.md', 'SPEC.md', 'compliance.md', 'gates/compliance-gate.md', 'gates/quality-checklist.md'])
    if (!fs.existsSync(path.join(M, f))) err(`100-skills/${f} 없음`);
}

// ⑥ 참조 무결성 · 담당/스킬이 가리키는 문서가 실재하나
const REFD = new Set();
for (const dir of [adir, sdir]) {
  if (!fs.existsSync(dir)) continue;
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (!e.name.endsWith('.md')) return;
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/`(?:\$\{CLAUDE_PLUGIN_ROOT\}\/)?((?:docs|100-skills|brand-templates|sample-data|scripts)\/[^`\s)]+?\.(?:md|mjs|json|csv))`/g))
      REFD.add([m[1], path.relative(ROOT, p)].join('|'));
  });
  walk(dir);
}
for (const r of REFD) {
  const [target, from] = r.split('|');
  // {번호}·… 같은 자리표시자는 참조가 아니다. 실행 시에 채워진다
  if (/[{}…]/.test(target)) continue;
  if (!fs.existsSync(path.join(ROOT, target))) err(`없는 파일을 참조한다: ${target}  ← ${from}`);
}
if (REFD.size) ok.push(`패키지 참조 ${REFD.size}건 검사 (brand·outputs·logs 는 실행 중 생기므로 제외)`);

// ⑥-b 스킬 이름 참조 대조 · 개명하면 여기서 죽는다
//   ⑥ 은 백틱 안이 docs/ · 100-skills/ … 로 시작할 때만 본다. 스킬 「이름」은 검사 대상이 아니었다.
{
  const real = fs.existsSync(sdir)
    ? fs.readdirSync(sdir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name) : [];
  const looksLikeSkill = tok => /^[0-9]-|보기$|하기$|^마케팅-/.test(tok) && !tok.includes('/') && !tok.includes('.');
  let bad = 0;
  const files = [];
  for (const dir of [adir, sdir, path.join(ROOT, 'docs')]) {
    if (!fs.existsSync(dir)) continue;
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (e.name.endsWith('.md')) files.push(p);
    });
    walk(dir);
  }
  for (const p of files) {
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/`([^`\s\/]{2,30})`/g)) {
      const tok = m[1];
      if (!looksLikeSkill(tok)) continue;
      if (real.includes(tok)) continue;
      err(`없는 스킬 이름을 가리킨다: \`${tok}\`  ← ${path.relative(ROOT, p)}`);
      bad++;
    }
  }
  if (!bad && real.length) ok.push(`스킬 이름 참조 대조 (${real.join(' · ')})`);
}

// ⑥-c 유령 담당 · AI 마케터 파일뿐 아니라 skills/ · docs/ 전체를 본다
//   실제로 마케팅팀-업무리스트 가 없는 담당을 부르고 있었다 (2026-08-22 발견)
{
  let bad = 0;
  const files = [];
  for (const dir of [sdir, path.join(ROOT, 'docs'), adir]) {
    if (!fs.existsSync(dir)) continue;
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (e.name.endsWith('.md')) files.push(p);
    });
    walk(dir);
  }
  for (const p of files) {
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/`(lead-[a-z-]+|staff-[a-z-]+|marketing-director)`/g))
      if (!agents.includes(m[1])) { err(`없는 담당을 부른다: ${m[1]}  ← ${path.relative(ROOT, p)}`); bad++; }
  }
  if (!bad) ok.push('유령 담당 없음 (skills · docs · agents 전역)');
}

// ⑥-d 버전이 두 곳에 있다 · 한쪽만 올리면 코워크가 「새것 없음」으로 판정한다
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  if (repoRoot) {
    const pv = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
    const mv = JSON.parse(fs.readFileSync(path.join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'))
      ?.plugins?.[0]?.version;
    if (pv !== mv) err(`버전 불일치 · plugin.json ${pv} vs marketplace.json ${mv} — 한쪽만 올리면 업데이트가 안 뜬다`);
    else ok.push(`버전 두 곳 일치 (${pv})`);
  }
}

// ⑥-e 100-skills 내부 참조 · 여기가 통째로 사각지대였다
//   ⑥ 은 agents/ · skills/ 만 훑는다. 그래서 TEAM.md · data/connections.md ·
//   mcp-setup/ 같은 없는 문서를 22곳이 가리키는 걸 못 봤다 (2026-08-22 외부 검토에서 발견).
{
  const M2 = path.join(ROOT, '100-skills');
  let bad = 0, seen = 0;
  if (fs.existsSync(M2)) {
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (!e.name.endsWith('.md')) return;
      const t = fs.readFileSync(p, 'utf8');
      // 백틱 안의 패키지 상대경로만 본다 (자리표시자·URL 제외)
      for (const m of t.matchAll(/`((?:docs|100-skills|gates|sample-data|brand-templates|scripts|data|mcp-setup)\/[^`\s)]+?\.(?:md|csv|json|mjs|html))`/g)) {
        const tgt = m[1];
        if (/[{}…*]/.test(tgt)) continue;
        seen++;
        const cands = [path.join(ROOT, tgt), path.join(M2, tgt)];
        if (!cands.some(c => fs.existsSync(c))) { err(`100-skills 가 없는 파일을 참조한다: ${tgt}  ← ${path.relative(ROOT, p)}`); bad++; }
      }
      // TEAM.md 처럼 백틱 없이 쓰인 죽은 문서
      for (const dead of ['TEAM.md', 'data/connections.md', 'mcp-setup/'])
        if (t.includes(dead)) { err(`100-skills 에 죽은 참조 「${dead}」  ← ${path.relative(ROOT, p)}`); bad++; }
    });
    walk(M2);
  }
  if (!bad) ok.push(`100-skills 내부 참조 ${seen}건 검사`);
}

// ⑥-f gate:true 스킬의 실습 예시에 판정 블록이 있나
//   053 이 gate:true 인데 예시에 AI 규제검토자 판정이 없었다 (2026-08-22 발견)
{
  let bad = 0, n = 0;
  for (const p of fs.existsSync(path.join(ROOT, '100-skills')) ?
       fs.readdirSync(path.join(ROOT, '100-skills'), { withFileTypes: true })
         .filter(e => e.isDirectory() && /^\d\d-/.test(e.name))
         .flatMap(c => {
           const sd = path.join(ROOT, '100-skills', c.name, 'skills');
           return fs.existsSync(sd) ? fs.readdirSync(sd).map(x => path.join(sd, x)) : [];
         }) : []) {
    const sk = path.join(p, 'SKILL.md');
    if (!fs.existsSync(sk)) continue;
    if (!/^gate:\s*true/m.test(fs.readFileSync(sk, 'utf8'))) continue;
    n++;
    const ex = path.join(p, 'example', 'output.md');
    if (!fs.existsSync(ex)) continue;
    const t = fs.readFileSync(ex, 'utf8');
    if (!/🛡|AI 규제검토자\(규제\)|규제 검사|게이트 판정|컴플라이언스 게이트/.test(t)) {
      err(`gate:true 인데 실습 예시에 판정 블록이 없다: ${path.basename(p)}`); bad++;
    }
  }
  if (!bad && n) ok.push(`gate:true ${n}개 · 실습 예시에 판정 블록 있음`);
}

// ⑥-g 구축 스킬의 점검표 숫자가 실물과 맞나
//   「skills/ 4개 전부」가 3개인 상태로 남아 온보딩 점검이 항상 실패 판정을 냈다
{
  const p = path.join(sdir, '마케팅팀-구축하기', 'SKILL.md');
  if (fs.existsSync(p)) {
    const t = fs.readFileSync(p, 'utf8');
    const nSkills = fs.readdirSync(sdir, { withFileTypes: true }).filter(e => e.isDirectory()).length;
    const nAgents = fs.readdirSync(adir).filter(f => f.endsWith('.md')).length;
    const m = t.match(/`skills\/` 폴더마다 `SKILL\.md` \| \*\*(\d+)\*\*/);
    if (m && Number(m[1]) !== nSkills) err(`구축 스킬 점검표의 스킬 수 ${m[1]} ≠ 실제 ${nSkills}`);
    const a2 = t.match(/`agents\/` 의 `\.md` 개수 \| \*\*(\d+)\*\*/);
    if (a2 && Number(a2[1]) !== nAgents) err(`구축 스킬 점검표의 담당 수 ${a2[1]} ≠ 실제 ${nAgents}`);
    if (m || a2) ok.push(`구축 스킬 점검표 숫자 = 실물 (스킬 ${nSkills} · 담당 ${nAgents})`);
  }
}

// ⑥-g1 버전 · 배포되는 파일이 바뀌었는데 버전이 그대로면 기존 사용자에게 안 간다
//   왜: 2026-08-23 · plugins/ 안에서 12개 파일 +930줄을 고쳐 놓고 0.14.0 을 그대로 뒀다.
//       코워크는 버전으로 「새것이 있나」를 판정한다. 그대로면 이미 깐 사람은 업데이트를 못 받는다.
//       윈도우 CRLF 수정도 라우팅 개선도 안 갔을 뻔했다.
//   검사: 마지막 버전 변경 커밋 이후에 plugins/ 가 바뀌었나 (저장소 안에서만 · git 이 있을 때만)
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  const git = (a) => spawnSync('git', a, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  if (repoRoot && fs.existsSync(path.join(repoRoot, '.git')) && git(['rev-parse', '--git-dir']).status === 0) {
    const ver = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).version;
    // 지금 버전 문자열이 처음 들어온 커밋
    const bump = git(['log', '-S', `"${ver}"`, '--reverse', '--format=%H', '--',
                      'plugins/marketing-team/.claude-plugin/plugin.json']).stdout?.trim().split('\n')[0];
    if (!bump) {
      notes.push(`버전 ${ver} · 아직 커밋되지 않았다 (올리는 중이면 정상)`);
    } else {
      const after = git(['diff', '--name-only', `${bump}..HEAD`, '--', 'plugins/']).stdout?.trim();
      const dirty = git(['status', '--porcelain', '--', 'plugins/']).stdout?.trim();
      const n = [after, dirty].filter(Boolean).join('\n').split('\n').filter(Boolean).length;
      // ⚠️ 여기서 막는 자리를 틀리면 아무 일도 못 한다 (2026-08-23 · 실제로 그랬다).
      //    버전은 **릴리스 때** 올리는 것이지 커밋마다 올리는 게 아니다.
      //    그래서 개발 중(로컬)에는 알려만 주고, CI 에서만 막는다 — 거기가 나가는 자리다.
      if (n) {
        const m = `버전이 ${ver} 인 채로 배포 파일 ${n}개가 바뀌었다 — 이대로 나가면 코워크가 ` +
                  '「새것 없음」으로 판정해 기존 사용자에게 안 간다';
        if (process.env.CI) err(m + '. plugin.json 과 marketplace.json 을 함께 올려라');
        else warn(m + '. **릴리스 전에** 두 곳을 함께 올려라 (지금 커밋은 막지 않는다)');
      } else ok.push(`버전 ${ver} · 그 뒤로 배포 파일 변경 없음`);
    }
  }
}

// ⑥-g2 줄바꿈 · 윈도우에서 클론하면 CRLF 로 오고, 그러면 frontmatter 를 아무도 못 읽는다
//   스크립트는 읽을 때 눕혀서 견디지만(각 스크립트 머리의 _readFileSync), 그건 우리 코드만이다.
//   작업본 자체가 CRLF 인 것은 알려 준다 — 안 보이는 상태로 두면 나중에 원인을 못 찾는다.
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  if (repoRoot && !fs.existsSync(path.join(repoRoot, '.gitattributes')))
    err('.gitattributes 가 없다 — 윈도우에서 클론하면 .md 가 CRLF 로 바뀌어 frontmatter 파서가 전부 실패한다 ' +
        '(실측 2026-08-23 · verify 🔴 128건). `* text=auto eol=lf` 한 줄이면 막힌다');

  let crlf = 0, seen = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) {
        seen++;
        // 읽는 즉시 눕히는 패치를 우회해야 원본 줄바꿈이 보인다
        if (fs.readFileSync(p).includes('\r\n')) crlf++;
      }
    }
  };
  walk(path.join(ROOT, '100-skills'));
  walk(path.join(ROOT, 'skills'));
  walk(path.join(ROOT, 'docs'));
  if (crlf) warn(`.md ${crlf}/${seen}개가 CRLF 다 — 작업본이 윈도우 줄바꿈이다. ` +
                 '스크립트는 견디지만 되돌리길 권한다: `git config core.autocrlf input` 뒤 다시 클론');
  else ok.push(`줄바꿈 LF (.md ${seen}개)`);
}

// ⑥-h LICENSE · 매니페스트가 MIT 라면 파일이 있어야 한다
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  const lic = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/plugin.json'), 'utf8')).license;
  if (lic && repoRoot && !fs.existsSync(path.join(repoRoot, 'LICENSE')))
    err(`plugin.json 이 ${lic} 인데 저장소에 LICENSE 파일이 없다`);
  else if (lic) ok.push(`LICENSE (${lic})`);
}

// ⑥-i 생성 수치가 문서와 **같은 값인가**
//   마커 존재만 보던 판은 README 의 「스킬 100」을 「스킬 999」로 바꿔도 통과했다
//   (2026-08-22 · 코덱스가 실제로 뚫어 보고 지적). build-stats 를 직접 돌려 비교한다.
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  const gen = path.join(ROOT, 'scripts', 'build-stats.mjs');
  if (!fs.existsSync(gen)) warn('scripts/build-stats.mjs 없음 — 수치 드리프트를 못 잡는다');
  else {
    const r = spawnSync(process.execPath, [gen, '--check'], { encoding: 'utf8' });
    if (r.status !== 0) {
      err('생성 수치가 문서와 다르다 — `node scripts/build-stats.mjs`');
      for (const l of (r.stdout || '').split('\n').filter(x => x.includes('어긋남'))) err(`  ${l.trim()}`);
    } else ok.push('생성 수치 일치 (build-stats --check)');
  }
  const targets = [path.join(ROOT, 'docs', '공통규약.md')];
  if (repoRoot) targets.push(path.join(repoRoot, 'README.md'));
  for (const t of targets)
    if (fs.existsSync(t) && !fs.readFileSync(t, 'utf8').includes('<!-- STATS:START -->'))
      err(`${path.basename(t)} 에 STATS 블록이 없다 — 숫자가 손으로 적히면 어긋난다`);
}

// ⑥-i3 원장 임계값이 기계와 문서에서 같은 값인가
//   800행·90일을 ledger-stats.mjs 가 세는데 규약·구축 스킬에도 손으로 적혀 있다.
//   한쪽만 고치면 「기계는 안 걸렸는데 문서는 걸렸다고 한다」가 된다 — 숫자가 갈리는 고전적 자리다.
{
  const gen = path.join(ROOT, 'scripts', 'ledger-stats.mjs');
  if (!fs.existsSync(gen)) warn('scripts/ledger-stats.mjs 없음 — 원장 부피·진단을 사람이 세게 된다');
  else {
    const src = fs.readFileSync(gen, 'utf8');
    const konst = (k) => (src.match(new RegExp(`^const ${k} = (\\d+)`, 'm')) || [])[1];
    const 임계 = { ROLLOVER_ROWS: konst('ROLLOVER_ROWS'), STALE_DAYS: konst('STALE_DAYS') };
    if (!임계.ROLLOVER_ROWS || !임계.STALE_DAYS) err('ledger-stats.mjs 에서 임계 상수를 못 읽었다 — 이름이 바뀌었나');
    else {
      //   ⚠️ 원장 세부(스키마·롤오버·진단)는 v0.45.0 에 docs/원장-운영.md 로 갈라졌다.
      //   임계 숫자의 정본은 이제 그쪽이다 — 규약에는 한 줄 포인터만 남았다.
      const 문서 = [
        [path.join(ROOT, 'docs', '원장-운영.md'), '원장-운영.md'],
        [path.join(ROOT, 'skills', '마케팅팀-구축하기', 'SKILL.md'), '마케팅팀-구축하기'],
      ];
      let drift = 0;
      for (const [p, name] of 문서) {
        if (!fs.existsSync(p)) continue;
        const t = fs.readFileSync(p, 'utf8');
        // 「800행」·「90일」이 그대로 적혀 있어야 한다 (천단위 쉼표 표기도 허용)
        const rows = new RegExp(`${Number(임계.ROLLOVER_ROWS).toLocaleString('en-US')}행|${임계.ROLLOVER_ROWS}행`);
        if (!rows.test(t)) { err(`${name} 의 롤오버 임계가 기계와 다르다 — ledger-stats.mjs 는 ${임계.ROLLOVER_ROWS}행`); drift++; }
        if (!new RegExp(`${임계.STALE_DAYS}일`).test(t)) { err(`${name} 의 무호출 임계가 기계와 다르다 — ledger-stats.mjs 는 ${임계.STALE_DAYS}일`); drift++; }
      }
      const r = spawnSync(process.execPath, [gen, '--dir', ROOT], { encoding: 'utf8' });
      if (r.status !== 0) err(`ledger-stats.mjs 가 돌지 않는다 — ${(r.stderr || '').split('\n')[0]}`);
      else if (!drift) ok.push(`원장 임계 일치 (롤오버 ${임계.ROLLOVER_ROWS}행 · 무호출 ${임계.STALE_DAYS}일)`);
    }
  }
}

// ⑥-i4 자동 점검 훅이 실제로 도나
//   훅은 깨져도 조용하다 — 세션마다 아무 일도 안 일어나는데 아무도 모른다. 여기서 실제로 돌려 본다.
{
  const hp = path.join(ROOT, 'hooks', 'hooks.json');
  if (!fs.existsSync(hp)) warn('hooks/hooks.json 없음 — 원장 자동 점검이 배포되지 않는다');
  else {
    let h; try { h = JSON.parse(fs.readFileSync(hp, 'utf8')); } catch (e) { err(`hooks/hooks.json 파싱 실패: ${e.message}`); }
    if (h) {
      const cmds = (h.hooks?.SessionStart || []).flatMap(g => (g.hooks || []).map(x => x.command || ''));
      if (!cmds.length) err('hooks.json 에 SessionStart 훅이 없다 — 자동 점검이 돌지 않는다');
      else {
        // 훅이 가리키는 스크립트가 실재하나 (${CLAUDE_PLUGIN_ROOT} 는 설치 시 플러그인 루트로 치환된다)
        let broken = 0;
        for (const c of cmds)
          for (const m of c.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s"']+)/g))
            if (!fs.existsSync(path.join(ROOT, m[1]))) { err(`훅이 없는 파일을 부른다: ${m[1]}`); broken++; }
        // 가리키는 파일이 없으면 돌려 볼 것도 없다
        if (!broken) {
          // --hook 모드가 조용한가 · 뭔가 낸다면 그것이 올바른 JSON 인가
          const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ledger-stats.mjs'), '--hook', '--dir', ROOT], { encoding: 'utf8' });
          const out = (r.stdout || '').trim();
          if (r.status !== 0) err(`훅 모드가 실패한다 (종료 ${r.status}) — 세션마다 조용히 죽는다`);
          else if (out) {
            try {
              const j = JSON.parse(out);
              if (j.hookSpecificOutput?.hookEventName !== 'SessionStart') err('훅 출력의 hookEventName 이 SessionStart 가 아니다');
              else ok.push('원장 자동 점검 훅 (SessionStart · 출력 JSON 유효)');
            } catch { err('훅이 JSON 이 아닌 것을 뱉는다 — 훅 출력은 파싱된다'); }
          } else ok.push('원장 자동 점검 훅 (SessionStart · 이상 없으면 조용함 확인)');
        }
      }
    }
  }
}

// ⑥-i4-b G2 실행 보호 훅이 승인 전 쓰기·셸·추가 스킬을 실제로 막나
{
  const hp = path.join(ROOT, 'hooks', 'hooks.json');
  const guard = path.join(ROOT, 'scripts', 'runtime-guard.mjs');
  const test = path.join(ROOT, 'scripts', 'test-runtime-guard.mjs');
  const missing = [guard, test].filter(file => !fs.existsSync(file));
  if (missing.length) err(`실행 보호 훅 파일이 없다: ${missing.map(file => path.basename(file)).join(' · ')}`);
  else {
    let hook;
    try { hook = JSON.parse(fs.readFileSync(hp, 'utf8')); }
    catch { hook = null; }
    const groups = hook?.hooks?.PreToolUse || [];
    const matchers = groups.map(group => group.matcher || '').join('|');
    const commands = groups.flatMap(group => (group.hooks || []).map(item => item.command || '')).join('\n');
    for (const tool of ['Bash', 'Write', 'Edit', 'Agent', 'Skill'])
      if (!matchers.includes(tool)) err(`PreToolUse 실행 보호 대상에 ${tool}이 없다`);
    if (!commands.includes('runtime-guard.mjs')) err('PreToolUse가 runtime-guard.mjs를 부르지 않는다');
    else {
      try {
        execFileSync(process.execPath, [test], { cwd: ROOT, stdio: 'pipe' });
        ok.push('G2 실행 보호 훅 (승인 · 경로 · 계획 밖 스킬 · 설치본 탐색 차단)');
      } catch (error) {
        const detail = String(error.stderr || error.stdout || error.message).trim().split('\n').at(-1);
        err(`G2 실행 보호 훅 실제 검사가 실패했다${detail ? ` · ${detail}` : ''}`);
      }
    }
  }
}

// ⑥-i5 영문 C레벨 약어가 다시 새지 않았나
//   0.17.0 에서 우리말로 바꿨는데 5관점 목록만 고치고 개별 언급 17곳을 놓쳤다 (실측 2026-08-25).
//   ⚠️ CFO 는 실제 업계 직함으로도 쓰인다 — persona 줄은 우리 팀 C레벨이 아니므로 예외다.
{
  const 약어 = ['CMO', 'CCO', 'CSO', 'CEO', 'CFO', 'CLO', 'CBO'];
  const hits = [];
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    if (e.name.startsWith('.') || e.name === 'node_modules') return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (!/\.(md|mjs|json|html)$/.test(e.name)) return;
    if (e.name === 'verify.mjs') return;                        // 검사 자신 — 여기 없으면 검사가 성립 안 한다
    if (/ \d+\.\w+$/.test(e.name)) return;                      // iCloud 충돌 사본 (`… 2.mjs`) — 아래 ⑥-i6 이 따로 잡는다
    if (d.endsWith('실제확인-기록')) return;                    // 지난 실측 기록 — **과거를 고쳐 쓰지 않는다**
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*persona:/.test(line)) return;                    // 업계 직함 — 우리 조직도가 아니다
      for (const a of 약어)
        if (new RegExp(`\\b${a}\\b`).test(line))
          hits.push(`${path.relative(ROOT, p)}:${i + 1} ${a}`);
    });
  });
  for (const sub of ['agents', 'skills', 'docs', '100-skills', 'brand-templates', 'scripts', 'hooks']) walk(path.join(ROOT, sub));
  if (hits.length) {
    err(`영문 C레벨 약어가 ${hits.length}곳 남았다 — 우리말 직함으로 바꿔라 (AI 마케터 · AI 규제검토자 · AI 사업검토자 · 경영/재무/고객/법무/브랜드)`);
    for (const h of hits.slice(0, 5)) err(`  ${h}`);
  } else ok.push('영문 C레벨 약어 0곳 (persona 의 업계 직함은 예외)');
}

// ⑥-i18 100개를 그냥 던지지 않나 · 「내 것이 뭔지」에 답하나
//   실측 2026-08-27 · 업무리스트는 100개를 업태와 무관하게 똑같이 편다.
//   B2B SaaS 마케터에게 「051~060 커머스」는 자기 것이 아닌데 그걸 말해 주지 않는다.
//   온보딩 첫 결과물도 업태 불문 001 이었다 — B2B 마케터에겐 「내 일이 아니네」로 읽힌다.
//   ⛔ 다만 **접거나 지우지 않는다.** 업태를 잘못 읽었을 수 있고, 근거 없이 접으면 틀린 걸 접는다.
{
  const L = fs.readFileSync(path.join(ROOT, 'skills', '마케팅팀-업무리스트', 'SKILL.md'), 'utf8');
  const B = fs.readFileSync(path.join(ROOT, 'skills', '마케팅팀-구축하기', 'SKILL.md'), 'utf8');
  const 빠짐 = [];
  if (!L.includes('100개를 그냥 던지지 않는다'))
    빠짐.push('업무리스트가 100개를 업태 무관하게 편다 — 「내 것이 뭔지」에 답을 못 한다');
  if (!L.includes('접거나 지우지 않는다'))
    빠짐.push('업무리스트에 「접지 않는다」가 없다 — 잘못 읽은 업태로 스킬을 숨기게 된다');
  if (!L.includes('프로필이 비어 있으면 순서를 바꾸지 않는다'))
    빠짐.push('프로필이 비었을 때 규칙이 없다 — 근거 없이 접는다');
  if (!B.includes('업태 불문 `001` 로 보내지 않는다'))
    빠짐.push('온보딩 첫 결과물이 업태를 안 탄다 — B2B 마케터에게 키워드 리서치가 첫 결과물이 된다');
  if (빠짐.length) {
    err(`업태별 안내 배선이 끊겼다 ${빠짐.length}건 — 프로필을 넣어도 「뭘 쓸지」를 모른다`);
    for (const x of 빠짐) err(`  ${x}`);
  } else ok.push('업태별 안내 (목록 순서 · 접지 않음 · 첫 결과물)');
}

// ⑥-i19 샘플 업종으로 규제를 걸지 않나 · 그리고 중간 경로가 있나
//   ⛔ 실측 2026-08-27 · **규약과 게이트가 정면으로 어긋나 있었다.**
//   규약 §0-b 「샘플 모드에서도 A브랜드의 업종·금기어를 그대로 쓴다」
//   게이트 절차1 「⛔ 업종이 비어 있으면 샘플 업종으로 대신 판정하지 않는다」
//   게이트가 맞다 — 샘플은 화장품이라 사료·주류 브랜드에 걸면 **틀린 안전감**을 준다.
//   통과했다고 믿고 발행하게 되므로, 안 거는 것보다 나쁘다.
//   ⚠️ 그리고 탈출구가 「3분 온보딩」 하나뿐이었다. 대부분 안 한다 —
//   **업종 한 줄**이면 규제 사전이 제 것으로 갈린다. 그 중간이 필요하다.
{
  const G = fs.readFileSync(path.join(ROOT, 'docs', '공통규약.md'), 'utf8');
  const R = fs.readFileSync(path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'utf8');
  const C = fs.readFileSync(path.join(ROOT, '100-skills', 'gates', 'compliance-gate.md'), 'utf8');
  const 빠짐 = [];

  // 셋이 같은 말을 하나 — 규제는 샘플 업종으로 걸지 않는다
  for (const [f, t, 이름] of [[G, '규제는 A브랜드 업종으로 걸지 않는다', '규약 §0-b'],
                              [R, '규제만은 A브랜드 업종으로 걸지 않는다', '런타임 §0']])
    if (!f.includes(t)) 빠짐.push(`${이름} 에 「샘플 업종으로 규제를 걸지 않는다」가 없다 — 사료 브랜드가 화장품법으로 검사받는다`);
  if (!C.includes('샘플 업종으로 대신 판정하지 않는다'))
    빠짐.push('게이트 절차1 에서 그 금지가 사라졌다');

  // 중간 경로 — 업종 한 줄
  if (!R.includes('업종만 알려주셔도'))
    빠짐.push('샘플 모드 끝맺음에 「업종 한 줄」 경로가 없다 — 탈출구가 3분 온보딩뿐이면 대부분 안 한다');
  if (!G.includes('업종만 말했음'))
    빠짐.push('규약 §0-b 에 「업종만 말했음」 모드가 없다');
  //   사용자가 고른 셋 — ①샘플로 실습 ②우리 회사 정보 ③회사 정보 없이 스킬만.
  //   ⛔ ③ 은 **고를 때만** 들어간다. 프로필이 없다고 여기로 오면 결과가 텅 빈다.
  const B2 = fs.readFileSync(path.join(ROOT, 'skills', '마케팅팀-구축하기', 'SKILL.md'), 'utf8');
  if (!B2.includes('③ 회사 정보 없이 스킬만 사용한다'))
    빠짐.push('온보딩에 3지선다가 없다 — 브랜드 없이 쓸 길을 사용자가 못 고른다');
  for (const [f, 이름] of [[G, '규약 §0-b'], [R, '런타임 §0']])
    if (!f.includes('`[틀]`')) 빠짐.push(`${이름} 에 [틀] 모드가 없다`);
  if (!G.includes('사용자가 **명시적으로 고를 때만**'))
    빠짐.push('[틀] 이 「고를 때만」이라는 제한이 없다 — 프로필 없는 사람이 전부 여기로 떨어진다');
  if (!G.includes('「채우면 살아나는 것」 표를 반드시 붙인다'))
    빠짐.push('[틀] 에 되돌아오는 문이 없다 — 절차만 받고 끝난다');
  //   실측 · [틀] 에서 쓸모가 3단으로 갈린다 (틀 27 · 분석 28 · 생성 24).
  //   생성 스킬은 문장이 안 나오는데, 만들고 나서 말하면 늦다. G2 에서 먼저 말해야 한다.
  if (!G.includes('스킬마다 남는 것이 다르다'))
    빠짐.push('[틀] 의 3단 차이가 규약에 없다 — 카피를 기다린 사람이 틀만 받는다');
  //   ⛔ 빈 틀을 먼저 내미는 것은 「없어서 못 합니다」의 다른 모양이다.
  //   카피를 기다린 사람에게 빈칸 표를 주면 준 쪽은 일했다고 생각하고 받은 쪽은 아무것도 못 얻는다.
  //   무엇을 요청할지는 스킬의 `inputs:` 에서 brand/ 파일을 뺀 것 — 실측 · 생성 24개 전부 나온다.
  if (!G.includes('틀을 던지지 않는다. 재료를 먼저 요청한다'))
    빠짐.push('생성 스킬이 빈 틀부터 던진다 — 재료를 먼저 요청해야 한다 (§0-c D3)');
  if (!G.includes('`inputs:` 에서 `brand/` 파일만 빼면'))
    빠짐.push('무엇을 요청할지의 근거가 없다 — 24개를 따로 적게 되고 곧 어긋난다');
  if (!R.includes('재료를 먼저 요청한다'))
    빠짐.push('런타임이 생성 스킬에서 재료를 먼저 요청하지 않는다');
  //   ⛔ 안전 · [틀] 이라고 게이트를 건너뛰면 안 된다. 「브랜드 정보를 안 넣었으니
  //   검사도 없다」는 이 제품에 없다. 공통(표시광고법)은 그대로 걸리고,
  //   못 잡는 것(업종별 금지어·우리 금기)을 판정 블록에 적는다.
  if (!G.includes('`[틀]` 이라고 게이트를 건너뛰지 않는다'))
    빠짐.push('[틀] 에서 게이트가 도는지가 명시되지 않았다 — 검사 없이 발행될 수 있다');
  if (!G.includes('못 잡은 것을 판정 블록에 반드시 적는다'))
    빠짐.push('[틀] 에서 못 잡은 것을 안 적는다 — 통과했다고 믿고 발행하게 된다');
  if (!B2.includes('재료를 그때그때 확인'))
    빠짐.push('온보딩 ③번이 재료 요청 경로를 안 밝힌다 — 글쓰기 스킬이 죽은 것처럼 읽힌다 (사용자 확정 문안 2026-08-31)');
  if (!B2.includes('②와 같은 결과'))
    빠짐.push('온보딩 ③번이 ②와의 동등성을 안 밝힌다 (사용자 확정 문안 2026-08-31)');
  if (!R.includes('빠른 진입 · 저위험 단일 업무'))
    빠짐.push('빠른 진입 계약이 런타임에 없다 (개선 플랜 §13 · 2026-08-31)');
  if (!fs.existsSync(path.join(ROOT, 'scripts', 'test-first-run-ux.mjs')))
    빠짐.push('빠른 진입 회귀 테스트가 없다 (scripts/test-first-run-ux.mjs)');
  if (!fs.existsSync(path.join(ROOT, 'scripts', '_픽스처', 'run-v1', 'advanced-run.json')))
    빠짐.push('run/v1 회귀 픽스처가 없다 (개선 플랜 Phase 0)');
  if (!fs.existsSync(path.join(ROOT, 'scripts', 'recall.mjs')) || !R.includes('recall.mjs'))
    빠짐.push('회상 색인이 없거나 G1 되짚기에 배선되지 않았다 (gbrain 구조 참고 · 2026-08-31)');
  if (!G.includes('재료를 받았으면 죽은 틀이 아니다'))
    빠짐.push('[틀] 모드에서 재료를 받아도 문장을 안 쓴다 — 요청만 하고 살리지 않는다 (사용자 지시 2026-08-30)');

  if (빠짐.length) {
    err(`샘플 업종·중간 경로 배선이 끊겼다 ${빠짐.length}건`);
    for (const x of 빠짐) err(`  ${x}`);
  } else ok.push('샘플 업종 (규제는 안 건다 · 업종 한 줄 중간 경로)');
}

// ⑥-i20 큰 입력을 통째로 읽지 않나 · 그리고 그 규칙이 실제로 필요한가
//   실측 2026-08-28 · sample-data/A브랜드-고객마스터.csv = 3,507행 · **약 11만 토큰**.
//   이 파일을 쓰는 스킬이 5개다 (064·065·076·077·079). 실사용 고객이 3만이면 열 배다.
//   규약은 **원장**에만 「통째로 읽지 않는다」를 정했고 **입력 데이터에는 규칙이 없었다.**
//   ⛔ 서브에이전트로 돌려도 그 안에서 통째로 읽으면 똑같다 — 격리는 해결이 아니다.
{
  const G = fs.readFileSync(path.join(ROOT, 'docs', '공통규약.md'), 'utf8');
  const R = fs.readFileSync(path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'utf8');
  const 빠짐 = [];
  if (!G.includes('큰 입력은 통째로 읽지 않는다'))
    빠짐.push('규약에 큰 입력 규칙이 없다 — 고객마스터 한 장이 11만 토큰이다');
  if (!G.includes('읽지 말고 집계한다'))
    빠짐.push('「읽지 말고 센다」가 없다 — 눈으로 세면 안 센다');
  if (!R.includes('큰 입력은 통째로 읽지 않는다'))
    빠짐.push('런타임에 큰 입력 규칙이 없다');

  // 규칙이 필요한 근거가 실재하나 — 샘플이 작아졌으면 규칙도 재검토 대상이다
  const SD = path.join(ROOT, 'sample-data');
  if (fs.existsSync(SD)) {
    const 큰 = fs.readdirSync(SD).filter(f => {
      try { return fs.statSync(path.join(SD, f)).size > 100 * 1024; } catch { return false; }
    });
    if (!큰.length) 빠짐.push('100KB 넘는 샘플이 사라졌다 — 규칙의 근거가 바뀌었으니 다시 재라');
  }
  if (빠짐.length) {
    err(`큰 입력 배선이 끊겼다 ${빠짐.length}건 — 컨텍스트가 통째로 먹힌다`);
    for (const x of 빠짐) err(`  ${x}`);
  } else ok.push('큰 입력 (통째로 안 읽음 · 스크립트 집계 · 근거 실재)');
}

// ⑥-i21 갈라진 절이 실제로 이어져 있나 (gstack Section index 패턴)
//   ⛔ 쪼개면 **「문서엔 있는데 안 읽는다」**가 하나 더 생긴다 — 오늘만 여섯 번 겪었다.
//   그래서 셋을 함께 잰다 — ① 색인이 있나 ② 대상 파일이 실재하나 ③ 절이 다 들어갔나.
//   참고 · gstack(garrytan/gstack) 이 20개 명령에서 쓰는 방식이고,
//   핵심 문장은 「Read a section in full before doing its step; do not work from memory」다.
{
  const R = fs.readFileSync(path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'utf8');
  const F = path.join(ROOT, 'docs', 'G3-분기절차.md');
  const 빠짐 = [];

  if (!R.includes('갈라진 절 · **조건이 걸렸을 때만 읽는다**'))
    빠짐.push('런타임에 Section index 가 없다 — 갈라진 절로 가는 길이 끊긴다');
  if (!R.includes('기억으로 하지 않는다'))
    빠짐.push('「기억으로 하지 않는다」가 없다 — 쪼갠 절은 안 읽으면 통째로 빠진다');
  if (!fs.existsSync(F)) 빠짐.push('docs/G3-분기절차.md 가 없다');
  else {
    const G3 = fs.readFileSync(F, 'utf8');
    for (const 절 of ['물어서 좁힌다', '스킬 밖이면', '회수'])
      if (!G3.includes(절)) 빠짐.push(`갈라진 파일에 「${절}」 절이 없다`);
    // 색인이 가리키는 경로가 실제 파일과 맞나
    if (!R.includes('docs/G3-분기절차.md')) 빠짐.push('색인이 파일 경로를 안 가리킨다');
  }
  //   ⚠️ 원장 운영(스키마·롤오버·진단 128줄)도 같은 방식으로 갈랐다 (v0.45.0).
  //   매 업무에 필요한 것은 「1행 적는다」뿐이고 나머지는 점검할 때만 쓴다.
  {
    const G2 = fs.readFileSync(path.join(ROOT, 'docs', '공통규약.md'), 'utf8');
    const LF = path.join(ROOT, 'docs', '원장-운영.md');
    if (!fs.existsSync(LF)) 빠짐.push('docs/원장-운영.md 가 없다');
    else for (const 절 of ['스키마', '롤오버', '진단'])
      if (!fs.readFileSync(LF, 'utf8').includes(절)) 빠짐.push(`원장-운영.md 에 「${절}」 절이 없다`);
    if (!G2.includes('docs/원장-운영.md')) 빠짐.push('규약이 원장-운영.md 를 안 가리킨다 — 갈라진 절이 고아가 된다');
    if (!G2.includes('업무 한 건 = 원장 한 행')) 빠짐.push('규약에서 매 업무 규칙(1행)까지 사라졌다 — 이건 남아야 한다');
  }
  // ⛔ 규제 게이트는 내리지 않는다 — 안 읽히면 발행물이 검사 없이 나간다
  if (!/### 규제 게이트/.test(R))
    빠짐.push('규제 게이트가 본체에서 사라졌다 — 조건부로 내리면 검사 없이 발행된다');

  if (빠짐.length) {
    err(`갈라진 절 배선이 끊겼다 ${빠짐.length}건`);
    for (const x of 빠짐) err(`  ${x}`);
  } else ok.push('갈라진 절 (색인 · 기억금지 · 3절 실재 · 게이트는 본체)');
}

// ⑥-i22 PLUGIN.md 의 스킬명이 SKILL.md 와 같나
//   실측 2026-08-28 · 024 를 「YouTube 스크립트」로 바꿨는데(v0.28.0)
//   03-content/PLUGIN.md 는 「YouTube 스크립트 (성과 증명형)」 옛 이름 그대로였다.
//   052 도 PLUGIN 은 「상세페이지 → Figma 자동화」, SKILL 은 「상세페이지 디자인 시안」이었다.
//   ⚠️ ROUTING.md 는 자동 생성이라 항상 맞는데 **PLUGIN.md 는 손으로 쓴다.**
//   이름을 바꿀 때 여기를 같이 안 고치면 카테고리 안내가 조용히 옛것을 말한다.
{
  const 어긋남 = [];
  const cats = fs.existsSync(path.join(ROOT, '100-skills'))
    ? fs.readdirSync(path.join(ROOT, '100-skills'), { withFileTypes: true }).filter(e => e.isDirectory()) : [];
  for (const c of cats) {
    const pf = path.join(ROOT, '100-skills', c.name, 'PLUGIN.md');
    const sd = path.join(ROOT, '100-skills', c.name, 'skills');
    if (!fs.existsSync(pf) || !fs.existsSync(sd)) continue;
    const txt = fs.readFileSync(pf, 'utf8');
    for (const d of fs.readdirSync(sd)) {
      const sf = path.join(sd, d, 'SKILL.md');
      if (!fs.existsSync(sf)) continue;
      const t = fs.readFileSync(sf, 'utf8');
      const id = (t.match(/^id:\s*"?(\d+)/m) || [])[1];
      const nm = (t.match(/^name:\s*(.+)$/m) || [])[1];
      if (!id || !nm) continue;
      const re = new RegExp(`\\|\\s*${id}\\s*\\|\\s*([^|]+?)\\s*\\|`, 'g');
      let m;
      while ((m = re.exec(txt))) {
        const v = m[1].trim();
        if (v && !/^\d+$/.test(v) && v !== nm.trim())
          어긋남.push(`${c.name} ${id} — PLUGIN「${v}」 vs SKILL「${nm.trim()}」`);
      }
    }
  }
  if (어긋남.length) {
    err(`PLUGIN.md 의 스킬명이 SKILL.md 와 다르다 ${어긋남.length}건 — 카테고리 안내가 옛 이름을 말한다`);
    for (const x of 어긋남.slice(0, 6)) err(`  ${x}`);
  } else ok.push('PLUGIN.md = SKILL.md 스킬명 (10 카테고리)');
}

// ⑥-i17 사업검토자를 부르는 것이 **플래그인가 AI 판단인가**
//   실측 2회 · 「판단이 갈리면 부른다」 → 호출 0회. 「주제로 부른다」로 고친 뒤에도 → **또 0회.**
//   2026-08-27 · 012 USP·가치제안(=포지셔닝)을 돌렸는데 안 불렀고 **「미호출」 표기도 없었다.**
//   산출물만 보면 검토를 거친 것처럼 보인다 — 안 부른 것보다 이게 더 나쁘다.
//   규제검토자는 잘 돈다. 차이는 하나 — **`gate: true` 는 플래그고 사업검토자는 판단이었다.**
{
  const 빠짐 = [];
  const R = fs.readFileSync(path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'utf8');
  const G = fs.readFileSync(path.join(ROOT, 'docs', '공통규약.md'), 'utf8');

  // review: 를 단 스킬이 실재하나 · 관점이 §F 다섯 안인가
  const 관점 = ['경영', '재무', '고객', '법무', '브랜드'];
  let n = 0; const 이상 = [];
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const q = path.join(d, e.name);
    if (e.isDirectory()) return walk(q);
    if (e.name !== 'SKILL.md') return;
    const v = (fs.readFileSync(q, 'utf8').match(/^review:\s*(.+)$/m) || [])[1];
    if (!v) return;
    n++;
    for (const k of v.trim().split('·')) if (!관점.includes(k.trim()))
      이상.push(`${path.basename(path.dirname(q))} — 알 수 없는 관점 「${k.trim()}」`);
  });
  walk(path.join(ROOT, '100-skills'));

  if (n === 0) 빠짐.push('review: 를 단 스킬이 0개 — 사업검토자는 다시 호출 0회가 된다');
  else if (n < 10) 빠짐.push(`review: 가 ${n}개뿐 — 가격·예산·우선순위·포지셔닝·계약을 덮지 못한다`);
  빠짐.push(...이상);
  if (!R.includes('`review:` 가 정한다')) 빠짐.push('런타임이 review: 를 읽지 않는다 — 플래그를 달아도 안 부른다');
  if (!R.includes('미호출')) 빠짐.push('못 불렀을 때 표기 규칙이 없다 — 안 부른 것을 안 부른 줄도 모른다');
  if (!G.includes('플래그가 정한다')) 빠짐.push('규약에 「플래그가 정한다」가 없다 — 다시 AI 판단으로 돌아간다');

  if (빠짐.length) {
    err(`사업검토자 호출 배선이 끊겼다 ${빠짐.length}건 — 실측 2회 모두 호출 0이었다`);
    for (const x of 빠짐) err(`  ${x}`);
  } else ok.push(`사업검토자 호출 (review: ${n}개 · 플래그 기반 · 미호출 표기)`);
}

// ⑥-i16 사전에 없는 업종을 공통만으로 끝내지 않나 · 그리고 세팅이 판정을 겸하지 않나
//   실측 2026-08-27 · 정본 사전은 다섯 업종만 덮는다(화장품·건기식·일반식품·의약품·금융).
//   필라테스·학원·병원·법률·부동산은 공통(표시광고법)으로만 걸리는데,
//   이 업종들의 진짜 위험(「치료」·「합격 보장」·「수익 확정」)은 **공통으로 안 잡힌다.**
//   사전을 무한히 늘릴 수 없으니 담당을 둔다 — 다만 ⛔ **만드는 담당이 찍으면 §F 가 무너진다.**
{
  const 빠짐 = [];
  const A = path.join(ROOT, 'agents', 'staff-compliance-setup.md');
  if (!fs.existsSync(A)) 빠짐.push('AI 규제세팅 담당이 없다');
  else {
    const a = fs.readFileSync(A, 'utf8');
    if (!a.includes('법조문 번호를 지어내지 않는다'))
      빠짐.push('담당이 법조문 생성을 금지하지 않는다 — 지어낸 조문은 틀린 안전감을 준다');
    if (!a.includes('⛔ 를 찍지 않는다'))
      빠짐.push('담당이 ⛔ 를 못 찍는다는 선언이 없다 — 만드는 담당이 찍으면 권한 분리가 무너진다');
    if (!a.includes('내가 모르는 것'))
      빠짐.push('담당 산출물에 「내가 모르는 것」 절이 없다 — 얕은 업종을 아는 척하게 된다');
  }
  for (const [f, 문구, 이유] of [
    ['100-skills/compliance.md', '사전에 없는 업종', '사전이 다섯만 덮는다는 사실이 안 적혀 있다'],
    ['100-skills/gates/compliance-gate.md', '우리 업종 규제 세팅해줘', '게이트가 사전 밖 업종에 다음 수를 권하지 않는다'],
    ['skills/마케팅팀-구축하기/SKILL.md', 'staff-compliance-setup', '온보딩이 담당을 부르지 않는다'],
    ['docs/공통규약.md', '만드는 담당과 찍는 담당을 겹치지 않는다', '권한 분리가 규약에 없다'],
    ['brand-templates/compliance-custom.md', '법률 자문이 아니다', '템플릿에 면책이 없다'],
  ]) {
    const q = path.join(ROOT, f);
    if (!fs.existsSync(q)) { 빠짐.push(`${f} 없음`); continue; }
    if (!fs.readFileSync(q, 'utf8').includes(문구)) 빠짐.push(`${f} — ${이유}`);
  }
  if (빠짐.length) {
    err(`규제 세팅 배선이 끊겼다 ${빠짐.length}건 — 사전 밖 업종이 공통만으로 끝난다`);
    for (const n of 빠짐) err(`  ${n}`);
  } else ok.push('규제 세팅 (담당 · 사전 밖 업종 · 권한 분리 · 면책)');
}

// ⑥-i15 우리 맥락 두 층 · 쓰기만 배선하고 읽기를 빠뜨리지 않았나
//   실측 2026-08-27 · 규약은 「원본 → 도메인 금기 → 우리 보완 순으로 겹쳐 읽는다」고
//   적어 두었는데 **skill-notes 를 실제로 읽는 스킬은 051 하나**였다.
//   G5 에 쓰는 배선만 있고 **읽는 배선이 없었다** — 사용자가 「계속 이렇게」라고 해서
//   파일을 만들어도 다음번에 아무도 안 읽는다. 쓰기만 있는 저장소는 죽은 저장소다.
//   ⚠️ 100개 SKILL.md 를 고치는 게 아니라 **런타임(AI-마케터)이 번호를 붙든 직후 읽는다.**
{
  const R = fs.readFileSync(path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'utf8');
  const G = fs.readFileSync(path.join(ROOT, 'docs', '공통규약.md'), 'utf8');
  const 빠짐 = [];

  if (!R.includes('skill-notes/{번호}.md 있나') && !R.includes('brand/skill-notes/{번호}.md` 가 있는지'))
    빠짐.push('런타임이 skill-notes 를 읽지 않는다 — 만들어도 다음번에 아무도 안 본다');
  if (!R.includes('우리 맥락은 **두 층**'))
    빠짐.push('런타임에 두 층 선언이 없다');
  if (!G.includes('다른 스킬에서도 쓰나'))
    빠짐.push('규약에 층 판정 한 문장이 없다 — 무엇이 어디로 갈지 매번 달라진다');
  for (const [문구, 이유] of [
    ['프로필에 스킬별 세부를 적지 않는다', '프로필이 무거워진다 — 100개가 매번 지고 다닌다'],
    ['브랜드 공통을 적지 않는다', 'skill-notes 에 공통을 적으면 나머지 99개가 못 본다'],
  ]) if (!G.includes(문구)) 빠짐.push(`규약에 「${문구}」가 없다 — ${이유}`);

  if (빠짐.length) {
    err(`우리 맥락 두 층 배선이 끊겼다 ${빠짐.length}건`);
    for (const n of 빠짐) err(`  ${n}`);
  } else ok.push('우리 맥락 두 층 (읽기 배선 · 층 판정 · 양방향 금지)');
}

// ⑥-i14 프로필을 대신 써 주는 자리가 살아 있나 · 그리고 사실을 지어내지 않나
//   ⛔ 여기가 사람들이 나가는 자리다. 「고객이 사는 진짜 이유 3개」를 백지에서 쓰라 하면
//   대부분 못 쓴다 — 말로는 아는데 글로 정리해 본 적이 없을 뿐이다.
//   실측 · 온보딩 ③ 이 「모르면 비우고 넘어간다」였다. 규약 §E 「빈칸은 셋 중 최악」과 정면으로 어긋난다.
//   ⚠️ 대신 써 주되 **말만** 쓴다. 숫자·경쟁사 실명·채널을 지어내면 판정이 통째로 뒤집힌다.
{
  const B = fs.readFileSync(path.join(ROOT, 'skills', '마케팅팀-구축하기', 'SKILL.md'), 'utf8');
  const G = fs.readFileSync(path.join(ROOT, 'docs', '공통규약.md'), 'utf8');
  const T = fs.readFileSync(path.join(ROOT, 'brand-templates', 'profile.md'), 'utf8');
  const 빠짐 = [];

  if (!B.includes('③-b')) 빠짐.push('구축 스킬에 ③-b 「대신 써 드립니다」가 없다 — 백지에서 막힌 사람이 나간다');
  //   「얼마나 자세히 써야 하나」가 처음 쓰는 사람이 가장 많이 막히는 곳이다.
  //   묻기만 하고 기준을 안 주면 명사 세 개가 들어오고, 그게 그대로 카피가 된다.
  if (!B.includes('③-a')) 빠짐.push('구축 스킬에 ③-a 「어느 정도로 쓰나」가 없다 — 기준 없이 물으면 일반론이 들어온다');
  if (!B.includes('경쟁사가 그대로 써도')) 빠짐.push('③-a 에 자가 점검 한 줄이 없다');
  //   업종은 규제 사전만 갈아 끼웠고, 정작 **묻는 말과 예시는 전부 이커머스 화장품**이었다.
  //   학원 원장에게 「마진율」을 물으면 답이 안 나온다 — 그건 물건 파는 사람의 언어다.
  //   구조(여섯 묶음)는 업종을 안 타지만 **부르는 말과 예시는 탄다.**
  for (const 업태 of ['로컬·매장', 'B2B·솔루션', '구독·교육'])
    if (!B.includes(업태)) 빠짐.push(`③-a 에 「${업태}」 업태가 없다 — 이커머스 아닌 사람은 ④ 에서 막힌다`);
  if (!B.includes('한 명 데려오는 데 얼마까지'))
    빠짐.push('③-a 에 업태 공통 질문(목표 CPA)이 없다 — 업태마다 다른 길이 한 곳으로 모이지 않는다');
  //   ⭐ 업태를 아무리 늘려도 빠지는 사람이 계속 생긴다 (비영리·프리랜서·공방·병원…).
  //   그래서 본문은 **줄글**(§0)이고, 형식이 필요한 것은 셋뿐이다 —
  //   §1 업종(규제 스위치) · §4 숫자 하나(계산) · §6 금기(문자 매칭).
  //   실측 · 절 번호로 참조하는 17개 스킬은 §4 22건 · §6 6건 · §1 2건에 몰렸고
  //   §2 고객 · §3 포지셔닝은 **0건**이었다. 정작 사람들이 못 쓰는 칸을 아무도 안 부른다.
  if (!T.includes('## 0. 우리 이야기')) 빠짐.push('빈 템플릿에 §0 줄글 자리가 없다 — 칸에 안 맞는 업태가 첫 줄에서 막힌다');
  {
    const S2 = fs.readFileSync(path.join(ROOT, 'sample-data', 'profile-sample.md'), 'utf8');
    if (!S2.includes('## 0. 우리 이야기')) 빠짐.push('profile-sample 에 §0 본보기가 없다 — 예시가 규칙을 이긴다');
  }
  //   ⚠️ v0.34.0 에서 「여섯 칸을 순서대로 묻지 않는다」로 못 박은 것은 **과했다.**
  //   사용자를 마케터로 한정하면(규약 §0-a) 그 여섯은 마케터의 언어다 — 설명이 필요 없다.
  //   업태를 타는 것은 **④ 숫자 하나뿐**이다. 고칠 것은 질문이 아니라 **답하는 방식의 강요**였다.
  if (!B.includes('어떻게 답하든 받는다')) 빠짐.push('온보딩이 답을 칸에 맞춰 쓰라고 강요한다 — 줄글·붙여넣기도 받아야 한다');
  //   ⚠️ 마케터에게 실제로 일어나는 것은 「없는 업태」가 아니라 **겹침**이다 —
  //   정기배송 D2C 는 실물+구독, 매장 브랜드는 실물+로컬, 대행사는 클라이언트마다 다르다.
  if (!B.includes('닫힌 목록이 아니고, 실제로는 자주 겹친다'))
    빠짐.push('업태 표가 닫힌 목록으로 읽힌다 — 겹치는 브랜드가 한 칸에 갇힌다');
  if (!T.includes('목표 CPA'))
    빠짐.push('프로필 템플릿 §4 에 업태 안내가 없다 — 실물 판매가 아니면 첫 칸에서 막힌다');
  if (/모르면 비우고 넘어간다/.test(B)) 빠짐.push('「모르면 비우고 넘어간다」가 살아 있다 — 그 칸은 영원히 빈칸으로 남는다');
  // 지어내면 안 되는 셋이 명시돼 있나
  for (const k of ['마진율', '경쟁사', '채널'])
    if (!new RegExp(`⛔ \\*\\*안 쓴다\\*\\*[^|]*\\|[^|]*`).test(B) || !B.includes(k))
      빠짐.push(`③-b 에 「${k}」 예외가 없다 — 사실을 지어내면 판정이 뒤집힌다`);
  // [초안] 이 세 곳에 배선돼 있나 — 한 곳만 있으면 초안이 실데이터로 둔갑한다
  if (!G.includes('[초안]')) 빠짐.push('규약 §0-b 에 [초안] 모드가 없다 — AI 가 쓴 값이 [실데이터] 로 나간다');
  if (!T.includes('[초안]')) 빠짐.push('프로필 템플릿에 [초안] 설명이 없다');
  //   ⛔ 규칙만 고치면 **예시가 이긴다.** 실측 · ③-a 는 「명사 말고 고객의 말」이라 적었는데
  //   정작 profile-sample 의 사는 이유가 「순한 성분 · 흡수감 · 리뷰 신뢰」(명사)였다.
  //   AI 도 사람도 채워진 예시를 보고 흉내 낸다 — 본보기가 규칙을 이긴다.
  {
    const S = fs.readFileSync(path.join(ROOT, 'sample-data', 'profile-sample.md'), 'utf8');
    const 사는 = (S.match(/^\| 사는 이유[^\n]*$/m) || [''])[0];
    if (!사는.includes('「')) 빠짐.push('profile-sample 의 사는 이유가 고객의 말이 아니다 — 예시가 ③-a 규칙을 이긴다');
    if (!T.includes('경쟁사가 그대로 써도')) 빠짐.push('빈 템플릿 §2 에 자가 점검이 없다 — 파일을 직접 여는 사람이 기준을 못 본다');
  }
  if (!B.includes('[초안]')) 빠짐.push('구축 스킬이 [초안] 을 붙이지 않는다');

  if (빠짐.length) {
    err(`프로필 대필 배선이 끊겼다 ${빠짐.length}건`);
    for (const n of [...new Set(빠짐)]) err(`  ${n}`);
  } else ok.push('프로필 대필 (③-b · 지어내지 않는 셋 · [초안] 3곳)');
}

// ⑥-i13 재방문 배선 — 「읽으라」고 적은 것이 실제로 만들어지나 · 먼저 꺼내지나
//   실측 2026-08-26 · 시스템이 먼저 말을 거는 자리 1개, 실효 0. 이유가 셋이었다.
//   ① 신호가 전부 「이상」이라 잘 쓰는 사람에겐 평생 안 뜬다
//   ② 훅 맥락이 통째로 「먼저 꺼내지 말 것」이었다 — 먼저 꺼낼 길이 없었다
//   ③ 규약은 build-log-summary 를 「읽어라」 하는데 롤오버(800행 = 수년)만 만들었다.
//      **읽으라고 적은 파일이 몇 년간 없었다** — 그러면 원장을 통독하게 되고 §A 가 깨진다.
{
  const L = fs.readFileSync(path.join(ROOT, 'scripts', 'ledger-stats.mjs'), 'utf8');
  const B = fs.readFileSync(path.join(ROOT, 'skills', '마케팅팀-구축하기', 'SKILL.md'), 'utf8');
  const 빠짐 = [];

  // 재방문 신호 3종이 기계와 문서 양쪽에 있나 (한쪽만 있으면 죽은 신호다)
  for (const [기호, 이름] of [['⏰', '주기도래'], ['📌', '미완'], ['📎', '플레이북']]) {
    if (!L.includes(`'${기호} ${이름}'`)) 빠짐.push(`${기호} ${이름} — 기계에 없다`);
    else if (!B.includes(`${기호} ${이름}`)) 빠짐.push(`${기호} ${이름} — 구축 스킬 표에 없다`);
  }
  // 훅 맥락이 갈려 있나 — 하나로 뭉치면 재방문이 다시 죽는다
  //   ⚠️ 주석이 아니라 **훅이 실제로 내보내는 맥락 문자열**을 본다 (주석에만 있으면 통과해 버린다)
  const 맥락 = (L.match(/const 맥락 = \[[\s\S]*?맥락\.join/) || [''])[0];
  if (!맥락.includes('첫 답에서 먼저 꺼낸다')) 빠짐.push('훅 맥락에 「첫 답에서 먼저 꺼낸다」가 없다 — 재방문이 일어날 수 없다');
  if (!맥락.includes('먼저 꺼내지 말 것')) 빠짐.push('훅 맥락에 「먼저 꺼내지 말 것」이 없다 — 이상까지 먼저 꺼내면 잔소리다');
  // 「읽어라」고 선언한 요약을 훅이 만드나
  if (!/if \(SUMMARY \|\| HOOK\)/.test(L))
    빠짐.push('build-log-summary 를 훅이 만들지 않는다 — 규약 §A 가 읽으라는 파일이 수년간 없게 된다');

  if (빠짐.length) {
    err(`재방문 배선이 끊겼다 ${빠짐.length}건 — 원장이 먼저 말을 걸지 못한다`);
    for (const n of 빠짐) err(`  ${n}`);
  } else ok.push('재방문 배선 (신호 3종 · 훅 분기 · 요약 생성)');
}

// ⑥-i12 정당한 정지 스킬은 자료 요청(HANDOFF)을 가지나
//   ⛔ 지어내면 위법이라 멈추는 스킬은 **「못 합니다」로 끝나면 안 된다.**
//   막힌 자리에서 해야 할 첫 일은 **재료를 구체적으로 요청하는 것**이다 (규약 §0-c D2·D3).
//   실측 2026-08-27 · 024 를 형식 전환으로 넓히면서 **그 자리에 있던 요청을 지웠다.**
//   대안(형식 전환·샘플·추정)은 요청을 대체하지 않는다 — 갈아탄 순간 요청이 사라지면
//   사용자는 더 나은 결과를 영영 못 받는다. 검사가 없어 지운 줄도 몰랐다.
{
  const 정지 = ['024', '032', '037', '040', '058', '064', '070', '075', '080', '083', '089', '090'];
  const 없음 = [];
  const 찾기 = n => {
    let hit = null;
    const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const q = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name.startsWith(n + '-')) hit = path.join(q, 'SKILL.md'); return walk(q); }
    });
    walk(path.join(ROOT, '100-skills'));
    return hit;
  };
  for (const n of 정지) {
    const f = 찾기(n);
    if (!f || !fs.existsSync(f)) { 없음.push(`${n} (파일 없음)`); continue; }
    const t = fs.readFileSync(f, 'utf8');
    if (!t.includes('HANDOFF → 사용자')) 없음.push(`${n} 사용자 계약 없음`);
    else if (!t.includes('여기서 막혔습니다')) 없음.push(`${n} ①②③ 없음`);
  }
  if (없음.length) {
    err(`정당한 정지 스킬에 자료 요청이 없다 ${없음.length}건 — 「못 합니다」로 끝나면 그냥 클로드다`);
    for (const n of 없음) err(`  ${n}`);
  } else ok.push(`정당한 정지 = 자료 요청 (${정지.length}개)`);
}

// ⑥-i11 선언한 폴백과 게이트 표가 같은 파일을 가리키나
//   실측 2026-08-26 · 065 RFM 은 `고객ID·주문일·주문금액` 3열이 필요한데
//   선언은 매출.xlsx 였고 게이트·예시는 고객마스터.csv 를 썼다. **선언이 틀렸다.**
//   046·048 도 같았다. 선언만 보고 도는 실행은 엉뚱한 파일을 집는다.
{
  const 어긋남 = [];
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const q = path.join(d, e.name);
    if (e.isDirectory()) return walk(q);
    if (e.name !== 'SKILL.md') return;
    const t = fs.readFileSync(q, 'utf8');
    const dec = (t.match(/^sample_fallback:\s*sample-data\/(\S+)/m) || [])[1];
    if (!dec) return;
    const g = (t.match(/\| 멈추는 곳 \| 묻는 것 \| 기본값[^\n]*\n\|[-| ]+\n((?:\|.*\n)+)/) || [])[1];
    if (g && g.includes('sample-data/') && !g.includes(dec))
      어긋남.push(path.basename(path.dirname(q)));
  });
  walk(path.join(ROOT, '100-skills'));
  if (어긋남.length) {
    err(`선언한 폴백과 게이트 표가 다른 파일을 가리킨다 ${어긋남.length}개 — 선언만 보고 도는 실행이 엉뚱한 파일을 집는다`);
    for (const n of 어긋남.slice(0, 5)) err(`  ${n}`);
  } else ok.push('폴백 선언 = 게이트 표 (100개)');
}

// ⑥-i10 D1~D5 가 규약·런타임·예시 셋에 다 있나
//   ⚠️ 규칙만 바꾸면 **예시가 이긴다.** AI 는 example/output.md 를 보고 흉내 낸다.
//   실측 2026-08-26 · G4 에 「경로·결론 3줄·부족한 것」이 적혀 있는데도
//   실제로는 「.md 파일 나왔습니다」로 끝났다 — 예시 100개 중 그 형태를 보여주는 것이 0개였다.
{
  for (const [f, name, 표식] of [
    [path.join(ROOT, 'docs', '공통규약.md'), '공통규약 §0-c', '그냥 클로드'],
    [path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'AI-마케터', 'D2'],
  ]) if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes(표식))
    err(`${name} 에 D1~D5 가 없다 — 정체성 규칙이 빠지면 그냥 클로드와 같아진다`);

  const ex = [];
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    const q = path.join(d, e.name);
    if (e.isDirectory()) return walk(q);
    if (e.name === 'output.md') ex.push(q);
  });
  walk(path.join(ROOT, '100-skills'));
  const 계약 = ex.filter(q => fs.readFileSync(q, 'utf8').includes('HANDOFF → 사용자'));
  if (!계약.length) err('예시 산출물에 「HANDOFF → 사용자」 본보기가 0개다 — 규칙만 있고 흉내 낼 것이 없다');
  else ok.push(`D1~D5 배선 · 계약 본보기 ${계약.length}/${ex.length}개`);
}

// ⑥-i9 이 버전의 실제 확인을 실제로 밟았나
//   ⚠️ 정적 검사로 원리적으로 못 잡는 것이 있다 — 스킬이 **실제로 열리는가**, 화면에 그 문장이 나오는가.
//   실측 2026-08-26 · 기계 검사 35종을 전부 통과한 상태에서 실패 3건이 「써 보고」 나왔다.
//   마지막 실측은 v0.14.0 이고 그 뒤로 버전이 여덟 번 올랐다. **안 밟으면 아무도 모른다.**
//   기록 이름은 커밋 해시다(실제확인.md). 그래서 파일 **안에 적힌 버전**으로 찾는다.
{
  const dir = path.join(ROOT, 'scripts', '실제확인-기록');
  const ver = fs.existsSync(mpath) ? JSON.parse(fs.readFileSync(mpath, 'utf8')).version : null;
  if (ver && fs.existsSync(dir)) {
    const 기록 = fs.readdirSync(dir).filter(f => f.endsWith('.md') && !f.startsWith('_폐기'))
      .map(f => ({ f, t: fs.readFileSync(path.join(dir, f), 'utf8') }))
      .filter(x => new RegExp(`\\bv?${ver.replace(/\./g, '\\.')}\\b`).test(x.t));
    const m = `이 버전(v${ver})의 실제 확인 기록이 ${기록.length ? '미완이다' : '없다'} — ` +
              '기계 검사로는 「스킬이 실제로 열리는가」를 못 잡는다 (scripts/실제확인.md)';
    if (!기록.length) {
      // ⚠️ CI 가 아니라 RELEASE 로 가른다. CI 는 **푸시마다** 돌기 때문에
      //    CI 에서 🔴 로 두면 사람이 밟기 전까지 main 이 영구히 빨갛다 (실측 2026-08-27 · 내가 그렇게 만들었다).
      //    버전 게이트는 버전을 올리면 스스로 풀리지만 이 게이트는 **사람만 풀 수 있다.**
      if (process.env.RELEASE) err(m + '. 밟고 scripts/실제확인-기록/{커밋}.md 로 남겨라');
      else warn(m + '. **릴리스 전에** 밟아라 (푸시는 막지 않는다)');
    } else {
      const 미완 = 기록.filter(x => x.t.includes('⬜'));
      if (미완.length) {
        const 개수 = 미완.reduce((a, x) => a + (x.t.match(/⬜/g) || []).length, 0);
        if (process.env.RELEASE) err(`${m} · 미완 ${개수}칸 (${미완[0].f})`);
        else warn(`${m} · 미완 ${개수}칸 (${미완[0].f}) — **릴리스 전에** 채워라`);
      } else ok.push(`실제 확인 실측 있음 (v${ver} · ${기록[0].f})`);
    }
  }
}

// ⑥-i8 배포 대상 파일이 git 에 실제로 들어가 있나
//   ⚠️ 이 검사들은 **디스크**를 본다. 그런데 사용자에게 가는 것은 **git 이 추적하는 것**이다.
//   실측 2026-08-26 · brand-templates/skill-notes.md 를 만들고 규약이 「정본 템플릿」이라 가리켰는데
//   add 가 안 돼 추적 밖이었다. 로컬은 멀쩡, 배포본에는 없음 — 참조 검사도 통과했다.
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  if (repoRoot && fs.existsSync(path.join(repoRoot, '.git'))) {
    const r = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'plugins/'],
                        { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
    const 미추적 = (r.stdout || '').split('\n').filter(Boolean)
      .filter(f => !/ \d+(\.\w+)?$/.test(f));          // iCloud 충돌 사본은 ⑥-i6 이 따로 잡는다
    if (미추적.length) {
      err(`배포 폴더에 git 이 모르는 파일이 ${미추적.length}개 있다 — 로컬에만 있고 사용자에게는 안 간다`);
      for (const f of 미추적.slice(0, 5)) err(`  ${f}`);
    } else ok.push('배포 대상 전부 git 추적됨 (디스크 ≠ 배포본 어긋남 없음)');
  }
}

// ⑥-i7 프로필 폴백이 배선돼 있나
//   「프로필 비었으면 샘플로 완주」는 규약에 있었지만 **어느 파일을 읽는지**가 어디에도 없었다.
//   그래서 프로필 없이 설치하면 업종·마진율·타깃·금기어가 통째로 빠진 채 돌았다 (실측 2026-08-25).
{
  const sp = path.join(ROOT, 'sample-data', 'profile-sample.md');
  if (!fs.existsSync(sp)) err('sample-data/profile-sample.md 없음 — 프로필 없는 사용자가 맥락 없이 돈다');
  else {
    const 읽는곳 = [
      [path.join(ROOT, 'docs', '공통규약.md'), '공통규약 §0-b'],
      [path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'AI-마케터 §0'],
      [path.join(ROOT, '100-skills', 'SPEC.md'), '100-skills/SPEC.md (requires 폴백)'],
    ];
    let miss = 0;
    for (const [f, name] of 읽는곳)
      if (fs.existsSync(f) && !fs.readFileSync(f, 'utf8').includes('profile-sample.md')) {
        err(`${name} 이 profile-sample.md 를 가리키지 않는다 — 폴백이 말로만 있고 경로가 없다`); miss++;
      }
    // 빈 템플릿과 샘플의 절 구조가 같아야 읽는 쪽이 안 바뀐다
    const secs = f => [...fs.readFileSync(f, 'utf8').matchAll(/^## (\d)\. (.+)$/gm)].map(m => m[1]).join(',');
    const tpl = path.join(ROOT, 'brand-templates', 'profile.md');
    if (fs.existsSync(tpl) && !secs(tpl).startsWith(secs(sp)))
      err(`profile-sample.md 와 brand-templates/profile.md 의 절 번호가 어긋난다 (샘플 ${secs(sp)} · 템플릿 ${secs(tpl)})`);
    else if (!miss) ok.push('프로필 폴백 배선 (샘플 ↔ 템플릿 절 구조 일치)');
  }
}

// ⑥-i6 iCloud 충돌 사본이 패키지 안에 있나
//   `eval-routing 2.mjs` 같은 파일은 동기화가 만든 낡은 사본이다. git 은 무시하지만
//   **`directory` 소스로 설치하면 폴더째 복사되어 설치본에 딸려 간다.** (실측 2026-08-25)
{
  const dups = [];
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    if (e.name === 'node_modules') return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (/ \d+(\.\w+)?$/.test(e.name)) dups.push(path.relative(ROOT, p));
  });
  walk(ROOT);
  if (dups.length) {
    warn(`iCloud 충돌 사본 ${dups.length}개가 패키지 안에 있다 — 지워라 (git 은 추적 안 하지만 directory 설치본에는 딸려 간다)`);
    for (const d of dups.slice(0, 5)) warn(`  ${d}`);
  } else ok.push('충돌 사본 없음');
}

// ⑥-i2 배포 대상 마크다운의 내부 상대 링크가 실재하나
//   깨진 링크가 지금은 0개지만 회귀를 자동으로 막지 못했다 (2026-08-22)
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  const files = [];
  const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
    if (e.name.startsWith('.') || e.name === 'node_modules') return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) return walk(p);
    if (e.name.endsWith('.md')) files.push(p);
  });
  for (const sub of ['agents', 'skills', 'docs', '100-skills', 'brand-templates', 'scripts']) walk(path.join(ROOT, sub));
  if (repoRoot && fs.existsSync(path.join(repoRoot, 'README.md'))) files.push(path.join(repoRoot, 'README.md'));
  let bad = 0, seen = 0;
  for (const p of files) {
    const t = fs.readFileSync(p, 'utf8');
    for (const m of t.matchAll(/\]\(([^)\s#]+\.(?:md|html|csv|json|mjs|py))(?:#[^)]*)?\)/g)) {
      const href = m[1];
      if (/^(https?:|mailto:|\$\{)/.test(href) || /[{}…*]/.test(href)) continue;
      seen++;
      if (!fs.existsSync(path.resolve(path.dirname(p), href))) {
        err(`깨진 내부 링크: ${href}  ← ${path.relative(repoRoot || ROOT, p)}`); bad++;
      }
    }
  }
  if (!bad) ok.push(`내부 상대 링크 ${seen}건 실재 확인`);
}

// ⑥-j writes_to 가 파일인가 디렉터리인가
{
  let dirs = 0;
  for (const c of fs.readdirSync(M).filter(d => /^\d\d-/.test(d))) {
    const sd = path.join(M, c, 'skills');
    if (!fs.existsSync(sd)) continue;
    for (const d of fs.readdirSync(sd)) {
      const p = path.join(sd, d, 'SKILL.md');
      if (!fs.existsSync(p)) continue;
      const f2 = (fs.readFileSync(p, 'utf8').match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
      const w = ((f2.match(/^writes_to:\s*(.*)$/m) || [, ''])[1] || '').replace(/^\[|\]$/g, '')
        .split(',').map(x => x.trim()).filter(x => x.includes('/'))[0] || '';
      if (w && w.endsWith('/')) { err(`writes_to 가 디렉터리다 (파일이어야 한다): ${d} → ${w}`); dirs++; }
    }
  }
  if (!dirs) ok.push('writes_to 전부 파일 경로');
}

// ⑥-k 저장소에 작업 산출물이 샜나
//   2026-08-23 · 어떤 실행이 저장소 루트에 _백업/ 을 만들었다. 쓰는 곳은 넷뿐이다.
{
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  const BAD = [/^_?백업/, /^backup/i, /^_bak/i, /^temp$/i, /^tmp$/i];
  let hit = 0;
  for (const base of [repoRoot, ROOT].filter(Boolean)) {
    for (const e of fs.readdirSync(base, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      if (BAD.some(r => r.test(e.name))) { err(`작업 산출물이 샜다: ${path.relative(repoRoot || ROOT, path.join(base, e.name))}/ — 쓰는 곳은 brand·outputs·logs·inputs 넷뿐이다`); hit++; }
    }
  }
  // 패키지 안에 작업 폴더가 생겼나
  for (const d of ['brand', 'outputs', 'logs', 'inputs'])
    if (fs.existsSync(path.join(ROOT, d))) { err(`패키지 안에 ${d}/ 이 있다 — 업데이트에 날아간다. 작업 폴더에 두어야 한다`); hit++; }
  if (!hit) ok.push('작업 산출물 유출 없음 (패키지·저장소 깨끗)');
}

// ⑥-l 실존 기업·브랜드 실명이 예시에 있나
//   2026-08-23 · 샘플은 B사·C사·D사 로 익명인데 실행 산출물이 화장품 3사를 실명으로 썼다.
//   열위 비교·배제 기준·가상 발언에 쓰이면 비방적 표시·광고(표시광고법 §3①4) 소지다.
{
  const bp = path.join(ROOT, 'scripts', 'banned-brands.json');
  if (!fs.existsSync(bp)) warn('scripts/banned-brands.json 없음 — 실존 브랜드 검사를 건너뛴다');
  else {
    const bb = JSON.parse(fs.readFileSync(bp, 'utf8'));
    const files = [];
    const walk = d => fs.existsSync(d) && fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (/\.(md|csv|json|html)$/.test(e.name)) files.push(p);
    });
    for (const sub of ['100-skills', 'sample-data', 'docs', 'brand-templates', 'hooks']) walk(path.join(ROOT, sub));
    let hit = 0;
    for (const p of files) {
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      if ((bb.allow || []).some(a => rel.endsWith(a))) continue;
      const t = fs.readFileSync(p, 'utf8');
      for (const b2 of bb.brands) if (t.includes(b2)) { err(`실존 브랜드 「${b2}」 · ${rel} — 지어낸 이름이면 B사·C사·D사 로 (docs/공통규약.md §L)`); hit++; }
    }
    if (!hit) ok.push(`실존 브랜드 ${bb.brands.length}종 · ${files.length}개 파일 깨끗`);
  }
}

// ⑦ 금칙어 · 옛 직함 · 죽은 스킬 이름 · 개인 인스턴스 흔적
//   검색어를 여기 리터럴로 쓰면 이 파일 자신이 걸려 영구 🔴 가 된다 → scripts/banned-words.json 으로 분리
//   그리고 스캔 뿌리가 둘이다: 플러그인(ROOT) 과 저장소 루트(REPO_ROOT · README·marketplace.json 이 거기 있다)
{
  const bwPath = path.join(ROOT, 'scripts', 'banned-words.json');
  const repoRoot = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
    ? path.resolve(ROOT, '..', '..') : null;
  if (!fs.existsSync(bwPath)) warn('scripts/banned-words.json 없음 — 금칙어 검사를 건너뛴다');
  else {
    const bw = JSON.parse(fs.readFileSync(bwPath, 'utf8'));
    const groups = Object.entries(bw).filter(([k]) => !k.startsWith('_'));
    const files = [];
    const SHIPPED = ['agents', 'skills', 'docs', '100-skills', '.claude-plugin', 'scripts', 'brand-templates', 'hooks'];
    const walk = (d, root, top) => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
      if (d === root && top && !top.includes(e.name)) return;
      if (e.name.startsWith('.') && d !== root) return;
      if (e.name === 'node_modules') return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) return walk(p, root, null);
      if (/\.(md|json|mjs|html)$/.test(e.name)) files.push(p);
    });
    walk(ROOT, ROOT, SHIPPED);
    if (repoRoot) {
      for (const n of ['README.md']) {
        const p = path.join(repoRoot, n); if (fs.existsSync(p)) files.push(p);
      }
      const mk = path.join(repoRoot, '.claude-plugin', 'marketplace.json');
      if (fs.existsSync(mk)) files.push(mk);
    }
    let hits = 0;
    for (const p of files) {
      const rel = path.relative(ROOT, p).replace(/\\/g, '/');
      if (rel.includes('/100-skills/')) continue;        // persona 직함 등 오탐 구역
      if (rel === 'scripts/banned-words.json') continue;  // 금칙어 목록 자신 — 여기 없으면 검사가 성립 안 한다
      const t = fs.readFileSync(p, 'utf8');
      for (const [g, cfg] of groups) {
        if ((cfg.allow || []).some(a => rel.endsWith(a))) continue;
        for (const w of cfg.words) if (t.includes(w)) { warn(`${g} 「${w}」 잔존 · ${rel}`); hits++; }
      }
    }
    if (!hits) ok.push(`금칙어 ${groups.length}군 · ${files.length}개 파일 깨끗`);
  }
}



// ⑧ 폴더로 열어 쓰는 경로 · .claude/ 연결 고리
//   깃이 심링크를 텍스트 파일로 받아 오는 환경(주로 윈도우)이 있다. 그러면 담당이 하나도 안 걸린다.
const REPO = fs.existsSync(path.join(ROOT, '..', '..', '.claude-plugin', 'marketplace.json'))
  ? path.resolve(ROOT, '..', '..')   // plugins/<name>/ 안에 있다 = 배포 저장소 구조
  : ROOT;                            // 단독 폴더로 쓰는 중
for (const link of ['agents', 'skills']) {
  const p = path.join(REPO, '.claude', link);
  let st;
  try { st = fs.lstatSync(p); } catch {
    notes.push(`.claude/${link} 없음 — 정상이다. 폴더로 열어 쓸 때 「팀 점검하자」가 만든다`);
    continue;
  }
  if (st.isSymbolicLink()) {
    if (!fs.existsSync(p)) err(`.claude/${link} 심링크가 깨져 있다 (가리키는 곳이 없다)`);
    else ok.push(`.claude/${link} → ${fs.readlinkSync(p)}`);
  } else if (st.isFile()) {
    err(`.claude/${link} 이 심링크가 아니라 텍스트 파일이다 (깃이 링크를 파일로 받은 경우) — ` +
        `그 파일을 지우고 plugins/marketing-team/${link} 폴더를 .claude/ 안으로 복사한다`);
  } else {
    ok.push(`.claude/${link} (복사본)`);
  }
}


// ⑨ 경로 규칙 · 담당/스킬이 "무엇이 패키지 안이고 무엇이 작업 폴더인지"를 알고 있나
//   이걸 모르면 플러그인으로 설치했을 때 sample-data·100-skills 를 엉뚱한 곳에서 찾는다.
{
  const missing = [];
  for (const f of [...agents.map(a => `agents/${a}.md`), ...skills.map(s => `skills/${s}/SKILL.md`)]) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    if (!t.includes('경로 규칙')) missing.push(f);
  }
  if (missing.length) err(`경로 규칙 블록 없음 (${missing.length}개): ${missing.slice(0, 4).join(', ')}${missing.length > 4 ? ' …' : ''}`);
  else ok.push('경로 규칙 전원 명시 (패키지 안 vs 작업 폴더)');
}

// ⑩ AI 마케터에 완주 조건이 살아 있나 (2026-08-22 시뮬에서 「짧게」 한마디에 게이트·착지가 빠졌다)
{
  const d = fs.existsSync(dpath) ? fs.readFileSync(dpath, 'utf8') : '';
  for (const k of ['완주 조건', '파일 착지', '규제 게이트', '원장'])
    if (!d.includes(k)) { err(`AI 마케터에 완주 조건 「${k}」 가 없다 — 단축 요청에 절차가 빠진다`); break; }
  if (d.includes('완주 조건')) ok.push('완주 조건 셋 명시 (단축 요청에도 생략 불가)');
}

// ⑪ 카탈로그 · 100개를 한 장으로 보는 파일이 있고 명부보다 최신인가
{
  // ⚠️ 시각(mtime) 비교로는 「둘 다 낡은」 상태를 못 잡는다.
  //    2026-08-22 · ROUTING.md 가 SKILL.md 와 16개 어긋났는데 카탈로그도 같이 낡아서 통과했다.
  //    AI 마케터는 명부를 먼저 읽으므로, 정본을 고쳐도 구형 이름·트리거로 판단한다.
  const cat = path.join(M, '카탈로그.html'), routing = path.join(M, 'ROUTING.md');
  if (!fs.existsSync(cat)) err('100-skills/카탈로그.html 없음 — `node scripts/build-catalog.mjs`');
  if (!fs.existsSync(routing)) err('100-skills/ROUTING.md 없음 — `node scripts/build-routing.mjs`');
  else {
    try {
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-routing.mjs'), '--check'], { stdio: 'pipe' });
      ok.push('ROUTING.md 전체 생성물 = 스킬·체인 정본');
    } catch {
      err('ROUTING.md 전체 생성물이 정본과 다르다 — `node scripts/build-routing.mjs`');
    }
    // SKILL.md(정본) → ROUTING.md 전수 대조
    const rows = Object.fromEntries([...fs.readFileSync(routing, 'utf8')
      .matchAll(/^\| (\d{3}) \| (.+?) \| (.+?) \|/gm)].map(m => [m[1], { name: m[2].trim(), trig: m[3].trim() }]));
    let drift = 0;
    for (const cdir of fs.readdirSync(M).filter(d => /^\d\d-/.test(d))) {
      const sd = path.join(M, cdir, 'skills');
      if (!fs.existsSync(sd)) continue;
      for (const d of fs.readdirSync(sd)) {
        const p = path.join(sd, d, 'SKILL.md');
        if (!fs.existsSync(p)) continue;
        const t = fs.readFileSync(p, 'utf8');
        const f2 = (t.match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
        const id = ((f2.match(/^id:\s*(.*)$/m) || [, ''])[1] || '').trim().replace(/"/g, '');
        const nm = ((f2.match(/^name:\s*(.*)$/m) || [, ''])[1] || '').trim().replace(/"/g, '');
        const tg = [...f2.matchAll(/^\s+- "(.+?)"$/gm)].map(m => `"${m[1]}"`).join(' · ');
        const r = rows[id];
        if (!r) { err(`ROUTING.md 에 ${id} 이 없다`); drift++; continue; }
        if (r.name !== nm) { err(`ROUTING.md ${id} 이름 불일치 · 명부「${r.name}」≠ 정본「${nm}」`); drift++; }
        else if (r.trig !== tg) { err(`ROUTING.md ${id} 부르는 말 불일치 — SKILL.md 가 정본이다`); drift++; }
      }
    }
    if (drift) err(`총 ${drift}개 어긋남 — \`node scripts/build-routing.mjs\` 로 다시 만든다`);
    else ok.push(`ROUTING.md = SKILL.md 100개 전수 일치`);
    // 카탈로그는 ROUTING 의 파생물이라 시각 비교로 충분하다
    if (fs.existsSync(cat) && fs.statSync(routing).mtimeMs > fs.statSync(cat).mtimeMs)
      warn('카탈로그가 ROUTING.md 보다 오래됐다 — `node scripts/build-catalog.mjs`');
    else if (fs.existsSync(cat)) ok.push('카탈로그 최신');
  }
}

// ⑫ 실행 영수증 · 검토한 산출물과 전달할 산출물이 같은가
//   gate.md 가 있어도 본문을 그 뒤에 고치면 검토 근거는 낡는다.
//   성공 경로뿐 아니라 **검토 후 한 글자 변경이 실제로 차단되는지** 임시 작업 폴더에서 밟는다.
{
  const receipt = path.join(ROOT, 'scripts', 'run-receipt.mjs');
  const test = path.join(ROOT, 'scripts', 'test-run-receipt.mjs');
  const contract = path.join(ROOT, 'docs', '실행-영수증.md');
  const marketer = fs.readFileSync(dpath, 'utf8');
  const gateAgent = fs.readFileSync(path.join(ROOT, 'agents', 'staff-gate-auditor.md'), 'utf8');
  const businessAgent = fs.readFileSync(path.join(ROOT, 'agents', 'staff-reviewer.md'), 'utf8');
  const missing = [];
  for (const [file, name] of [[receipt, 'run-receipt.mjs'], [test, 'test-run-receipt.mjs'], [contract, '실행-영수증.md']])
    if (!fs.existsSync(file)) missing.push(name);
  for (const word of ['run.json', 'run-receipt.mjs', 'verification-failed'])
    if (!marketer.includes(word)) missing.push(`AI 마케터의 ${word} 배선`);
  if (!gateAgent.includes('검사 기준 산출물')) missing.push('AI 규제검토자의 검사 기준 반환');
  if (!businessAgent.includes('검사 기준 산출물')) missing.push('AI 사업검토자의 검사 기준 반환');

  if (missing.length) err(`실행 영수증 배선이 끊겼다: ${missing.join(' · ')}`);
  else {
    try {
      execFileSync(process.execPath, [test], { cwd: ROOT, stdio: 'pipe' });
      ok.push('실행 영수증 (완료 상태 · writes_to · 체인 순서 · PII · SHA-256 · 다중 검토 차단)');
      // 산출물 내용 검사 층 · 판단이 아니라 재는 것만 여기 있다 (pii · csv-format · house-style)
      for (const [script, label] of [
        ['test-output-checks.mjs', '산출물 내용 검사 (CSV 형식 · 우리말 · 개인정보)'],
        ['check-flag-counts.mjs', '플래그 개수 문서 일치 (gate · pii · review)'],
        ['test-plan-compiler.mjs', '계획 스키마·승인 해시 (계획 밖 산출물·순서 변경 차단)'],
        ['test-router.mjs', '자연어 후보 라우터 (006·046 · 복합 요청 분해)'],
        ['test-chain-compiler.mjs', '일반 체인 그래프 (누락·역순·순환·입력 단절 차단)'],
        ['test-review-policy.mjs', '산출물별 검토 정책 자동 생성'],
        ['test-orchestrator-events.mjs', '오케스트레이터 이벤트 기록·요약'],
      ]) {
        const p = path.join(ROOT, 'scripts', script);
        if (!fs.existsSync(p)) { err(`${label} 스크립트가 없다: scripts/${script}`); continue; }
        try {
          execFileSync(process.execPath, [p], { cwd: ROOT, stdio: 'pipe' });
          ok.push(label);
        } catch (error) {
          const detail = String(error.stderr || error.stdout || error.message).trim().split('\n').at(-1);
          err(`${label} 실패${detail ? ` · ${detail}` : ''}`);
        }
      }
    } catch (error) {
      const detail = String(error.stderr || error.stdout || error.message).trim().split('\n').at(-1);
      err(`실행 영수증 실제 검사가 실패했다${detail ? ` · ${detail}` : ''}`);
    }
  }
}

// ⑬ 실기동 결함 회귀 · 2026-08-30 실제 실행에서 발견한 네 가지가 소스에서 다시 생기지 않나
//   ① 마스킹 설명·예시가 원문 ID를 다시 노출 ② 검토 보고서가 내부 용어를 사용자에게 노출
//   ③ 같은 기간이라는 이유만으로 서로 다른 합성 샘플을 교차 계산 ④ 주간 계절성을 이상치로 오탐
//   설치 검증도 저장소 세션이 캐시 설치본을 가리는 경우를 통과로 세지 않게 문서 계약을 고정한다.
{
  const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
  const sales = read('100-skills', '07-analytics', 'skills', '061-sales-data-analysis', 'SKILL.md');
  const rfm = read('100-skills', '07-analytics', 'skills', '065-rfm-segments', 'SKILL.md');
  const reviewer = read('agents', 'staff-reviewer.md');
  const common = read('docs', '공통규약.md');
  const marketer = read('skills', 'AI-마케터', 'SKILL.md');
  const samples = read('sample-data', 'README.md');
  const liveGuide = read('docs', '클로드코드-실기검증.md');
  const missing = [];

  for (const word of ['같은 요일', '반복 패턴', '[기준 부족]'])
    if (!sales.includes(word)) missing.push(`061 요일 보정의 「${word}」`);
  for (const word of ['실행별 임의 대체키', '무염 SHA-256', '설명용 예시'])
    if (!rfm.includes(word)) missing.push(`065 ID 보호의 「${word}」`);
  for (const word of ['회사 자료가 없어 연습용 자료를 사용했습니다', '원문 식별자'])
    if (!reviewer.includes(word)) missing.push(`사업검토자 쉬운말·식별자 점검의 「${word}」`);
  if (!common.includes('[자료 충돌]') || !common.includes('교차 계산 금지'))
    missing.push('공통규약의 [자료 충돌]·교차 계산 금지');
  if (!marketer.includes('[자료 충돌]') || !marketer.includes('합산·나눗셈'))
    missing.push('AI 마케터의 [자료 충돌]·합산/나눗셈 금지');
  if (!samples.includes('독립적으로 만든 합성 데이터') || !samples.includes('파일을 넘나드는 계산을 하지 않는다'))
    missing.push('샘플 README의 독립 합성 데이터·교차 계산 금지');
  for (const word of ['Source: Directory', 'GitHub', '~/.claude/plugins/cache', 'plugins/marketing-team/scripts/실제확인-기록'])
    if (!liveGuide.includes(word)) missing.push(`실기검증 설치 격리·기록 경로의 「${word}」`);

  if (missing.length) {
    err(`실기동 결함 회귀 배선이 끊겼다 ${missing.length}건`);
    for (const x of missing) err(`  ${x}`);
  } else ok.push('실기동 결함 회귀 (ID 재노출 · 내부말 · 샘플 충돌 · 요일 오탐 · 설치 격리)');
}

// 출력
console.log('\n마케팅 팀 패키지 점검\n');
for (const o of ok) console.log(`  ✅ ${o}`);
for (const n of notes) console.log(`  ·  ${n}`);
if (issues.length) {
  console.log('');
  for (const [sev, m] of issues) console.log(`  ${sev} ${m}`);
}
const e = issues.filter(i => i[0] === '🔴').length;
const w = issues.filter(i => i[0] === '🟡').length;
console.log(`\n🔴 ${e} · 🟡 ${w}\n`);
process.exit(e ? 1 : 0);
