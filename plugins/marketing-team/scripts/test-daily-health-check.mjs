#!/usr/bin/env node
/** 일일 자가검증 실행기 회귀 (§14 M1) — 목록 · 실패 계속 · 시간 초과 · 통합 판정 · 연속 실패 회로 · 정책 무결 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'daily-health-check.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-dhc-'));
const run = (args, env) => spawnSync(process.execPath, [SCRIPT, ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });

try {
  // ① 기본 목록 — 구조 1 · 회귀(자기 자신 제외) · 안전 1
  let r = run(['--list']);
  const list = JSON.parse(r.stdout);
  assert.ok(list.some(c => c.name === 'verify' && c.area === '구조'), 'verify 가 구조 검사로 있어야 한다');
  assert.ok(list.filter(c => c.area === '회귀').length >= 8, '회귀 스위트가 자동 발견돼야 한다');
  assert.ok(!list.some(c => c.name === 'test-daily-health-check'), '자기 자신은 목록에서 빠져야 한다 (재귀 금지)');
  assert.ok(list.some(c => c.area === '안전'), '정책 무결 검사가 있어야 한다');

  // 시험용 검사 목록 — 통과 1 · 실패 1 · 정지 1
  const mkScript = (name, body) => {
    const p = path.join(temp, name);
    fs.writeFileSync(p, body);
    return p;
  };
  const pass = mkScript('pass.mjs', 'console.log("ok")');
  const fail = mkScript('fail.mjs', 'console.error("의도한 실패"); process.exit(1)');
  const hang = mkScript('hang.mjs', 'setTimeout(() => {}, 60000)');
  const checksFile = path.join(temp, 'checks.json');
  fs.writeFileSync(checksFile, JSON.stringify([
    { name: 'ok-check', area: '회귀', script: pass },
    { name: 'fail-check', area: '회귀', script: fail },
    { name: 'hang-check', area: '회귀', script: hang },
  ]));
  const reports = path.join(temp, 'reports');
  const policy = path.join(temp, 'policy.json');
  fs.writeFileSync(policy, JSON.stringify({
    schema: 'marketing-team.self-check-policy/v1', repeat_failure_limit: 2,
    auto_fix: { allow: [], forbid: ['scripts/daily-health-check.mjs', 'maintenance/self-check-policy.json'] },
  }));
  const env = { DHC_CHECKS: checksFile, DHC_REPORT_DIR: reports, DHC_POLICY: policy, DHC_TIMEOUT_MS: '700' };

  // ② 한 검사가 실패·정지해도 끝까지 돌고, 통합 실패한다
  r = run([], env);
  assert.equal(r.status, 1, '실패가 있으면 종료 코드 1 이어야 한다');
  assert.match(r.stdout, /✅ 회귀 · ok-check/, '실패 뒤에도 나머지 검사가 돌아야 한다');
  assert.match(r.stdout, /🔴 회귀 · fail-check/, '실패가 표시돼야 한다');
  assert.match(r.stdout, /시간 초과/, '정지한 검사는 시간 초과로 잡아야 한다');
  const rep1 = JSON.parse(fs.readFileSync(path.join(reports, fs.readdirSync(reports)[0]), 'utf8'));
  assert.equal(rep1.schema, 'marketing-team.health/v1');
  assert.deepEqual({ t: rep1.counts.total, f: rep1.counts.failed }, { t: 3, f: 2 }, '요약 집계가 맞아야 한다');
  assert.deepEqual(rep1.circuit_break, [], '첫 실패는 회로 차단이 아니다');

  // ③ 같은 실패 2회 → 회로 차단 표시 (M4 의 재료)
  r = run([], env);
  const rep2Name = fs.readdirSync(reports).sort().at(-1);
  const rep2 = JSON.parse(fs.readFileSync(path.join(reports, rep2Name), 'utf8'));
  assert.ok(rep2.circuit_break.includes('fail-check'), '연속 실패는 회로 차단에 올라야 한다');
  assert.match(r.stdout, /자동 수정 금지/, '회로 차단은 자동 수정 금지를 함께 말해야 한다');

  // ④ 정책 무결 — 실행기 자신이 금지 목록에 없으면 안전 검사가 실패한다
  const badPolicy = path.join(temp, 'bad-policy.json');
  fs.writeFileSync(badPolicy, JSON.stringify({ repeat_failure_limit: 2, auto_fix: { forbid: [] } }));
  const policyOnly = path.join(temp, 'policy-check.json');
  fs.writeFileSync(policyOnly, JSON.stringify([{ name: 'self-check-policy', area: '안전', policy: true }]));
  r = run([], { DHC_CHECKS: policyOnly, DHC_REPORT_DIR: path.join(temp, 'r2'), DHC_POLICY: badPolicy });
  assert.equal(r.status, 1, '자기 보호가 빠진 정책은 실패해야 한다');
  assert.match(r.stdout, /자동 수정 금지 목록에 없다/);

  // ⑤ 전부 통과 → 종료 코드 0
  const okOnly = path.join(temp, 'ok.json');
  fs.writeFileSync(okOnly, JSON.stringify([{ name: 'ok-check', area: '회귀', script: pass }]));
  r = run([], { DHC_CHECKS: okOnly, DHC_REPORT_DIR: path.join(temp, 'r3'), DHC_POLICY: policy });
  assert.equal(r.status, 0, '전부 통과면 0 이어야 한다');
  assert.match(r.stdout, /✅ 자가검증 · 검사 1 · 실패 0/);

  console.log('자가검증 실행기 · 목록 4 · 계속·집계 4 · 회로 2 · 정책 2 · 통과 2 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
