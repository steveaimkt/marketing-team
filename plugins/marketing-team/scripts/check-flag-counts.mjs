#!/usr/bin/env node
/**
 * check-flag-counts.mjs · 문서가 손으로 적은 플래그 개수가 실제와 맞는지 잰다.
 *
 * 실측 2026-08-30 — AI-마케터가 `gate: true` 를 「100개 중 32개」라고 두 곳에서 말했는데
 * 실제는 34개였다. 플래그가 늘어도 문장은 그대로 남는다. 사람이 셀 일이 아니다.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLAGS = [
  { flag: 'gate: true', label: '`gate: true`' },
  { flag: 'pii: true', label: '`pii: true`' },
];

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

const skills = walk(path.join(PLUGIN, '100-skills')).filter(p => p.endsWith('SKILL.md'));
const actual = {};
for (const { flag } of FLAGS) {
  actual[flag] = skills.filter(p =>
    fs.readFileSync(p, 'utf8').split('\n').some(line => line.trim() === flag)).length;
}
const reviewCount = skills.filter(p =>
  fs.readFileSync(p, 'utf8').split('\n').some(line => /^review:/.test(line))).length;

const docs = [
  ...walk(path.join(PLUGIN, 'docs')),
  ...walk(path.join(PLUGIN, 'skills')),
  ...walk(path.join(PLUGIN, 'agents')),
].filter(p => p.endsWith('.md'));

let bad = 0;
for (const file of docs) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(PLUGIN, file);
  for (const { flag, label } of FLAGS) {
    // 「`gate: true` · 100개 중 32개」 · 「`pii: true` · 7개」 형태를 잡는다
    const re = new RegExp(`\`${flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`[^\\n]{0,24}?(\\d+)개`, 'g');
    for (const m of text.matchAll(re)) {
      const said = Number(m[1]);
      if (said === 100) continue;                       // 「100개 중」의 100
      if (said !== actual[flag]) {
        console.error(`🔴 ${rel} · ${label} 를 ${said}개라고 적었는데 실제는 ${actual[flag]}개다`);
        bad++;
      }
    }
  }
  for (const m of text.matchAll(/`review:`[^\n]{0,24}?(\d+)개/g)) {
    const said = Number(m[1]);
    if (said !== 100 && said !== reviewCount) {
      console.error(`🔴 ${rel} · \`review:\` 를 ${said}개라고 적었는데 실제는 ${reviewCount}개다`);
      bad++;
    }
  }
}
const line = FLAGS.map(f => `${f.flag} ${actual[f.flag]}개`).join(' · ');
if (bad) { console.error(`🔴 문서와 실제가 다르다 · ${bad}건 (실제 ${line} · review: ${reviewCount}개)`); process.exit(1); }
console.log(`✅ 플래그 개수 문서 일치 · ${line} · review: ${reviewCount}개`);
