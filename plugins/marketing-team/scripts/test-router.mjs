#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoutingIndex, routeOne, routeRequest } from './router.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(loadRoutingIndex().length, 100, '라우팅 색인에는 스킬 100개가 있어야 한다.');

let scoped = 0;
for (const skill of loadRoutingIndex().filter(row => ['006', '046'].includes(row.id))) {
  for (const intent of skill.examples) {
    scoped++;
    assert.equal(routeOne(intent).candidates[0].id, skill.id, `${skill.id} 기본 요청을 다른 스킬로 보냈다: ${intent}`);
  }
}
assert.equal(scoped, 12, '006·046 평가 문장 수가 예상과 다르다.');
assert.equal(routeOne('광고 예산을 채널별로 어떻게 나눌지 다시 정해줘').decision, '046');
assert.equal(routeOne('소비자 리뷰에서 불만과 구매 이유를 뽑아줘').decision, '006');
const compound = routeRequest('리뷰 불만을 분석하고 광고 예산을 다시 나눠줘');
assert.equal(compound.request_class, 'compound');
assert.deepEqual(compound.subrequests.map(row => row.candidates[0].id), ['006', '046']);

console.log('자연어 후보 라우터 · 색인 100 · 006·046 12/12 · 새 표현 2 · 복합 분해 1 · ✅');
