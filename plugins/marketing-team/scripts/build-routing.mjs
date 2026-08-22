#!/usr/bin/env node
/**
 * build-routing.mjs · SKILL.md frontmatter → 100-skills/ROUTING.md
 *
 * 사용:
 *   node scripts/build-routing.mjs          ROUTING.md 재생성
 *   node scripts/build-routing.mjs --check  정본과 일치하는지만 검사
 *
 * ROUTING.md는 파생물이다. 이름·트리거·연결·게이트·상태 변경의 정본은
 * 각 스킬의 SKILL.md, 체인의 정본은 PLUGIN.md와 CHAINS.md다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = path.join(ROOT, '100-skills');
const OUT = path.join(M, 'ROUTING.md');
const CHECK = process.argv.includes('--check');

const CATEGORY_NAMES = {
  '01-research': '시장조사',
  '02-product': '제품기획',
  '03-content': '콘텐츠',
  '04-social': 'SNS',
  '05-ads': '광고',
  '06-commerce': '이커머스',
  '07-analytics': '데이터',
  '08-crm': 'CRM',
  '09-brand-sales': '브랜딩·세일즈',
  '10-ops': '운영',
};

const frontmatter = raw => (raw.match(/^---\n([\s\S]*?)\n---\n?/) || [, ''])[1];
const scalar = (fm, key) => ((fm.match(new RegExp(`^${key}:\\s*(.*)$`, 'm')) || [, ''])[1] || '')
  .trim().replace(/^"|"$/g, '');
const inlineList = value => {
  const v = value.trim().replace(/^\[/, '').replace(/\]$/, '');
  return v ? v.split(',').map(x => x.trim().replace(/^"|"$/g, '')).filter(Boolean) : [];
};
const blockList = (fm, key) => {
  const m = fm.match(new RegExp(`^${key}:\\s*\\n((?:\\s+- .+\\n?)+)`, 'm'));
  if (!m) return [];
  return [...m[1].matchAll(/^\s+-\s+"?(.+?)"?\s*$/gm)].map(x => x[1].replace(/"$/, ''));
};
const md = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

if (!fs.existsSync(M)) throw new Error(`100-skills 폴더가 없습니다: ${M}`);
const categories = fs.readdirSync(M, { withFileTypes: true })
  .filter(e => e.isDirectory() && /^\d\d-/.test(e.name))
  .map(e => e.name).sort();
if (categories.length !== 10) throw new Error(`카테고리는 10개여야 합니다. 현재 ${categories.length}개`);

const all = [];
const chains = [];
for (const category of categories) {
  const pluginPath = path.join(M, category, 'PLUGIN.md');
  if (!fs.existsSync(pluginPath)) throw new Error(`${category}/PLUGIN.md가 없습니다.`);
  const pfm = frontmatter(fs.readFileSync(pluginPath, 'utf8'));
  for (const key of ['chain', 'chain_steps', 'chain_desc'])
    if (!scalar(pfm, key)) throw new Error(`${category}/PLUGIN.md의 ${key} 값이 없습니다.`);
  chains.push({
    name: scalar(pfm, 'chain'),
    steps: scalar(pfm, 'chain_steps'),
    description: scalar(pfm, 'chain_desc'),
  });

  const skillsDir = path.join(M, category, 'skills');
  const skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();
  if (skillDirs.length !== 10) throw new Error(`${category} 스킬은 10개여야 합니다. 현재 ${skillDirs.length}개`);

  for (const skillDir of skillDirs) {
    const skillPath = path.join(skillsDir, skillDir, 'SKILL.md');
    if (!fs.existsSync(skillPath)) throw new Error(`${category}/skills/${skillDir}/SKILL.md가 없습니다.`);
    const fm = frontmatter(fs.readFileSync(skillPath, 'utf8'));
    const skill = {
      id: scalar(fm, 'id'),
      name: scalar(fm, 'name'),
      triggers: blockList(fm, 'triggers'),
      next: inlineList(scalar(fm, 'chains_to')),
      gate: scalar(fm, 'gate') === 'true',
      mutating: scalar(fm, 'mutating') === 'true',
      category,
    };
    if (!/^\d{3}$/.test(skill.id) || !skill.name || skill.triggers.length < 1)
      throw new Error(`${category}/skills/${skillDir}의 id·name·triggers를 확인하세요.`);
    all.push(skill);
  }
}

const ids = all.map(s => s.id);
const expected = Array.from({ length: 100 }, (_, i) => String(i + 1).padStart(3, '0'));
if (all.length !== 100 || new Set(ids).size !== 100 || expected.some(id => !ids.includes(id)))
  throw new Error('스킬 ID는 001–100이 중복 없이 정확히 한 번씩 있어야 합니다.');

const crossText = fs.readFileSync(path.join(M, 'CHAINS.md'), 'utf8');
const crossChains = [...crossText.matchAll(/^\|\s*\*\*(.+?)\*\*\s*\|\s*`(.+?)`\s*\|\s*(.+?)\s*\|\s*$/gm)]
  .map(m => ({ name: m[1], steps: m[2], description: m[3] }));
if (crossChains.length !== 5) throw new Error(`교차 체인은 5개여야 합니다. 현재 ${crossChains.length}개`);

const triggerCount = all.reduce((n, s) => n + s.triggers.length, 0);
const gateCount = all.filter(s => s.gate).length;
const mutatingCount = all.filter(s => s.mutating).length;
const lines = [
  '# 스킬 100 · 라우팅 테이블 (정본)',
  '',
  '> CMO가 상시로 들고 있는 명부. **본문은 매칭된 순간에만 연다** (Progressive Disclosure).',
  '> 자동 생성 · `node scripts/build-routing.mjs` · **손으로 고치지 않는다** (`SKILL.md` frontmatter가 정본).',
  `> 100개 · 부를 말 ${triggerCount}개 · 게이트 ${gateCount}개 · 상태변경 ${mutatingCount}개`,
  '',
];

for (const category of categories) {
  lines.push(`## ${category} · ${CATEGORY_NAMES[category] || category}`, '');
  lines.push('| ID | 스킬 | 부르는 말 | 다음 | G |', '|---|---|---|---|---|');
  for (const s of all.filter(x => x.category === category).sort((a, b) => a.id.localeCompare(b.id))) {
    const triggers = s.triggers.map(x => `"${md(x)}"`).join(' · ');
    const flag = `${s.gate ? 'G' : ''}${s.mutating ? '!' : ''}`;
    lines.push(`| ${s.id} | ${md(s.name)} | ${triggers} | ${md(s.next.join(', '))} | ${flag} |`);
  }
  lines.push('');
}

lines.push(
  `> **G** = 대외 발행물 · 발행 전 CCO(규제) 판정 (${gateCount}개)`,
  `> **!** = 상태를 바꾼다 (예약·발행·예산) · ⏸ 승인 필수 (${mutatingCount}개)`,
  '',
  '## 체인 15종 (여러 스킬을 한 번에 잇는 말)',
  '',
  '한 스킬만 부르는 대신 **한 줄로 한 바퀴를 도는** 말이다.',
  '카테고리마다 하나씩 10종, 카테고리를 넘나드는 것이 5종이다.',
  '',
  '| 체인 | 부를 말 | 순서 | 무엇을 하나 |',
  '|---|---|---|---|',
);
for (const c of chains)
  lines.push(`| **${md(c.name)}** | 「${md(c.name)} 돌려줘」 · 「${md(c.name)}」 | \`${md(c.steps)}\` | ${md(c.description)} |`);

lines.push(
  '',
  '**교차 체인 5종** · 카테고리를 넘나든다 (정본 `100-skills/CHAINS.md`)',
  '',
  '| 체인 | 부를 말 | 순서 | 무엇을 하나 |',
  '|---|---|---|---|',
);
for (const c of crossChains)
  lines.push(`| **${md(c.name)}** | 「${md(c.name)} 돌려줘」 | \`${md(c.steps)}\` | ${md(c.description)} |`);

lines.push(
  '',
  '> ⚠️ **슬래시 명령이 아니다.** `commands/` 폴더는 2026-08-04에 없앴다.',
  '> 그냥 말하면 CMO가 순서대로 태운다. 중간에 ⏸가 뜨면 답을 주고 이어 간다.',
  '> 정본은 각 카테고리의 `PLUGIN.md`와 `CHAINS.md`다.',
  '',
  '',
  '경로: `100-skills/{카테고리}/skills/{ID}-{slug}/SKILL.md`',
  '',
);

const output = lines.join('\n');
if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== output) {
    console.error('ROUTING.md가 SKILL.md·PLUGIN.md·CHAINS.md 정본과 다릅니다. `node scripts/build-routing.mjs`를 실행하세요.');
    process.exit(1);
  }
  console.log(`ROUTING.md 정본 일치 · 스킬 100 · 부를 말 ${triggerCount} · 체인 15`);
} else {
  fs.writeFileSync(OUT, output);
  console.log(`ROUTING.md 생성 · 스킬 100 · 부를 말 ${triggerCount} · 게이트 ${gateCount} · 상태변경 ${mutatingCount} · 체인 15`);
}
