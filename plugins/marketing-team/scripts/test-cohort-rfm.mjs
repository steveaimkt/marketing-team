#!/usr/bin/env node
/** cohort-retention.mjs · rfm-segments.mjs 가 실제 샘플 데이터로 계산한 값을 잰다.
 * 기준값은 064·065 example/output.md 의 사람이 검산한 수치와 대조해 맞춘 것이다 (2026-09-14). */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..');
const CSV = path.join(ROOT, 'sample-data', 'A브랜드-구매이력-12개월.csv');
const run = (script, ...args) => {
  const result = spawnSync(process.execPath, [path.join(DIR, script), ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

const cohort = run('cohort-retention.mjs', CSV);
const jan = cohort.cohorts.find(c => c.month === '2026-01');
assert.equal(jan.size, 42, '2026-01 코호트 인원이 example 산출물과 다릅니다.');
assert.ok(Math.abs(jan.retention['1'] - 0.0238) < 0.001, '2026-01 M+1 유지율이 example 산출물과 다릅니다.');
assert.ok(Math.abs(jan.retention['5'] - 0.1667) < 0.001, '2026-01 M+5 유지율이 example 산출물과 다릅니다.');
assert.equal(cohort.intervalDistribution.count, 108, '재구매 간격 건수가 example 산출물과 다릅니다.');
assert.equal(cohort.intervalDistribution.medianDays, 77, '재구매 간격 중앙값이 example 산출물과 다릅니다.');

const rfm = run('rfm-segments.mjs', CSV);
assert.equal(rfm.customerCount, 320, '고유 고객 수가 example 산출물(320명)과 다릅니다.');
assert.equal(rfm.buckets, 5, '고객 320명이면 5분위여야 합니다(200명 미만일 때만 3분위).');
const segTotal = Object.values(rfm.segments).reduce((sum, s) => sum + s.count, 0);
assert.equal(segTotal, rfm.customerCount, '세그먼트 인원 합계가 전체 고객 수와 다릅니다(065 Contract §1).');
// 원문 고객ID가 출력에 그대로 남지 않는가 (065 Contract §4) — 대체키만 있어야 한다
assert.ok(rfm.customers.every(c => /^고객-[0-9a-f]{8}$/.test(c.customerKey)), '대체키 형식이 아닙니다 — 원문 ID가 샐 수 있습니다.');

console.log('cohort-retention·rfm-segments 계산 검증 · 코호트 인원·유지율 3 · 간격 분포 2 · RFM 인원·분위·세그먼트 합계 3 · 대체키 형식 1 · ✅');
