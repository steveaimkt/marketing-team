#!/usr/bin/env node
/** runtime-guard.mjs의 활성 범위·G2 승인·경로 차단을 확인한다. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'runtime-guard.mjs');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'marketing-runtime-guard-'));
const transcript = path.join(temp, 'session.jsonl');
const pluginRoot = path.resolve(path.dirname(SCRIPT), '..');

const row = (role, text) => JSON.stringify({ message: { role, content: [{ type: 'text', text }] } });
const writeTranscript = lines => fs.writeFileSync(transcript, `${lines.join('\n')}\n`);
const call = (tool_name, tool_input = {}) => spawnSync(process.execPath, [SCRIPT], {
  input: JSON.stringify({
    hook_event_name: 'PreToolUse', session_id: 'test-session', transcript_path: transcript,
    cwd: temp, tool_name, tool_input,
  }),
  encoding: 'utf8',
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
});
const decision = result => result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'none';

try {
  writeTranscript([row('user', '일반 코드 파일을 고쳐줘')]);
  let result = call('Write', { file_path: path.join(temp, 'src', 'app.js') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(decision(result), 'none', 'AI 마케터가 아닌 세션까지 막았습니다.');

  const active = row('user', '# 마케팅 AI 마케터\n/skills/AI-마케터/SKILL.md');
  writeTranscript([active, row('user', '광고 예산 다시 짜줘')]);
  result = call('Bash', { command: 'node analysis.mjs' });
  assert.equal(decision(result), 'deny', '계획 없는 실행을 허용했습니다.');
  result = call('Bash', { command: `BASE="${pluginRoot}"\necho "routing"; grep -n "046" "$BASE/100-skills/ROUTING.md" 2>/dev/null | head -5` });
  assert.equal(decision(result), 'none', '계획 수립에 필요한 읽기 전용 조회까지 막았습니다.');
  result = call('Bash', { command: 'BASE="$(touch outputs/bypass)"\necho "$BASE"' });
  assert.equal(decision(result), 'deny', '변수 선언으로 감싼 명령 실행을 읽기 전용으로 허용했습니다.');
  result = call('Bash', { command: 'ls sample-data > outputs/list.txt' });
  assert.equal(decision(result), 'deny', '읽기 명령으로 위장한 리다이렉션 쓰기를 허용했습니다.');

  const plan = row('assistant', '[실행 계획]\n046 ROAS 진단을 실행합니다.\n[승인 요청]\n진행하려면 “진행 승인”이라고 답해주세요.');
  writeTranscript([active, plan]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'deny', '사용자 승인 없는 쓰기를 허용했습니다.');

  const approval = row('user', '진행 승인');
  writeTranscript([active, plan, approval]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'none', '승인 뒤 작업 폴더의 정상 쓰기를 막았습니다.');

  result = call('Edit', { file_path: path.join(temp, '..', 'outside.md') });
  assert.equal(decision(result), 'deny', '작업 폴더 밖 쓰기를 허용했습니다.');
  result = call('Write', { file_path: path.join(temp, 'tmp', 'result.md') });
  assert.equal(decision(result), 'deny', '허용되지 않은 최상위 폴더 쓰기를 허용했습니다.');

  const secondPlan = row('assistant', '[실행 계획]\n새 캠페인 카피를 만듭니다.\n[승인 요청]\n진행하려면 “진행 승인”이라고 답해주세요.');
  writeTranscript([active, plan, approval, secondPlan]);
  result = call('Bash', { command: 'node build.mjs' });
  assert.equal(decision(result), 'deny', '새 계획에 예전 승인을 재사용했습니다.');

  writeTranscript([active, plan, approval]);
  result = call('Bash', { command: 'find /Users -name SKILL.md' });
  assert.equal(decision(result), 'deny', '홈 전체 설치본 탐색을 허용했습니다.');
  result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" verify outputs/run.json` });
  assert.equal(decision(result), 'none', '현재 CLAUDE_PLUGIN_ROOT의 정상 명령을 막았습니다.');

  result = call('Skill', { skill: 'dataviz' });
  assert.equal(decision(result), 'deny', '실행 계획에 없는 추가 스킬 호출을 허용했습니다.');
  const plannedTool = row('assistant', '[실행 계획]\n046과 spreadsheet 도구로 CSV를 만듭니다.\n[승인 요청]\n진행하려면 “진행 승인”이라고 답해주세요.');
  writeTranscript([active, plannedTool, approval]);
  result = call('Skill', { skill: 'spreadsheet' });
  assert.equal(decision(result), 'none', '계획에 명시하고 승인받은 추가 스킬을 막았습니다.');

  // 승인의 대상은 문장이 아니라 계획 해시다 · plan.json 이 있을 때만 본다 (하위 호환)
  {
    const rel = 'outputs/2026-08-30/046-roas-budget-rebalance';
    const dir = path.join(temp, rel);
    fs.mkdirSync(dir, { recursive: true });
    const planFile = path.join(dir, 'plan.json');
    writeTranscript([
      row('assistant', '# 마케팅 AI 마케터\n[실행 계획]\n1. 046\n[승인 요청]'),
      row('user', '진행 승인'),
    ]);
    const basePlan = () => ({
      schema: 'marketing-team.plan/v1', plan_id: 'p', request: '광고 예산 다시 짜줘', skills: ['046'],
      steps: [{
        step: 1, skill: '046',
        inputs: ['plugin:sample-data/A브랜드-채널성과-90일.csv'],
        outputs: [`workspace:${rel}/046-roas-budget-rebalance.md`],
        reviews: [{ kind: 'business', perspective: '재무' }],
      }],
      budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
    });
    const pc = (...a) => spawnSync(process.execPath,
      [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: temp, encoding: 'utf8' });
    const tryWrite = () => decision(call('Write', { file_path: path.join(dir, '046-roas-budget-rebalance.md') }));

    fs.writeFileSync(planFile, `${JSON.stringify(basePlan(), null, 2)}\n`);
    pc('compile', `${rel}/plan.json`);
    assert.equal(tryWrite(), 'deny', '승인 대기 계획에서 쓰기를 허용했습니다.');

    pc('approve', `${rel}/plan.json`);
    assert.equal(tryWrite(), 'none', '승인 봉인한 계획의 쓰기를 막았습니다.');

    const changed = JSON.parse(fs.readFileSync(planFile, 'utf8'));
    changed.request = '다른 요청';
    fs.writeFileSync(planFile, `${JSON.stringify(changed, null, 2)}\n`);
    assert.equal(tryWrite(), 'deny', '승인 뒤 바뀐 계획으로 쓰기를 허용했습니다.');

    pc('compile', `${rel}/plan.json`);
    pc('approve', `${rel}/plan.json`);
    assert.equal(tryWrite(), 'none', '재승인한 계획의 쓰기를 막았습니다.');

    fs.rmSync(planFile);
    assert.equal(tryWrite(), 'none', 'plan.json 이 없는 예전 경로까지 막았습니다.');
  }

  console.log('실행 보호 훅 · 비마케팅 격리 1 · 승인 전 실행 차단 1 · 읽기 전용 조회 허용 1 · 위장 쓰기 차단 1 · 승인 차단 1 · 승인 통과 1 · 경로 차단 2 · 승인 재사용 차단 1 · 설치본 탐색 차단 1 · 계획 밖 스킬 차단 1 · 계획 해시 승인 5 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
