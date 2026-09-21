#!/usr/bin/env node
/** AI 마케터의 G2 승인을 Claude Code PreToolUse 단계에서 강제한다. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { approvalState } from './plan-compiler.mjs';

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const PLAN_MARKER = /^(?:\*\*)?\[실행 계획\][\s\S]*?(?:^(?:\*\*)?\[승인 요청\]|⏸)/m;
// 줄머리만 — 문장 속 인용은 계획이 아니다 (실측 2026-08-30).
// 굵은 표식(**[실행 계획]**)도 인정한다 — 모델이 강조로 굵히는 버릇이 있어 승인이 결속되지 않는
// 헛 재승인이 두 번 실측됐다 (2026-08-31 · 온보딩·빠른 진입).
// ⏸ 만 있고 리터럴 [승인 요청] 헤더가 없는 계획 화면도 승인 대상으로 인정한다 —
// [승인 요청] 헤더를 생략한 채 ⏸ 로만 멈추는 스킬(039)에서 정상 "진행 승인"이
// 영구 거부되는 버그가 실측됐다 (2026-09-13 · 5장 039).
// 승인 판정 A안 (2026-08-30) · 「진행 승인」으로 시작하면 뒤에 지시가 붙어도 승인이다 (보류·취소류는 제외).
// 자연 변형(「네 진행해주세요」 등)은 온전한 한 문장일 때만 승인으로 친다.
const APPROVAL_EXACT = /^\s*(?:네|예|넵)?[\s,]*(?:진행\s*승인|계획\s*승인|승인합니다|승인|이\s*계획으로\s*진행(?:해\s*줘|해주세요|합니다)?|진행해\s*줘요?|진행해주세요|진행하자)\s*[.!~]?\s*$/;
// 조사(은·는·이·가)가 승인과 부정어 사이에 끼면 부정 lookahead 를 못 걸었다
// (실측 2026-09-13, 「진행 승인은 아직 못 하겠어요」가 승인으로 오판됨) — 조사를 선택적으로 허용한다.
const APPROVAL_PREFIX = /^\s*진행\s*승인(?!\s*(?:은|는|이|가)?\s*(?:보류|취소|아직|말|안\s|못\s))/;
// 승인 판정 B안 (2026-09-13 · 4장 038) · 사용자가 정보와 승인 의사를 한 문장에 담아
// 「진행 승인」이 문장 맨 끝에 오면(앞에 다른 말이 있어도) 승인으로 친다. A안(접두)의 반대쪽 —
// 실제 대화에서 정보를 먼저 말하고 승인으로 문장을 맺는 경우가 실측으로 재현됐다.
// 부정형 뒤엔 걸리지 않는다("승인 안 함"처럼 승인 뒤에 말이 더 붙으면 $ 에서 끝나지 않아 제외된다).
const APPROVAL_SUFFIX = /(?:^|[\s,.!?~])(?:진행\s*승인|계획\s*승인|승인합니다|승인)\s*[.!~]?\s*$/;
// 부정·철회가 한 군데라도 있으면 승인이 아니다 (실측 2026-09-22 · 작동 검토 #3 —
// 「진행 승인하지 마세요」·「진행 승인합니다. 아니, 취소할게요」가 접두 승인으로 통과했다).
// 재료에 우연히 걸리면 한 번 더 묻게 될 뿐이다 · 오인 승인보다 안전한 쪽을 고른다.
const WITHDRAW = /하지\s*마|하지\s*말|말아\s*(?:줘|주세요|요)|취소|보류|철회|중단|멈춰|그만|아니(?:요|[,.\s]|$)|아뇨|잠깐|아직/;
const APPROVAL = { test: text => !WITHDRAW.test(text) && (APPROVAL_EXACT.test(text) || APPROVAL_PREFIX.test(text) || APPROVAL_SUFFIX.test(text)) };
const ACTIVE_MARKERS = ['# 마케팅 AI 마케터', '/skills/ai-marketer/SKILL.md', '\\skills\\ai-marketer\\SKILL.md'];
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
  // 마지막으로 뜻을 밝힌 사용자 말이 이긴다 · 승인한 뒤 「취소」하면 승인이 풀린다
  let ok = false;
  for (let i = latestPlan + 1; i < rows.length; i++) {
    if (rows[i].role !== 'user') continue;
    if (APPROVAL.test(rows[i].text)) ok = true;
    else if (WITHDRAW.test(rows[i].text)) ok = false;
  }
  if (ok) return { ok: true, plan: rows[latestPlan].text };
  return { ok: false, reason: '사용자의 명시적 진행 승인이 없습니다.' };
}

/**
 * 스킬이 화면에 낸 ⏸ 질문(체인 전용 멈춤 등 Phase 안의 질문)이 사람 답 없이
 * 다음 단계로 넘어가는 것을 잡는다 (실측 2026-09-14 · 8장 CRM 체인 1차 —
 * "휴면 경계를 며칠로 볼지" ⏸ 질문에 답이 없는 채 다음 스킬까지 끝까지 진행됐다).
 * 위 approved()·PLAN_MARKER 는 **G2 실행계획** 화면 하나만 본다 — 이건 실행 **도중**
 * 각 스킬이 내는 ⏸ 전부를 본다. 마지막 ⏸ 이후에 사용자(user) 행이 하나도 없으면 "열린 채"다.
 */
