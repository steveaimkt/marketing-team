#!/usr/bin/env node
/**
 * validate-my-skills.mjs · 사용자가 092 로 만든 스킬을 검사한다.
 *
 * 왜: validate-skills.mjs 는 공식 100개만 본다. 092 가 만든 스킬은
 *     「심사를 통과했다」면서 자동 검증 대상 밖이었다 (2026-08-22 · 외부 검토).
 *
 * 사용: node scripts/validate-my-skills.mjs [brand/my-skills 경로]
 *       기본값 ./brand/my-skills
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

const DIR = process.argv[2] || path.join(process.cwd(), 'brand', 'my-skills');
const issues = [];
const err = m => issues.push(['🔴', m]);
const warn = m => issues.push(['🟡', m]);
const ok = [];

if (!fs.existsSync(DIR)) { console.log(`\n사용자 스킬 폴더 없음: ${DIR}\n  (092 로 만들기 전이면 정상이다)\n`); process.exit(0); }

const REQ = ['id','name','description','slug','category','tier','triggers','inputs','outputs',
             'requires','chains_to','gate','mutating','writes_to','builder','version',
             'persona','when_to_use','success_metrics'];
const SEC = ['## Contract','## Phases','## Output Format','## Anti-Patterns','## 활용'];

const dirs = fs.readdirSync(DIR, { withFileTypes: true }).filter(e => e.isDirectory());
let n = 0;
for (const d of dirs) {
  const p = path.join(DIR, d.name, 'SKILL.md');
  if (!fs.existsSync(p)) { err(`${d.name}/SKILL.md 없음`); continue; }
  n++;
  const t = fs.readFileSync(p, 'utf8');
  const f = (t.match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
  const g = k => ((f.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1] || '').trim().replace(/^"|"$/g, '');
  const id = g('id'), slug = g('slug');

  for (const k of REQ) if (!new RegExp(`^${k}:`, 'm').test(f)) err(`${d.name} · ${k} 없음`);
  if (!/^u\d\d$/.test(id)) err(`${d.name} · id 는 u01~u99 여야 한다 (지금: ${id})`);
  if (g('category') !== 'custom') err(`${d.name} · category 는 custom 이어야 한다 (지금: ${g('category')})`);
  if (d.name !== `${id}-${slug}`) err(`${d.name} · 폴더명이 {id}-{slug} 와 다르다 (${id}-${slug})`);
  const trig = [...f.matchAll(/^\s+- "(.+?)"$/gm)].length;
  if (trig < 3) err(`${d.name} · 부를 말 ${trig}개 (3개 이상)`);

  // 착지 · 사용자 스킬도 규칙은 같다
  const wt = g('writes_to');
  if (wt && !new RegExp(`outputs/\\{날짜\\}/${id}-`).test(wt)) err(`${d.name} · writes_to 가 outputs/{날짜}/${id}- 로 시작하지 않는다`);
  if (!/⛔ \*\*착지/.test(t)) err(`${d.name} · Phases 끝에 착지 블록이 없다 (SPEC §4)`);

  // 게이트 · 없으면 true 로 본다
  if (!/^gate:/m.test(f)) warn(`${d.name} · gate 미기재 — true 로 간주된다`);
  else if (g('gate') === 'true' && !/규제 검사|컴플라이언스 게이트|게이트 판정|AI 규제검토자|🛡/.test(t)) err(`${d.name} · gate:true 인데 판정 블록 없음`);

  for (const sec of SEC) if (!t.includes(sec)) err(`${d.name} · ${sec} 없음`);
  if (!fs.existsSync(path.join(DIR, d.name, 'routing-eval.jsonl'))) warn(`${d.name} · routing-eval.jsonl 없음`);
}

// INDEX 대조
const idx = path.join(DIR, 'INDEX.md');
if (!fs.existsSync(idx)) { if (n) err('INDEX.md 없음 — AI 마케터가 G1 에서 이 명부를 읽는다'); }
else {
  const t = fs.readFileSync(idx, 'utf8');
  for (const d of dirs) if (!t.includes(d.name.split('-')[0])) err(`INDEX.md 에 ${d.name} 이 없다 — 등록해도 안 불린다`);
  ok.push(`INDEX.md 대조 ${dirs.length}건`);
}

console.log(`\n사용자 스킬 점검 · ${DIR}\n`);
if (n) ok.unshift(`스킬 ${n}개`);
for (const o of ok) console.log(`  ✅ ${o}`);
for (const [s, m] of issues) console.log(`  ${s} ${m}`);
const e = issues.filter(i => i[0] === '🔴').length;
console.log(`\n🔴 ${e} · 🟡 ${issues.length - e}\n`);
process.exit(e ? 1 : 0);
