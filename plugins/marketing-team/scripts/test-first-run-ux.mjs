#!/usr/bin/env node
/** 빠른 진입(개선 플랜 §13) 계약 회귀 — 첫 화면 규칙·고위험 제외·승인 접두 재료·픽스처 보존 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── 계약 앵커 · SKILL 이 빠른 진입 규칙을 들고 있는가 ──
const S = fs.readFileSync(path.join(ROOT, 'skills', 'AI-마케터', 'SKILL.md'), 'utf8');
for (const [anchor, why] of [
  ['빠른 진입 · 저위험 단일 업무는 첫 화면 하나로', '빠른 진입 계약이 없다'],
  ['mutating: true (발송·게시·예약', '고위험 제외 ①(외부 실행)이 없다'],
  ['pii: true (개인 데이터', '고위험 제외 ②(PII)가 없다'],
  ['예산 확정·배분', '고위험 제외 ③(예산)이 없다'],
  ['계약·법률 표현', '고위험 제외 ④(법률)가 없다'],
  ['최소 재료 한 개만', '한 번에 하나만 묻는 규칙이 없다'],
  ['같은 화면에', '샘플·실제 병기 규칙이 없다'],
  ['승인과 재료를 한 답으로', '승인 접두 재료 규칙이 없다'],
  ['「진행 승인」 단독이 무엇으로 도는지', '승인 줄이 기본값을 안 밝힌다 (사용자 지적 2026-09-01)'],
  ['빠른 진입이어도 줄지 않는 것', '안전장치 유지 선언이 없다'],
  ['같은 요청은 늘 같은 판정', '판정 일관성 규칙이 없다'],
]) assert.ok(S.includes(anchor), why);

// ── 승인 접두 + 재료 · 훅이 실제로 인정하는가 ──
const GUARD = path.join(HERE, 'runtime-guard.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-first-run-'));
const transcript = path.join(temp, 'session.jsonl');
const row = (role, text) => JSON.stringify({ message: { role, content: [{ type: 'text', text }] } });
const call = (tool_name, tool_input = {}) => spawnSync(process.execPath, [GUARD], {
  input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 't', transcript_path: transcript,
    cwd: temp, tool_name, tool_input }),
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: ROOT, CLAUDE_PROJECT_DIR: temp },
});
const decision = r => r.stdout.trim() ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecision : 'none';

try {
  const active = row('user', '# 마케팅 AI 마케터');
  const plan = row('assistant', '[실행 계획]\n광고 문구 3안 → 표현 안전 점검 → 결과 저장\n[승인 요청]\n진행하려면 「진행 승인」');
  // 승인 + 재료 한 답 — 플랜 §13.4 의 정확한 사용례
  fs.writeFileSync(transcript, [active, plan,
    row('user', '진행 승인. 제품은 저자극 선크림이고 핵심 혜택은 자외선 차단')].join('\n') + '\n');
  let r = call('Write', { file_path: path.join(temp, 'outputs', 'copy.md') });
  assert.equal(decision(r), 'none', '승인 접두 뒤 재료가 붙은 답을 승인으로 인정하지 않는다.');
  fs.writeFileSync(transcript, [active, plan, row('user', '진행 승인. 샘플로')].join('\n') + '\n');
  r = call('Write', { file_path: path.join(temp, 'outputs', 'copy.md') });
  assert.equal(decision(r), 'none', '「진행 승인. 샘플로」를 승인으로 인정하지 않는다.');
  // 단독 「진행 승인」 — 승인 줄이 기본값으로 안내하는 경로 (사용자 지적 2026-09-01)
  fs.writeFileSync(transcript, [active, plan, row('user', '진행 승인')].join('\n') + '\n');
  r = call('Write', { file_path: path.join(temp, 'outputs', 'copy.md') });
  assert.equal(decision(r), 'none', '단독 「진행 승인」을 승인으로 인정하지 않는다 — 기본값 경로가 막힌다.');
  fs.writeFileSync(transcript, [active, plan, row('user', '진행 승인 보류할게')].join('\n') + '\n');
  r = call('Write', { file_path: path.join(temp, 'outputs', 'copy.md') });
  assert.equal(decision(r), 'deny', '보류를 승인으로 오인했다.');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

// ── run/v1 회귀 픽스처 · 셋이 보존되고 파싱되는가 (개선 플랜 Phase 0) ──
const FIX = path.join(HERE, '_픽스처', 'run-v1');
const names = ['beginner-run.json', 'intermediate-run.json', 'advanced-run.json'];
for (const n of names) {
  const p = path.join(FIX, n);
  assert.ok(fs.existsSync(p), `run/v1 픽스처가 없다: ${n}`);
  const run = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(run.schema, 'marketing-team.run/v1', `${n} 스키마가 다르다`);
  assert.ok(run.run_id && run.status === 'completed', `${n} 이 완료 영수증이 아니다`);
  assert.ok(Array.isArray(run.outputs) && run.outputs.every(o => /^[a-f0-9]{64}$/.test(o.sha256 || '')),
    `${n} 산출물 지문이 없다`);
}
const adv = JSON.parse(fs.readFileSync(path.join(FIX, 'advanced-run.json'), 'utf8'));
assert.equal((adv.steps || []).length, 4, '고급 픽스처에 4단계가 없다');

console.log('빠른 진입·픽스처 · 계약 앵커 11 · 승인 접두 재료 2 · 단독 승인 1 · 보류 거부 1 · run/v1 픽스처 3(단계 4) · ✅');