function openPause(rows) {
  let lastPause = -1;
  for (let i = 0; i < rows.length; i++)
    if (rows[i].role === 'assistant' && rows[i].text.includes('⏸')) lastPause = i;
  if (lastPause < 0) return null;
  if (rows.slice(lastPause + 1).some(row => row.role === 'user')) return null;
  const line = rows[lastPause].text.split('\n').find(l => l.includes('⏸'));
  return (line || '⏸').trim().slice(0, 80);
}

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

const DISCLOSURE_PHRASE = '물어보지 못해 기본값으로 갔다';

/**
 * §H 「② 확인 ⏸ 이 그릇으로 만들까요?」 — 최종 단계로 run-receipt start 하기 전에
 * 그 확인이 실제로 있었다는 증거를 요구한다.
 *
 * 증거 1순위: 대화 어딘가에 ⏸ 를 낸 assistant 행 — G2 승인 화면도 ⏸ 로 끝나므로
 * (approved() 가 이미 그 화면을 요구한다), 정상 진행이면 이 조건은 이미 채워져 있다.
 * 증거 2순위(비대화형 폴백): 화면 증거가 없으면, 이 실행 자신이 낸 산출물
 * (draft.outputs · .md·.html) 안에서 "물어보지 못해 기본값으로 갔다" 문구를 찾는다.
 * §H 순서상 start 시점에는 산출물이 이미 있으므로, 이 실행 자신의 파일 몇 개만
 * 읽는 것은 범위가 좁고 값싼 I/O 다 — 원장이나 다른 실행을 보지 않는다.
 *
 * 실측 2026-09-15 · 원고소스(v9) production 표본 대조 —
 * · 단계:초안 은 아직 그릇을 고르지 않으므로 이 검사에서 뺀다.
 * · 062(개별 확인 질문이 화면에 안 뜨고 계획 승인 단계로 흡수된 실제 사례,
 *   _실행조건.md 「확인된 것」③)도 G2 계획 화면 자체의 ⏸ 로 이미 통과한다 —
 *   그 ⏸ 를 "이 그릇으로" 문구에 결속하지 않고 대화 전체에서 찾기 때문이다.
 * · 문구는 실제 산출물(087-partnership-pack.md)에서 축약·의역 없이 그대로
 *   쓰인 것을 확인했다 — 그래서 부분 문자열 그대로 찾는다.
 *
 * run.json 을 못 읽거나 없으면 막지 않는다 — 훅이 세션을 잠그는 쪽이 더 나쁘다.
 */
