#!/usr/bin/env node
/** 스킬의 review/gate 선언을 실제 산출물별 required_reviews로 확장한다. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const base = value => path.posix.basename(String(value || '').replace(/^workspace:/, ''));
const key = row => `${row.kind}:${row.perspective || ''}:${row.artifact}`;

export function requiredReviewsForExecution(skillRows, outputRows) {
  const outputs = outputRows.map(row => typeof row === 'string' ? { path: row } : row);
  const required = [];
  for (const skill of skillRows) {
    const contracts = new Set((skill.writes_to || skill.writesTo || []).map(base));
    const artifacts = outputs.filter(row => contracts.has(base(row.path)));
    for (const artifact of artifacts) {
      for (const perspective of skill.review || [])
        required.push({ kind: 'business', perspective, artifact: artifact.path });
      if (skill.gate) required.push({ kind: 'compliance', artifact: artifact.path });
    }
  }
  return [...new Map(required.map(row => [key(row), row])).values()];
}

export function mergeRequiredReviews(manual, automatic) {
  return [...new Map([...automatic, ...manual].map(row => [key(row), row])).values()];
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  console.error('review-policy.mjs는 plan-compiler/run-receipt가 내부에서 호출합니다.');
  process.exit(1);
}
