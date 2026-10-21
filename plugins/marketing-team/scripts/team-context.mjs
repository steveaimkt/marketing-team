#!/usr/bin/env node
/**
 * 마케팅 작업 폴더에서는 대화가 시작될 때마다 AI 마케터를 팀원으로 세운다 (SessionStart 훅).
 *
 * 왜 · 사용자 지적 2026-09-23 「트리거에 해당하지 않으면 일반 클로드 대화와 동일」.
 *   스킬은 설명(트리거)에 걸려야 열린다. 걸리지 않으면 플러그인이 한 줄도 끼어들 수 없어서
 *   같은 작업 폴더인데도 팀원이 아니라 처음 보는 도우미처럼 답했다.
 *   startup · resume · clear · compact 에서 모두 불린다. 압축 뒤에도 맥락이 다시 선다.
 *
 * UserPromptSubmit 에서도 불린다 (사용자 지시 2026-09-24 「말을 거는 순간 AI 마케터가 대답하게」).
 *   이 대화에서 ai-marketer 스킬이 아직 안 열렸으면, 인사든 짧은 질문이든 먼저 스킬을 열라고 붙인다.
 *   한 번 열렸으면(압축 뒤에도 스킬은 다시 붙는다) 아무것도 내지 않는다. 매번 다시 열면 컨텍스트만 불어난다.
 *   「/」로 시작하는 명령은 사용자가 이미 스킬을 고른 것이라 건드리지 않는다.
 *
 * 켜는 조건 · 「마케팅 팀 구축하자」를 마친 작업 폴더(brand/profile.md 가 있는 곳)에서만.
 *   플러그인은 사용자 전체로 설치되므로 훅은 모든 폴더에서 불린다. 구축한 폴더 밖에는 끼어들지 않는다
 *   (사용자 지시 2026-10-21 「설치하는 폴더에만 권한」 · 전에는 logs·inputs 폴더만 있어도 켜졌다).
 *   플러그인 개발 저장소에서도 켜지 않는다.
 *   못 읽거나 조건이 안 맞으면 아무것도 내지 않는다. 훅이 세션을 막는 일은 없다.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { replayStep } from './plan-compiler.mjs';


export const TEAM_CONTEXT = `이 작업 폴더는 사용자의 마케팅 팀 공간이다. 이 대화에서 너는 사용자의 마케팅 팀원인 AI 마케터다.
- 이 대화의 첫 답을 하기 전에 ai-marketer 스킬을 연다. 인사나 짧은 질문이어도, 트리거 문구와 달라도 같다.
  「업무 리스트 보여줘」는 marketing-team-tasks, 「구축하자」·설치 점검은 marketing-team-setup 을 연다.
- 스킬 100개 중 하나를 돌릴 때는 실행 계획, 확인 질문, 결과 보고를 스킬이 정한 모양 그대로 낸다. 덧붙이지 않는다.
  계획 화면이 있으면 그 화면이 첫 줄이다. 없을 때만 첫 줄에 무엇으로 하는지 밝힌다.
- 그 밖의 일반 대화에서는 마케팅 비서다. 정리, 요약, 찾기 같은 자잘한 일은 바로 챙기고,
  사용자가 계획이나 초안, 진행 상황을 말하면 잘된 점 하나와 고칠 점 하나를 근거와 함께 말하고,
  대화에서 나온 목표와 고민을 보고 가장 큰 다음 일 하나를 이유와 함께 제안한다.
- brand/profile.md 에 적힌 우리 회사를 알고 말하고, 결론을 먼저 쓰고, 의견을 물으면 추천 하나와 이유 한 줄을 낸다.
  모르면 모른다고 하고 없는 숫자는 지어내지 않는다.
- 사용자에게 훅, 게이트, G1 같은 시스템 말을 쓰지 않는다.
- 대화가 압축된 뒤라면 승인과 진행 상태는 outputs 의 plan.json 과 run.json 에 있다. 이미 받은 승인을 다시 묻지 않는다.`;

export function isMarketingWorkspace(dir) {
  if (!dir) return false;
  try {
    if (fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))) return false; // 플러그인 개발 저장소
    return fs.statSync(path.join(dir, 'brand', 'profile.md')).isFile();
  } catch { return false; }
}

export const PROMPT_CONTEXT = `이 메시지에 답하기 전에 ai-marketer 스킬을 먼저 연다. 인사나 짧은 질문이어도 같다. AI 마케터로서 답한다.
「업무 리스트 보여줘」처럼 목록을 보려는 말이면 marketing-team-tasks, 「구축하자」·설치 점검이면 marketing-team-setup 을 대신 연다.`;

const LOADED = /"skill"\s*:\s*"(?:marketing-team:)?ai-marketer"|[\\/]skills[\\/]ai-marketer[\\/]/;

/** 이 대화에서 ai-marketer 가 이미 열렸나 · 못 읽으면 안 열린 것으로 본다(한 번 더 여는 쪽이 덜 나쁘다) */
export function entrySkillLoaded(transcriptPath) {
  try {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return false;
    return LOADED.test(fs.readFileSync(transcriptPath, 'utf8'));
  } catch { return false; }
}

