#!/usr/bin/env node
/** AI 마케터의 G2 승인을 Claude Code PreToolUse 단계에서 강제한다. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { approvalState } from './plan-compiler.mjs';

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const PLAN_MARKER = /^\[실행 계획\][\s\S]*?^\[승인 요청\]/m; // 줄머리만 — 문장 속 인용은 계획이 아니다 (실측 2026-08-30)
// 승인 판정 A안 (2026-08-30) · 「진행 승인」으로 시작하면 뒤에 지시가 붙어도 승인이다 (보류·취소류는 제외).
// 자연 변형(「네 진행해주세요」 등)은 온전한 한 문장일 때만 승인으로 친다.
const APPROVAL_EXACT = /^\s*(?:네|예|넵)?[\s,]*(?:진행\s*승인|계획\s*승인|승인합니다|승인|이\s*계획으로\s*진행(?:해\s*줘|해주세요|합니다)?|진행해\s*줘요?|진행해주세요|진행하자)\s*[.!~]?\s*$/;
const APPROVAL_PREFIX = /^\s*진행\s*승인(?!\s*(?:보류|취소|아직|말|안\s|못\s))/;
const APPROVAL = { test: text => APPROVAL_EXACT.test(text) || APPROVAL_PREFIX.test(text) };
const ACTIVE_MARKERS = ['# 마케팅 AI 마케터', '/skills/AI-마케터/SKILL.md', '\\skills\\AI-마케터\\SKILL.md'];
const WRITE_ROOTS = new Set(['brand', 'outputs', 'logs', 'inputs']);

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let body = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { body += chunk; });
    process.stdin.on('end', () => resolve(body));
    process.stdin.on('error', reject);
  });
}

function textOfContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n');
}

function transcriptRows(file) {
  if (!file || !fs.existsSync(file)) return [];
  const stat = fs.statSync(file);
  const start = Math.max(0, stat.size - MAX_TRANSCRIPT_BYTES);
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    const raw = buffer.toString('utf8');
    const body = start ? raw.slice(raw.indexOf('\n') + 1) : raw;
    const rows = [];
    for (const line of body.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        const role = event?.message?.role;
        if (role !== 'assistant' && role !== 'user') continue;
        const text = textOfContent(event.message.content);
        if (text) rows.push({ role, text });
      } catch {
        // 손상된 한 줄 때문에 훅 전체를 무력화하지 않는다.
      }
    }
    return rows;
  } finally {
    fs.closeSync(fd);
  }
}

function isActive(rows, rawTranscript) {
  return ACTIVE_MARKERS.some(marker => rawTranscript.includes(marker)) ||
    rows.some(row => row.text.includes('# 마케팅 AI 마케터'));
}

function approved(rows) {
  let latestPlan = -1;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].role === 'assistant' && PLAN_MARKER.test(rows[i].text)) latestPlan = i;
  }
  if (latestPlan < 0) return { ok: false, reason: '실행 계획 표식이 없습니다.' };
  for (let i = latestPlan + 1; i < rows.length; i++) {
    if (rows[i].role === 'user' && APPROVAL.test(rows[i].text)) return { ok: true, plan: rows[latestPlan].text };
  }
  return { ok: false, reason: '사용자의 명시적 진행 승인이 없습니다.' };
}

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function validateWrite(input) {
  const toolInput = input.tool_input || {};
  const raw = input.tool_name === 'NotebookEdit'
    ? toolInput.notebook_path || toolInput.file_path
    : toolInput.file_path || toolInput.path;
  if (!raw) return '쓰기 대상 경로를 확인할 수 없습니다.';
  // 셸 cd 가 플러그인 폴더에 머물러 있어도 작업 폴더 기준을 잃지 않는다 (실측 2026-08-30 · 3회 오차단).
  const cwd = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const target = path.resolve(cwd, raw);
  if (!inside(cwd, target)) return `작업 폴더 밖에는 쓸 수 없습니다: ${raw}`;
  const [root] = path.relative(cwd, target).split(path.sep);
  if (!WRITE_ROOTS.has(root))
    return `AI 마케터가 쓸 수 있는 곳은 brand/ · outputs/ · logs/ · inputs/뿐입니다: ${raw}`;
  return '';
}

function validateBash(input) {
  const command = String(input.tool_input?.command || '');
  const fallbackRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const pluginRoot = path.resolve(process.env.CLAUDE_PLUGIN_ROOT || fallbackRoot);
  if (/(?:^|[;&|]\s*)find\s+(?:\/|~|\/Users)(?:\s|$)/m.test(command))
    return '루트·홈 전체에서 설치본을 찾지 마세요. 현재 ${CLAUDE_PLUGIN_ROOT}만 사용하세요.';

  const cacheMatches = command.match(/(?:~|\/[^\s"']+)?\/\.claude\/plugins\/cache\/[^\s"']+/g) || [];
  for (const raw of cacheMatches) {
    const expanded = raw.startsWith('~/') ? path.join(process.env.HOME || '', raw.slice(2)) : raw;
    if (!inside(pluginRoot, path.resolve(expanded)))
      return '다른 캐시·설치본을 참조하지 마세요. 현재 ${CLAUDE_PLUGIN_ROOT}만 사용하세요.';
  }
  return '';
}

function isReadOnlyBash(input) {
  const raw = String(input.tool_input?.command || '');
  // 따옴표 속은 인수지 문법이 아니다 — 판정 전에 비운다 (실측 2026-08-30 · grep "=> {" 를 쓰기로 오인).
  // 단 $·백틱이 든 겹따옴표는 명령 치환이 살아 있으므로 남긴다.
  const unquoted = raw
    .replace(/'[^']*'/g, "''")
    .replace(/"[^"]*"/g, q => (/[`$]/.test(q) ? q : '""'));
  const command = unquoted.replace(/\d?>\s*\/dev\/null/g, '');
  if (/(?:^|\s)(?:rm|mv|cp|mkdir|touch|tee|chmod|chown|install|patch|apply_patch|node|python\d*|ruby|perl|npm|npx|pnpm|yarn|bun|deno|curl|wget|osascript)(?:\s|$)/.test(command))
    return false;
  if (/(?:^|\s)sed\s+[^;&|]*\s-i(?:\s|$)/.test(command)) return false;
  if (/(?:^|\s)find\s+[^;&|]*(?:-delete|-exec|-ok)(?:\s|$)/.test(command)) return false;
  if (/(^|[^<])>{1,2}(?!&)/.test(command) || /<(?!(?:=|<))/.test(command)) return false;

  const allowed = new Set(['cd', 'pwd', 'ls', 'rg', 'grep', 'head', 'tail', 'sed', 'cat', 'wc', 'stat', 'find', 'jq', 'test', '[', 'echo', 'printf']);
  const segments = command.split(/&&|\|\||;|\||\n/).map(item => item.trim()).filter(Boolean);
  return segments.length > 0 && segments.every(segment => {
    if (/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)$/.test(segment) &&
        !/^(?:HOME|CODEX_HOME)=/.test(segment) && !/`|\$\(/.test(segment)) return true;
    const name = segment.match(/^([^\s]+)/)?.[1];
    return allowed.has(name);
  });
}

/** node 로 부른 플러그인 스크립트의 (파일명, 첫 하위 명령)을 얻는다. 형식이 어긋나면 null. */
function pluginScriptCall(input) {
  const raw = String(input.tool_input?.command || '').trim();
  if (raw.includes('\n') || /`|\$\(/.test(raw)) return null;
  const fallbackRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const pluginRoot = path.resolve(process.env.CLAUDE_PLUGIN_ROOT || fallbackRoot);
  const m = raw.match(/^(?:cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|<>]+)\s*&&\s*)?node\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|<>]+))([^;&|<>]*)$/);
  if (!m) return null;
  const target = (m[1] || m[2] || m[3])
    .replace('${CLAUDE_PLUGIN_ROOT}', pluginRoot)
    .replace('$CLAUDE_PLUGIN_ROOT', pluginRoot);
  if (!target.endsWith('.mjs')) return null;
  const scriptsDir = path.join(pluginRoot, 'scripts');
  const candidates = [
    path.isAbsolute(target) ? path.resolve(target) : null,
    path.resolve(input.cwd || process.cwd(), target),
    path.resolve(pluginRoot, target),
  ].filter(Boolean);
  if (!candidates.some(file => inside(scriptsDir, file))) return null;
  const sub = String(m[4] || '').trim().match(/^(?:"([^"]*)"|'([^']*)'|(\S+))/);
  return { script: path.basename(target.replace(/\\/g, '/')), sub: (sub && (sub[1] || sub[2] || sub[3])) || '' };
}

/**
 * 명령·상태별 허용 목록 (P0 · 2026-08-30 최종 검토) —
 * scripts/ 에 파일이 있다는 이유로 허용하지 않는다. 빌드·동기화·기준선 갱신은 개발자 명령이고,
 * 마케팅 실행 훅의 허용 대상이 아니다. null 은 「하위 명령 무관」이다.
 */
const SCRIPT_ALLOW = {
  // 승인 전 · 라우팅과 계획 준비만 — 파일을 바꾸는 명령은 없다 (compile 은 계획 초안만 봉인한다)
  pre: {
    'router.mjs': null,
    'chain-compiler.mjs': ['check', 'list'],
    'plan-compiler.mjs': ['compile', 'check'],
    // --summary 는 요약 파일을, --hook 은 스탬프를 쓴다 — 읽기 점검(--check)만 (실측 2026-08-30 · 릴리스 검토)
    'ledger-stats.mjs': ['--check'],
  },
  // 계획 대기(미승인·해시 불일치) · 계획 상태 기계만 — 잠긴 상태에서 빠져나오는 문
  pending: {
    'plan-compiler.mjs': ['compile', 'approve', 'check'],
  },
  // 문장 승인 + 계획 정합 뒤 · 계획이 요구하는 실행·검증 명령만
  run: {
    'router.mjs': null,
    'chain-compiler.mjs': ['check', 'list'],
    'plan-compiler.mjs': ['compile', 'approve', 'check'],
    'run-receipt.mjs': null,
    'orchestrator-events.mjs': ['summary'],
    'ledger-stats.mjs': ['--check'],
    'output-checks.mjs': null,
    'pii-check.mjs': null,
  },
};

function allowedScript(input, stage) {
  const call = pluginScriptCall(input);
  if (!call) return false;
  const subs = SCRIPT_ALLOW[stage]?.[call.script];
  if (subs === undefined) return false;
  return subs === null || subs.includes(call.sub);
}

function validateSkill(input, plan) {
  const skill = String(input.tool_input?.skill || input.tool_input?.name || '').trim();
  if (!skill) return '호출할 스킬 이름을 확인할 수 없습니다.';
  if (!plan.includes(skill))
    return `실행 계획에 없는 추가 스킬은 호출할 수 없습니다: ${skill} · 필요하면 새 [실행 계획]에 추가해 다시 승인받으세요.`;
  return '';
}

async function main() {
  let input;
  try {
    input = JSON.parse(await readStdin());
  } catch (error) {
    deny(`실행 보호 훅 입력을 읽지 못했습니다: ${error.message}`);
    return;
  }

  let rawTranscript = '';
  try {
    if (input.transcript_path && fs.existsSync(input.transcript_path))
      rawTranscript = fs.readFileSync(input.transcript_path, 'utf8').slice(-MAX_TRANSCRIPT_BYTES);
  } catch {
    // 아래 rows가 비면 안전하게 승인 실패로 처리한다.
  }
  const rows = transcriptRows(input.transcript_path);
  if (!isActive(rows, rawTranscript)) return;

  // 플러그인 개발 저장소(marketplace.json 이 있는 곳)에서는 실행 보호를 걸지 않는다 —
  // 이 가드는 사용자 마케팅 작업 공간을 위한 것이다. 스킬 경로를 언급만 해도 무장되는 탓에
  // 자기 소스 유지보수(패치·커밋)까지 잠겼다 (실측 2026-08-30 · 편집 6건 전부 거부).
  const devRoot = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  try { if (fs.existsSync(path.join(devRoot, '.claude-plugin', 'marketplace.json'))) return; } catch { /* 무시 */ }

  if (input.tool_name === 'Bash') {
    const issue = validateBash(input);
    if (issue) {
      deny(issue);
      return;
    }
  }

/**
 * 승인의 대상은 문장이 아니라 **계획 해시**다.
 *
 * 실측 2026-08-30 — 중급 실행이 승인 전에 계획에 없던 HTML 을 만들었고,
 * 고급 실행이 사용자가 지정한 순서를 바꿔 돌았다. 대화에서 「진행 승인」을 받았는지만 보면
 * 그 뒤에 계획이 바뀌어도 알 수 없다.
 *
 * `plan.json` 이 있을 때만 본다. 없으면 예전 문장 게이트 그대로다 (하위 호환).
 * 읽지 못하면 막지 않는다 — 훅이 세션을 잠그는 쪽이 더 나쁘다. 문장 게이트가 남아 있다.
 */
function planApproval(cwd) {
  if (!cwd) return null;
  const root = path.join(cwd, 'outputs');
  let newest = null;
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.name === 'plan.json') {
        try {
          const at = fs.statSync(target).mtimeMs;
          if (!newest || at > newest.at) newest = { file: target, at };
        } catch { /* 건너뛴다 */ }
      }
    }
  };
  try { if (fs.existsSync(root)) walk(root); } catch { return null; }
  if (!newest) return null;
  let plan;
  try { plan = JSON.parse(fs.readFileSync(newest.file, 'utf8')); } catch { return null; }
  try {
    const state = approvalState(plan);
    if (state.ok) return null;
    return `${state.reason} (${path.relative(cwd, newest.file)})`;
  } catch { return null; }
}

  const approval = approved(rows);
  if (!approval.ok) {
    // 조회와 라우팅·계획 준비 명령만 승인 전에 돈다 — G1 라우팅·G2 컴파일이 여기 산다 (실측 2026-08-30).
    // 산출물 쓰기(Write/Edit)와 영수증·생성·동기화 스크립트는 승인 뒤에도 허용 목록으로만 돈다 (P0).
    if (input.tool_name === 'Bash' && (isReadOnlyBash(input) || allowedScript(input, 'pre'))) return;
    deny(`${approval.reason} 먼저 [실행 계획]과 [승인 요청]을 한 화면에 제시하고, 사용자에게 정확히 “진행 승인”을 받으세요.`);
    return;
  }

  const planIssue = planApproval(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  // 계획 상태 기계(plan-compiler·run-receipt)는 잠긴 상태에서 빠져나오는 유일한 문이다 —
  // 이 문까지 잠그면 compile 뒤 approve 를 부를 수 없다 (실측 2026-08-30 · 영구 잠금).
  // 읽기 조회는 계획을 위반할 수 없고(R8a), plan.json 자체는 쓰기 차단이 아니라 해시가 지킨다(R8b) —
  // 무효 계획을 고칠 문이 없으면 세션이 벽돌이 된다 (실측 2026-08-30 · 컴파일 거부 계획에서 완전 잠금).
  const planFileWrite = ['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name) &&
    path.basename(String(input.tool_input?.file_path || input.tool_input?.notebook_path || '')) === 'plan.json';
  if (planIssue && !planFileWrite &&
      !(input.tool_name === 'Bash' && (isReadOnlyBash(input) || allowedScript(input, 'pending')))) {
    deny(`승인한 계획과 지금 계획이 맞지 않습니다: ${planIssue} · 새 [실행 계획]을 제시하고 다시 “진행 승인”을 받은 뒤, plan-compiler.mjs approve 로 봉인하세요.`);
    return;
  }

  if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) {
    const issue = validateWrite(input);
    if (issue) deny(issue);
  } else if (input.tool_name === 'Bash') {
    // 승인은 계획을 허락한 것이지 파일시스템을 연 것이 아니다 — 쓰는 문은 Write/Edit 하나다.
    // (실측 2026-08-30 · 승인 뒤 셸 heredoc·python3 이 경로 규칙을 그대로 지나쳤다)
    // 스크립트도 파일이 있다고 다 허용하지 않는다 — 계획이 요구하는 실행·검증 명령만 (P0 허용 목록).
    if (!isReadOnlyBash(input) && !allowedScript(input, 'run'))
      deny('승인 뒤에도 파일은 Write/Edit 로 씁니다. Bash 는 읽기 조회와 절차가 요구하는 플러그인 스크립트(run-receipt·plan-compiler·router 등 허용 목록)만 실행합니다.');
  } else if (input.tool_name === 'Skill') {
    const issue = validateSkill(input, approval.plan);
    if (issue) deny(issue);
  }
}

await main();
