#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mergeRequiredReviews, requiredReviewsForExecution } from './review-policy.mjs';

const out = [
  { path: 'workspace:outputs/x/050-utm-attribution.csv' },
  { path: 'workspace:outputs/x/050-utm-attribution-해설.md' },
];
const required = requiredReviewsForExecution([{
  id: '050', review: ['재무'], gate: true,
  writes_to: ['outputs/{날짜}/050-utm-attribution/050-utm-attribution.csv', 'outputs/{날짜}/050-utm-attribution/050-utm-attribution-해설.md'],
}], out);
assert.equal(required.length, 4, '산출물 2개 × 사업·규제 검토가 필요하다.');
assert.equal(required.filter(row => row.kind === 'compliance').length, 2);
assert.equal(mergeRequiredReviews([required[0]], required).length, 4, '수동 항목과 자동 항목을 중복시키면 안 된다.');
console.log('검토 정책 · 산출물별 자동 생성 4 · 중복 제거 1 · ✅');
