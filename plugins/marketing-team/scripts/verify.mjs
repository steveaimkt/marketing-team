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
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    if (!desc) err(`agents/${e.name} · description 없음 — 디렉터가 언제 부를지 모른다`);
    agents.push(base);
  }
  ok.push(`담당 ${agents.length}명 (평탄 · 전원 frontmatter 완비) · 디렉터는 스킬`);
}

// ③ 디렉터가 전원을 알고 있나 · 유령이 없나
// 디렉터는 메인 컨텍스트에서 도는 스킬이다. 서브에이전트가 아니다 (2026-08-22 결정).
//   서브에이전트가 다시 위임하면 맥락이 두 겹으로 접힌다. 내려가는 단계는 언제나 한 단이다.
if (fs.existsSync(path.join(adir, 'marketing-director.md')))
  err('agents/marketing-director.md 가 있다 — 디렉터는 skills/마케팅-디렉터 여야 한다 (중첩 위임 방지)');
const dpath = path.join(ROOT, 'skills', '마케팅-디렉터', 'SKILL.md');
if (!fs.existsSync(dpath)) err('skills/마케팅-디렉터/SKILL.md 없음 — 입구가 없다');
else {
  const d = fs.readFileSync(dpath, 'utf8');
  for (const a of agents) if (!d.includes(a)) err(`디렉터가 모르는 담당: ${a} — 조직도에 없으면 호출되지 않는다`);
  // 담당은 「내가 나를 검사할 수 없는 자리」에만 둔다 (2026-08-22 결정). 실행자는 두지 않는다.
  const exec = agents.filter(a => !a.startsWith('staff-'));
  if (exec.length) err(`실행 담당이 있다: ${exec.join(', ')} — 실행은 디렉터가 메인에서 한다. 담당은 판정 전담만`);
  for (const m of d.matchAll(/`(lead-[a-z-]+|staff-[a-z-]+)`/g))
    if (!agents.includes(m[1])) err(`디렉터가 없는 담당을 부른다: ${m[1]}`);
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
  for (const f of ['ROUTING.md', 'CHAINS.md', 'compliance.md', 'gates/compliance-gate.md', 'gates/quality-checklist.md'])
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

// ⑦ 개인 인스턴스 흔적
const TRACES = ['트루먼', '/private/tmp/claude-', '/Users/'];
// 배포되는 면만 본다 · 작업 메모 폴더까지 뒤지면 오탐이 난다
const SHIPPED = ['agents', 'skills', 'docs', '100-skills', '.claude-plugin', 'README.md'];
const scan = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => {
  if (d === ROOT && !SHIPPED.includes(e.name)) return;
  if (e.name.startsWith('.') && d !== ROOT) return;
  if (e.name === 'node_modules') return;
  const p = path.join(d, e.name);
  if (e.isDirectory()) return scan(p);
  if (!/\.(md|json)$/.test(e.name)) return;
  const t = fs.readFileSync(p, 'utf8');
  for (const w of TRACES) if (t.includes(w)) warn(`개인 인스턴스 흔적 "${w}" · ${path.relative(ROOT, p)}`);
});
scan(ROOT);


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
