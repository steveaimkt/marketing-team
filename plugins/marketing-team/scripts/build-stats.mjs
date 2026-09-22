#!/usr/bin/env node
/**
 * build-stats.mjs · 숫자를 정본에서 계산해 문서의 생성 블록을 갱신한다.
 *
 * 왜: 같은 숫자를 사람이 여러 문서에 적어서 전부 어긋났다 (2026-08-22).
 *     README 454 vs 실제 469 · 공통규약 md71/html5 vs 실제 md75/html8.
 *
 * 사용: node scripts/build-stats.mjs          갱신
 *       node scripts/build-stats.mjs --check  어긋나면 종료코드 1
 *
 * 문서에 아래 표식 사이를 갈아 끼운다.
 *   <!-- STATS:START --> ... <!-- STATS:END -->
 *   <!-- SKILLS:START --> ... <!-- SKILLS:END -->   README 의 스킬 100개·체인 목록 (있을 때만)
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(ROOT, '..', '..');
const M = path.join(ROOT, '100-skills');
const CHECK = process.argv.includes('--check');

const fm = t => (t.match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
const fld = (f, k) => ((f.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1] || '').trim().replace(/^"|"$/g, '');

const S = [];
for (const c of fs.readdirSync(M).filter(d => /^\d\d-/.test(d)).sort()) {
  const sd = path.join(M, c, 'skills');
  if (!fs.existsSync(sd)) continue;
  for (const d of fs.readdirSync(sd).sort()) {
    const p = path.join(sd, d, 'SKILL.md');
    if (fs.existsSync(p)) S.push(fm(fs.readFileSync(p, 'utf8')));
  }
}

const ext = f => {
  const w = fld(f, 'writes_to').replace(/^\[|\]$/g, '').split(',').map(x => x.trim()).filter(x => x.includes('/'))[0] || '';
  const m = w.match(/\.(\w+)$/);
  return m ? m[1] : (w ? 'dir' : 'none');
};
const by = {};
for (const f of S) { const e = ext(f); by[e] = (by[e] || 0) + 1; }

const stats = {
  skills: S.length,
  triggers: S.reduce((a, f) => a + [...f.matchAll(/^\s+- "/gm)].length, 0),
  gate: S.filter(f => fld(f, 'gate') === 'true').length,
  mutating: S.filter(f => fld(f, 'mutating') === 'true').length,
  sample: S.filter(f => fld(f, 'sample_fallback')).length,
  writesTo: S.filter(f => fld(f, 'writes_to')).length,
  chains: (fs.readFileSync(path.join(M, 'ROUTING.md'), 'utf8').match(/^\| \*\*/gm) || []).length,
  ext: by,
};
const extLine = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(' · ');

const BLOCK = `<!-- STATS:START -->
스킬 ${stats.skills} · 부를 말 ${stats.triggers} · 게이트 ${stats.gate} · 상태변경 ${stats.mutating} · 체인 ${stats.chains}
저장 형식 ${extLine} · \`writes_to\` 보유 ${stats.writesTo} · 샘플 폴백 ${stats.sample}
<!-- STATS:END -->`;

// README 의 스킬 목록 · 손으로 옮기면 낡는다 (2026-09-22 · README 를 사용자용으로 다시 쓰며 더함)
// 카테고리 이름과 체인 표는 ROUTING.md, 스킬 한 줄은 SKILL.md frontmatter 가 정본이다
const ROUTING = fs.readFileSync(path.join(M, 'ROUTING.md'), 'utf8');
const catName = Object.fromEntries([...ROUTING.matchAll(/^## (\d\d-[a-z-]+) · (.+)$/gm)].map(m => [m[1], m[2].trim()]));
const cell = v => String(v || '').replace(/\|/g, '\\|').trim();
const firstTrigger = f => (f.match(/^\s+- "([^"]+)"/m) || [, ''])[1];
const cats = {};
for (const f of S) (cats[fld(f, 'category')] ||= []).push(f);
const skillParts = Object.keys(cats).sort().map(c => {
  const rows = cats[c].map(f => `| ${fld(f, 'id')} | ${cell(fld(f, 'name'))}${fld(f, 'gate') === 'true' ? ' 🛡' : ''} | ${cell(fld(f, 'when_to_use'))} | 「${cell(firstTrigger(f))}」 |`);
  return `<details>\n<summary><strong>${c.slice(0, 2)} ${catName[c] || c}</strong> (스킬 ${cats[c].length}개)</summary>\n\n| 번호 | 스킬 | 언제 쓰나 | 이렇게 부른다 |\n|---|---|---|---|\n${rows.join('\n')}\n\n</details>`;
});
const chainRows = [...ROUTING.matchAll(/^\| \*\*(.+?)\*\* \| (.+?) \| `(.+?)` \| (.+?) \|$/gm)]
  .map(m => `| **${m[1]}** | ${m[4]} | ${m[2].split(' · ')[0]} |`);
const SKILLS_BLOCK = `<!-- SKILLS:START -->
${skillParts.join('\n\n')}

<details>
<summary><strong>체인 ${chainRows.length}종</strong> (스킬 여러 개를 한 번에 잇는다)</summary>

| 체인 | 무엇을 잇나 | 이렇게 부른다 |
|---|---|---|
${chainRows.join('\n')}

</details>

🛡 는 발행 전에 AI 규제검토자가 표현을 검사하는 스킬이다 (${stats.gate}개).
<!-- SKILLS:END -->`;

const TARGETS = [path.join(REPO, 'README.md'), path.join(ROOT, 'docs', '공통규약.md')];
let changed = 0, missing = 0;
for (const t of TARGETS) {
  if (!fs.existsSync(t)) continue;
  const s = fs.readFileSync(t, 'utf8');
  if (!s.includes('<!-- STATS:START -->')) { missing++; console.log(`  · ${path.relative(REPO, t)} 에 STATS 블록 없음`); continue; }
  let out = s.replace(/<!-- STATS:START -->[\s\S]*?<!-- STATS:END -->/, BLOCK);
  if (out.includes('<!-- SKILLS:START -->')) out = out.replace(/<!-- SKILLS:START -->[\s\S]*?<!-- SKILLS:END -->/, SKILLS_BLOCK);
  if (out !== s) { if (!CHECK) fs.writeFileSync(t, out); changed++; console.log(`  ${CHECK ? '🔴 어긋남' : '✓ 갱신'} ${path.relative(REPO, t)}`); }
}
console.log(`\n${BLOCK.replace(/<!--.*?-->\n?/g, '')}`);
if (CHECK && changed) { console.error('🔴 생성 수치가 문서와 다르다 — `node scripts/build-stats.mjs`'); process.exit(1); }
if (!CHECK) console.log(`갱신 ${changed} · 블록 없음 ${missing}`);
