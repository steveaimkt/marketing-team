#!/usr/bin/env node
/**
 * test-output-checks.mjs · 산출물 내용 검사 회귀
 * 골든 케이스는 실측 산출물에서 그대로 가져왔다 (2026-08-30).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runChecks, AVAILABLE_CHECKS } from './output-checks.mjs';

let pass = 0;
const check = (name, ok) => { if (!ok) { console.error(`🔴 ${name}`); process.exit(1); } pass++; };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'output-checks-'));
const write = (rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};
const resolve = ref => path.join(root, String(ref).replace(/^(workspace|plugin):/, ''));
const hard = list => list.filter(l => !l.startsWith('⚠'));

// ── csv-format
write('out/bad.csv', '# 리뷰 분석\n\n| 번호 | 분류 |\n|---|---|\n| 1 | 긍정 |\n');
let r = await runChecks({ outputs: ['workspace:out/bad.csv'], checks: ['csv-format'] }, resolve);
check('마크다운을 .csv 로 저장한 것을 잡는다', hard(r).some(l => l.includes('마크다운')));
check('BOM 없음을 잡는다', hard(r).some(l => l.includes('BOM')));

write('out/ragged.csv', '﻿번호,분류\n1,긍정\n2,부정,여분\n');
r = await runChecks({ outputs: ['workspace:out/ragged.csv'], checks: ['csv-format'] }, resolve);
check('열 수가 어긋난 행을 잡는다', hard(r).some(l => l.includes('열 수가')));

write('out/good.csv', '﻿번호,분류\n1,긍정\n2,부정\n');
r = await runChecks({ outputs: ['workspace:out/good.csv'], checks: ['csv-format'] }, resolve);
check('정상 CSV 는 통과한다', hard(r).length === 0);

// ── house-style
write('out/leak.md', '이 스킬은 `chains_to` 로 이어지고 폴백하면 에스컬레이션합니다.\n');
r = await runChecks({ outputs: ['workspace:out/leak.md'], checks: ['house-style'] }, resolve);
check('chains_to 노출을 잡는다', hard(r).some(l => l.includes('chains_to')));
check('폴백 노출을 잡는다', hard(r).some(l => l.includes('폴백')));
check('에스컬레이션 노출을 잡는다', hard(r).some(l => l.includes('에스컬레이션')));

write('out/soft.md', '어느 자료가 정본인지 — 아직 못 정했습니다.\n');
r = await runChecks({ outputs: ['workspace:out/soft.md'], checks: ['house-style'] }, resolve);
check('정본·줄표는 경고로만 낸다', hard(r).length === 0 && r.length >= 2);

write('out/clean.md', '결과는 여기 저장했습니다 · outputs/2026-08-30/result.md\n');
r = await runChecks({ outputs: ['workspace:out/clean.md'], checks: ['house-style'] }, resolve);
check('깨끗한 문서는 통과한다', r.length === 0);

// ── 검토 보고서도 검사 대상
write('out/review-경영.md', '근거 파일이 없어 폴백했습니다.\n');
r = await runChecks({ outputs: [], reviews: [{ report: 'workspace:out/review-경영.md', artifact: 'workspace:out/clean.md' }], checks: ['house-style'] }, resolve);
check('검토 보고서의 내부말도 잡는다', hard(r).some(l => l.includes('폴백')));

// ── 미선언 · 모르는 검사
check('선언이 없으면 아무것도 안 돈다', (await runChecks({ outputs: ['workspace:out/leak.md'] }, resolve)).length === 0);
r = await runChecks({ outputs: [], checks: ['없는검사'] }, resolve);
check('모르는 검사 이름을 잡는다', hard(r).some(l => l.includes('모르는 검사')));
check('검사 목록이 노출된다', AVAILABLE_CHECKS.includes('pii') && AVAILABLE_CHECKS.includes('csv-format'));

fs.rmSync(root, { recursive: true, force: true });
console.log(`산출물 검사 · CSV 형식 4 · 우리말 5 · 미선언·오타 3 · ✅ (${pass})`);