async function main() {
  let input = {};
  try {
    let body = '';
    process.stdin.setEncoding('utf8');
    for await (const chunk of process.stdin) body += chunk;
    input = body.trim() ? JSON.parse(body) : {};
  } catch { /* 못 읽으면 아무것도 내지 않는다 */ }
  const dir = path.resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (!isMarketingWorkspace(dir)) return;
  if (input.hook_event_name === 'UserPromptSubmit') {
    if (String(input.prompt || '').trimStart().startsWith('/')) return;
    // 책 실습 대본 · 원고 장(8~13장)을 샘플로 따라 하면 턴마다 원고 파일과 원고 답변이 정해져 있다
    let step = null;
    try { step = replayStep(dir, input.prompt); } catch { step = null; }
    if (step?.turn) {
      const t = step.turn;
      const say = [
        `책 실습 · ${step.장} ${step.k + 1}/${step.total}번째 차례다. ` +
          ((t.files || []).length ? `이 차례의 원고 결과 파일은 이미 ${step.folder}/ 에 놓였다.` : '이 차례에 새로 놓을 파일은 없다.'),
        (t.plan ? '분석, 생성, 검토자 호출을 하지 않는다. 계획 파일(plan.json)만 쓴다.' : '분석, 생성, 파일 쓰기, 검토자 호출을 하지 않는다.') +
          ' run-receipt book 도 돌리지 않는다(원고 파일과 화면은 이 대본이 이미 놓고 넘겼다). 도구 사이에 설명 말을 쓰지 않는다.',
        t.plan ? `이 차례는 계획 화면이다. ${t.plan.replaceAll('{날짜}', step.날짜)} 에 계획(plan.json · 스킬 ${t.skills.join('→')})을 쓰고 plan-compiler.mjs compile 이 통과할 때까지 고친 뒤, ` +
          (/\`\`\`text/.test(step.screen) ? '아래 화면을 한 글자도 바꾸지 말고 그대로 낸다(계획은 이미 \`\`\`text 상자에 들어 있다).' : '아래 화면을 \`\`\`text 상자에 담아 낸다.') : '',
        t.approve && (step.plan || t.approvePlan) ? `먼저 node "\${CLAUDE_PLUGIN_ROOT}/scripts/plan-compiler.mjs" approve "${step.plan || t.approvePlan.replaceAll('{날짜}', step.날짜)}" 로 계획을 봉인한다.` : '',
        t.image ? '이 차례는 이미지 생성 차례다. 힉스필드(Higgsfield) 도구가 이 대화에 연결돼 있는지 본다. 없으면 아래 화면을 내지 말고, 책 부록 A 대로 힉스필드를 연결한 뒤 같은 말을 다시 보내 달라고만 답한다. 연결돼 있어도 새로 생성하지 않는다.' : '',
        t.plan ? '' : '그다음 아래 화면을 한 글자도 바꾸지 말고, 앞뒤에 말을 붙이지 말고 그대로 낸다.',
        '<<<', step.screen, '>>>',
      ].filter(Boolean).join('\n');
      process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: say } })}\n`);
      return;
    }
    if (entrySkillLoaded(input.transcript_path)) return;
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: PROMPT_CONTEXT },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: TEAM_CONTEXT },
  })}\n`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('team-context.mjs')) {
  main().catch(() => {});
}
