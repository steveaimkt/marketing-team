#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadRoutingIndex, routeOne, routeRequest } from './router.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(loadRoutingIndex().length, 100, '라우팅 색인에는 스킬 100개가 있어야 한다.');

// 평가셋 누수 차단 (P2 · 2026-08-30 최종 검토) — routing-eval.jsonl 문장이 운영 색인에 들어가면
// 같은 문장으로 재는 평가가 과대평가된다. 색인은 triggers·name·description·when_to_use 만 쓴다.
assert.ok(loadRoutingIndex().every(row => !('examples' in row) && !('exampleGrams' in row)),
  '평가 문장이 운영 색인에 새어 들어갔다.');

// 평가 문장은 홀드아웃으로만 쓴다. ⚠️ 어휘층(2-gram)은 패러프레이즈에 원래 약하다 —
// 누수 제거 직후 실측(2026-08-30) top3 적중 5/12 가 이 층의 민낯이고, 실 라우팅 품질은
// B층(eval-routing --live-cc · 실모델)이 담당이다. 여기서는 그 바닥이 더 내려가지 않는 것만 지킨다.
// 평가 문장을 손으로 트리거에 옮겨 이 숫자를 올리는 것은 누수를 손으로 반복하는 것이다 — 금지.
const evalFiles = {
  '006': '100-skills/01-research/skills/006-review-mining/routing-eval.jsonl',
  '046': '100-skills/05-ads/skills/046-roas-budget-rebalance/routing-eval.jsonl',
};
let scoped = 0, top1 = 0, top3 = 0;
for (const [id, rel] of Object.entries(evalFiles)) {
  const lines = fs.readFileSync(path.join(ROOT, rel), 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const intent = JSON.parse(line).intent;
    if (!intent) continue;
    scoped++;
    const routed = routeOne(intent);
    if (routed.candidates.some(row => row.id === id)) top3++;
    if (routed.candidates[0]?.id === id) top1++;
  }
}
assert.equal(scoped, 12, '006·046 평가 문장 수가 예상과 다르다.');
assert.ok(top3 >= 5, `홀드아웃 top3 가 바닥(5/12) 밑으로 내려갔다 (${top3}/${scoped}) — 어휘층이 회귀했다.`);
assert.ok(top1 >= 2, `홀드아웃 top1 이 바닥(2/12) 밑으로 내려갔다 (${top1}/${scoped}).`);

// 「예산을 채널별로 나눠줘」는 046(ROAS 재배분)↔095(예산 플래너)가 갈리는 경계 문장이다 —
// 어휘층은 후보에 올리는 것까지가 약속이고, 가르는 것은 헷갈리는-쌍 문서와 모델의 몫이다.
assert.ok(routeOne('광고 예산을 채널별로 어떻게 나눌지 다시 정해줘').candidates.some(row => row.id === '046'),
  '046 이 경계 문장의 top3 후보에도 없다.');
assert.equal(routeOne('소비자 리뷰에서 불만과 구매 이유를 뽑아줘').candidates[0].id, '006');
const compound = routeRequest('리뷰 불만을 분석하고 광고 예산을 다시 나눠줘');
assert.equal(compound.request_class, 'compound');
assert.deepEqual(compound.subrequests.map(row => row.candidates[0].id), ['006', '046']);

console.log(`자연어 후보 라우터 · 색인 100 · 누수 차단 1 · 홀드아웃 top3 ${top3}/12 · top1 ${top1}/12 (어휘층 바닥 지킴 · 실품질은 B층) · 새 표현 2 · 복합 분해 1 · ✅`);
