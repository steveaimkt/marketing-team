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

  const active = row('user', '# 마케팅 AI 마케터\n/skills/ai-marketer/SKILL.md');
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
  // 064·065 계산 도구 (2026-09-14) — 승인 뒤에는 실행되고, 파일을 쓰지 않으니 P0 허용 목록에 들어간다
  result = call('Bash', { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/cohort-retention.mjs" "sample-data/x.csv"' });
  assert.equal(decision(result), 'none', '승인 뒤 cohort-retention.mjs 실행을 막았습니다.');
  result = call('Bash', { command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/rfm-segments.mjs" "sample-data/x.csv" --dormancy-days 120' });
  assert.equal(decision(result), 'none', '승인 뒤 rfm-segments.mjs 실행을 막았습니다.');
  // 굵은 표식도 계획으로 결속된다 (실측 2026-08-31 · 헛 재승인 2회)
  const boldPlan = row('assistant', '**[실행 계획]**\n광고 문구 3안\n**[승인 요청]**\n진행하려면 「진행 승인」');
  writeTranscript([active, boldPlan, approval]);
  result = call('Write', { file_path: path.join(temp, 'outputs', 'result.md') });
  assert.equal(decision(result), 'none', '굵은 표식 계획에 승인이 결속되지 않았습니다 — 헛 재승인이 난다.');

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
  // 결합 옵션 우회 (릴리스 관문 검토 2026-08-30) — 허용 플래그 뒤에 쓰기 플래그를 붙이는 수
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --check --summary` });
  assert.equal(decision(result), 'deny', '허용 플래그 뒤에 붙인 쓰기 플래그(--summary)를 통과시켰습니다.');
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --check --hook` });
  assert.equal(decision(result), 'deny', '허용 플래그 뒤에 붙인 쓰기 플래그(--hook)를 통과시켰습니다.');
  // 따옴표 우회 (릴리스 재검토 2026-08-30) — 셸이 따옴표를 벗기면 같은 쓰기 플래그다
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --check "--summary"` });
  assert.equal(decision(result), 'deny', '따옴표로 감싼 쓰기 플래그("--summary")를 통과시켰습니다.');
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --check '--hook'` });
  assert.equal(decision(result), 'deny', "따옴표로 감싼 쓰기 플래그('--hook')를 통과시켰습니다.");
  result = call('Bash', { command: `node "${pluginRoot}/scripts/ledger-stats.mjs" --check -"-summary"` });
  assert.equal(decision(result), 'deny', '접합 인용(-"-summary")을 통과시켰습니다.');
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

  // ── 저위험 자동 승인 (2026-09-07) ────────────────────────────
  // 저위험 단일 업무는 사람 문장 없이 통과한다. pii·mutating·gate 는 그대로 막힌다.
  {
    const rel = 'outputs/2026-09-07/자동승인';
    const dir = path.join(temp, rel);
    fs.mkdirSync(dir, { recursive: true });
    const planFile = path.join(dir, 'plan.json');
    // 002 는 review: 브랜드·고객 을 요구한다. 006 은 요구하지 않는다.
    const 검토 = id => id === '002'
      ? [{ kind: 'business', perspective: '브랜드' }, { kind: 'business', perspective: '고객' }]
      : [];
    // 스킬 계약(writes_to)이 요구하는 산출물 셋을 그대로 적는다
    const 슬러그 = { '002': '002-competitor-analysis', '006': '006-review-mining' };
    const 산출 = id => {
      const g = 슬러그[id];
      if (!g) return [`workspace:${rel}/out.md`];
      const 끝 = id === '006' ? `${g}-해설.md` : `${g}.md`;
      return [`workspace:${rel}/${g}.xlsx`, `workspace:${rel}/${g}.html`, `workspace:${rel}/${끝}`];
    };
    const 계획 = id => ({
      schema: 'marketing-team.plan/v1', plan_id: 'auto', request: '경쟁사 비교해줘', skills: [id],
      steps: [{ step: 1, skill: id, inputs: [], outputs: 산출(id), reviews: 검토(id) }],
      budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
    });
    const 써넣기 = skill => fs.writeFileSync(planFile, `${JSON.stringify(계획(skill), null, 2)}\n`);
    const pc = (...a) => spawnSync(process.execPath,
      [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: temp, encoding: 'utf8' });
    let 쓸파일 = 'out.md';
    const 쓰기시도 = () => decision(call('Write', { file_path: path.join(dir, 쓸파일) }));

    // 승인 문장이 전혀 없는 대화
    writeTranscript([active, row('user', '경쟁사 비교해줘')]);

    // 002 는 gate·pii·mutating 이 전부 false → 문장 없이 통과해야 한다
    써넣기('002');
    쓸파일 = '002-competitor-analysis.md';
    pc('compile', `${rel}/plan.json`);
    pc('approve', `${rel}/plan.json`);
    assert.equal(쓰기시도(), 'none', '저위험 계획을 사람 문장 없이 통과시키지 못했습니다.');

    // 006 은 pii: true → 여전히 사람 승인이 있어야 한다
    써넣기('006');
    쓸파일 = '006-review-mining-해설.md';
    pc('compile', `${rel}/plan.json`);
    pc('approve', `${rel}/plan.json`);
    assert.equal(쓰기시도(), 'deny', 'pii: true 스킬을 승인 없이 통과시켰습니다.');

    // 계획이 스스로 저위험을 선언해도 소용없어야 한다 — 표시는 SKILL.md 에서 읽는다
    const 위장 = 계획('006');
    위장.low_risk = true;
    fs.writeFileSync(planFile, `${JSON.stringify(위장, null, 2)}\n`);
    pc('compile', `${rel}/plan.json`);
    pc('approve', `${rel}/plan.json`);
    assert.equal(쓰기시도(), 'deny', '계획이 선언한 low_risk 를 믿고 통과시켰습니다.');

    // 없는 스킬 번호는 저위험으로 치지 않는다
    써넣기('999');
    pc('compile', `${rel}/plan.json`);
    assert.equal(쓰기시도(), 'deny', '모르는 스킬을 저위험으로 통과시켰습니다.');

    fs.rmSync(planFile, { force: true });
  }

  // ── ⏸ 열린 질문 뒤 다음 단계 시작 차단 (실측 2026-09-14 · 8장 CRM 체인 1차) ──
  // 100개 업무 스킬은 Skill 도구를 다시 타지 않고 한 대화 안에서 이어지므로,
  // 체인의 다음 단계로 넘어가는 실제 경계는 run-receipt.mjs step-start 다.
  {
    const pauseMsg = row('assistant', '⏸ 며칠부터 휴면으로 볼지 정해 주세요.\n기본값은 180일입니다.');
    writeTranscript([active, plan, approval, pauseMsg]);
    result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" step-start "outputs/run.json" --step 2` });
    assert.equal(decision(result), 'deny', '⏸ 질문에 답 없이 다음 단계 시작을 허용했습니다.');

    writeTranscript([active, plan, approval, pauseMsg, row('user', '180일로 할게요')]);
    result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" step-start "outputs/run.json" --step 2` });
    assert.equal(decision(result), 'none', '사용자 답이 온 뒤에도 다음 단계 시작을 막았습니다.');

    // 막는 것은 "다음 단계 시작"뿐이다 — 지금 단계를 마무리하는 것까지 잠그지 않는다
    writeTranscript([active, plan, approval, pauseMsg]);
    result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" step-done "outputs/run.json" --step 1` });
    assert.equal(decision(result), 'none', '⏸ 대기 중에 현재 단계 마무리(step-done)까지 막았습니다.');
  }

  // ── 계획 스코핑 (실측 2026-09-14 · 8장 CRM 체인) ──────────────
  // 옆 단계(이미 승인된 저위험 계획)의 plan.json 이 더 최근이라는 이유로,
  // 규제검토가 필요한 다른 단계의 승인·위험판정을 대신하면 안 된다.
  {
    const 저위험폴더 = 'outputs/2026-09-14/064-cohort-retention';
    const 게이트폴더 = 'outputs/2026-09-14/075-kakao-alimtalk';
    fs.mkdirSync(path.join(temp, 저위험폴더), { recursive: true });
    fs.mkdirSync(path.join(temp, 게이트폴더), { recursive: true });
    const 저위험계획 = {
      schema: 'marketing-team.plan/v1', plan_id: 'p', request: '재구매율 봐줘', skills: ['064'],
      steps: [{ step: 1, skill: '064', inputs: [], outputs: [`workspace:${저위험폴더}/064-cohort-retention.csv`], reviews: [] }],
      budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
    };
    const planFile = path.join(temp, 저위험폴더, 'plan.json');
    fs.writeFileSync(planFile, `${JSON.stringify(저위험계획, null, 2)}\n`);
    const pc = (...a) => spawnSync(process.execPath,
      [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: temp, encoding: 'utf8' });
    pc('compile', `${저위험폴더}/plan.json`);
    pc('approve', `${저위험폴더}/plan.json`);

    // 승인 문장이 전혀 없는 대화 · 075 자신의 plan.json 은 아직 없다
    writeTranscript([active, row('user', '카카오 알림톡도 설계해줘')]);
    result = call('Write', { file_path: path.join(temp, 게이트폴더, '075-kakao-alimtalk.md') });
    assert.equal(decision(result), 'deny', '옆 단계(064)의 승인된 저위험 계획을 075 에 대신 썼습니다.');

    fs.rmSync(planFile, { force: true });
  }

  // ── ⏸ 초안 확인 증거 · run-receipt start 전 (2026-09-15) ──────────
  // §H 「② 확인 ⏸ 이 그릇으로 만들까요?」— 대화에 ⏸ 가 전혀 없고, 산출물에도
  // "물어보지 못해 기본값으로 갔다" 밝힘이 없으면 최종 단계 start 를 막는다.
  {
    const rel = 'outputs/2026-09-15/046-roas-budget-rebalance';
    const dir = path.join(temp, rel);
    fs.mkdirSync(dir, { recursive: true });
    const rj = `${rel}/run.json`;
    const writeReceipt = extra => fs.writeFileSync(path.join(temp, rj), `${JSON.stringify({
      schema: 'marketing-team.run/v1', status: 'draft', request: '광고 예산 다시 짜줘',
      skills: ['046'], data_mode: '샘플',
      outputs: [`workspace:${rel}/046-roas-budget-rebalance.md`],
      required_reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
      ...extra,
    }, null, 2)}\n`);
    const startCmd = `node "${pluginRoot}/scripts/run-receipt.mjs" start "${rel}/run.json"`;

    // 대화에 ⏸ 가 전혀 없고(plan 표식도 [승인 요청] 헤더만 씀) 산출물에도 밝힘이 없다 → 막는다
    writeReceipt({ 단계: '최종' });
    fs.writeFileSync(path.join(dir, '046-roas-budget-rebalance.md'), '[샘플] 예산 재배분안\n');
    writeTranscript([active, plan, approval]);
    result = call('Bash', { command: startCmd });
    assert.equal(decision(result), 'deny', '⏸ 증거도 밝힘 문구도 없는 최종 단계 start 를 허용했습니다.');

    // 대화 어딘가에 ⏸ 가 있으면(G2 승인 화면 자체) 통과한다 — 확인이 계획 단계로 흡수된
    // 실제 패턴(062 실행조건 기록)과 같다.
    const pausedPlan = row('assistant', '[실행 계획]\n046 예산 재배분을 실행합니다.\n[승인 요청]\n⏸ 이대로 진행할까요?');
    writeTranscript([active, pausedPlan, approval]);
    result = call('Bash', { command: startCmd });
    assert.equal(decision(result), 'none', '대화에 ⏸ 가 있는데도 최종 단계 start 를 막았습니다.');

    // ⏸ 가 없어도, 이 실행 자신의 산출물에 밝힘 문구가 있으면 비대화형 폴백으로 통과한다
    writeTranscript([active, plan, approval]);
    fs.writeFileSync(path.join(dir, '046-roas-budget-rebalance.md'),
      '[샘플] 예산 재배분안\n\n> 물어보지 못해 기본값으로 갔다: 그릇 선택 → 기본값(.md) 채택.\n');
    result = call('Bash', { command: startCmd });
    assert.equal(decision(result), 'none', '산출물의 밝힘 문구를 비대화형 증거로 인정하지 않았습니다.');

    // 단계:초안 은 아직 그릇을 고르지 않으므로 이 검사 대상이 아니다
    writeReceipt({ 단계: '초안' });
    writeTranscript([active, plan, approval]);
    result = call('Bash', { command: startCmd });
    assert.equal(decision(result), 'none', '초안 단계 start 에 그릇 확인 증거를 요구했습니다.');
  }

  // ── 저위험 자동 승인은 그릇 확인도 함께 면제한다 (2026-09-15) ──────
  // G2 자체의 ⏸ 를 요구하지 않는 경로에서 그릇 확인 ⏸ 만 따로 요구하면,
  // 화면에 ⏸ 가 한 번도 안 뜨는 정상 저위험 실행이 막힌다 (표본에 없던 조합이라 면제로 처리).
  {
    const rel = 'outputs/2026-09-15/자동승인-그릇';
    const dir = path.join(temp, rel);
    fs.mkdirSync(dir, { recursive: true });
    const planFile = path.join(dir, 'plan.json');
    // 002 는 gate·pii·mutating 이 전부 없어 저위험 자동 승인 대상이다 (위 블록과 동일 계약).
    const 계획 = {
      schema: 'marketing-team.plan/v1', plan_id: 'auto2', request: '경쟁사 비교해줘', skills: ['002'],
      steps: [{ step: 1, skill: '002', inputs: [], reviews: [
        { kind: 'business', perspective: '브랜드' }, { kind: 'business', perspective: '고객' },
      ], outputs: [
        `workspace:${rel}/002-competitor-analysis.xlsx`,
        `workspace:${rel}/002-competitor-analysis.html`,
        `workspace:${rel}/002-competitor-analysis.md`,
      ] }],
      budget: { tool_calls: 0, wall_minutes: 0, review_rounds: 3 },
    };
    fs.writeFileSync(planFile, `${JSON.stringify(계획, null, 2)}\n`);
    const pc = (...a) => spawnSync(process.execPath,
      [path.join(path.dirname(SCRIPT), 'plan-compiler.mjs'), ...a], { cwd: temp, encoding: 'utf8' });
    pc('compile', `${rel}/plan.json`);
    pc('approve', `${rel}/plan.json`);

    fs.writeFileSync(path.join(temp, `${rel}/run.json`), `${JSON.stringify({
      schema: 'marketing-team.run/v1', status: 'draft', request: '경쟁사 비교해줘',
      skills: ['002'], data_mode: '샘플', 단계: '최종',
      outputs: [
        `workspace:${rel}/002-competitor-analysis.xlsx`,
        `workspace:${rel}/002-competitor-analysis.html`,
        `workspace:${rel}/002-competitor-analysis.md`,
      ],
      required_reviews: [], ledger: { path: 'workspace:logs/build-log.md' },
    }, null, 2)}\n`);
    for (const f of ['002-competitor-analysis.xlsx', '002-competitor-analysis.html', '002-competitor-analysis.md'])
      fs.writeFileSync(path.join(dir, f), '[샘플]\n');

    // 승인 문장도 ⏸ 도 전혀 없는 대화 — 저위험 자동 승인이라 G2 자체가 이미 문장 없이 통과한다
    writeTranscript([active, row('user', '경쟁사 비교해줘')]);
    result = call('Bash', { command: `node "${pluginRoot}/scripts/run-receipt.mjs" start "${rel}/run.json"` });
    assert.equal(decision(result), 'none', '저위험 자동 승인 실행의 최종 단계 start 를 그릇 확인 증거 없이 막았습니다.');
  }

  console.log('실행 보호 훅 · 비마케팅 격리 1 · 승인 전 실행 차단 1 · 읽기 전용 조회 허용 1 · 위장 쓰기 차단 1 · 승인 차단 1 · 승인 통과 1 · 경로 차단 2 · 승인 재사용 차단 1 · 설치본 탐색 차단 1 · 계획 밖 스킬 차단 1 · 셸 쓰기 차단 2 · 따옴표 조회 허용 1 · 스크립트 예외 1 · 계산 도구 허용 2 · 표식 인용 무해 1 · 계획 해시 승인 5 · 상태기계 탈출 1 · 승인 유연화 3 · 승인 전 컴파일 1 · 기준 폴더 1 · 계획대기 조회·수정 2 · 개발 저장소 예외 1 · P0 허용 목록 15 · 저위험 자동 승인 4 · ⏸ 열린질문 차단 3 · 계획 스코핑 1 · ⏸ 초안 확인 증거 4 · 저위험 그릇 확인 면제 1 · ✅');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
