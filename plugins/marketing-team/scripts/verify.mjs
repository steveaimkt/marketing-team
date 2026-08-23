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
    if (!desc) err(`agents/${e.name} · description 없음 — CMO가 언제 부를지 모른다`);
    agents.push(base);
  }
  ok.push(`담당 ${agents.length}명 (평탄 · 전원 frontmatter 완비) · CMO는 스킬`);
}

// ③ CMO가 전원을 알고 있나 · 유령이 없나
// CMO는 메인 컨텍스트에서 도는 스킬이다. 서브에이전트가 아니다 (2026-08-22 결정).
//   서브에이전트가 다시 위임하면 맥락이 두 겹으로 접힌다. 내려가는 단계는 언제나 한 단이다.
if (fs.existsSync(path.join(adir, 'marketing-director.md')))
  err('agents/marketing-director.md 가 있다 — CMO는 skills/마케팅-CMO 여야 한다 (중첩 위임 방지)');
const dpath = path.join(ROOT, 'skills', '마케팅-CMO', 'SKILL.md');
if (!fs.existsSync(dpath)) err('skills/마케팅-CMO/SKILL.md 없음 — 입구가 없다');
else {
  const d = fs.readFileSync(dpath, 'utf8');
  for (const a of agents) if (!d.includes(a)) err(`CMO가 모르는 담당: ${a} — 조직도에 없으면 호출되지 않는다`);
  // 담당은 「내가 나를 검사할 수 없는 자리」에만 둔다 (2026-08-22 결정). 실행자는 두지 않는다.
  const exec = agents.filter(a => !a.startsWith('staff-'));
  if (exec.length) err(`실행 담당이 있다: ${exec.join(', ')} — 실행은 CMO가 메인에서 한다. 담당은 판정 전담만`);
  for (const m of d.matchAll(/`(lead-[a-z-]+|staff-[a-z-]+)`/g))
    if (!agents.includes(m[1])) err(`CMO가 없는 담당을 부른다: ${m[1]}`);
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

// ⑥-c 유령 담당 · CMO 파일뿐 아니라 skills/ · docs/ 전체를 본다
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
//   053 이 gate:true 인데 예시에 CCO 판정이 없었다 (2026-08-22 발견)
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
    if (!/🛡|CCO\(규제\)|게이트 판정|컴플라이언스 게이트/.test(t)) {
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
    for (const sub of ['100-skills', 'sample-data', 'docs', 'brand-templates']) walk(path.join(ROOT, sub));
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
    const SHIPPED = ['agents', 'skills', 'docs', '100-skills', '.claude-plugin', 'scripts', 'brand-templates'];
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

// ⑩ CMO에 완주 조건이 살아 있나 (2026-08-22 시뮬에서 「짧게」 한마디에 게이트·착지가 빠졌다)
{
  const d = fs.existsSync(dpath) ? fs.readFileSync(dpath, 'utf8') : '';
  for (const k of ['완주 조건', '파일 착지', '규제 게이트', '원장'])
    if (!d.includes(k)) { err(`CMO에 완주 조건 「${k}」 가 없다 — 단축 요청에 절차가 빠진다`); break; }
  if (d.includes('완주 조건')) ok.push('완주 조건 셋 명시 (단축 요청에도 생략 불가)');
}

// ⑪ 카탈로그 · 100개를 한 장으로 보는 파일이 있고 명부보다 최신인가
{
  // ⚠️ 시각(mtime) 비교로는 「둘 다 낡은」 상태를 못 잡는다.
  //    2026-08-22 · ROUTING.md 가 SKILL.md 와 16개 어긋났는데 카탈로그도 같이 낡아서 통과했다.
  //    CMO 는 명부를 먼저 읽으므로, 정본을 고쳐도 구형 이름·트리거로 판단한다.
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
