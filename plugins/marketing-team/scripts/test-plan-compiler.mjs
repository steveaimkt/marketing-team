#!/usr/bin/env node
/**
 * test-plan-compiler.mjs · 계획 스키마·해시·승인 봉인 회귀
 * 골든 케이스는 실측에서 나왔다 (2026-08-30) — 계획 밖 HTML 생성, 지정 순서 변경.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planHash, validatePlan, approvalState } from './plan-compiler.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-plan-'));
const dir = path.join(temp, 'outputs', '2026-08-30', '046-roas-budget-rebalance');
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(path.join(temp, 'logs'), { recursive: true });
const planFile = path.join(dir, 'plan.json');
const rel = 'outputs/2026-08-30/046-roas-budget-rebalance';
const OUT = `workspace:${rel}/046-roas-budget-rebalance.md`;
const cli = (script, ...args) =>
  spawnSync(process.execPath, [path.join(HERE, script), ...args], { cwd: temp, encoding: 'utf8' });
const base = () => ({
  schema: 'marketing-team.plan/v1',
  plan_id: 'p-001',
  request: '광고 예산 다시 짜줘',
  skills: ['046'],
  steps: [{
    step: 1, skill: '046',
    inputs: ['plugin:sample-data/A브랜드-채널성과-90일.csv'],
    outputs: [OUT],
    reviews: [{ kind: 'business', perspective: '재무' }],
  }],
  budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
});
const save = plan => fs.writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
const load = () => JSON.parse(fs.readFileSync(planFile, 'utf8'));

try {
  // 해시 재현성 · 민감도
  assert.equal(planHash(base()), planHash(base()), '같은 계획은 같은 해시여야 한다');
  const reordered = base(); reordered.steps[0].inputs = [...reordered.steps[0].inputs].reverse();
  assert.equal(planHash(base()), planHash(reordered), '입력 순서는 의미가 아니므로 해시가 같아야 한다');
  for (const mutate of [
    p => p.skills.push('045'),
    p => p.steps[0].outputs.push(`workspace:${rel}/extra.html`),
    p => p.steps[0].reviews.push({ kind: 'compliance' }),
    p => { p.request = '다른 요청'; },
  ]) {
    const changed = base(); mutate(changed);
    assert.notEqual(planHash(base()), planHash(changed), '계획이 바뀌면 해시가 달라져야 한다');
  }

  // 계약 검사
  const badOutput = base(); badOutput.steps[0].outputs.push(`workspace:${rel}/extra.html`);
  assert.match(validatePlan(badOutput).join(' '), /계약에 없는 산출물/, '계획 밖 산출물을 잡아야 한다');
  const noReview = base(); noReview.steps[0].reviews = [];
  assert.match(validatePlan(noReview).join(' '), /business:재무/, 'review: 선언 누락을 잡아야 한다');
  const orderMismatch = base(); orderMismatch.skills = ['045'];
  assert.match(validatePlan(orderMismatch).join(' '), /순서가 다릅니다/, 'skills 와 steps 불일치를 잡아야 한다');
  const ghost = base(); ghost.skills = ['999']; ghost.steps[0].skill = '999';
  assert.match(validatePlan(ghost).join(' '), /그런 스킬이 없습니다/, '없는 스킬을 잡아야 한다');

  // 사용자가 지정한 순서 · 모델이 바꾸면 막는다 (실측 2026-08-30 · 061→073→065→066 이 바뀜)
  const ordered = base();
  ordered.requested_order = ['046'];
  assert.equal(validatePlan(ordered).length, 0, '지정 순서와 같으면 통과해야 한다');
  const reordered2 = base();
  reordered2.requested_order = ['045', '046'];
  assert.match(validatePlan(reordered2).join(' '), /지정한 순서와 다릅니다/, '순서를 바꾸면 잡아야 한다');
  assert.notEqual(planHash(base()), planHash(ordered), 'requested_order 도 해시에 들어가야 한다');

  // 승인 상태
  save(base());
  assert.equal(cli('plan-compiler.mjs', 'compile', `${rel}/plan.json`).status, 0, 'compile 은 성공해야 한다');
  assert.equal(load().status, 'awaiting-approval', 'compile 뒤에는 승인 대기여야 한다');
  assert.equal(approvalState(load()).ok, false, '승인 전에는 유효하지 않아야 한다');

  assert.equal(cli('plan-compiler.mjs', 'approve', `${rel}/plan.json`).status, 0, 'approve 는 성공해야 한다');
  assert.equal(load().status, 'approved');
  assert.equal(approvalState(load()).ok, true, '승인 뒤에는 유효해야 한다');

  const after = load(); after.steps[0].outputs.push(`workspace:${rel}/extra.html`); save(after);
  assert.equal(approvalState(load()).ok, false, '승인 뒤 계획이 바뀌면 무효여야 한다');
  assert.notEqual(cli('plan-compiler.mjs', 'check', `${rel}/plan.json`).status, 0, 'check 가 막아야 한다');

  // 승인 전 start 차단 · 승인 뒤 통과
  save(base());
  cli('plan-compiler.mjs', 'compile', `${rel}/plan.json`);
  const runFile = path.join(dir, 'run.json');
  fs.writeFileSync(runFile, `${JSON.stringify({
    schema: 'marketing-team.run/v1', status: 'draft', request: '광고 예산 다시 짜줘', skills: ['046'],
    data_mode: '샘플',
    inputs: [{ path: 'plugin:sample-data/A브랜드-채널성과-90일.csv', period: '2026-05-01~2026-07-29' }],
    profile: 'plugin:sample-data/profile-sample.md',
    outputs: [OUT],
    required_reviews: [{ kind: 'business', perspective: '재무', artifact: OUT }],
    reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
  }, null, 2)}\n`);
  const blocked = cli('run-receipt.mjs', 'start', `${rel}/run.json`);
  assert.notEqual(blocked.status, 0, '승인 전에는 실행을 열지 않아야 한다');
  assert.match(blocked.stderr, /승인/, '왜 막혔는지 알려야 한다');

  cli('plan-compiler.mjs', 'approve', `${rel}/plan.json`);
  const started = cli('run-receipt.mjs', 'start', `${rel}/run.json`);
  assert.equal(started.status, 0, `승인 뒤에는 시작해야 한다: ${started.stderr}`);
  assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).plan.plan_sha256, planHash(load()), '영수증에 승인 해시가 남아야 한다');

  console.log('계획 컴파일러 · 해시 재현·민감도 7 · 계약 검사 4 · 지정 순서 2 · 승인 상태 5 · start 차단·통과 2 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
