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
    if (!/🛡|AI 규제검토자\(규제\)|게이트 판정|컴플라이언스 게이트/.test(t)) {
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
      const 문서 = [
        [path.join(ROOT, 'docs', '공통규약.md'), '공통규약.md'],
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