function draftConfirmIssue(cwd, receiptArg, rows) {
  if (!receiptArg || !cwd) return null;
  if (rows.some(row => row.role === 'assistant' && row.text.includes('⏸'))) return null;
  let draft;
  try {
    const abs = path.resolve(cwd, receiptArg);
    if (!inside(cwd, abs) || !fs.existsSync(abs)) return null;
    draft = JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch { return null; }
  if (String(draft?.단계 || '최종').trim() !== '최종') return null; // 초안 단계는 그릇 확인 대상이 아니다
  const outputs = Array.isArray(draft?.outputs) ? draft.outputs : [];
  for (const item of outputs) {
    const raw = typeof item === 'string' ? item : item?.path;
    const rel = String(raw || '').replace(/^workspace:/, '');
    if (!/\.(md|html)$/i.test(rel)) continue; // 문구가 실제로 실리는 자리로 범위를 좁힌다
    try {
      const fileAbs = path.resolve(cwd, rel);
      if (!inside(cwd, fileAbs) || !fs.existsSync(fileAbs)) continue;
      if (fs.readFileSync(fileAbs, 'utf8').includes(DISCLOSURE_PHRASE)) return null;
    } catch { /* 한 파일을 못 읽어도 나머지 파일에서 계속 찾는다 */ }
  }
  return `⏸ 초안 확인 화면이 대화에 없고, 산출물에도 "${DISCLOSURE_PHRASE}" 밝힘이 없습니다 · ` +
    `초안을 보여주고 「이 그릇으로 만들까요?」 확인을 받거나, 비대화형이면 산출물에 그 문구를 남긴 뒤 다시 시도하세요.`;
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
    return `AI 마케터가 쓸 수 있는 곳은 brand · outputs · logs · inputs 뿐입니다: ${raw}`;
  return '';
}

/**
 * 승인 뒤 문서 생성용 Python (실측 2026-09-22 · 작동 검토 #2 — 공통규약 §H 가 python-pptx·docx·openpyxl
 * 을 쓰라고 하는데 승인 뒤에도 python3 가 전부 막혔다. 개발 저장소 예외 때문에 여기서는 안 드러났다).
 * 여는 것은 셋뿐이다 · 라이브러리 확인(import 만) · 작업 폴더 outputs 안 스크립트 · 공식 문서 스킬 스크립트.
 * 명령 하나짜리만 · 파이프·리다이렉션·이어 붙이기·치환은 그대로 막는다.
 */
function allowedPython(input) {
  const command = String(input.tool_input?.command || '').trim();
  if (/[;&|<>`\n]|\$\(/.test(command.replace(/-c\s+(["'])[^"']*\1/, ''))) return false;
  const m = command.match(/^python3?\s+(.+)$/);
  if (!m) return false;
  const rest = m[1].trim();
  const c = rest.match(/^-c\s+(["'])([^"']*)\1$/);
  if (c) return /^\s*(?:import\s+[\w.]+(?:\s*,\s*[\w.]+)*\s*;?\s*)+$/.test(c[2]);
  const script = (rest.match(/^(["']?)([^"'\s]+\.py)\1(?:\s|$)/) || [])[2];
  if (!script) return false;
  const cwd = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const abs = path.resolve(cwd, script);
  if (inside(path.join(cwd, 'outputs'), abs)) return true;
  return /[\\/]skills[\\/](?:xlsx|docx|pptx|pdf)[\\/]/.test(abs);
}

function isPlanDraftWrite(input) {
  if (!['Write', 'Edit'].includes(input.tool_name)) return false;
  const raw = input.tool_input?.file_path || input.tool_input?.path;
  if (!raw || path.basename(String(raw)) !== 'plan.json' || validateWrite(input)) return false;
  const cwd = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  return path.relative(cwd, path.resolve(cwd, raw)).split(path.sep)[0] === 'outputs';
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

  // awk/sort/uniq/cut 추가 — 대량 CSV 집계 수단이 없어 모델이 조합별 grep 반복이나
  // 무한 사고정지로 빠지는 버그가 실측됐다 (2026-09-13 · 7장 073, 11장 065/073).
  // node/python 은 위험도가 달라 그대로 차단한다.
  const allowed = new Set(['cd', 'pwd', 'ls', 'rg', 'grep', 'head', 'tail', 'sed', 'cat', 'wc', 'stat', 'find', 'jq', 'test', '[', 'echo', 'printf', 'awk', 'sort', 'uniq', 'cut']);
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
  const argsRaw = String(m[4] || '').trim();
  // 인수를 셸처럼 토큰화한다 — 「"--summary"」처럼 따옴표로 감싼 옵션이 공백 분리 검사를
  // 지나쳐 셸에서 벗겨지는 우회가 있었다 (릴리스 재검토 실측 2026-08-30).
  // 온전한 따옴표 토큰과 맨 토큰만 인정하고, 접합 인용(-"-summary")·이스케이프·변수가 섞인
  // 애매한 토큰은 통째로 거부한다 — 벗긴 뒤 무엇이 될지 여기서 확정할 수 없기 때문이다.
  const tokens = [];
  const tokenRe = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let piece;
  while ((piece = tokenRe.exec(argsRaw))) {
    if (piece[3] !== undefined && /["'\\$]/.test(piece[3])) return null;
    tokens.push(piece[1] ?? piece[2] ?? piece[3]);
  }
  const flags = tokens.filter(token => token.startsWith('--'));
  return { script: path.basename(target.replace(/\\/g, '/')), sub: tokens[0] || '', flags, tokens };
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
    'recall.mjs': ['search', 'graph'],   // 되짚기 조회 — index(쓰기)는 승인 뒤
    // 기억 조회 — capture(쓰기)는 승인 뒤. 옵션까지 목록에 둔다 (결합 옵션 우회 차단이 모든 --옵션을 본다)
    'memory.mjs': ['search', 'list', 'doctor', '--type', '--top', '--json'],
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
    'recall.mjs': null,
    'memory.mjs': null,   // G5 기억 남기기 — 초안 json 은 Write 로 쓰고 이 스크립트가 읽는다
    'orchestrator-events.mjs': ['summary'],
    'ledger-stats.mjs': ['--check'],
    'output-checks.mjs': null,
    'pii-check.mjs': null,
    // 064·065 가 계산을 직접 새로 짜지 않고 쓰는 계산 도구 (2026-09-14) — 파일을 쓰지 않고
    // 표준출력에 JSON만 낸다. 해석은 여전히 모델의 일이다.
    'cohort-retention.mjs': null,
    'rfm-segments.mjs': null,
  },
};

function allowedScript(input, stage) {
  const call = pluginScriptCall(input);
  if (!call) return false;
  const subs = SCRIPT_ALLOW[stage]?.[call.script];
  if (subs === undefined) return false;
  if (subs === null) return true;
  if (!subs.includes(call.sub)) return false;
  // 결합 옵션 우회 차단 (릴리스 관문 검토 실측 2026-08-30) — 첫 인수만 보면
  // 「--check --summary」가 통과해 쓰기 모드가 열린다. 제한 목록이 걸린 스크립트는
  // 명령의 모든 --옵션이 목록 안에 있어야 한다.
  return call.flags.every(flag => subs.includes(flag));
}

function validateSkill(input, plan) {
  const skill = String(input.tool_input?.skill || input.tool_input?.name || '').trim();
  if (!skill) return '호출할 스킬 이름을 확인할 수 없습니다.';
  if (!plan.includes(skill))
    return `실행 계획에 없는 추가 스킬은 호출할 수 없습니다: ${skill} · 필요하면 새 [실행 계획]에 추가해 다시 승인받으세요.`;
  return '';
}

/* ── 저위험 자동 승인 · 저자 지시 2026-09-07 「요청하면 바로 결과」 ──────────
 * 원고(4장)는 요청 한 줄 뒤 곧바로 결과표가 나온다고 적는다. 사람이 정하는 자리는
 * 처음(요청)과 마지막(결과 판단) 둘뿐이라는 것이 이 책의 약속이다.
 * 그래서 **저위험 단일 업무**는 사람 문장 없이 통과시킨다.
 *
 * 🔴 푸는 것은 「사람이 한 문장을 치는 대기」뿐이다. 다음은 그대로 남는다 —
 *    · 계획 해시 결속(planApproval) — 승인 뒤 계획이 바뀌면 여전히 막는다
 *    · 계획에 없는 스킬 차단(validateSkill)
 *    · 쓰기 경로 검사(validateWrite) · Bash 쓰기 차단 · 파일 착지
 *    2026-08-30 사고(계획에 없던 HTML·순서 바꿔 돌기)는 이 셋이 막는 것이라 그대로 막힌다.
 *
 * 🔴 위험 표시는 **계획에 적힌 값을 믿지 않고** SKILL.md 를 그때 읽는다.
 *    plan.json 은 미승인 상태에서 쓸 수 있어(상태기계 탈출문), 계획이 스스로
 *    「저위험」을 선언하게 두면 문이 통째로 열린다.
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_ROOT = path.join(PLUGIN_ROOT, '100-skills');

/** 스킬 하나의 위험 표시. 못 찾거나 못 읽으면 null — 모르면 저위험으로 치지 않는다. */
function skillFlags(id) {
  let areas;
  try { areas = fs.readdirSync(SKILLS_ROOT, { withFileTypes: true }); } catch { return null; }
  for (const area of areas) {
    if (!area.isDirectory()) continue;
    const dir = path.join(SKILLS_ROOT, area.name, 'skills');
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    const hit = names.find(n => n.startsWith(`${id}-`));
    if (!hit) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, hit, 'SKILL.md'), 'utf8'); } catch { return null; }
    return {
      gate: /^gate:\s*true\s*$/m.test(text),
      pii: /^pii:\s*true\s*$/m.test(text),
      mutating: /^mutating:\s*true\s*$/m.test(text),
    };
  }
  return null;
}

/** 계획의 모든 단계가 저위험이어야 저위험이다. 하나라도 모르면 false. */
function lowRiskPlan(plan) {
  const steps = plan?.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  for (const step of steps) {
    const id = (String(step?.skill ?? '').match(/\d{3}/) || [])[0];
    if (!id) return false;
    const flags = skillFlags(id);
    if (!flags || flags.gate || flags.pii || flags.mutating) return false;
  }
  return true;
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
/**
 * 지금 도구 호출이 어느 스킬(3자리 id)의 것인지 짚는다. 모르면 null —
 * 모르면 아래 newestPlan 이 예전처럼 전체 중 최신으로 되돌아간다(하위 호환).
 */
function currentStepId(input) {
  if (input.tool_name === 'Skill') {
    return (String(input.tool_input?.skill || input.tool_input?.name || '').match(/\d{3}/) || [])[0] || null;
  }
  if (['Write', 'Edit', 'NotebookEdit'].includes(input.tool_name)) {
    const raw = input.tool_name === 'NotebookEdit'
      ? (input.tool_input?.notebook_path || input.tool_input?.file_path)
      : (input.tool_input?.file_path || input.tool_input?.path);
    return (String(raw || '').match(/outputs[\\/][^\\/]+[\\/](\d{3})-/) || [])[1] || null;
  }
  return null;
}

function newestPlan(cwd, preferId) {
  if (!cwd) return null;
  const root = path.join(cwd, 'outputs');
  let newest = null, newestScoped = null;
  // 규모 실측 2026-08-31 · 이 탐색은 모든 도구 호출마다 돈다. 폴더 5,000개에서 호출당 ~120ms —
  // 수년치가 쌓이면 수백 ms 다. 계획 게이트가 실제로 물 일이 있는 것은 최근 계획뿐이므로
  // (옛 계획은 완료·승인 상태) 날짜 이름 폴더는 90일 창 밖이면 걷지 않는다.
  // 90일 넘게 방치된 미승인 계획은 게이트를 잃지만, 그것은 버려진 계획이다.
  const cutoff = new Date(Date.now() - 92 * 86400e3).toISOString().slice(0, 7); // YYYY-MM
  const walk = (dir, depth = 0) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth === 0 && /^\d{4}-\d{2}/.test(entry.name) && entry.name.slice(0, 7) < cutoff) continue;
        walk(target, depth + 1);
      }
      else if (entry.name === 'plan.json') {
        try {
          const at = fs.statSync(target).mtimeMs;
          if (!newest || at > newest.at) newest = { file: target, at };
          // 여러 단계가 각자 plan.json 을 갖는 체인에서, 옆 단계(이미 승인된 저위험 계획)가
          // 최신 파일이라는 이유로 지금 단계의 승인·위험판정을 대신하면 안 된다
          // (실측 2026-09-14 · 8장 CRM 체인 — 저위험 1단계 계획이 규제검토 필요한 4단계까지 대신 승인했다).
          // 같은 {id}-슬러그 폴더 안의 plan.json 만 "이 단계 것"으로 인정한다.
          if (preferId && path.basename(dir).startsWith(`${preferId}-`) &&
              (!newestScoped || at > newestScoped.at)) newestScoped = { file: target, at };
        } catch { /* 건너뛴다 */ }
      }
    }
  };
  try { if (fs.existsSync(root)) walk(root); } catch { return null; }
  // preferId 를 아는데 그 폴더 안에 계획이 없으면 "전체 중 최신"으로 물러나지 않는다 —
  // 물러나면 옆 단계의 계획을 다시 빌려 쓰게 되어 고치려던 문제가 그대로 남는다.
  // 이 단계 것이 없다는 뜻이므로 null 을 낸다(= 미승인과 같게 취급, 세션을 잠그지 않는다).
  const picked = preferId ? newestScoped : newest;
  if (!picked) return null;
  try { return { file: picked.file, plan: JSON.parse(fs.readFileSync(picked.file, 'utf8')) }; }
  catch { return null; }
}

function planApproval(cwd, preferId) {
  const found = newestPlan(cwd, preferId);
  if (!found) return null;
  try {
    const state = approvalState(found.plan);
    if (state.ok) return null;
    return `${state.reason} (${path.relative(cwd, found.file)})`;
  } catch { return null; }
}

  const approval = approved(rows);
  const cwd = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  const preferId = currentStepId(input);

  // 저위험 단일 업무는 사람 문장 없이 통과한다 (2026-09-07). 계획이 없으면 해당 없다.
  let autoPlan = null;
  if (!approval.ok) {
    const found = newestPlan(cwd, preferId);
    if (found && lowRiskPlan(found.plan)) autoPlan = found.plan;
  }

  if (!approval.ok && !autoPlan) {
    // 조회와 라우팅·계획 준비 명령만 승인 전에 돈다 — G1 라우팅·G2 컴파일이 여기 산다 (실측 2026-08-30).
    // 산출물 쓰기(Write/Edit)와 영수증·생성·동기화 스크립트는 승인 뒤에도 허용 목록으로만 돈다 (P0).
    if (input.tool_name === 'Bash' && (isReadOnlyBash(input) || allowedScript(input, 'pre'))) return;
    // G2 화면은 plan.json 에서 찍는다 · 그 초안은 승인 전에 써야 한다 (실측 2026-09-22 · 작동 검토 #1 ·
    // 첫 plan.json 이 여기서 막혀 문서의 순서대로는 계획 화면을 만들 수 없었다).
    // outputs 아래 plan.json 하나만 연다 · 산출물은 여전히 승인과 해시 봉인 뒤에만 쓴다
    if (isPlanDraftWrite(input)) return;
    deny(`${approval.reason} 먼저 [실행 계획]과 [승인 요청]을 한 화면에 제시하고, 사용자에게 정확히 “진행 승인”을 받으세요.`);
    return;
  }

  // 계획 밖 스킬 검사에 쓸 계획 본문 — 자동 승인이면 계획 자체를 글로 삼는다
  const planText = approval.ok ? approval.plan : JSON.stringify(autoPlan);

  const planIssue = planApproval(cwd, preferId);
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
    // 다음 단계를 여는 문(step-start) 앞에서, 직전 ⏸ 질문이 아직 안 열렸는지 먼저 본다.
    // 100개 업무 스킬은 Skill 도구를 다시 타지 않고 한 대화 안에서 이어지므로,
    // 체인의 다음 단계로 넘어가는 실제 경계는 이 호출이다.
    const call = pluginScriptCall(input);
    if (call?.script === 'run-receipt.mjs' && call.sub === 'step-start') {
      const pause = openPause(rows);
      if (pause) {
        deny(`직전 화면이 ⏸ 로 멈췄는데 사용자 답 없이 다음 단계로 넘어가려 합니다: "${pause}" · 사용자의 답을 받은 뒤 다시 시도하세요.`);
        return;
      }
    }
    // 저위험 자동 승인(autoPlan)은 G2 자체의 ⏸ 도 요구하지 않는 경로다 — 같은 신뢰 경계이므로
    // 그릇 확인 ⏸ 도 함께 면제한다. 아니면 화면에 ⏸ 가 한 번도 안 뜬 정상 실행이 막힌다
    // (실측 2026-09-15 · 표본에 없던 조합이라 안전 쪽으로 면제).
    if (call?.script === 'run-receipt.mjs' && call.sub === 'start' && !autoPlan) {
      const issue = draftConfirmIssue(cwd, call.tokens?.[1], rows);
      if (issue) {
        deny(issue);
        return;
      }
    }
    // 승인은 계획을 허락한 것이지 파일시스템을 연 것이 아니다 — 쓰는 문은 Write/Edit 하나다.
    // (실측 2026-08-30 · 승인 뒤 셸 heredoc·python3 이 경로 규칙을 그대로 지나쳤다)
    // 스크립트도 파일이 있다고 다 허용하지 않는다 — 계획이 요구하는 실행·검증 명령만 (P0 허용 목록).
    if (!isReadOnlyBash(input) && !allowedScript(input, 'run') && !allowedPython(input))
      deny('승인 뒤에도 파일은 Write/Edit 로 씁니다. Bash 는 읽기 조회와 절차가 요구하는 플러그인 스크립트(run-receipt·plan-compiler·router 등 허용 목록)만 실행합니다.');
  } else if (input.tool_name === 'Skill') {
    const issue = validateSkill(input, planText);
    if (issue) deny(issue);
  }
}

await main();
