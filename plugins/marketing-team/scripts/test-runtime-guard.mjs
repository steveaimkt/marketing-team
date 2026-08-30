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
  env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: temp },
});
const decision = result => result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput.permissionDecision : 'none';

try {
  writeTranscript([row('user', '일반 코드 파일을 고쳐줘')]);
  let result = call('Write', { file_path: path.join(temp, 'src', 'app.js') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(decision(result), 'none', 'AI 마케터가 아닌 세션까지 막았습니다.');

  // ② 개발 저장소 예외 (2026-08-30) · marketplace.json 이 있는 곳은 플러그인 개발 저장소다
  fs.mkdirSync(path.join(temp, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(temp, '.claude-plugin', 'marketplace.json'), '{}');
  writeTranscript([row('user', '# 마케팅 AI 마케터')]);
  let devResult = call('Write', { file_path: path.join(temp, 'src', 'guard.mjs') });
  assert.equal(decision(devResult), 'none', '개발 저장소에서 소스 편집을 잠갔습니다.');
  fs.rmSync(path.join(temp, '.claude-plugin'), { recursive: true, force: true });

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

  // 회귀 2026-08-30 · 훅 결함 — 승인 뒤 셸 쓰기 · 따옴표 오인 · 표식 인용 오인 · 스크립트 예외
  writeTranscript([active, plan, approval]);
  result = call('Bash', { command: 'python3 patch.py' });
  assert.equal(decision(result), 'deny', '승인 뒤 스크립트 언어로 쓰는 것을 허용했습니다.');
  result = call('Bash', { command: "cat > outputs/x.md <<'EOF'\nhi\nEOF" });
  assert.equal(decision(result), 'deny', '승인 뒤 heredoc 쓰기를 허용했습니다.');
  result = call('Bash', { command: 'grep -n "=> {" outputs/result.md' });
  assert.equal(decision(result), 'none', '따옴표 속 기호를 문법으로 오인해 조회를 막았습니다.');
  result = call('Bash', { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/run-receipt.mjs" start "outputs/run.json"' });
  assert.equal(decision(result), 'none', '절차가 요구하는 플러그인 스크립트 실행을 막았습니다.');
  const quotedMarker = row('assistant', '본보기 설명 · 되돌림 화면도 「[실행 계획]」·「[승인 요청]」 표식을 그대로 쓴다.');
  writeTranscript([active, plan, approval, quotedMarker]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'none', '문장 속 표식 인용을 새 계획으로 오인해 승인을 무효화했습니다.');

  // 회귀 v0.47 · 승인 유연화(R4) · 승인 전 상태 기계(R6) · 기준 폴더(R2)
  writeTranscript([active, plan, row('user', '진행 승인 그리고 규제 세팅도 확인해줘')]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'none', '「진행 승인」으로 시작하는 답을 거부했습니다.');
  writeTranscript([active, plan, row('user', '네 진행해주세요')]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'none', '자연스러운 승인 변형을 거부했습니다.');
  writeTranscript([active, plan, row('user', '진행 승인 보류할게')]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'deny', '보류 답변을 승인으로 오인했습니다.');
  writeTranscript([active, plan]);
  result = call('Bash', { command: `node "${pluginRoot}/scripts/plan-compiler.mjs" compile "outputs/plan.json"` });
  assert.equal(decision(result), 'none', '승인 전 상태 기계(컴파일) 호출을 막았습니다 — G2 가 열리지 않습니다.');
  writeTranscript([active, plan, approval]);
  result = spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'test-session', transcript_path: transcript,
      cwd: os.tmpdir(), tool_name: 'Write', tool_input: { file_path: path.join(temp, 'outputs', 'result.md') } }),
    encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot, CLAUDE_PROJECT_DIR: temp },
  });
  assert.equal(decision(result), 'none', '셸 cd 표류 시 작업 폴더 쓰기를 오차단했습니다.');

  // P0 · 스크립트 허용 목록 (2026-08-30 최종 검토) — scripts/ 에 파일이 있다고 다 허용하지 않는다
  writeTranscript([active, plan]);
  result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" start "outputs/run.json"` });
  assert.equal(decision(result), 'deny', '승인 전에 영수증 시작을 허용했습니다.');
  for (const dev of ['bootstrap.mjs', 'build-routing.mjs', 'sync-skills.mjs']) {
    result = call('Bash', { command: `node "${pluginRoot}/scripts/${dev}"` });
    assert.equal(decision(result), 'deny', `승인 전에 개발 스크립트를 허용했습니다: ${dev}`);
  }
  // ledger-stats 는 --summary(요약 파일)·--hook(스탬프)이 쓴다 — 읽기 점검만 허용 (릴리스 검토 2026-08-30)
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --summary` });
  assert.equal(decision(result), 'deny', '승인 전에 원장 요약 쓰기를 허용했습니다.');
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --hook` });
  assert.equal(decision(result), 'deny', '승인 전에 원장 스탬프 쓰기를 허용했습니다.');
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --check` });
  assert.equal(decision(result), 'none', '읽기 점검(--check)까지 막았습니다.');
  writeTranscript([active, plan, approval]);
  result = call('Bash', { command: `node "${pluginRoot}/scripts/eval-routing.mjs" --update-baseline` });
  assert.equal(decision(result), 'deny', '승인 뒤 기준선 갱신 스크립트를 허용했습니다.');
  result = call('Bash', { command: `node "${pluginRoot}/scripts/build-catalog.mjs"` });
  assert.equal(decision(result), 'deny', '승인 뒤 생성 스크립트를 허용했습니다.');

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
    result = call('Bash', { command: `node "${pluginRoot}/scripts/plan-compiler.mjs" approve "${rel}/plan.json"` });
    assert.equal(decision(result), 'none', '승인 대기 상태가 상태 기계 호출까지 잠갔습니다 — approve 로 빠져나올 수 없습니다.');
    result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" start "${rel}/run.json"` });
    assert.equal(decision(result), 'deny', '계획 대기 중에 영수증 시작을 허용했습니다 (P0).');
    result = call('Bash', { command: 'ls outputs' });
    assert.equal(decision(result), 'none', '계획 대기가 읽기 조회까지 잠갔습니다.');
    result = call('Write', { file_path: planFile });
    assert.equal(decision(result), 'none', '무효 계획을 고칠 문이 없습니다 — plan.json 쓰기가 잠겼습니다.');

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

  console.log('실행 보호 훅 · 비마케팅 격리 1 · 승인 전 실행 차단 1 · 읽기 전용 조회 허용 1 · 위장 쓰기 차단 1 · 승인 차단 1 · 승인 통과 1 · 경로 차단 2 · 승인 재사용 차단 1 · 설치본 탐색 차단 1 · 계획 밖 스킬 차단 1 · 셸 쓰기 차단 2 · 따옴표 조회 허용 1 · 스크립트 예외 1 · 표식 인용 무해 1 · 계획 해시 승인 5 · 상태기계 탈출 1 · 승인 유연화 3 · 승인 전 컴파일 1 · 기준 폴더 1 · 계획대기 조회·수정 2 · 개발 저장소 예외 1 · P0 허용 목록 10 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
