#!/usr/bin/env node
/**
 * build-routing.mjs · ROUTING.md 를 100개 SKILL.md 에서 다시 만든다.
 *
 * 왜: ROUTING.md 헤더는 「자동 생성」이라고 적었는데 생성기가 없었다.
 *     그래서 SKILL.md 를 고쳐도 명부가 안 따라왔고, CMO 는 명부를 먼저 읽으므로
 *     최신 스킬을 만들어도 구형 이름·트리거로 판단했다 (2026-08-22 · 외부 검토).
 *     검증기는 「명부 = 카탈로그」만 봐서, 낡은 둘이 서로 같으면 통과했다.
 *
 * 사용: node scripts/build-routing.mjs            다시 만든다
 *       node scripts/build-routing.mjs --check    고치지 않고 어긋남만 본다 (1 = 어긋남)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = path.join(ROOT, '100-skills');
const CHECK = process.argv.includes('--check');

const CAT = {
  '01-research': '시장조사', '02-product': '제품기획', '03-content': '콘텐츠',
  '04-social': 'SNS', '05-ads': '광고', '06-commerce': '이커머스',
  '07-analytics': '데이터', '08-crm': 'CRM', '09-brand-sales': '브랜딩·세일즈',
  '10-ops': '운영',
};

const fm = t => (t.match(/^---\n([\s\S]*?)\n---\n/) || [, ''])[1];
const fld = (f, k) => ((f.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [, ''])[1] || '').trim().replace(/^"|"$/g, '');
const lst = v => v.replace(/^\[|\]$/g, '').replace(/"/g, '').split(',').map(x => x.trim()).filter(Boolean);

// ── 1. 스킬 100개를 읽는다
const skills = [];
for (const cat of fs.readdirSync(M).filter(d => /^\d\d-/.test(d)).sort()) {
  const sd = path.join(M, cat, 'skills');
  if (!fs.existsSync(sd)) continue;
  for (const dir of fs.readdirSync(sd).sort()) {
    const p = path.join(sd, dir, 'SKILL.md');
    if (!fs.existsSync(p)) continue;
    const f = fm(fs.readFileSync(p, 'utf8'));
    skills.push({
      cat, id: fld(f, 'id'), name: fld(f, 'name'),
      triggers: [...f.matchAll(/^\s+- "(.+?)"$/gm)].map(m => m[1]),
      next: lst(fld(f, 'chains_to')),
      gate: fld(f, 'gate') === 'true', mut: fld(f, 'mutating') === 'true',
    });
  }
}
if (skills.length !== 100) { console.error(`🔴 스킬 ${skills.length}개 (100이어야 한다)`); process.exit(1); }

// ── 2. 체인부는 기존 ROUTING.md 의 「## 체인」 이후를 그대로 이어 붙인다 (정본은 CHAINS.md)
const RP = path.join(M, 'ROUTING.md');
const prev = fs.existsSync(RP) ? fs.readFileSync(RP, 'utf8') : '';
const chainIdx = prev.indexOf('## 체인');
const tail = chainIdx >= 0 ? prev.slice(chainIdx) : '';

// ── 3. 조립
const nGate = skills.filter(s => s.gate).length;
const nMut = skills.filter(s => s.mut).length;
const nTrig = skills.reduce((a, s) => a + s.triggers.length, 0);
const today = fs.statSync(M).mtime.toISOString().slice(0, 10);

let out = `# 스킬 100 · 라우팅 테이블 (정본)

> CMO 가 상시로 들고 있는 명부. **본문은 매칭된 순간에만 연다** (Progressive Disclosure).
> 자동 생성 · \`node scripts/build-routing.mjs\` · **손으로 고치지 않는다** (SKILL.md frontmatter 가 정본).
> ${skills.length}개 · 부를 말 ${nTrig}개 · 게이트 ${nGate}개 · 상태변경 ${nMut}개
`;

for (const [cat, ko] of Object.entries(CAT)) {
  const rows = skills.filter(s => s.cat === cat);
  if (!rows.length) continue;
  out += `\n## ${cat} · ${ko}\n\n| ID | 스킬 | 부르는 말 | 다음 | G |\n|---|---|---|---|---|\n`;
  for (const s of rows) {
    const g = [s.gate ? 'G' : '', s.mut ? '!' : ''].join('');
    out += `| ${s.id} | ${s.name} | ${s.triggers.map(t => `"${t}"`).join(' · ')} | ${s.next.join(', ')} | ${g} |\n`;
  }
}
out += `\n> **G** = 대외 발행물 · 발행 전 CCO(규제) 판정 (${nGate}개)\n`;
out += `> **!** = 상태를 바꾼다 (예약·발행·예산) · ⏸ 승인 필수 (${nMut}개)\n\n`;
out += tail || '';

// ── 4. 쓰거나 비교하거나
const cur = fs.existsSync(RP) ? fs.readFileSync(RP, 'utf8') : '';
if (CHECK) {
  if (cur.trim() === out.trim()) { console.log(`✅ ROUTING.md = SKILL.md ${skills.length}개 (일치)`); process.exit(0); }
  // 어디가 다른지 행 단위로 보여준다
  const rowsOf = t => Object.fromEntries([...t.matchAll(/^\| (\d{3}) \| (.+?) \| (.+?) \|/gm)].map(m => [m[1], `${m[2]} | ${m[3]}`]));
  const a = rowsOf(cur), b = rowsOf(out);
  const diff = Object.keys(b).filter(k => a[k] !== b[k]);
  console.error(`🔴 ROUTING.md 가 SKILL.md 와 어긋난다 · ${diff.length}개\n`);
  for (const id of diff.slice(0, 20)) {
    console.error(`  ${id}\n    명부  ${(a[id] || '(없음)').slice(0, 100)}\n    정본  ${b[id].slice(0, 100)}`);
  }
  console.error(`\n  고치려면: node scripts/build-routing.mjs`);
  process.exit(1);
}
fs.writeFileSync(RP, out);
console.log(`ROUTING.md 생성 · 스킬 ${skills.length} · 부를 말 ${nTrig} · 게이트 ${nGate} · 상태변경 ${nMut}`);
